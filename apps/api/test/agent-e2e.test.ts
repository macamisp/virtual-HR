/**
 * Desktop agent end to end (FR-ATT-011, FR-ATT-012; ADR 018): pairing with explicit consent,
 * device-bound token rotation, agent heartbeats with server-signed anchors, the agent leading the
 * counters next to a browser, offline sync rebuilt from the server anchor (OFFLINE_SYNCED),
 * idempotent batches, revocation (device, consent withdrawal), permissions and RLS.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { generateSync } from 'otplib';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { anchorKey, signAnchor, verifyAnchor } from '../src/agent/offline-sync.ts';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import { AgentDeviceListSchema, AgentSessionSchema, CONSENT_NOTICES, OfflineSyncResultSchema, PairingCodeSchema } from '../../../packages/shared/src/index.ts';
import type { AgentSession, Anchor } from '../../../packages/shared/src/index.ts';

const ORG = 'a6a60000-0000-4000-8000-000000000001';
const PORT = 3086;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  admin: { id: 'a6a60000-0000-4000-8000-000000000011', email: 'admin@agent.test', name: 'Ada Admin', role: 'ADMIN', mfa: true },
  a: { id: 'a6a60000-0000-4000-8000-000000000012', email: 'anna@agent.test', name: 'Anna A', role: 'EMPLOYEE', mfa: false },
  b: { id: 'a6a60000-0000-4000-8000-000000000013', email: 'ben@agent.test', name: 'Ben B', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;
const VERSION = CONSENT_NOTICES.DESKTOP_AGENT.version;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Desktop agent (FR-ATT-011, FR-ATT-012)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  const webSecret = {} as Record<Who, string>;
  const webSession = {} as Record<Who, string>;
  const sockets: Socket[] = [];
  let agent: AgentSession;
  let lastAnchor: Anchor;
  let seq = 0;

  const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) => call(path, { ...init, token: tokens[who] });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  async function pairNew(who: Who = 'a', name = 'Anna laptop'): Promise<AgentSession> {
    const { code } = await ok(await api(who, '/agent/pairing-codes', { method: 'POST' }), 201, PairingCodeSchema);
    return await ok(await call('/agent/pair', { method: 'POST', body: { code, deviceName: name, platform: 'LINUX', agentVersion: '0.1.0', consentNoticeVersion: VERSION } }), 200, AgentSessionSchema);
  }
  function socketFor(token: string): Promise<Socket> {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token } });
    sockets.push(s);
    return new Promise((res, rej) => { s.once('connect', () => res(s)); s.once('connect_error', rej); });
  }
  async function beat(s: Socket, p: { orgId: string; userId: string; deviceId: string; sessionId: string; secret: string; active?: number; idle?: number; inCall?: boolean }) {
    seq += 1;
    const hb = await signHeartbeatPayload({ orgId: p.orgId, userId: p.userId, deviceId: p.deviceId, sessionId: p.sessionId, sequenceNumber: seq, nonce: randomUUID(), activeSeconds: p.active ?? 30, idleSeconds: p.idle ?? 0, tabVisible: true, windowFocused: true, inCall: p.inCall ?? false }, p.secret);
    return (await s.emitWithAck('presence:heartbeat', hb)) as { success: boolean; error?: string; anchor?: Anchor };
  }
  const openSession = async () => (await adminPool.query(`SELECT * FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`, [U.a.id])).rows[0];

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.RATE_LIMIT_AGENT_PAIR = '1000';
    process.env.RATE_LIMIT_AGENT_TOKEN = '1000';
    process.env.RATE_LIMIT_HEARTBEAT = '1000';
    process.env.JOBS_ENABLED = 'false';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Agent Ltd', 'agent-e2e')`, [ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, ORG, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
      // Attendance needs the monitoring notice accepted (FR-ATT-020).
      await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at) VALUES ($1, $2, $3, 'MONITORING', true, now())`, [ORG, u.id, CONSENT_NOTICES.MONITORING.version]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }) });
      const body = (await res.json()) as { accessToken: string; sessionSecret: string; sessionId: string };
      tokens[who] = body.accessToken;
      webSecret[who] = body.sessionSecret;
      webSession[who] = body.sessionId;
    }
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  describe('Pairing with explicit consent', { concurrency: false }, () => {
    it('the notice for the consent screen is public', async () => {
      const n = await ok<{ desktopAgent: { version: string; summary: string } }>(await call('/agent/notice'), 200);
      assert.equal(n.desktopAgent.version, VERSION);
      assert.match(n.desktopAgent.summary, /never reads keystrokes/);
    });

    it('a signed-in user gets an 8-character code valid for 5 minutes; only its hash is stored', async () => {
      const c = await ok(await api('a', '/agent/pairing-codes', { method: 'POST' }), 201, PairingCodeSchema);
      assert.match(c.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const ttl = Date.parse(c.expiresAt) - Date.now();
      assert.ok(ttl > 290_000 && ttl <= 300_000, `ttl ${ttl}`);
      const rows = (await adminPool.query(`SELECT code_hash FROM agent_pairing_codes WHERE user_id = $1`, [U.a.id])).rows;
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].code_hash, c.code.replace('-', ''));
      assert.equal((await call('/agent/pairing-codes', { method: 'POST' })).status, 401, 'signed-in only');
    });

    it('pairing needs the current consent version and a valid, unused, unexpired code', async () => {
      const { code } = await ok(await api('a', '/agent/pairing-codes', { method: 'POST' }), 201, PairingCodeSchema);
      const body = { code, deviceName: 'Anna laptop', platform: 'LINUX', agentVersion: '0.1.0', consentNoticeVersion: VERSION };
      assert.equal((await call('/agent/pair', { method: 'POST', body: { ...body, consentNoticeVersion: 'v0.9' } })).status, 409);
      assert.equal((await call('/agent/pair', { method: 'POST', body: { ...body, code: 'ABCD-EFGH' } })).status, 401);
      assert.equal((await call('/agent/pair', { method: 'POST', body: { ...body, extra: 1 } })).status, 400, 'strict schema');
      agent = await ok(await call('/agent/pair', { method: 'POST', body: { ...body, code: code.toLowerCase().replace('-', '') } }), 200, AgentSessionSchema);
      assert.equal(agent.user.id, U.a.id);
      assert.equal((await call('/agent/pair', { method: 'POST', body })).status, 401, 'a code works once');
      const consent = (await adminPool.query(`SELECT granted, notice_version FROM monitoring_consents WHERE user_id = $1 AND consent_type = 'DESKTOP_AGENT'`, [U.a.id])).rows;
      assert.deepEqual(consent, [{ granted: true, notice_version: VERSION }]);
      const audit = (await adminPool.query(`SELECT action FROM audit_logs WHERE org_id = $1 AND entity_id = $2`, [ORG, agent.deviceId])).rows.map((r) => r.action);
      assert.ok(audit.includes('AGENT_PAIRED'));

      const late = await ok(await api('b', '/agent/pairing-codes', { method: 'POST' }), 201, PairingCodeSchema);
      await adminPool.query(`UPDATE agent_pairing_codes SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE user_id = $1`, [U.b.id]);
      assert.equal((await call('/agent/pair', { method: 'POST', body: { ...body, code: late.code } })).status, 401, 'expired');
    });

    it('the agent rotates its own refresh token; a web refresh token or a reused one is refused', async () => {
      const rotated = await ok(await call('/agent/token', { method: 'POST', body: { deviceId: agent.deviceId, refreshToken: agent.refreshToken } }), 200, AgentSessionSchema);
      assert.notEqual(rotated.refreshToken, agent.refreshToken);
      assert.equal((await call('/agent/token', { method: 'POST', body: { deviceId: randomUUID(), refreshToken: rotated.refreshToken } })).status, 401, 'other device id');
      // The failed attempt above revoked that family, so pair again for the rest of the suite.
      assert.equal((await call('/agent/token', { method: 'POST', body: { deviceId: agent.deviceId, refreshToken: agent.refreshToken } })).status, 401, 'reuse');
      agent = await pairNew();
    });
  });

  describe('Agent heartbeats', { concurrency: false }, () => {
    let agentSocket: Socket;
    let webSocket: Socket;

    it('an agent heartbeat clocks in with source AGENT and returns a verifiable server anchor', async () => {
      agentSocket = await socketFor(agent.accessToken);
      const ack = await beat(agentSocket, { orgId: ORG, userId: U.a.id, deviceId: agent.deviceId, sessionId: agent.sessionId, secret: agent.sessionSecret });
      assert.equal(ack.success, true, ack.error ?? '');
      assert.ok(ack.anchor);
      lastAnchor = ack.anchor!;
      assert.ok(Math.abs(lastAnchor.serverTimeMs - Date.now()) < 5000);
      assert.ok(verifyAnchor(anchorKey(process.env.JWT_SECRET!), { orgId: ORG, userId: U.a.id, deviceId: agent.deviceId }, lastAnchor.serverTimeMs, lastAnchor.signature));
      const s = await openSession();
      assert.equal(s.clock_in_source, 'AGENT');
      assert.equal(s.device_id, agent.deviceId);
      assert.equal(s.agent_device_id, agent.deviceId);
    });

    it('a heartbeat signed for another device id is rejected (the server sets the device id)', async () => {
      const ack = await beat(agentSocket, { orgId: ORG, userId: U.a.id, deviceId: 'spoofed-device', sessionId: agent.sessionId, secret: agent.sessionSecret });
      assert.equal(ack.success, false);
    });

    it('browser heartbeats next to the agent keep the session alive without counting twice or MULTI_DEVICE', async () => {
      webSocket = await socketFor(tokens.a);
      const before = await openSession();
      const ack = await beat(webSocket, { orgId: ORG, userId: U.a.id, deviceId: 'web-anna', sessionId: webSession.a, secret: webSecret.a });
      assert.equal(ack.success, true, ack.error ?? '');
      assert.equal(ack.anchor, undefined, 'browsers get no anchor');
      const after = await openSession();
      assert.equal(after.active_seconds, before.active_seconds);
      assert.ok(!after.flags.includes('MULTI_DEVICE'), String(after.flags));
      assert.ok(new Date(after.last_heartbeat_at) >= new Date(before.last_heartbeat_at));
      const ev = (await adminPool.query(`SELECT meta FROM presence_events WHERE user_id = $1 AND event_type = 'HEARTBEAT' ORDER BY id DESC LIMIT 2`, [U.a.id])).rows.map((r) => r.meta.source);
      assert.deepEqual(ev, ['WEB', 'AGENT'], 'the source is visible in the raw events (FR-ATT-020)');
    });
  });

  describe('Offline sync (server-anchored)', { concurrency: false }, () => {
    const key = () => anchorKey(process.env.JWT_SECRET!);
    const pastAnchor = (hoursAgo: number): Anchor => {
      const t = Date.now() - hoursAgo * 3600_000;
      return { serverTimeMs: t, signature: signAnchor(key(), { orgId: ORG, userId: U.a.id, deviceId: agent.deviceId }, t) };
    };
    const intervals = (n: number, from = 30) => Array.from({ length: n }, (_, i) => ({ offsetMs: (from + i * 30) * 1000, activeSeconds: 30, idleSeconds: 0 }));
    let anchor2h: Anchor;
    let firstBatch = '';
    let firstSessions = 0;

    it('only the agent may upload; a browser token gets 403 and a tampered anchor 400', async () => {
      anchor2h = pastAnchor(2);
      const body = { batchId: randomUUID(), anchor: anchor2h, intervals: intervals(2) };
      assert.equal((await api('a', '/agent/offline-sync', { method: 'POST', body })).status, 403);
      const tampered = { ...body, anchor: { ...anchor2h, serverTimeMs: anchor2h.serverTimeMs - 3600_000 } };
      assert.equal((await call('/agent/offline-sync', { method: 'POST', body: tampered, token: agent.accessToken })).status, 400);
      assert.equal((await call('/agent/offline-sync', { method: 'POST', body: { ...body, intervals: [{ offsetMs: 0, activeSeconds: 31, idleSeconds: 0 }] }, token: agent.accessToken })).status, 400, 'schema');
    });

    it('an hour offline becomes a closed OFFLINE_SYNCED session rebuilt from the anchor; daily totals follow', async () => {
      firstBatch = randomUUID();
      const r = await ok(await call('/agent/offline-sync', { method: 'POST', body: { batchId: firstBatch, anchor: anchor2h, intervals: intervals(120) }, token: agent.accessToken }), 200, OfflineSyncResultSchema);
      assert.equal(r.accepted, 120);
      assert.equal(r.duplicate, false);
      // One session per day touched: run near midnight (org time) the hour is split (FR-ATT-008).
      firstSessions = r.sessionIds.length;
      assert.ok(firstSessions === 1 || firstSessions === 2, `sessions ${firstSessions}`);
      const rows = (await adminPool.query(`SELECT * FROM attendance_sessions WHERE id = ANY($1::uuid[]) ORDER BY clock_in_at`, [r.sessionIds])).rows;
      for (const s of rows) {
        assert.equal(s.clock_in_source, 'OFFLINE_SYNC');
        assert.equal(s.status, 'CLOSED');
        assert.deepEqual(s.flags, ['OFFLINE_SYNCED']);
        const segs = (await adminPool.query(`SELECT flags FROM attendance_segments WHERE session_id = $1`, [s.id])).rows;
        assert.ok(segs.length >= 1 && segs.every((g) => g.flags.includes('OFFLINE_SYNCED')));
        const ev = (await adminPool.query(`SELECT event_type FROM presence_events WHERE session_id = $1 AND event_type <> 'ATTENDANCE_INPUT'`, [s.id])).rows;
        assert.deepEqual(ev, [{ event_type: 'OFFLINE_SYNC' }]);
        const daily = (await adminPool.query(`SELECT net_seconds FROM attendance_daily WHERE user_id = $1 AND work_date = $2`, [U.a.id, s.work_date])).rows[0];
        assert.ok(daily.net_seconds >= s.active_seconds, `daily ${daily.net_seconds}`);
      }
      assert.equal(new Date(rows[0].clock_in_at).getTime(), anchor2h.serverTimeMs + 30_000, 'time = server anchor + offset, never the device clock');
      assert.equal(rows.reduce((n, s) => n + s.active_seconds, 0), 3600);
    });

    it('the same batch again is a no-op; a different batch over the same time is rejected as overlap', async () => {
      const again = await ok(await call('/agent/offline-sync', { method: 'POST', body: { batchId: firstBatch, anchor: anchor2h, intervals: intervals(120) }, token: agent.accessToken }), 200, OfflineSyncResultSchema);
      assert.equal(again.duplicate, true);
      const over = await ok(await call('/agent/offline-sync', { method: 'POST', body: { batchId: randomUUID(), anchor: anchor2h, intervals: intervals(10) }, token: agent.accessToken }), 200, OfflineSyncResultSchema);
      assert.equal(over.accepted, 0);
      assert.equal(over.rejected.OVERLAP, 10);
      const n = (await adminPool.query(`SELECT count(*)::int AS n FROM attendance_sessions WHERE user_id = $1 AND clock_in_source = 'OFFLINE_SYNC'`, [U.a.id])).rows[0].n;
      assert.equal(n, firstSessions);
    });

    it('time after "now" and anchors older than the window are refused', async () => {
      const recent = pastAnchor(0.01); // 36 s ago
      const fut = await ok(await call('/agent/offline-sync', { method: 'POST', body: { batchId: randomUUID(), anchor: recent, intervals: intervals(10, 3600) }, token: agent.accessToken }), 200, OfflineSyncResultSchema);
      assert.equal(fut.accepted, 0);
      assert.equal(fut.rejected.FUTURE, 10);
      const stale = await ok(await call('/agent/offline-sync', { method: 'POST', body: { batchId: randomUUID(), anchor: pastAnchor(40), intervals: intervals(2) }, token: agent.accessToken }), 200, OfflineSyncResultSchema);
      assert.equal(stale.accepted, 0);
      assert.ok(stale.rejected.STALE_ANCHOR);
    });
  });

  describe('Devices, revocation, permissions and RLS', { concurrency: false }, () => {
    it('users list their own devices; others cannot see or revoke them', async () => {
      const mine = await ok(await api('a', '/agent/devices'), 200, AgentDeviceListSchema);
      assert.ok(mine.items.some((d) => d.id === agent.deviceId && d.revokedAt === null));
      assert.ok(!(await ok(await api('b', '/agent/devices'), 200, AgentDeviceListSchema)).items.some((d) => d.id === agent.deviceId));
      assert.equal((await api('b', `/agent/devices/${agent.deviceId}`, { method: 'DELETE' })).status, 404);
    });

    it('revoking a device drops its socket at once and stops its token refresh', async () => {
      const s = await socketFor(agent.accessToken);
      const dropped = new Promise<void>((res) => s.once('disconnect', () => res()));
      const r = await ok<{ revokedAt: string | null }>(await api('a', `/agent/devices/${agent.deviceId}`, { method: 'DELETE' }), 200);
      assert.ok(r.revokedAt);
      await Promise.race([dropped, wait(5000).then(() => assert.fail('socket not dropped'))]);
      const lead = (await adminPool.query(`SELECT agent_last_seen_at FROM attendance_sessions WHERE agent_device_id = $1 AND status = 'OPEN'`, [agent.deviceId])).rows;
      assert.ok(lead.every((r) => r.agent_last_seen_at === null), 'the browser counts again at once');
      assert.equal((await call('/agent/token', { method: 'POST', body: { deviceId: agent.deviceId, refreshToken: agent.refreshToken } })).status, 401);
    });

    it('an admin (org.manage) may revoke anyone\'s device', async () => {
      const bAgent = await pairNew('b', 'Ben desktop');
      await ok(await api('admin', `/agent/devices/${bAgent.deviceId}`, { method: 'DELETE' }), 200);
      const row = (await adminPool.query(`SELECT revoked_by FROM agent_devices WHERE id = $1`, [bAgent.deviceId])).rows[0];
      assert.equal(row.revoked_by, U.admin.id);
    });

    it('withdrawing the desktop-agent consent revokes every agent of that user; it cannot be granted from the web', async () => {
      const one = await pairNew('a', 'Anna laptop 2');
      const two = await pairNew('a', 'Anna desktop');
      assert.equal((await api('a', '/me/consents', { method: 'POST', body: { type: 'DESKTOP_AGENT', granted: true, noticeVersion: VERSION } })).status, 400);
      await ok(await api('a', '/me/consents', { method: 'POST', body: { type: 'DESKTOP_AGENT', granted: false, noticeVersion: VERSION } }), 201);
      const rows = (await adminPool.query(`SELECT revoked_at FROM agent_devices WHERE id = ANY($1::uuid[])`, [[one.deviceId, two.deviceId]])).rows;
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.revoked_at));
    });

    it('agent tables are invisible without a tenant context (RLS) and the app role cannot delete evidence', async () => {
      const appPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app' });
      try {
        for (const t of ['agent_devices', 'agent_pairing_codes', 'offline_sync_batches']) {
          assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, t);
        }
        await assert.rejects(appPool.query(`DELETE FROM offline_sync_batches`), /permission denied/);
        await assert.rejects(appPool.query(`DELETE FROM agent_devices`), /permission denied/);
      } finally {
        await appPool.end();
      }
    });
  });
});
