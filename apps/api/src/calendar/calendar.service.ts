/**
 * Two-way calendar sync (FR-MEET-006; ADR 023).
 * Out: scheduled meetings a person hosts or attends appear in their Google or Outlook calendar
 *      (created, moved, cancelled with the meeting).
 * In:  their response (Google RSVP; deleting the event counts as declining) and busy times.
 * Tokens are sealed with a data key wrapped by the key provider (KMS in AWS); no token, event title
 * of other events or provider response body is ever logged or stored in plain text.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { KEY_PROVIDER, generateDek, openSmall, sealSmall } from '../documents/crypto.ts';
import type { KeyProvider } from '../documents/crypto.ts';
import { ProviderError, adaptersFromEnv, pkcePair } from './providers.ts';
import type { ProviderAdapter, Tokens } from './providers.ts';
import { CALENDAR_PROVIDERS } from '../../../../packages/shared/src/calendar/types.ts';
import type { BusyList, CalendarConnection, CalendarProvider } from '../../../../packages/shared/src/calendar/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';

export interface RequestMeta { ip: string | null; userAgent: string | null }

interface ConnRow {
  id: string; org_id: string; user_id: string; provider: CalendarProvider; account_email: string | null; tokens_enc: Buffer; key_wrapped: Buffer; key_id: string;
  expires_at: Date; status: 'ACTIVE' | 'ERROR'; last_sync_at: Date | null; last_error: string | null;
}
interface SealedTokens { accessToken: string; refreshToken: string | null }

const HORIZON_DAYS = 60;
const BUSY_DAYS = 14;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const webUrl = () => (process.env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');

@Injectable()
export class CalendarService {
  private readonly adapters: Record<CalendarProvider, ProviderAdapter>;

  constructor(private readonly prisma: PrismaService, @Inject(KEY_PROVIDER) private readonly keys: KeyProvider) {
    this.adapters = adaptersFromEnv();
  }

  /** Tests swap in adapters pointed at local fakes. */
  setAdapters(a: Record<CalendarProvider, ProviderAdapter>): void {
    Object.assign(this.adapters, a);
  }

  // ------------------------------------------------------------------ tokens at rest

  private async seal(orgId: string, connectionId: string, t: SealedTokens): Promise<{ tokens_enc: Buffer; key_wrapped: Buffer; key_id: string }> {
    const dek = generateDek();
    try {
      const w = await this.keys.wrap(dek, { orgId, documentId: connectionId, purpose: 'calendar' });
      return { tokens_enc: sealSmall(dek, JSON.stringify(t)), key_wrapped: w.wrapped, key_id: w.keyId };
    } finally {
      dek.fill(0);
    }
  }

  private async open(c: ConnRow): Promise<SealedTokens> {
    const dek = await this.keys.unwrap(c.key_wrapped, c.key_id, { orgId: c.org_id, documentId: c.id, purpose: 'calendar' });
    try {
      return JSON.parse(openSmall(dek, c.tokens_enc)) as SealedTokens;
    } finally {
      dek.fill(0);
    }
  }

  // ------------------------------------------------------------------ connect / disconnect

  async list(user: AuthenticatedUser): Promise<{ items: CalendarConnection[] }> {
    const rows = await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<ConnRow>(`SELECT * FROM calendar_connections WHERE user_id = $1`, [user.id])).rows);
    return {
      items: CALENDAR_PROVIDERS.map((provider) => {
        const r = rows.find((x) => x.provider === provider);
        return {
          provider, available: this.adapters[provider].configured, connected: !!r, accountEmail: r?.account_email ?? null,
          status: r ? r.status : 'NONE', lastSyncAt: r?.last_sync_at?.toISOString() ?? null, lastError: r?.last_error ?? null,
        };
      }),
    };
  }

  /** The URL to send the browser to. `state` is random, stored hashed, single use, 10 minutes. */
  async start(user: AuthenticatedUser, provider: CalendarProvider): Promise<{ authorizeUrl: string }> {
    const a = this.adapters[provider];
    if (!a.configured) throw new ConflictException(`${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} calendar sync is not set up on this server`);
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkcePair();
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`DELETE FROM calendar_oauth_states WHERE user_id = $1 OR expires_at < now()`, [user.id]);
      await db.query(`INSERT INTO calendar_oauth_states (org_id, user_id, provider, state_hash, verifier, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes', now())`,
        [user.orgId, user.id, provider, sha256(state), verifier]);
    });
    return { authorizeUrl: a.authorizeUrl(state, challenge) };
  }

  /** The provider's redirect (no session): returns where to send the browser next. */
  async callback(q: { code?: string; state?: string; error?: string }, meta: RequestMeta): Promise<string> {
    const back = (r: string) => `${webUrl()}/account/calendar?${r}`;
    if (!q.state || !/^[A-Za-z0-9_-]{20,100}$/.test(q.state)) return back('error=invalid_state');
    const s = (await this.prisma.getPool().query<{ id: string; org_id: string; user_id: string; provider: CalendarProvider; verifier: string; expires_at: Date }>(
      `SELECT * FROM fn_lookup_calendar_state($1)`, [sha256(q.state)])).rows[0];
    if (!s) return back('error=invalid_state');
    await this.prisma.runWithTenantContext(s.org_id, (db) => db.query(`DELETE FROM calendar_oauth_states WHERE id = $1`, [s.id]));
    if (s.expires_at.getTime() < Date.now()) return back('error=expired');
    if (q.error || !q.code) return back(`error=${q.error === 'access_denied' ? 'denied' : 'failed'}`);
    let tokens: Tokens;
    try {
      tokens = await this.adapters[s.provider].exchangeCode(q.code, s.verifier);
    } catch {
      return back('error=failed');
    }
    if (!tokens.refreshToken) return back('error=no_offline_access');
    await this.prisma.runWithTenantContext(s.org_id, async (db) => {
      const existing = (await db.query<{ id: string }>(`SELECT id FROM calendar_connections WHERE user_id = $1 AND provider = $2`, [s.user_id, s.provider])).rows[0];
      const id = existing?.id ?? (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      const sealed = await this.seal(s.org_id, id, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      await db.query(
        `INSERT INTO calendar_connections (id, org_id, user_id, provider, account_email, tokens_enc, key_wrapped, key_id, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')
         ON CONFLICT (org_id, user_id, provider) DO UPDATE SET account_email = EXCLUDED.account_email, tokens_enc = EXCLUDED.tokens_enc,
           key_wrapped = EXCLUDED.key_wrapped, key_id = EXCLUDED.key_id, expires_at = EXCLUDED.expires_at, status = 'ACTIVE', last_error = NULL, updated_at = now()`,
        [id, s.org_id, s.user_id, s.provider, tokens.accountEmail, sealed.tokens_enc, sealed.key_wrapped, sealed.key_id, tokens.expiresAt],
      );
      await appendAuditEntry(db, { orgId: s.org_id, actorId: s.user_id, action: 'CALENDAR_CONNECTED', entityType: 'CALENDAR_CONNECTION', entityId: id,
        after: { provider: s.provider, accountEmail: tokens.accountEmail }, ip: meta.ip ?? undefined, userAgent: meta.userAgent ?? undefined });
    });
    return back(`connected=${s.provider}`);
  }

  async disconnect(user: AuthenticatedUser, provider: CalendarProvider, meta: RequestMeta): Promise<{ ok: true }> {
    const c = await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<ConnRow>(`SELECT * FROM calendar_connections WHERE user_id = $1 AND provider = $2`, [user.id, provider])).rows[0]);
    if (!c) throw new NotFoundException('Not connected');
    // Best effort: take our upcoming meetings out of their calendar and release the grant.
    try {
      const token = await this.accessToken(c);
      const links = await this.prisma.runWithTenantContext(user.orgId, async (db) => (await db.query<{ external_id: string }>(
        `SELECT l.external_id FROM calendar_event_links l JOIN meetings m ON m.id = l.meeting_id WHERE l.user_id = $1 AND l.provider = $2 AND m.scheduled_end > now()`, [user.id, provider])).rows);
      for (const l of links) await this.adapters[provider].remove(token, l.external_id).catch(() => undefined);
      const t = await this.open(c);
      if (t.refreshToken) await this.adapters[provider].revoke(t.refreshToken);
    } catch { /* the provider may already have revoked us */ }
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`DELETE FROM calendar_event_links WHERE user_id = $1 AND provider = $2`, [user.id, provider]);
      await db.query(`DELETE FROM calendar_busy WHERE user_id = $1 AND provider = $2`, [user.id, provider]);
      await db.query(`DELETE FROM calendar_connections WHERE id = $1`, [c.id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'CALENDAR_DISCONNECTED', entityType: 'CALENDAR_CONNECTION', entityId: c.id,
        after: { provider }, ip: meta.ip ?? undefined, userAgent: meta.userAgent ?? undefined });
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ sync

  /** A valid access token, refreshed (and re-sealed) when it is about to expire. */
  private async accessToken(c: ConnRow): Promise<string> {
    const t = await this.open(c);
    if (c.expires_at.getTime() > Date.now() + 60_000) return t.accessToken;
    if (!t.refreshToken) throw new ProviderError(401, 'No refresh token');
    const fresh = await this.adapters[c.provider].refresh(t.refreshToken);
    const sealed = await this.seal(c.org_id, c.id, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
    await this.prisma.runWithTenantContext(c.org_id, (db) => db.query(
      `UPDATE calendar_connections SET tokens_enc = $2, key_wrapped = $3, key_id = $4, expires_at = $5, updated_at = now() WHERE id = $1`,
      [c.id, sealed.tokens_enc, sealed.key_wrapped, sealed.key_id, fresh.expiresAt]));
    return fresh.accessToken;
  }

  async syncUser(user: AuthenticatedUser): Promise<{ items: CalendarConnection[] }> {
    const rows = await this.prisma.runWithTenantContext(user.orgId, async (db) => (await db.query<ConnRow>(`SELECT * FROM calendar_connections WHERE user_id = $1`, [user.id])).rows);
    for (const c of rows) await this.syncConnection(c);
    return await this.list(user);
  }

  /** Job entry (every 5 minutes): every connection of every organisation. */
  async syncAll(): Promise<number> {
    const orgs = (await this.prisma.getPool().query<{ id: string }>(`SELECT id FROM fn_list_orgs_for_jobs()`)).rows;
    let n = 0;
    for (const o of orgs) {
      const rows = await this.prisma.runWithTenantContext(o.id, async (db) => (await db.query<ConnRow>(`SELECT * FROM calendar_connections`)).rows);
      for (const c of rows) { await this.syncConnection(c); n += 1; }
    }
    return n;
  }

  private async syncConnection(c: ConnRow): Promise<void> {
    const a = this.adapters[c.provider];
    if (!a.configured) return;
    try {
      const token = await this.accessToken(c);
      await this.prisma.runWithTenantContext(c.org_id, async (db) => {
        const me = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [c.user_id])).rows[0]!;
        const selfEmail = c.account_email ?? me.email;
        await this.pushMeetings(db, c, a, token, selfEmail);
        await this.pullResponses(db, c, a, token, selfEmail);
        await this.pullBusy(db, c, a, token);
        await db.query(`UPDATE calendar_connections SET last_sync_at = now(), status = 'ACTIVE', last_error = NULL WHERE id = $1`, [c.id]);
      });
    } catch (err) {
      const reconnect = err instanceof ProviderError && (err.status === 400 || err.status === 401 || err.status === 403);
      const message = reconnect ? 'Access was revoked or expired. Connect the calendar again.' : 'Sync failed; it will be retried.';
      await this.prisma.runWithTenantContext(c.org_id, (db) => db.query(
        `UPDATE calendar_connections SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [c.id, reconnect ? 'ERROR' : c.status, message]));
    }
  }

  /** Upcoming scheduled meetings this person hosts or attends (not declined) vs what is in their calendar. */
  private async pushMeetings(db: pg.PoolClient, c: ConnRow, a: ProviderAdapter, token: string, selfEmail: string): Promise<void> {
    const wanted = (await db.query<{ id: string; title: string; agenda: string; scheduled_start: Date; scheduled_end: Date; ics_sequence: number; host_email: string }>(
      `SELECT m.id, m.title, m.agenda, m.scheduled_start, m.scheduled_end, m.ics_sequence, h.email AS host_email
       FROM meetings m JOIN users h ON h.id = m.host_id
       WHERE m.type = 'SCHEDULED' AND m.status IN ('SCHEDULED', 'LIVE') AND m.scheduled_end > now() AND m.scheduled_start < now() + ($2 || ' days')::interval
         AND (m.host_id = $1 OR EXISTS (SELECT 1 FROM meeting_attendees x WHERE x.meeting_id = m.id AND x.user_id = $1 AND x.response <> 'DECLINED'))`,
      [c.user_id, String(HORIZON_DAYS)])).rows;
    const links = new Map((await db.query<{ meeting_id: string; external_id: string; synced_sequence: number }>(
      `SELECT meeting_id, external_id, synced_sequence FROM calendar_event_links WHERE user_id = $1 AND provider = $2`, [c.user_id, c.provider])).rows.map((l) => [l.meeting_id, l]));
    for (const m of wanted) {
      const link = links.get(m.id);
      links.delete(m.id);
      if (link && link.synced_sequence >= m.ics_sequence) continue;
      const externalId = await a.upsert(token, link?.external_id ?? null, {
        uid: `${m.id}@hrvo`, sequence: m.ics_sequence, title: m.title, description: m.agenda, start: m.scheduled_start, end: m.scheduled_end,
        organizerEmail: m.host_email, selfEmail, joinUrl: `${webUrl()}/meetings/${m.id}`,
      });
      await db.query(
        `INSERT INTO calendar_event_links (org_id, meeting_id, user_id, provider, external_id, synced_sequence) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (meeting_id, user_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id, synced_sequence = EXCLUDED.synced_sequence, updated_at = now()`,
        [c.org_id, m.id, c.user_id, c.provider, externalId, m.ics_sequence]);
    }
    // No longer wanted: cancelled, declined, or the person was removed. Still-upcoming ones leave
    // their calendar; past ones stay there as history. Either way the link goes.
    for (const [meetingId, l] of links) {
      const upcoming = (await db.query(`SELECT 1 FROM meetings WHERE id = $1 AND scheduled_end > now()`, [meetingId])).rowCount;
      if (upcoming) await a.remove(token, l.external_id);
      await db.query(`DELETE FROM calendar_event_links WHERE meeting_id = $1 AND user_id = $2 AND provider = $3`, [meetingId, c.user_id, c.provider]);
    }
  }

  /** Their answer in their calendar becomes their answer here (attendees only; hosts do not RSVP). */
  private async pullResponses(db: pg.PoolClient, c: ConnRow, a: ProviderAdapter, token: string, selfEmail: string): Promise<void> {
    const links = (await db.query<{ meeting_id: string; external_id: string; last_response: string | null; response: string; title: string }>(
      `SELECT l.meeting_id, l.external_id, l.last_response, x.response, m.title
       FROM calendar_event_links l JOIN meetings m ON m.id = l.meeting_id
       JOIN meeting_attendees x ON x.meeting_id = l.meeting_id AND x.user_id = l.user_id
       WHERE l.user_id = $1 AND l.provider = $2 AND m.scheduled_end > now() AND m.status IN ('SCHEDULED', 'LIVE')`, [c.user_id, c.provider])).rows;
    for (const l of links) {
      const seen = (await a.response(token, l.external_id, selfEmail)) ?? 'DECLINED';
      if (seen === l.last_response) continue;
      await db.query(`UPDATE calendar_event_links SET last_response = $4, updated_at = now() WHERE meeting_id = $1 AND user_id = $2 AND provider = $3`, [l.meeting_id, c.user_id, c.provider, seen]);
      if (seen !== 'NEEDS_ACTION' && seen !== l.response) {
        await db.query(`UPDATE meeting_attendees SET response = $3 WHERE meeting_id = $1 AND user_id = $2`, [l.meeting_id, c.user_id, seen]);
        await appendAuditEntry(db, { orgId: c.org_id, actorId: c.user_id, action: seen === 'ACCEPTED' ? 'MEETING_ACCEPTED' : 'MEETING_DECLINED', entityType: 'MEETING', entityId: l.meeting_id, after: { via: c.provider } });
      }
    }
  }

  private async pullBusy(db: pg.PoolClient, c: ConnRow, a: ProviderAdapter, token: string): Promise<void> {
    const from = new Date();
    const to = new Date(from.getTime() + BUSY_DAYS * 86_400_000);
    const blocks = (await a.busy(token, from, to)).filter((b) => b.end > b.start).slice(0, 500);
    await db.query(`DELETE FROM calendar_busy WHERE user_id = $1 AND provider = $2`, [c.user_id, c.provider]);
    for (const b of blocks) {
      await db.query(`INSERT INTO calendar_busy (org_id, user_id, provider, start_at, end_at) VALUES ($1, $2, $3, $4, $5)`, [c.org_id, c.user_id, c.provider, b.start, b.end]);
    }
  }

  /** Busy blocks of colleagues for the scheduling form: times only, never what they are. */
  async busy(user: AuthenticatedUser, userIds: string[], from: Date, to: Date): Promise<BusyList> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => ({
      items: (await db.query<{ user_id: string; start_at: Date; end_at: Date }>(
        `SELECT user_id, start_at, end_at FROM calendar_busy WHERE user_id = ANY($1::uuid[]) AND end_at > $2 AND start_at < $3 ORDER BY start_at`,
        [userIds, from, to])).rows.map((r) => ({ userId: r.user_id, start: r.start_at.toISOString(), end: r.end_at.toISOString() })),
    }));
  }
}
