/**
 * Work schedules in the compliance engine (FR-ORG-005, FR-ATT-014; ADR 032), against Postgres:
 * the schedule in force on the work date (person, then team, then organisation default; the
 * latest version that has started), flexible hours without late or early-leave flags, separate
 * grace for late arrival and early leave, and break time beyond the allowance flagged without
 * changing net time. The nightly replay compares the new field like every other one.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import type { AttendanceSession, Clock, WorkSchedule } from '../../../packages/shared/src/attendance/types.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { AttendanceService, REPLAY_FIELDS } from '../src/attendance/attendance.service.ts';

const ORG = '5c5c0000-0000-4000-8000-000000000001';
const TEAM = '5c5c0000-0000-4000-8000-000000000101';
const OWN = '5c5c0000-0000-4000-8000-000000000011'; // has their own schedule
const TEAMMATE = '5c5c0000-0000-4000-8000-000000000012'; // team schedule only
const LONER = '5c5c0000-0000-4000-8000-000000000013'; // no team: organisation default
const NINE_TO_SIX = { start: '09:00', end: '18:00', expectedHours: 8 };
const weekdays = (day: { start: string; end: string; expectedHours: number }) => ({ '1': day, '2': day, '3': day, '4': day, '5': day });

class FixedClock implements Clock { constructor(private readonly t: Date) {} now(): Date { return this.t; } }

/** One closed session on a Colombo work date, local times "HH:MM". */
function session(userId: string, workDate: string, inLocal: string, outLocal: string, breakMinutes = 0): AttendanceSession {
  const at = (hhmm: string) => new Date(new Date(`${workDate}T${hhmm}:00+05:30`).getTime());
  const clockInAt = at(inLocal);
  const clockOutAt = at(outLocal);
  const span = (clockOutAt.getTime() - clockInAt.getTime()) / 1000;
  const breakSeconds = breakMinutes * 60;
  return {
    id: crypto.randomUUID(), orgId: ORG, userId, deviceId: 'web', workDate, clockInAt, clockOutAt,
    clockInSource: 'AUTO_HEARTBEAT', clockOutSource: 'LOGOUT', activeSeconds: span - breakSeconds, idleSeconds: 0, breakSeconds,
    meetingSeconds: 0, netSeconds: span - breakSeconds, lastHeartbeatAt: clockOutAt, ipIn: '127.0.0.1', ipOut: '127.0.0.1',
    flags: [], status: 'CLOSED', currentState: 'OFFLINE', segments: [], consecutiveIdleSeconds: 0,
  } as AttendanceSession;
}

describe('Work schedules in the compliance engine (FR-ORG-005)', () => {
  let adminPool: pg.Pool;
  let repo: PostgresAttendanceRepository;
  let service: AttendanceService;
  const save = (s: Partial<WorkSchedule> & Pick<WorkSchedule, 'days' | 'effectiveFrom'>) =>
    repo.saveWorkSchedule({ id: crypto.randomUUID(), orgId: ORG, flexible: false, graceMinutes: 10, ...s });
  const check = (userId: string, workDate: string, sessions: AttendanceSession[]) => service.computeScheduleCompliance({ orgId: ORG, userId, workDate, sessions });

  before(async () => {
    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev',
      user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres',
    });
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug, timezone) VALUES ($1, 'Schedules Ltd', 'schedule-compliance', 'Asia/Colombo')`, [ORG]);
    await adminPool.query(`DELETE FROM public_holidays WHERE org_id = $1`, [ORG]); // no default calendar in this suite
    await adminPool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Ops')`, [TEAM, ORG]);
    await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, team_id) VALUES
      ($1, $4, 'own@sched.test', 'Own', 'EMPLOYEE', $5), ($2, $4, 'mate@sched.test', 'Mate', 'EMPLOYEE', $5), ($3, $4, 'loner@sched.test', 'Loner', 'EMPLOYEE', NULL)`,
      [OWN, TEAMMATE, LONER, ORG, TEAM]);
    repo = new PostgresAttendanceRepository();
    service = new AttendanceService({}, new FixedClock(new Date('2026-10-20T15:00:00Z')), repo, ORG);

    // Organisation default: 08:00-17:00. Team: 09:00-18:00. Own: two versions.
    await save({ days: weekdays({ start: '08:00', end: '17:00', expectedHours: 8 }), effectiveFrom: '2026-01-01' });
    await save({ teamId: TEAM, days: weekdays(NINE_TO_SIX), effectiveFrom: '2026-01-01' });
    await save({ userId: OWN, days: weekdays(NINE_TO_SIX), effectiveFrom: '2026-01-01', effectiveTo: '2026-10-11' });
    await save({ userId: OWN, days: weekdays({ start: '10:00', end: '19:00', expectedHours: 8 }), effectiveFrom: '2026-10-12', effectiveTo: '2026-10-30' });
  });

  after(async () => {
    await repo.clearAll(ORG);
    await repo.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await adminPool.end();
  });

  it('uses the version in force on the work date, not whichever row comes first', async () => {
    // Friday 9 October: version 1 (09:00 start), so 09:25 is late.
    const v1 = await check(OWN, '2026-10-09', [session(OWN, '2026-10-09', '09:25', '18:00')]);
    assert.equal(v1.lateArrivalMinutes, 25);
    assert.ok(v1.flags.includes('LATE_ARRIVAL'));
    // Wednesday 14 October: version 2 (10:00 start), so 09:25 is early, not late; leaving at 18:00 is an hour early.
    const v2 = await check(OWN, '2026-10-14', [session(OWN, '2026-10-14', '09:25', '18:00')]);
    assert.equal(v2.lateArrivalMinutes, 0);
    assert.equal(v2.earlyLeaveMinutes, 60);
  });

  it('falls back to the team schedule once a person\'s own schedule has ended, then to the organisation default', async () => {
    // 2 November: OWN's last version ended on 30 October, so the team's 09:00 start applies.
    assert.equal((await check(OWN, '2026-11-02', [session(OWN, '2026-11-02', '09:05', '18:00')])).lateArrivalMinutes, 0);
    assert.equal((await check(OWN, '2026-11-02', [session(OWN, '2026-11-02', '09:30', '18:00')])).lateArrivalMinutes, 30);
    assert.equal((await check(TEAMMATE, '2026-10-14', [session(TEAMMATE, '2026-10-14', '09:30', '18:00')])).lateArrivalMinutes, 30, 'team schedule');
    assert.equal((await check(LONER, '2026-10-14', [session(LONER, '2026-10-14', '08:30', '17:00')])).lateArrivalMinutes, 30, 'organisation default 08:00');
    // A schedule that starts in the future does not apply yet.
    await save({ userId: LONER, days: weekdays({ start: '12:00', end: '20:00', expectedHours: 7 }), effectiveFrom: '2026-12-01' });
    assert.equal((await check(LONER, '2026-10-14', [])).expectedSeconds, 8 * 3600);
    assert.equal((await check(LONER, '2026-12-02', [])).expectedSeconds, 7 * 3600);
  });

  it('flexible hours keep expected time and absence, but never flag late arrival or early leave', async () => {
    const FLEX = '5c5c0000-0000-4000-8000-000000000014';
    await adminPool.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, 'flex@sched.test', 'EMPLOYEE')`, [FLEX, ORG]);
    await save({ userId: FLEX, flexible: true, days: weekdays(NINE_TO_SIX), effectiveFrom: '2026-01-01' });
    const day = await check(FLEX, '2026-10-14', [session(FLEX, '2026-10-14', '11:00', '15:00')]);
    assert.equal(day.lateArrivalMinutes, 0);
    assert.equal(day.earlyLeaveMinutes, 0);
    assert.equal(day.expectedSeconds, 8 * 3600);
    assert.deepEqual(day.flags, []);
    assert.deepEqual((await check(FLEX, '2026-10-15', [])).flags, ['ABSENT'], 'no sessions on a working day is still absent');
  });

  it('late arrival and early leave have separate grace minutes', async () => {
    const GRACE = '5c5c0000-0000-4000-8000-000000000015';
    await adminPool.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, 'grace@sched.test', 'EMPLOYEE')`, [GRACE, ORG]);
    await save({ userId: GRACE, graceMinutes: 5, earlyLeaveGraceMinutes: 30, days: weekdays(NINE_TO_SIX), effectiveFrom: '2026-01-01' });
    const within = await check(GRACE, '2026-10-14', [session(GRACE, '2026-10-14', '09:04', '17:35')]);
    assert.deepEqual([within.lateArrivalMinutes, within.earlyLeaveMinutes], [0, 0], '4 min late is within 5; 25 min early is within 30');
    const beyond = await check(GRACE, '2026-10-15', [session(GRACE, '2026-10-15', '09:06', '17:20')]);
    assert.deepEqual([beyond.lateArrivalMinutes, beyond.earlyLeaveMinutes], [6, 40]);
    assert.ok(beyond.flags.includes('LATE_ARRIVAL') && beyond.flags.includes('EARLY_LEAVE'));
    // Without its own early-leave grace a schedule uses the late-arrival grace for both, as before.
    assert.equal((await check(TEAMMATE, '2026-10-14', [session(TEAMMATE, '2026-10-14', '09:00', '17:45')])).earlyLeaveMinutes, 15);
  });

  it('break time beyond the allowance is flagged and does not change net time', async () => {
    const BREAKS = '5c5c0000-0000-4000-8000-000000000016';
    await adminPool.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, 'breaks@sched.test', 'EMPLOYEE')`, [BREAKS, ORG]);
    await save({ userId: BREAKS, breakAllowanceMinutes: 60, days: weekdays({ start: '09:00', end: '18:00', expectedHours: 7 }), effectiveFrom: '2026-01-01' });
    const over = [session(BREAKS, '2026-10-14', '09:00', '18:00', 50), session(BREAKS, '2026-10-14', '18:00', '18:30', 25)];
    const day = await check(BREAKS, '2026-10-14', over);
    assert.equal(day.excessBreakMinutes, 15);
    assert.ok(day.flags.includes('EXCESS_BREAK'));
    assert.equal(day.actualSeconds, over.reduce((s, x) => s + x.netSeconds, 0), 'net time is unchanged');
    assert.equal((await check(BREAKS, '2026-10-15', [session(BREAKS, '2026-10-15', '09:00', '18:00', 60)])).excessBreakMinutes, 0, 'exactly the allowance');
    assert.equal((await check(TEAMMATE, '2026-10-14', [session(TEAMMATE, '2026-10-14', '09:00', '18:00', 180)])).excessBreakMinutes, 0, 'no allowance set: no limit');
  });

  it('the stored day carries the excess break, and the nightly replay compares it', async () => {
    const WATCH = '5c5c0000-0000-4000-8000-000000000017';
    await adminPool.query(`INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, 'watch@sched.test', 'EMPLOYEE')`, [WATCH, ORG]);
    await save({ userId: WATCH, breakAllowanceMinutes: 30, days: weekdays(NINE_TO_SIX), effectiveFrom: '2026-01-01' });
    const s = session(WATCH, '2026-10-16', '09:00', '18:00', 45);
    await repo.saveSession(s);
    const daily = await service.recomputeDailySummaryForUser(ORG, WATCH, '2026-10-16');
    assert.equal(daily?.excessBreakMinutes, 15);
    const stored = await adminPool.query(`SELECT excess_break_minutes FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = '2026-10-16'`, [ORG, WATCH]);
    assert.equal(stored.rows[0].excess_break_minutes, 15);
    // NFR-ACC-004: every computed field of a day is one the nightly replay compares, this one included.
    const identity = new Set(['orgId', 'userId', 'workDate']);
    const computed = Object.keys(await service.computeDailySummary(ORG, WATCH, '2026-10-16')).filter((k) => !identity.has(k));
    assert.deepEqual(computed.filter((k) => !(REPLAY_FIELDS as readonly string[]).includes(k)), [], 'fields the replay would not check');
    assert.ok((REPLAY_FIELDS as readonly string[]).includes('excessBreakMinutes'));
  });
});
