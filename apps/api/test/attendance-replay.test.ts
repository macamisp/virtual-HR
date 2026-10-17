/**
 * NFR-ACC-004 (SRS 6.5), written before the implementation: daily totals must be identical when
 * recomputed from the stored sessions, and a nightly replay job compares the stored
 * attendance_daily row of every person with that recomputation and alerts HR on any difference
 * without touching the stored row.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SystemClock } from '../../../packages/shared/src/index.ts';
import { PrismaService } from '../src/common/prisma.service.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { AttendanceFlagsService } from '../src/attendance/attendance-flags.service.ts';
import { NotificationsService } from '../src/notifications/notifications.service.ts';
import { NotificationPreferencesService } from '../src/notifications/notification-preferences.service.ts';
import { ScheduledWorkService } from '../src/notifications/scheduled-work.service.ts';
import { PlanningService } from '../src/planning/planning.service.ts';
import { TimeEntriesActualTime } from '../src/tasks/actual-time.ts';
import { AttendanceGateway } from '../src/attendance/attendance.gateway.ts';

const ORG = 'ac040000-0000-4000-8000-000000000001';
const U = { hr: 'ac040000-0000-4000-8000-000000000011', emp: 'ac040000-0000-4000-8000-000000000012' };
const DAY = '2026-10-15';
const ts = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:30`); // Asia/Colombo

describe('Nightly replay of daily totals (NFR-ACC-004)', { concurrency: false }, () => {
  let admin: pg.Pool;
  let prisma: PrismaService;
  let service: AttendanceService;
  let work: ScheduledWorkService;

  async function session(userId: string, inAt: Date, outAt: Date, net: number, extra: Partial<{ active: number; idle: number; breakS: number; meeting: number }> = {}) {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO attendance_sessions (id, org_id, user_id, device_id, work_date, clock_in_at, clock_out_at, clock_in_source, clock_out_source,
         active_seconds, idle_seconds, break_seconds, meeting_seconds, net_seconds, last_heartbeat_at, ip_in, status, current_state)
       VALUES ($1, $2, $3, 'laptop', $4, $5, $6, 'AUTO_HEARTBEAT', 'LOGOUT', $7, $8, $9, $10, $11, $6, '10.0.0.1', 'CLOSED', 'OFFLINE')`,
      [id, ORG, userId, DAY, inAt, outAt, extra.active ?? net, extra.idle ?? 0, extra.breakS ?? 0, extra.meeting ?? 0, net]);
    return id;
  }
  const daily = async (userId: string) => (await admin.query(`SELECT * FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = $3`, [ORG, userId, DAY])).rows[0];

  before(async () => {
    process.env.JOBS_ENABLED = 'false';
    process.env.MAIL_TRANSPORT = 'memory';
    admin = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Replay Ltd', 'replay-test', 'Asia/Colombo')`, [ORG]);
    await admin.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status) VALUES ($1, $3, 'hr@replay.test', 'Hana', 'HR', 'x', 'ACTIVE'), ($2, $3, 'emp@replay.test', 'Eve', 'EMPLOYEE', 'x', 'ACTIVE')`, [U.hr, U.emp, ORG]);
    await admin.query(`INSERT INTO work_schedules (org_id, user_id, days, flexible, grace_minutes, effective_from) VALUES ($1, $2, $3, false, 10, '2026-01-01')`,
      [ORG, U.emp, JSON.stringify({ '1': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '2': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '3': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '4': { startTime: '09:00', endTime: '17:00', expectedHours: 8 }, '5': { startTime: '09:00', endTime: '17:00', expectedHours: 8 } })]);
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const repo = new PostgresAttendanceRepository();
    const flags = new AttendanceFlagsService(prisma);
    service = new AttendanceService({ orgTimezone: 'Asia/Colombo' }, new SystemClock(), repo, ORG);
    service.setFlagSink(flags);
    const prefs = new NotificationPreferencesService(prisma);
    const gateway = { notifyUser: () => undefined } as unknown as AttendanceGateway;
    const notifications = new NotificationsService(prisma, gateway, { dispatch: async () => undefined }, prefs);
    const planning = new PlanningService(prisma, new TimeEntriesActualTime(prisma));
    work = new ScheduledWorkService(prisma, notifications, planning, service, repo, flags);
  });

  after(async () => {
    await prisma?.onModuleDestroy();
    await admin.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await admin.end();
  });

  it('recomputing a day from its stored sessions matches the stored daily row exactly', async () => {
    await session(U.emp, ts('09:05'), ts('12:30'), 3 * 3600 + 25 * 60, { active: 3 * 3600, idle: 25 * 60 });
    await session(U.emp, ts('13:15'), ts('17:40'), 4 * 3600 + 25 * 60, { active: 4 * 3600 + 25 * 60 });
    const stored = await service.recomputeDailySummaryForUser(ORG, U.emp, DAY);
    assert.ok(stored);
    const r = await service.replayDay(ORG, DAY);
    assert.equal(r.users, 1);
    assert.deepEqual(r.mismatches, []);
    console.log(`# NFR-ACC-004 replay ${DAY}: ${r.users} person, ${r.mismatches.length} differences (net ${stored!.netSeconds} s stored = recomputed)`);
  });

  it('a stored total that drifted from its sessions is reported field by field, and the stored row is left as it is', async () => {
    await admin.query(`UPDATE attendance_daily SET net_seconds = net_seconds - 600, day_status = 'LATE' WHERE org_id = $1 AND user_id = $2 AND work_date = $3`, [ORG, U.emp, DAY]);
    const r = await service.replayDay(ORG, DAY);
    const fields = r.mismatches.map((m) => m.field).sort();
    assert.deepEqual(fields, ['dayStatus', 'netSeconds']);
    const net = r.mismatches.find((m) => m.field === 'netSeconds')!;
    assert.equal(Number(net.recomputed) - Number(net.stored), 600);
    assert.equal((await daily(U.emp)).net_seconds, Number(net.stored), 'the replay only reports; it does not rewrite history');
  });

  it('a person with sessions but no daily row is a difference too', async () => {
    await session(U.hr, ts('10:00'), ts('11:00'), 3600);
    const r = await service.replayDay(ORG, DAY);
    assert.ok(r.mismatches.some((m) => m.userId === U.hr && m.field === 'row' && m.stored === 'missing'));
  });

  it('the nightly job checks yesterday for every organisation, alerts HR once and writes an audit entry; a clean day alerts nobody', async () => {
    // "Now" is the night after DAY in the organisation's timezone.
    const now = new Date(`${DAY}T21:30:00Z`); // 03:00 on the 16th in Colombo
    const n = await work.attendanceReplay(now);
    assert.ok(n >= 2, `differences found: ${n}`);
    const notes = await admin.query(`SELECT user_id, type, title, dedupe_key FROM notifications WHERE org_id = $1 AND type = 'ATTENDANCE_REPLAY_MISMATCH'`, [ORG]);
    assert.equal(notes.rows.length, 1, 'HR is told once');
    assert.equal(notes.rows[0].user_id, U.hr);
    assert.match(notes.rows[0].title, /2026-10-15/);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1 AND action = 'ATTENDANCE_REPLAY_MISMATCH'`, [ORG])).rows[0].n, 1);
    // Running again the same night does not nag.
    await work.attendanceReplay(now);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND type = 'ATTENDANCE_REPLAY_MISMATCH'`, [ORG])).rows[0].n, 1);
    // Repair the day: the daily close rewrites the rows and the replay is clean.
    await service.runDailyCloseJob(ORG, DAY);
    const clean = await service.replayDay(ORG, DAY);
    assert.deepEqual(clean.mismatches, []);
    assert.equal(await work.attendanceReplay(new Date(`${DAY}T22:30:00Z`)), 0);
  });
});
