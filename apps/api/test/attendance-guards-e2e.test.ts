/**
 * Anti-spoofing, network policy, review flags, alerts and the presence challenge end to end
 * (FR-ATT-017, 018, 021, 023; ADR 019). Flags never change recorded time; that is asserted too.
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
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { signHeartbeatPayload } from '../../../packages/shared/src/attendance/heartbeat-signer.ts';
import { AttendanceFlagListSchema, AttendanceGuardsSchema, CONSENT_NOTICES } from '../../../packages/shared/src/index.ts';
import type { AttendanceFlag, PresenceChallenge } from '../../../packages/shared/src/index.ts';

const ORG = 'a7a70000-0000-4000-8000-000000000001';
const TEAM = 'a7a70000-0000-4000-8000-000000000101';
const PORT = 3085;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const TZ = 'Asia/Colombo';
const U = {
  hr: { id: 'a7a70000-0000-4000-8000-000000000011', email: 'hr@guards.test', name: 'Hal HR', role: 'HR', mfa: true, team: null, manager: null },
  lead: { id: 'a7a70000-0000-4000-8000-000000000012', email: 'lead@guards.test', name: 'Lee Lead', role: 'TEAM_LEAD', mfa: false, team: TEAM, manager: null },
  emp: { id: 'a7a70000-0000-4000-8000-000000000013', email: 'emma@guards.test', name: 'Emma Emp', role: 'EMPLOYEE', mfa: false, team: TEAM, manager: 'a7a70000-0000-4000-8000-000000000012' },
  other: { id: 'a7a70000-0000-4000-8000-000000000014', email: 'otto@guards.test', name: 'Otto Other', role: 'EMPLOYEE', mfa: false, team: null, manager: null },
} as const;
type Who = keyof typeof U;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Attendance safeguards (FR-ATT-017, 018, 021, 023)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  const base = `http://localhost:${PORT}`;
  const login = {} as Record<Who, { accessToken: string; sessionId: string; sessionSecret: string }>;
  const sockets: Socket[] = [];
  let seq = 1_900_000_000;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login[who].accessToken}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  function socket(who: Who, headers: Record<string, string> = {}): Promise<Socket> {
    const s = io(base, { transports: ['websocket'], reconnection: false, auth: { token: login[who].accessToken }, extraHeaders: headers });
    sockets.push(s);
    return new Promise((res, rej) => { s.once('connect', () => res(s)); s.once('connect_error', rej); });
  }
  async function payload(who: Who, deviceId: string, o: { active?: number; idle?: number; badSig?: boolean } = {}) {
    seq += 1;
    const hb = await signHeartbeatPayload({ orgId: ORG, userId: U[who].id, deviceId, sessionId: login[who].sessionId, sequenceNumber: seq, nonce: randomUUID(),
      activeSeconds: o.active ?? 30, idleSeconds: o.idle ?? 0, tabVisible: true, windowFocused: true, inCall: false }, login[who].sessionSecret);
    return o.badSig ? { ...hb, signature: '0'.repeat(64) } : hb;
  }
  const beat = async (s: Socket, who: Who, deviceId: string, o: { active?: number; idle?: number; badSig?: boolean } = {}) =>
    (await s.emitWithAck('presence:heartbeat', await payload(who, deviceId, o))) as { success: boolean; error?: string };
  const flagsOf = async (who: Who) => (await adminPool.query<{ kind: string; status: string; session_id: string | null }>(`SELECT kind, status, session_id FROM attendance_flags WHERE user_id = $1 ORDER BY created_at`, [U[who].id])).rows;
  const notes = async (who: Who, type: string) => (await adminPool.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = $2`, [U[who].id, type])).rows;

  before(async () => {
    process.env.BREACHED_PASSWORD_CHECK = 'local';
    process.env.MAIL_TRANSPORT = 'memory';
    process.env.RATE_LIMIT_LOGIN = '1000';
    process.env.RATE_LIMIT_HEARTBEAT = '1000';
    process.env.JOBS_ENABLED = 'false';
    process.env.TRUST_PROXY_HEADERS = 'cloudflare';
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Guards Ltd', 'guards-e2e', $2)`, [ORG, TZ]);
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Support')`, [TEAM, ORG]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret, team_id) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9)`,
        [u.id, ORG, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null, u.team]);
      await adminPool.query(`INSERT INTO monitoring_consents (org_id, user_id, notice_version, consent_type, granted, accepted_at) VALUES ($1, $2, $3, 'MONITORING', true, now())`, [ORG, u.id, CONSENT_NOTICES.MONITORING.version]);
    }
    await adminPool.query(`UPDATE users SET manager_id = $2 WHERE id = $1`, [U.emp.id, U.lead.id]);
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: generateSync({ secret: SECRET }) } : {}) }) });
      login[who] = (await res.json()) as { accessToken: string; sessionId: string; sessionSecret: string };
    }
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    await app?.close();
    delete process.env.TRUST_PROXY_HEADERS;
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  describe('Safeguard settings', { concurrency: false }, () => {
    it('admins/HR read and save them; ranges are validated; employees are refused; changes are audited', async () => {
      const d = await ok(await api('hr', '/admin/attendance-guards'), 200, AttendanceGuardsSchema);
      assert.deepEqual(d, { allowedCidrs: [], allowedCountries: [], presenceChallenge: false, longIdleAlertMinutes: 0, flagAlertThreshold: 3, noClockInReminder: true });
      assert.equal((await api('emp', '/admin/attendance-guards')).status, 403);
      assert.equal((await api('hr', '/admin/attendance-guards', { method: 'PUT', body: { ...d, allowedCidrs: ['10.0.0.0/33'] } })).status, 400);
      const g = await ok(await api('hr', '/admin/attendance-guards', { method: 'PUT', body: { ...d, allowedCidrs: ['203.0.113.0/24'], allowedCountries: ['lk', 'LK', 'SG'] } }), 200, AttendanceGuardsSchema);
      assert.deepEqual(g.allowedCountries, ['LK', 'SG'], 'normalised and de-duplicated');
      const audit = (await adminPool.query(`SELECT 1 FROM audit_logs WHERE org_id = $1 AND action = 'ATTENDANCE_GUARDS_UPDATED'`, [ORG])).rowCount;
      assert.equal(audit, 1);
    });
  });

  describe('Signals and network', { concurrency: false }, () => {
    let empSocket: Socket;

    it('outside the allowed range and country: flagged once, recorded with the session, time unaffected', async () => {
      empSocket = await socket('emp', { 'cf-connecting-ip': '198.51.100.7', 'cf-ipcountry': 'US' });
      for (let i = 0; i < 3; i += 1) assert.equal((await beat(empSocket, 'emp', 'web-emma')).success, true);
      const kinds = (await flagsOf('emp')).map((f) => f.kind).sort();
      assert.deepEqual(kinds, ['COUNTRY_NOT_ALLOWED', 'IP_NOT_ALLOWED']);
      const s = (await adminPool.query(`SELECT ip_in, country_in, country_out, active_seconds FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`, [U.emp.id])).rows[0];
      assert.deepEqual({ ip: s.ip_in, cin: s.country_in, cout: s.country_out }, { ip: '198.51.100.7', cin: 'US', cout: 'US' });
      assert.equal(s.active_seconds, 90, 'flags never change recorded time');
    });

    it('another country seconds later: impossible travel, and the second device is flagged as concurrent', async () => {
      const gb = await socket('emp', { 'cf-connecting-ip': '198.51.100.8', 'cf-ipcountry': 'GB' });
      assert.equal((await beat(gb, 'emp', 'web-emma-2')).success, true);
      const kinds = (await flagsOf('emp')).map((f) => f.kind);
      assert.ok(kinds.includes('IMPOSSIBLE_TRAVEL'), kinds.join());
      assert.ok(kinds.includes('MULTI_DEVICE'), kinds.join());
      const travel = (await adminPool.query(`SELECT details FROM attendance_flags WHERE user_id = $1 AND kind = 'IMPOSSIBLE_TRAVEL'`, [U.emp.id])).rows[0].details;
      assert.equal(travel.from, 'US');
      assert.equal(travel.to, 'GB');
      assert.ok(travel.kmh > 1000);
    });

    it('proxy headers are ignored unless TRUST_PROXY_HEADERS=cloudflare (they could be forged)', async () => {
      process.env.TRUST_PROXY_HEADERS = '';
      try {
        const forged = await socket('other', { 'cf-connecting-ip': '203.0.113.5', 'cf-ipcountry': 'LK' });
        assert.equal((await beat(forged, 'other', 'web-otto')).success, true);
        const s = (await adminPool.query(`SELECT ip_in, country_in FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`, [U.other.id])).rows[0];
        assert.equal(s.country_in, null);
        assert.notEqual(s.ip_in, '203.0.113.5');
        // The forged in-range IP was ignored, so the real address (outside the range) is what got flagged.
        const f = (await adminPool.query(`SELECT details FROM attendance_flags WHERE user_id = $1 AND kind = 'IP_NOT_ALLOWED'`, [U.other.id])).rows;
        assert.equal(f.length, 1);
        assert.notEqual(f[0].details.ip, '203.0.113.5');
        forged.disconnect();
      } finally {
        process.env.TRUST_PROXY_HEADERS = 'cloudflare';
      }
    });

    it('repeated rejected (forged) signals raise one flag for review', async () => {
      for (let i = 0; i < 6; i += 1) {
        const ack = await beat(empSocket, 'emp', 'web-emma', { badSig: true });
        assert.equal(ack.success, false);
      }
      await wait(300);
      const kinds = (await flagsOf('emp')).map((f) => f.kind);
      assert.equal(kinds.filter((k) => k === 'INVALID_HEARTBEATS').length, 1);
    });
  });

  describe('Review', { concurrency: false }, () => {
    let item: AttendanceFlag;

    it('the manager sees their report\'s flags and may resolve them; HR sees everyone; other employees may not review', async () => {
      const lead = await ok(await api('lead', '/attendance/flags?scope=review'), 200, AttendanceFlagListSchema);
      assert.ok(lead.items.length >= 4 && lead.items.every((f) => f.person.id === U.emp.id && f.canResolve));
      item = lead.items.find((f) => f.kind === 'IP_NOT_ALLOWED')!;
      const hr = await ok(await api('hr', '/attendance/flags?scope=review'), 200, AttendanceFlagListSchema);
      assert.ok(hr.items.some((f) => f.id === item.id));
      assert.equal((await api('other', '/attendance/flags?scope=review')).status, 403);
      const mine = await ok(await api('emp', '/attendance/flags?scope=mine'), 200, AttendanceFlagListSchema);
      assert.ok(mine.items.length >= 4 && mine.items.every((f) => !f.canResolve));
      assert.ok((await ok(await api('other', '/attendance/flags?scope=mine'), 200, AttendanceFlagListSchema)).items.every((f) => f.person.id === U.other.id));
    });

    it('the person explains; only they can; reviewers then resolve with a note (audited)', async () => {
      const c = await ok<AttendanceFlag>(await api('emp', `/attendance/flags/${item.id}/comment`, { method: 'POST', body: { comment: 'I was on the office VPN' } }), 200);
      assert.equal(c.userComment, 'I was on the office VPN');
      assert.equal((await api('lead', `/attendance/flags/${item.id}/comment`, { method: 'POST', body: { comment: 'x' } })).status, 404);
      assert.equal((await api('emp', `/attendance/flags/${item.id}/resolve`, { method: 'POST', body: { resolution: 'NO_ACTION', note: 'fine by me' } })).status, 403);
      assert.equal((await api('lead', `/attendance/flags/${item.id}/resolve`, { method: 'POST', body: { resolution: 'NO_ACTION', note: 'ok' } })).status, 400, 'a note is required');
      const r = await ok<AttendanceFlag>(await api('lead', `/attendance/flags/${item.id}/resolve`, { method: 'POST', body: { resolution: 'NO_ACTION', note: 'VPN exit, confirmed with Emma' } }), 200);
      assert.equal(r.status, 'RESOLVED');
      assert.equal(r.resolvedBy?.id, U.lead.id);
      assert.equal((await adminPool.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'ATTENDANCE_FLAG_RESOLVED'`, [item.id])).rowCount, 1);
    });

    it('nobody resolves a flag about themselves, and other teams cannot see or resolve', async () => {
      const own = (await adminPool.query(`INSERT INTO attendance_flags (org_id, user_id, work_date, kind, category, dedupe_key) VALUES ($1, $2, '2026-10-13', 'PERIODIC_ACTIVITY', 'SPOOFING', $3) RETURNING id`, [ORG, U.lead.id, randomUUID()])).rows[0].id;
      assert.equal((await api('lead', `/attendance/flags/${own}/resolve`, { method: 'POST', body: { resolution: 'NO_ACTION', note: 'all good here' } })).status, 403);
      const otto = (await adminPool.query(`INSERT INTO attendance_flags (org_id, user_id, work_date, kind, category, dedupe_key) VALUES ($1, $2, '2026-10-13', 'ANONYMIZER', 'NETWORK', $3) RETURNING id`, [ORG, U.other.id, randomUUID()])).rows[0].id;
      assert.equal((await api('lead', `/attendance/flags/${otto}/resolve`, { method: 'POST', body: { resolution: 'NO_ACTION', note: 'not my team' } })).status, 404);
      await assert.rejects(adminPool.query(`UPDATE attendance_flags SET status = 'RESOLVED', resolution = 'NO_ACTION', resolution_note = 'self', resolved_by = $1, resolved_at = now() WHERE id = $2`, [U.lead.id, own]), /not_self/);
    });
  });

  describe('Alerts (FR-ATT-021) and the mechanical-input scan', { concurrency: false }, () => {
    const work = () => app.get(ScheduledWorkService, { strict: false });
    const elevenToday = () => fromZonedTime(`${formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd')} 11:00:00`, TZ);

    it('no clock-in by schedule start + grace: one reminder (not on a flexible schedule)', async () => {
      const now = elevenToday();
      const day = formatInTimeZone(now, TZ, 'i');
      await adminPool.query(`DELETE FROM attendance_sessions WHERE user_id = $1`, [U.hr.id]);
      await adminPool.query(`INSERT INTO work_schedules (id, org_id, user_id, days, flexible, grace_minutes, effective_from) VALUES ($1, $2, $3, $4, false, 10, '2026-01-01')`,
        [randomUUID(), ORG, U.hr.id, JSON.stringify({ [day]: { start: '10:00', end: '18:00', expectedHours: 8 } })]);
      await work().attendanceAlerts(now);
      await work().attendanceAlerts(now);
      const n = await notes('hr', 'ATTENDANCE_NO_CLOCK_IN');
      assert.equal(n.length, 1);
      assert.match(n[0].title, /not clocked in/);
    });

    it('a paused session past the configured minutes alerts the reviewer, and periodic input is flagged', async () => {
      await adminPool.query(`UPDATE organizations SET att_long_idle_alert_minutes = 60 WHERE id = $1`, [ORG]);
      const now = new Date();
      const sid = randomUUID();
      await adminPool.query(`DELETE FROM attendance_sessions WHERE user_id = $1`, [U.other.id]);
      await adminPool.query(`INSERT INTO attendance_sessions (id, org_id, user_id, device_id, work_date, clock_in_at, clock_in_source, last_heartbeat_at, ip_in, status, current_state)
        VALUES ($1, $2, $3, 'web-otto', $4, $5, 'AUTO_HEARTBEAT', $6, '10.0.0.1', 'OPEN', 'PAUSED')`, [sid, ORG, U.other.id, formatInTimeZone(now, TZ, 'yyyy-MM-dd'), new Date(now.getTime() - 3 * 3600_000), now]);
      await adminPool.query(`INSERT INTO attendance_segments (org_id, session_id, state, started_at) VALUES ($1, $2, 'PAUSED', $3)`, [ORG, sid, new Date(now.getTime() - 90 * 60_000)]);
      for (let i = 0; i < 240; i += 1) {
        const meta = i % 8 === 0 ? { activeSeconds: 2, idleSeconds: 28, tabVisible: true, windowFocused: true, source: 'AGENT' } : { activeSeconds: 0, idleSeconds: 30, tabVisible: true, windowFocused: true, source: 'AGENT' };
        await adminPool.query(`INSERT INTO presence_events (org_id, user_id, session_id, server_ts, event_type, state, meta) VALUES ($1, $2, $3, $4, 'HEARTBEAT', 'IDLE', $5)`,
          [ORG, U.other.id, sid, new Date(now.getTime() - (240 - i) * 30_000), JSON.stringify(meta)]);
      }
      await work().attendanceAlerts(now);
      const n = await notes('hr', 'ATTENDANCE_LONG_IDLE');
      assert.equal(n.length, 1, 'Otto has no manager or team, so HR is told');
      assert.match(n[0].title, /Otto Other has been idle for 90 minutes/);
      assert.ok((await flagsOf('other')).some((f) => f.kind === 'PERIODIC_ACTIVITY' && f.session_id === sid));
    });

    it('several open items alert the manager once per week', async () => {
      await work().attendanceAlerts(new Date());
      await work().attendanceAlerts(new Date());
      const n = await notes('lead', 'ATTENDANCE_FLAGS_TO_REVIEW');
      assert.equal(n.length, 1);
      assert.match(n[0].title, /attendance items to review for Emma Emp/);
      assert.match(n[0].body, /Nothing has been changed or deducted/);
    });

    it('a session closed by the server tells the person, with the reason', async () => {
      // Near midnight the first pass only splits the session; the second, 3 hours later, times it out.
      const t = Date.now() + 3 * 3600_000;
      await work().attendanceReconcile(new Date(t));
      await work().attendanceReconcile(new Date(t + 3 * 3600_000));
      const n = await notes('emp', 'ATTENDANCE_AUTO_CLOCK_OUT');
      assert.equal(n.length, 1);
      assert.match(n[0].body, /stopped sending activity.*request a correction/);
    });
  });

  describe('Presence challenge (FR-ATT-023)', { concurrency: false }, () => {
    async function idleLeadUntilChallenge(): Promise<{ challenge: PresenceChallenge }> {
      const svc = app.get(AttendanceService);
      await adminPool.query(`UPDATE attendance_sessions SET status = 'CLOSED', clock_out_at = now(), clock_out_source = 'LOGOUT' WHERE user_id = $1 AND status = 'OPEN'`, [U.lead.id]);
      svc.invalidatePolicy(ORG);
      const s = await socket('lead');
      const got = new Promise<PresenceChallenge>((res) => s.once('attendance:challenge', res));
      // 15 minutes of silence fed at past server times, then the heartbeat that crosses the threshold via the socket.
      // Each past time is taken relative to "now" as it is sent, so a slow machine cannot open a gap of
      // more than ~30 s between the last injected heartbeat and the live one.
      await svc.ingestHeartbeat(await payload('lead', 'web-lee', { active: 30, idle: 0 }), new Date(Date.now() - 31 * 30_000));
      for (let i = 1; i <= 29; i += 1) await svc.ingestHeartbeat(await payload('lead', 'web-lee', { active: 0, idle: 30 }), new Date(Date.now() - (31 - i) * 30_000));
      assert.equal((await beat(s, 'lead', 'web-lee', { active: 0, idle: 30 })).success, true);
      return { challenge: await Promise.race([got, wait(5000).then(() => assert.fail('no challenge event'))]) };
    }

    it('off by default; when on, the user gets "Are you still working?" and a reply in time resumes ACTIVE', async () => {
      await ok(await api('hr', '/admin/attendance-guards', { method: 'PUT', body: { allowedCidrs: [], allowedCountries: [], presenceChallenge: true, longIdleAlertMinutes: 0, flagAlertThreshold: 0, noClockInReminder: false } }), 200);
      const { challenge } = await idleLeadUntilChallenge();
      assert.ok(Date.parse(challenge.expiresAt) - Date.now() > 50_000);
      const r = await ok<{ currentState: string }>(await api('lead', '/attendance/challenge', { method: 'POST', body: { challengeId: challenge.id } }), 200);
      assert.equal(r.currentState, 'ACTIVE');
      assert.equal((await api('lead', '/attendance/challenge', { method: 'POST', body: { challengeId: challenge.id } })).status, 409, 'answered already');
      const ev = (await adminPool.query(`SELECT 1 FROM presence_events WHERE user_id = $1 AND event_type = 'PRESENCE_CONFIRMED'`, [U.lead.id])).rowCount;
      assert.equal(ev, 1);
    });

    it('no reply: the reconciler pauses from the moment the question was asked', async () => {
      const { challenge } = await idleLeadUntilChallenge();
      await app.get(AttendanceService).runReconciliation(new Date(Date.parse(challenge.expiresAt) + 1000), ORG);
      const s = (await adminPool.query(`SELECT id, current_state, challenge_id FROM attendance_sessions WHERE user_id = $1 AND status = 'OPEN'`, [U.lead.id])).rows[0];
      assert.equal(s.current_state, 'PAUSED');
      assert.equal(s.challenge_id, null);
      const seg = (await adminPool.query(`SELECT started_at FROM attendance_segments WHERE session_id = $1 AND state = 'PAUSED'`, [s.id])).rows[0];
      assert.equal(new Date(seg.started_at).getTime(), Date.parse(challenge.expiresAt) - 60_000);
      assert.equal((await api('lead', '/attendance/challenge', { method: 'POST', body: { challengeId: challenge.id } })).status, 409, 'too late');
    });
  });

  describe('RLS', () => {
    it('attendance_flags is invisible without a tenant context and cannot be deleted by the app', async () => {
      const appPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app' });
      try {
        assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM attendance_flags`)).rows[0].n, 0);
        await assert.rejects(appPool.query(`DELETE FROM attendance_flags`), /permission denied/);
      } finally {
        await appPool.end();
      }
    });
  });
});
