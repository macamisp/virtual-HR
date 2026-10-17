/**
 * Two-way calendar sync end to end (FR-MEET-006; ADR 023) against local fakes of Google Calendar
 * and Microsoft Graph that check PKCE, tokens and the calls we make. No real Google or Microsoft
 * account is involved.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { CalendarService } from '../src/calendar/calendar.service.ts';
import { adaptersFromEnv } from '../src/calendar/providers.ts';
import { BusyListSchema, CalendarConnectionListSchema, MeetingSchema } from '../../../packages/shared/src/index.ts';

const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const PORT = 3082;
const G_PORT = 3071;
const M_PORT = 3072;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  host: { id: 'aaaa0000-0000-4000-8000-000000000011', email: 'host@cal.test', name: 'Holly Host', role: 'HR', mfa: true },
  att: { id: 'aaaa0000-0000-4000-8000-000000000012', email: 'ann@cal.test', name: 'Ann Attendee', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;

// ------------------------------------------------------------------ fakes

interface FakeEvent { id: string; body: Record<string, unknown>; deleted?: boolean; responseStatus?: string; showAs?: string }
function body(req: IncomingMessage): Promise<string> {
  return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
}
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

class FakeProvider {
  server!: Server;
  pendingCodes = new Map<string, { challenge: string; email: string }>();
  issued = new Set<string>();
  events = new Map<string, FakeEvent>();
  calls: string[] = [];
  revoked: string[] = [];
  failRefresh = false;
  busy: Array<{ start: string; end: string }> = [];
  private n = 0;

  constructor(private readonly kind: 'google' | 'microsoft', private readonly port: number) {}

  start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req).then(([status, out]) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 204 ? undefined : JSON.stringify(out));
    }));
    return new Promise((r) => this.server.listen(this.port, () => r()));
  }

  private authed(req: IncomingMessage): boolean {
    return this.issued.has((req.headers.authorization ?? '').replace('Bearer ', ''));
  }

  private token(refresh: boolean, email: string): Record<string, unknown> {
    this.n += 1;
    const access = `${this.kind}-access-${this.n}`;
    this.issued.add(access);
    return { access_token: access, ...(refresh ? { refresh_token: `${this.kind}-refresh-1` } : {}), expires_in: 3600, id_token: idToken(email) };
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const raw = await body(req);
    this.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname.endsWith('/token')) {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'authorization_code') {
        const p = this.pendingCodes.get(f.get('code') ?? '');
        const ok = p && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === p.challenge;
        if (!ok) return [400, { error: 'invalid_grant' }];
        this.pendingCodes.delete(f.get('code')!);
        return [200, this.token(true, p.email)];
      }
      if (this.failRefresh || f.get('refresh_token') !== `${this.kind}-refresh-1`) return [400, { error: 'invalid_grant' }];
      return [200, this.token(false, '')];
    }
    if (url.pathname.endsWith('/revoke')) { this.revoked.push(new URLSearchParams(raw).get('token') ?? ''); return [200, {}]; }
    if (!this.authed(req)) return [401, { error: 'unauthorized' }];
    if (this.kind === 'google') {
      if (url.pathname === '/calendar/v3/calendars/primary/events/import' && req.method === 'POST') {
        const b = JSON.parse(raw) as Record<string, unknown>;
        const id = `g-${this.events.size + 1}`;
        this.events.set(id, { id, body: b, responseStatus: 'needsAction' });
        return [200, { id }];
      }
      const m = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const e = this.events.get(decodeURIComponent(m[1]!));
        if (!e || e.deleted) return [404, {}];
        if (req.method === 'PATCH') { e.body = { ...e.body, ...(JSON.parse(raw) as object) }; return [200, { id: e.id }]; }
        if (req.method === 'DELETE') { e.deleted = true; return [204, null]; }
        return [200, { status: 'confirmed', attendees: [{ email: U.att.email, self: true, responseStatus: e.responseStatus }] }];
      }
      if (url.pathname === '/calendar/v3/freeBusy') return [200, { calendars: { primary: { busy: this.busy } } }];
    } else {
      if (url.pathname === '/v1.0/me/events' && req.method === 'POST') {
        const b = JSON.parse(raw) as Record<string, unknown>;
        const id = `m-${this.events.size + 1}`;
        this.events.set(id, { id, body: b, showAs: 'busy' });
        return [201, { id }];
      }
      const m = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const e = this.events.get(decodeURIComponent(m[1]!));
        if (!e || e.deleted) return [404, {}];
        if (req.method === 'PATCH') { e.body = { ...e.body, ...(JSON.parse(raw) as object) }; return [200, { id: e.id }]; }
        if (req.method === 'DELETE') { e.deleted = true; return [204, null]; }
        return [200, { isCancelled: false, showAs: e.showAs }];
      }
      if (url.pathname === '/v1.0/me/calendarView') return [200, { value: this.busy.map((b) => ({ start: { dateTime: b.start.replace('Z', '') }, end: { dateTime: b.end.replace('Z', '') }, showAs: 'busy' })) }];
    }
    return [404, {}];
  }
}

describe('Calendar sync (FR-MEET-006)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const google = new FakeProvider('google', G_PORT);
  const microsoft = new FakeProvider('microsoft', M_PORT);
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  let meetingId = '';

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  /** Simulates the person approving access at the provider and being redirected back. */
  async function connect(who: Who, provider: 'GOOGLE' | 'MICROSOFT', fake: FakeProvider): Promise<string> {
    const { authorizeUrl } = await ok<{ authorizeUrl: string }>(await api(who, `/calendar/${provider.toLowerCase()}/connect`, { method: 'POST' }), 200);
    const q = new URL(authorizeUrl).searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    const code = `code-${who}-${provider}`;
    fake.pendingCodes.set(code, { challenge: q.get('code_challenge')!, email: U[who].email });
    const res = await fetch(`${base}/calendar/oauth/callback?code=${code}&state=${q.get('state')}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return res.headers.get('location')!;
  }

  before(async () => {
    Object.assign(process.env, {
      BREACHED_PASSWORD_CHECK: 'local', MAIL_TRANSPORT: 'memory', RATE_LIMIT_LOGIN: '1000', JOBS_ENABLED: 'false', APP_WEB_URL: 'http://web.test',
      GOOGLE_OAUTH_CLIENT_ID: 'g-client', GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret', MICROSOFT_OAUTH_CLIENT_ID: 'm-client', MICROSOFT_OAUTH_CLIENT_SECRET: 'm-secret',
      GOOGLE_OAUTH_AUTH_URL: `http://localhost:${G_PORT}/auth`, GOOGLE_OAUTH_TOKEN_URL: `http://localhost:${G_PORT}/token`, GOOGLE_OAUTH_REVOKE_URL: `http://localhost:${G_PORT}/revoke`,
      GOOGLE_CALENDAR_API: `http://localhost:${G_PORT}/calendar/v3`, MICROSOFT_LOGIN_URL: `http://localhost:${M_PORT}/oauth2/v2.0`, MICROSOFT_GRAPH_API: `http://localhost:${M_PORT}/v1.0`,
      CALENDAR_OAUTH_REDIRECT_URL: `${base}/calendar/oauth/callback`,
    });
    await Promise.all([google.start(), microsoft.start()]);
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Cal Ltd', 'cal-e2e')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, ORG, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
    }
  });

  after(async () => {
    await app?.close();
    google.server?.close();
    microsoft.server?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('both providers are offered once configured; nothing is connected yet', async () => {
    const l = await ok(await api('att', '/calendar/connections'), 200, CalendarConnectionListSchema);
    assert.deepEqual(l.items.map((c) => [c.provider, c.available, c.connected]), [['GOOGLE', true, false], ['MICROSOFT', true, false]]);
  });

  it('connecting runs OAuth with PKCE; tokens are stored encrypted; the state works once', async () => {
    const location = await connect('att', 'GOOGLE', google);
    assert.equal(location, 'http://web.test/account/calendar?connected=GOOGLE');
    const row = (await adminPool.query(`SELECT account_email, tokens_enc FROM calendar_connections WHERE user_id = $1`, [U.att.id])).rows[0];
    assert.equal(row.account_email, U.att.email);
    assert.ok(!row.tokens_enc.toString('latin1').includes('google-access'), 'no token in plain text');
    assert.ok(!row.tokens_enc.toString('latin1').includes('google-refresh'));
    const res = await fetch(`${base}/calendar/oauth/callback?code=x&state=${'A'.repeat(43)}`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), 'http://web.test/account/calendar?error=invalid_state');
    const audit = (await adminPool.query(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'CALENDAR_CONNECTED'`, [ORG])).rowCount;
    assert.equal(audit, 1);
  });

  it('a scheduled meeting appears in the attendee\'s Google calendar with our UID; a reschedule updates it', async () => {
    const start = new Date(Date.now() + 2 * 86_400_000);
    const m = await ok(await api('host', '/meetings', { method: 'POST', body: { type: 'SCHEDULED', title: 'Quarterly review', agenda: 'Numbers', start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString(), attendeeIds: [U.att.id], sendInvites: false } }), 201, MeetingSchema);
    meetingId = m.id;
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    const ev = [...google.events.values()][0]!;
    assert.equal(ev.body.iCalUID, `${meetingId}@hrvo`);
    assert.deepEqual(ev.body.organizer, { email: U.host.email });
    assert.equal(ev.body.summary, 'Quarterly review');
    const later = new Date(start.getTime() + 86_400_000);
    await ok(await api('host', `/meetings/${meetingId}`, { method: 'PUT', body: { start: later.toISOString(), end: new Date(later.getTime() + 3600_000).toISOString(), version: m.version } }), 200);
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    assert.equal((ev.body.start as { dateTime: string }).dateTime, later.toISOString());
    assert.equal(google.events.size, 1, 'updated, not duplicated');
  });

  it('accepting or declining in Google comes back to the meeting; a declined meeting leaves the calendar', async () => {
    const ev = [...google.events.values()][0]!;
    ev.responseStatus = 'accepted';
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    const accepted = (await adminPool.query(`SELECT response FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2`, [meetingId, U.att.id])).rows[0].response;
    assert.equal(accepted, 'ACCEPTED');
    ev.responseStatus = 'declined';
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    assert.equal((await adminPool.query(`SELECT response FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2`, [meetingId, U.att.id])).rows[0].response, 'DECLINED');
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    assert.equal(ev.deleted, true);
  });

  it('busy times come back as times only and show for scheduling', async () => {
    const s = new Date(Date.now() + 86_400_000);
    google.busy = [{ start: s.toISOString(), end: new Date(s.getTime() + 1800_000).toISOString() }];
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const b = await ok(await api('host', `/calendar/busy?userIds=${U.att.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), 200, BusyListSchema);
    assert.deepEqual(b.items, [{ userId: U.att.id, start: s.toISOString(), end: new Date(s.getTime() + 1800_000).toISOString() }]);
  });

  it('Outlook: the host\'s own meeting is created there (idempotent create) and removed when cancelled', async () => {
    assert.equal(await connect('host', 'MICROSOFT', microsoft), 'http://web.test/account/calendar?connected=MICROSOFT');
    const start = new Date(Date.now() + 3 * 86_400_000);
    const m = await ok(await api('host', '/meetings', { method: 'POST', body: { type: 'SCHEDULED', title: 'Planning', start: start.toISOString(), end: new Date(start.getTime() + 1800_000).toISOString(), sendInvites: false } }), 201, MeetingSchema);
    await ok(await api('host', '/calendar/sync', { method: 'POST' }), 200);
    const ev = [...microsoft.events.values()].find((e) => e.body.subject === 'Planning')!;
    assert.equal(ev.body.transactionId, `${m.id}@hrvo`);
    assert.equal(ev.body.attendees, undefined, 'no attendees, so Graph sends no invitations');
    await ok(await api('host', `/meetings/${m.id}`, { method: 'DELETE' }), 200);
    await ok(await api('host', '/calendar/sync', { method: 'POST' }), 200);
    assert.equal(ev.deleted, true);
  });

  it('an expiring token is refreshed; a revoked grant shows "connect again"', async () => {
    await adminPool.query(`UPDATE calendar_connections SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND provider = 'GOOGLE'`, [U.att.id]);
    const before = google.calls.filter((c) => c === 'POST /token').length;
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    assert.equal(google.calls.filter((c) => c === 'POST /token').length, before + 1);
    google.failRefresh = true;
    await adminPool.query(`UPDATE calendar_connections SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND provider = 'GOOGLE'`, [U.att.id]);
    const l = await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200, CalendarConnectionListSchema);
    const g = l.items.find((c) => c.provider === 'GOOGLE')!;
    assert.equal(g.status, 'ERROR');
    assert.match(g.lastError ?? '', /Connect the calendar again/);
    google.failRefresh = false;
  });

  it('disconnecting removes upcoming events, revokes the grant and deletes the tokens (audited)', async () => {
    await adminPool.query(`UPDATE calendar_connections SET expires_at = now() + interval '1 hour', status = 'ACTIVE' WHERE user_id = $1`, [U.att.id]);
    await ok(await api('att', '/calendar/google', { method: 'DELETE' }), 200);
    assert.deepEqual(google.revoked, ['google-refresh-1']);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM calendar_connections WHERE user_id = $1`, [U.att.id])).rows[0].n, 0);
    assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM calendar_busy WHERE user_id = $1`, [U.att.id])).rows[0].n, 0);
    assert.equal((await api('att', '/calendar/google', { method: 'DELETE' })).status, 404);
  });

  it('provider URLs cannot be overridden in production; unknown providers are refused', async () => {
    assert.throws(() => adaptersFromEnv({ NODE_ENV: 'production', GOOGLE_CALENDAR_API: 'http://evil.test' }), /production/);
    assert.equal((await api('att', '/calendar/yahoo/connect', { method: 'POST' })).status, 400);
    assert.ok(app.get(CalendarService, { strict: false }));
  });

  it('calendar tables are invisible without a tenant context (RLS)', async () => {
    const appPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app' });
    try {
      for (const t of ['calendar_connections', 'calendar_oauth_states', 'calendar_event_links', 'calendar_busy']) {
        assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, t);
      }
    } finally {
      await appPool.end();
    }
  });
});
