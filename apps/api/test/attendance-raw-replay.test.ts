/** NFR-ACC-004: a replay must independently rebuild totals from recorded inputs. */
import 'reflect-metadata';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { DEFAULT_ATTENDANCE_CONFIG, type HeartbeatPayload, SystemClock } from '../../../packages/shared/src/index.ts';

const ORG = 'ac040001-0000-4000-8000-000000000001';
const USER = 'ac040001-0000-4000-8000-000000000011';
const DAY = '2026-10-15';
const at = (seconds: number) => new Date(Date.parse(`${DAY}T09:00:00Z`) + seconds * 1000);

describe('Raw attendance replay (NFR-ACC-004)', () => {
  let db: pg.Pool;
  let repo: PostgresAttendanceRepository;
  let service: AttendanceService;
  let id: string;
  let originalNet: number;
  const secret = randomBytes(32).toString('hex');
  let sequence = 0;
  async function beat(seconds: number, deviceId = 'a') {
    sequence += 1;
    const body: Omit<HeartbeatPayload, 'signature'> = { orgId: ORG, userId: USER, sessionId: 'raw-replay', deviceId, activeSeconds: 30, idleSeconds: 0, inCall: false, tabVisible: true, windowFocused: true, nonce: randomBytes(16).toString('hex'), sequenceNumber: sequence };
    return service.ingestHeartbeat({ ...body, signature: service.getValidator().signHeartbeat(body, secret) }, at(seconds));
  }
  before(async () => {
    db = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await db.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await db.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Raw replay', 'raw-replay', 'UTC')`, [ORG]);
    await db.query(`INSERT INTO users (id, org_id, email, role, status, created_at) VALUES ($1, $2, 'raw@replay.test', 'EMPLOYEE', 'ACTIVE', '2026-10-01')`, [USER, ORG]);
    repo = new PostgresAttendanceRepository();
    service = new AttendanceService({ orgTimezone: 'UTC' }, new SystemClock(), repo, ORG);
    await service.registerSessionSecret('raw-replay', secret, ORG);
    await service.recordMonitoringConsent({ orgId: ORG, userId: USER, noticeVersion: 'v1.0.0' });
  });
  after(async () => { await repo?.close(); await db.query(`DELETE FROM organizations WHERE id = $1`, [ORG]); await db.end(); });

  it('replays heartbeats, two devices, breaks, meetings and logout exactly', async () => {
    id = (await beat(0)).session.id;
    await beat(30, 'b');
    await service.startBreak(USER, at(35), ORG);
    await beat(60);
    await service.endBreak(USER, at(65), ORG);
    await service.joinMeeting(USER, randomUUID(), at(70), ORG);
    await beat(90, 'b');
    await service.leaveMeeting(USER, at(100), ORG);
    await beat(120);
    await service.onExplicitLogout(USER, at(125), ORG);
    const row = await service.recomputeDailySummaryForUser(ORG, USER, DAY);
    originalNet = row!.netSeconds;
    const replay = await service.replayDay(ORG, DAY);
    assert.deepEqual(replay.mismatches, []);
    console.log(`# NFR-ACC-004 raw replay: net ${originalNet} s, ${replay.mismatches.length} differences`);
  });

  it('detects identical corruption of a session AND daily total, without rewriting either', async () => {
    await db.query(`UPDATE attendance_sessions SET net_seconds = net_seconds + 7 WHERE id = $1`, [id]);
    await db.query(`UPDATE attendance_daily SET net_seconds = net_seconds + 7 WHERE org_id = $1 AND user_id = $2`, [ORG, USER]);
    const replay = await service.replayDay(ORG, DAY);
    const net = replay.mismatches.find((m) => m.field === 'netSeconds');
    assert.ok(net, 'a session-based replay cannot detect matching corruption in both aggregates');
    assert.equal(net.recomputed, originalNet);
    assert.equal(net.stored, originalNet + 7);
    assert.equal((await db.query(`SELECT net_seconds FROM attendance_sessions WHERE id = $1`, [id])).rows[0].net_seconds, originalNet + 7);
    console.log(`# NFR-ACC-004 injected drift: stored ${net.stored} s, raw replay ${net.recomputed} s, delta 7 s detected`);
  });
  it('uses the recorded policy even after policy changes, and checks missing daily rows for users without sessions', async () => {
    await db.query(`UPDATE attendance_sessions SET net_seconds = $2 WHERE id = $1`, [id, originalNet]);
    await db.query(`UPDATE attendance_daily SET net_seconds = $3 WHERE org_id = $1 AND user_id = $2`, [ORG, USER, originalNet]);
    service.setPolicyProvider(async () => ({ paidBreakMinutesPerDay: 0 }));
    assert.deepEqual((await service.replayDay(ORG, DAY)).mismatches, []);
    const absent = await service.replayDay(ORG, '2026-10-14');
    assert.ok(absent.mismatches.some((m) => m.userId === USER && m.field === 'row'));
  });

  it('replays both sides of a midnight split and a subsequent grace expiry', async () => {
    await beat(53_960);
    await beat(53_990);
    const split = await service.runReconciliation(at(54_001), ORG);
    assert.equal(split.splitCount, 1);
    await beat(54_010, 'b');
    await service.onSocketDisconnect(USER, at(54_015), ORG);
    await service.runReconciliation(at(54_136), ORG);
    for (const day of [DAY, '2026-10-16']) {
      await service.recomputeDailySummaryForUser(ORG, USER, day);
      assert.deepEqual((await service.replayDay(ORG, day)).mismatches, [], day);
    }
  });

  it('rolls back the session and segments if recording the raw input fails', async () => {
    const session = await repo.findSessionById(ORG, id);
    assert.ok(session);
    const before = session.netSeconds;
    session.netSeconds += 99;
    const record = repo.recordPresenceEvent;
    repo.recordPresenceEvent = async () => { throw new Error('Journal unavailable'); };
    try {
      await assert.rejects(repo.saveSession(session, { orgId: ORG, userId: USER, sessionId: id, at: at(130), config: DEFAULT_ATTENDANCE_CONFIG, input: { kind: 'logout' } }), /Journal unavailable/);
      assert.equal((await repo.findSessionById(ORG, id))?.netSeconds, before);
    } finally { repo.recordPresenceEvent = record; }
  });

  it('replays mixed active/idle offline counters without treating an entire segment as active', async () => {
    const now = Date.now();
    await service.applyOfflineSync({ orgId: ORG, userId: USER, deviceId: 'offline-mixed', anchorServerMs: now - 61_000,
      intervals: [{ offsetMs: 0, activeSeconds: 12, idleSeconds: 18 }, { offsetMs: 30_000, activeSeconds: 0, idleSeconds: 30 }], ip: '127.0.0.1' });
    const day = new Date(now).toISOString().slice(0, 10);
    const row = await repo.findDailyAttendance(ORG, USER, day);
    assert.equal(row?.activeSeconds, 12);
    assert.equal(row?.idleSeconds, 48);
    assert.deepEqual((await service.replayDay(ORG, day)).mismatches, []);
  });

  it('reports missing input history instead of claiming legacy aggregates are proven', async () => {
    await db.query(`DELETE FROM presence_events WHERE org_id = $1 AND session_id = $2 AND event_type = 'ATTENDANCE_INPUT'`, [ORG, id]);
    const result = await service.replayDay(ORG, DAY);
    assert.ok(result.mismatches.some((m) => m.field === 'rawEvents' && m.stored === 'missing'));
  });

  it('raw inputs remain tenant isolated and append-only for the application role', async () => {
    const hidden = await repo.findAttendanceInputs('ac040001-0000-4000-8000-000000000099', USER, DAY);
    assert.deepEqual(hidden, []);
    await assert.rejects(repo.queryWithRls(ORG, `UPDATE presence_events SET meta = '{}' WHERE org_id = $1`, [ORG]), /permission denied/);
  });

});
