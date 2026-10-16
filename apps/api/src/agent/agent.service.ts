/**
 * Desktop agent: pairing, device sessions, devices and offline sync (FR-ATT-011, FR-ATT-012; ADR 018).
 */
import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { getJwtSecret } from '../common/config.ts';
import { AuthService } from '../auth/auth.service.ts';
import { AttendanceService } from '../attendance/attendance.service.ts';
import { anchorKey, verifyAnchor } from './offline-sync.ts';
import { CONSENT_NOTICES, PAIRING_ALPHABET, PAIRING_TTL_SECONDS, Permission, userCan } from '../../../../packages/shared/src/index.ts';
import type {
  AgentDevice, AgentSession, AuthenticatedUser, OfflineSyncDto, OfflineSyncResult, PairDto, PairingCode,
} from '../../../../packages/shared/src/index.ts';

export interface RequestContext { ip: string | null; userAgent: string | null }

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** XXXX-XXXX from an unambiguous alphabet; the stored hash ignores the dash. */
const normalise = (code: string) => code.replace('-', '').toUpperCase();

interface DeviceRow { id: string; name: string; platform: AgentDevice['platform']; agent_version: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null; user_id: string; family_id: string }
const toDevice = (r: DeviceRow): AgentDevice => ({
  id: r.id, name: r.name, platform: r.platform, agentVersion: r.agent_version, createdAt: r.created_at.toISOString(),
  lastSeenAt: r.last_seen_at?.toISOString() ?? null, revokedAt: r.revoked_at?.toISOString() ?? null,
});

@Injectable()
export class AgentService {
  private readonly key = anchorKey(getJwtSecret());

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly attendance: AttendanceService,
  ) {}

  /** The text the agent shows on its consent screen before pairing. */
  notice() {
    return { desktopAgent: CONSENT_NOTICES.DESKTOP_AGENT, monitoring: CONSENT_NOTICES.MONITORING };
  }

  /** Signed-in web user: a one-time code, valid 5 minutes. Earlier unused codes are dropped. */
  async createPairingCode(user: AuthenticatedUser, ctx: RequestContext): Promise<PairingCode> {
    const raw = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000);
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(`DELETE FROM agent_pairing_codes WHERE user_id = $1 AND (used_at IS NULL OR expires_at < now() - interval '1 day')`, [user.id]);
      const r = await db.query<{ id: string }>(
        `INSERT INTO agent_pairing_codes (org_id, user_id, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [user.orgId, user.id, sha256(raw), expiresAt],
      );
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'AGENT_PAIRING_CODE_CREATED', entityType: 'AGENT_PAIRING', entityId: r.rows[0]!.id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
    });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: expiresAt.toISOString() };
  }

  /** Unauthenticated: the agent redeems a code with the user's explicit consent and gets its own session. */
  async pair(dto: PairDto, ctx: RequestContext): Promise<AgentSession> {
    if (dto.consentNoticeVersion !== CONSENT_NOTICES.DESKTOP_AGENT.version) {
      throw new ConflictException('The consent notice has changed. Restart the agent and read the current notice.');
    }
    const hash = sha256(normalise(dto.code));
    const found = (await this.prisma.getPool().query<{ id: string; org_id: string; user_id: string; expires_at: Date; used_at: Date | null; user_status: string; email: string; display_name: string | null; role: string; team_id: string | null }>(
      `SELECT * FROM fn_lookup_agent_pairing($1)`, [hash],
    )).rows[0];
    // One message for every failure so codes cannot be probed.
    const invalid = () => new UnauthorizedException('This code is not valid or has expired. Create a new one in the web app.');
    if (!found || found.used_at || found.expires_at.getTime() < Date.now() || found.user_status !== 'ACTIVE') throw invalid();
    return await this.prisma.runWithTenantContext(found.org_id, async (db) => {
      const claim = await db.query(`UPDATE agent_pairing_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id`, [found.id]);
      if (!claim.rowCount) throw invalid();
      const user = { id: found.user_id, org_id: found.org_id, email: found.email, display_name: found.display_name, role: found.role, team_id: found.team_id };
      const s = await this.auth.issueAgentSession(db, user, { ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      const dev = await db.query<{ id: string }>(
        `INSERT INTO agent_devices (org_id, user_id, family_id, name, platform, agent_version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [found.org_id, found.user_id, s.familyId, dto.deviceName, dto.platform, dto.agentVersion],
      );
      const deviceId = dev.rows[0]!.id;
      const consent = await db.query<{ id: string }>(
        `INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at, ip, user_agent)
         VALUES ($1, $2, $3, 'DESKTOP_AGENT', true, now(), $4, $5) RETURNING id`,
        [found.org_id, found.user_id, dto.consentNoticeVersion, ctx.ip, ctx.userAgent],
      );
      const meta = { ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined };
      await appendAuditEntry(db, { orgId: found.org_id, actorId: found.user_id, action: 'CONSENT_GIVEN', entityType: 'CONSENT', entityId: consent.rows[0]!.id, after: { type: 'DESKTOP_AGENT', noticeVersion: dto.consentNoticeVersion, granted: true }, ...meta });
      await appendAuditEntry(db, { orgId: found.org_id, actorId: found.user_id, action: 'AGENT_PAIRED', entityType: 'AGENT_DEVICE', entityId: deviceId, after: { name: dto.deviceName, platform: dto.platform, agentVersion: dto.agentVersion }, ...meta });
      return {
        deviceId, accessToken: s.accessToken, refreshToken: s.refreshToken, sessionId: s.sessionId, sessionSecret: s.sessionSecret,
        user: { id: s.user.id, orgId: s.user.orgId, email: s.user.email, displayName: s.user.displayName },
      };
    });
  }

  /** Unauthenticated: rotate the agent's refresh token. Only works for the device's own session family. */
  async token(deviceId: string, refreshToken: string, ctx: RequestContext): Promise<AgentSession> {
    const r = await this.auth.refresh(refreshToken, ctx.ip ?? undefined, ctx.userAgent ?? undefined);
    const ok = await this.prisma.runWithTenantContext(r.user.orgId, async (db) =>
      (await db.query(`SELECT 1 FROM agent_devices WHERE id = $1 AND family_id = $2 AND revoked_at IS NULL`, [deviceId, r.familyId])).rowCount);
    if (!ok) {
      // A web refresh token, or a revoked device: the new session must not survive.
      await this.prisma.runWithTenantContext(r.user.orgId, (db) => this.auth.revokeFamily(db, r.user.orgId, r.familyId));
      throw new UnauthorizedException('This device is not paired. Pair it again from the web app.');
    }
    return {
      deviceId, accessToken: r.accessToken, refreshToken: r.refreshToken, sessionId: r.sessionId, sessionSecret: r.sessionSecret,
      user: { id: r.user.id, orgId: r.user.orgId, email: r.user.email, displayName: r.user.displayName },
    };
  }

  async devices(user: AuthenticatedUser): Promise<{ items: AgentDevice[] }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => ({
      items: (await db.query<DeviceRow>(`SELECT * FROM agent_devices WHERE user_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`, [user.id])).rows.map(toDevice),
    }));
  }

  /** Your own device; org.manage may revoke anyone's. Revoking ends its session family at once. */
  async revoke(user: AuthenticatedUser, deviceId: string, ctx: RequestContext): Promise<AgentDevice> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const d = (await db.query<DeviceRow>(`SELECT * FROM agent_devices WHERE id = $1 FOR UPDATE`, [deviceId])).rows[0];
      if (!d || (d.user_id !== user.id && !userCan(user, Permission.ORG_MANAGE))) throw new NotFoundException('Device not found');
      if (d.revoked_at) return toDevice(d);
      return toDevice(await this.revokeRow(db, user, d, ctx));
    });
  }

  /** Withdrawing the DESKTOP_AGENT consent revokes every agent of that user (called by ConsentsService). */
  async revokeAllForUser(db: pg.PoolClient, user: AuthenticatedUser, ctx: RequestContext): Promise<number> {
    const rows = (await db.query<DeviceRow>(`SELECT * FROM agent_devices WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE`, [user.id])).rows;
    for (const d of rows) await this.revokeRow(db, user, d, ctx);
    return rows.length;
  }

  private async revokeRow(db: pg.PoolClient, user: AuthenticatedUser, d: DeviceRow, ctx: RequestContext): Promise<DeviceRow> {
    const r = (await db.query<DeviceRow>(`UPDATE agent_devices SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *`, [d.id, user.id])).rows[0]!;
    await this.auth.revokeFamily(db, user.orgId, d.family_id);
    // A revoked agent stops leading the counters at once (not only after the 90 s liveness window).
    await db.query(`UPDATE attendance_sessions SET agent_last_seen_at = NULL WHERE agent_device_id = $1 AND status = 'OPEN'`, [d.id]);
    await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'AGENT_REVOKED', entityType: 'AGENT_DEVICE', entityId: d.id, after: { owner: d.user_id }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
    return r;
  }

  /** The agent session behind an access token, or 403 (a browser cannot upload offline time). */
  private async deviceOf(user: AuthenticatedUser): Promise<string> {
    if (!user.sessionId) throw new ForbiddenException('Offline sync is only available to the desktop agent');
    const id = await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<{ id: string }>(
        `SELECT d.id FROM agent_devices d JOIN auth_sessions s ON s.family_id = d.family_id
         WHERE s.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL`, [user.sessionId, user.id])).rows[0]?.id);
    if (!id) throw new ForbiddenException('Offline sync is only available to the desktop agent');
    return id;
  }

  /** FR-ATT-012: apply a buffered offline batch once; flags OFFLINE_SYNCED for review. */
  async offlineSync(user: AuthenticatedUser, dto: OfflineSyncDto, ctx: RequestContext): Promise<OfflineSyncResult> {
    const deviceId = await this.deviceOf(user);
    const prior = await this.prisma.runWithTenantContext(user.orgId, async (db) =>
      (await db.query<{ accepted: number; rejected: Record<string, number>; session_ids: string[]; device_id: string }>(
        `SELECT accepted, rejected, session_ids, device_id FROM offline_sync_batches WHERE id = $1`, [dto.batchId])).rows[0]);
    if (prior) {
      if (prior.device_id !== deviceId) throw new ConflictException('This batch id is already used');
      return { batchId: dto.batchId, accepted: prior.accepted, rejected: prior.rejected, sessionIds: prior.session_ids, duplicate: true };
    }
    if (!verifyAnchor(this.key, { orgId: user.orgId, userId: user.id, deviceId }, dto.anchor.serverTimeMs, dto.anchor.signature)) {
      throw new BadRequestException('The time anchor is not valid for this device');
    }
    if (dto.anchor.serverTimeMs > Date.now()) throw new GoneException('The time anchor is in the future');
    const { plan, sessionIds } = await this.attendance.applyOfflineSync({
      orgId: user.orgId, userId: user.id, deviceId, anchorServerMs: dto.anchor.serverTimeMs, intervals: dto.intervals, ip: ctx.ip ?? '0.0.0.0',
    });
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      await db.query(
        `INSERT INTO offline_sync_batches (id, org_id, user_id, device_id, anchor_at, accepted, rejected, session_ids) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [dto.batchId, user.orgId, user.id, deviceId, new Date(dto.anchor.serverTimeMs), plan.accepted, JSON.stringify(plan.rejected), sessionIds],
      );
      await appendAuditEntry(db, {
        orgId: user.orgId, actorId: user.id, action: 'OFFLINE_SYNC_APPLIED', entityType: 'AGENT_DEVICE', entityId: deviceId,
        after: { batchId: dto.batchId, accepted: plan.accepted, rejected: plan.rejected, sessions: sessionIds.length }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined,
      });
    });
    return { batchId: dto.batchId, accepted: plan.accepted, rejected: plan.rejected, sessionIds, duplicate: false };
  }
}
