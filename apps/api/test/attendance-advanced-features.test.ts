/**
 * TDD Test Suite: Advanced Attendance Capabilities (FR-ATT-013..020 & FR-TS-001)
 *
 * Requirements Covered:
 * - FR-ATT-013: Corrections workflow (user request, manager review, status ADJUSTED, self-approval prevention, audit logs)
 * - FR-ATT-014: Schedule compliance (late arrival, early leave, absence, overtime, holiday/leave suppression)
 * - FR-ATT-015 & Section 6.3: Daily record + idempotent daily close job + FR-TS-001 draft timesheet
 * - FR-ATT-016: Live board with role-scoped visibility (Team Lead vs HR/Admin)
 * - FR-ATT-019: CSV and XLSX export with permission guards and audit logging
 * - FR-ATT-020 & FR-AUD-004: Transparency "what we collect" text, raw events, and monitoring notice consent
 * - Row-Level Security (RLS) enforcement on all new tables
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  UserRole,
  CorrectionStatus,
  InMemoryHolidayProvider,
  InMemoryLeaveProvider,
} from '../../../packages/shared/src/attendance/types.ts';
import type { Clock } from '../../../packages/shared/src/attendance/types.ts';
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { AttendanceService } from '../src/attendance/attendance.service.ts';

class ControllableClock implements Clock {
  private currentTime: Date;
  constructor(initialTime: Date) {
    this.currentTime = new Date(initialTime);
  }
  now(): Date {
    return new Date(this.currentTime);
  }
  setTime(time: Date): void {
    this.currentTime = new Date(time);
  }
  advanceSeconds(seconds: number): void {
    this.currentTime = new Date(this.currentTime.getTime() + seconds * 1000);
  }
}

describe('Advanced Attendance Capabilities (FR-ATT-013..020, FR-TS-001, RLS & Auditing)', () => {
  let adminPool: pg.Pool;
  let repo: PostgresAttendanceRepository;
  let service: AttendanceService;
  let clock: ControllableClock;
  let holidayProvider: InMemoryHolidayProvider;
  let leaveProvider: InMemoryLeaveProvider;

  const orgA = 'aaaa1111-1111-1111-1111-111111111111';
  const orgB = 'bbbb2222-2222-2222-2222-222222222222';
  const teamAlpha = 'cccc3333-3333-3333-3333-333333333333';
  const teamBeta = 'dddd4444-4444-4444-4444-444444444444';

  const userEmployee = 'eeee5555-5555-5555-5555-555555555551';
  const userLead = 'eeee5555-5555-5555-5555-555555555552';
  const userManager = 'eeee5555-5555-5555-5555-555555555553';
  const userHr = 'eeee5555-5555-5555-5555-555555555554';
  const userOtherTeam = 'eeee5555-5555-5555-5555-555555555555';
  const userOrgB = 'ffff6666-6666-6666-6666-666666666666';

  before(async () => {
    clock = new ControllableClock(new Date('2026-10-14T15:00:00Z')); // 20:30 Asia/Colombo
    holidayProvider = new InMemoryHolidayProvider();
    leaveProvider = new InMemoryLeaveProvider();

    adminPool = new pg.Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5433', 10),
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'hrvo_dev',
    });

    // Clean up test data for these isolated test orgs only
    await adminPool.query(`DELETE FROM organizations WHERE id IN ('${orgA}', '${orgB}')`);

    // Seed organizations
    await adminPool.query(`
      INSERT INTO organizations (id, name, slug, timezone)
      VALUES 
        ('${orgA}', 'Acme Corp', 'acme-advanced', 'Asia/Colombo'),
        ('${orgB}', 'Beta Corp', 'beta-advanced', 'Asia/Colombo')
    `);

    // Seed teams (lead_id is set after users exist: teams.lead_id references users)
    await adminPool.query(`
      INSERT INTO teams (id, org_id, name)
      VALUES
        ('${teamAlpha}', '${orgA}', 'Engineering Alpha'),
        ('${teamBeta}', '${orgA}', 'Marketing Beta')
    `);

    // Seed users
    await adminPool.query(`
      INSERT INTO users (id, org_id, email, display_name, role, team_id, manager_id)
      VALUES
        ('${userEmployee}', '${orgA}', 'emp@acme.com', 'Alice Employee', 'EMPLOYEE', '${teamAlpha}', '${userManager}'),
        ('${userLead}', '${orgA}', 'lead@acme.com', 'Bob Lead', 'TEAM_LEAD', '${teamAlpha}', '${userManager}'),
        ('${userManager}', '${orgA}', 'mgr@acme.com', 'Charlie Manager', 'MANAGER', NULL, NULL),
        ('${userHr}', '${orgA}', 'hr@acme.com', 'Diana HR', 'HR', NULL, NULL),
        ('${userOtherTeam}', '${orgA}', 'other@acme.com', 'Eve Marketing', 'EMPLOYEE', '${teamBeta}', '${userManager}'),
        ('${userOrgB}', '${orgB}', 'user@beta.com', 'Frank Beta', 'EMPLOYEE', NULL, NULL)
    `);
    await adminPool.query(`UPDATE teams SET lead_id = '${userLead}' WHERE id = '${teamAlpha}'`);

    repo = new PostgresAttendanceRepository();
    service = new AttendanceService({}, clock, repo, orgA, holidayProvider, leaveProvider);
  });

  after(async () => {
    await repo.clearAll(orgA);
    await repo.clearAll(orgB);
    await repo.close();
    await adminPool.end();
  });

  // 1. FR-ATT-013: Attendance Corrections
  describe('FR-ATT-013: Correction Workflow', () => {
    let sessionId: string;

    before(async () => {
      // Create a session for userEmployee
      sessionId = crypto.randomUUID();
      await repo.saveSession({
        id: sessionId,
        orgId: orgA,
        userId: userEmployee,
        deviceId: 'dev-1',
        workDate: '2026-10-14',
        clockInAt: new Date('2026-10-14T04:00:00Z'), // 09:30 local
        clockOutAt: new Date('2026-10-14T12:00:00Z'), // 17:30 local
        clockInSource: 'AUTO_HEARTBEAT',
        clockOutSource: 'LOGOUT',
        activeSeconds: 28800,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 28800,
        lastHeartbeatAt: new Date('2026-10-14T12:00:00Z'),
        ipIn: '127.0.0.1',
        ipOut: '127.0.0.1',
        flags: [],
        status: 'CLOSED',
        currentState: 'OFFLINE',
        segments: [],
        consecutiveIdleSeconds: 0,
      });
    });

    it('Allows employee to submit a correction request for an inaccurate session', async () => {
      const correction = await service.requestCorrection({
        orgId: orgA,
        userId: userEmployee,
        sessionId,
        requestedIn: new Date('2026-10-14T03:30:00Z'), // 09:00 local (fixed missed 30m)
        requestedOut: new Date('2026-10-14T12:30:00Z'), // 18:00 local
        reason: 'Office badge was delayed and internet dropped at exit',
      });

      assert.ok(correction.id);
      assert.equal(correction.status, CorrectionStatus.PENDING);
      assert.equal(correction.userId, userEmployee);

      // Verify audit log entry was created for request
      const logs = await repo.findAuditLogs(orgA, 'ATTENDANCE_CORRECTION', correction.id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].action, 'ATTENDANCE_CORRECTION_REQUESTED');
    });

    it('Strictly prevents user from approving their own correction request', async () => {
      const pendingList = await service.getPendingCorrections(orgA);
      const correction = pendingList[0];

      await assert.rejects(
        async () => {
          await service.reviewCorrection({
            orgId: orgA,
            reviewerId: userEmployee, // Self-approval attempt!
            reviewerRole: UserRole.EMPLOYEE,
            correctionId: correction.id,
            approved: true,
          });
        },
        /User cannot approve their own correction/i,
      );
    });

    it('Rejects review attempt from an unauthorized user (neither manager nor HR)', async () => {
      const pendingList = await service.getPendingCorrections(orgA);
      const correction = pendingList[0];

      await assert.rejects(
        async () => {
          await service.reviewCorrection({
            orgId: orgA,
            reviewerId: userOtherTeam,
            reviewerRole: UserRole.EMPLOYEE,
            correctionId: correction.id,
            approved: true,
          });
        },
        /Unauthorized to review correction/i,
      );
    });

    it('Manager approves correction: preserves original session, marks original ADJUSTED, creates adjusted session & audit log', async () => {
      const pendingList = await service.getPendingCorrections(orgA);
      const correction = pendingList[0];

      const result = await service.reviewCorrection({
        orgId: orgA,
        reviewerId: userManager,
        reviewerRole: UserRole.MANAGER,
        correctionId: correction.id,
        approved: true,
        reviewNote: 'Verified with office CCTV and task logs',
      });

      assert.equal(result.correction.status, CorrectionStatus.APPROVED);
      assert.equal(result.correction.reviewerId, userManager);

      // Verify original session is preserved and status is ADJUSTED
      const originalSession = await repo.findSessionById(orgA, sessionId);
      assert.ok(originalSession);
      assert.equal(originalSession.status, 'ADJUSTED');

      // Verify adjusted session was created with requested times
      assert.ok(result.adjustedSession);
      assert.equal(result.adjustedSession.clockInSource, 'CORRECTION');
      assert.equal(result.adjustedSession.clockOutSource, 'CORRECTION');
      assert.equal(result.adjustedSession.clockInAt.toISOString(), '2026-10-14T03:30:00.000Z');
      assert.equal(result.adjustedSession.clockOutAt?.toISOString(), '2026-10-14T12:30:00.000Z');

      // Verify tamper-evident audit log
      const logs = await repo.findAuditLogs(orgA, 'ATTENDANCE_CORRECTION', correction.id);
      assert.equal(logs.length, 2); // Requested + Approved
      assert.equal(logs[1].action, 'ATTENDANCE_CORRECTION_APPROVED');
      assert.equal(logs[1].actorId, userManager);
    });
  });

  // 2. FR-ATT-014: Schedule Compliance
  describe('FR-ATT-014: Schedule Compliance Engine', () => {
    before(async () => {
      // Work schedule: Monday to Friday 09:00 to 18:00 (expected 8h net), 10m grace
      await repo.saveWorkSchedule({
        id: crypto.randomUUID(),
        orgId: orgA,
        userId: userEmployee,
        days: {
          '1': { start: '09:00', end: '18:00', expectedHours: 8 },
          '2': { start: '09:00', end: '18:00', expectedHours: 8 },
          '3': { start: '09:00', end: '18:00', expectedHours: 8 },
          '4': { start: '09:00', end: '18:00', expectedHours: 8 },
          '5': { start: '09:00', end: '18:00', expectedHours: 8 },
        },
        flexible: false,
        graceMinutes: 10,
        effectiveFrom: '2026-01-01',
      });
    });

    it('Computes late arrival when clock-in exceeds start + grace minutes', async () => {
      // 2026-10-14 is Wednesday (day 3). Schedule start 09:00 + 10m grace = 09:10
      // In UTC: Asia/Colombo is +05:30. 09:00 local = 03:30 UTC. 09:25 local = 03:55 UTC (25m late).
      const compliance = await service.computeScheduleCompliance({
        orgId: orgA,
        userId: userEmployee,
        workDate: '2026-10-14',
        sessions: [
          {
            id: crypto.randomUUID(),
            orgId: orgA,
            userId: userEmployee,
            deviceId: 'dev-1',
            workDate: '2026-10-14',
            clockInAt: new Date('2026-10-14T03:55:00Z'), // 09:25 local
            clockOutAt: new Date('2026-10-14T12:30:00Z'), // 18:00 local
            clockInSource: 'AUTO_HEARTBEAT',
            clockOutSource: 'LOGOUT',
            activeSeconds: 28800,
            idleSeconds: 0,
            breakSeconds: 0,
            meetingSeconds: 0,
            netSeconds: 28800,
            lastHeartbeatAt: new Date('2026-10-14T12:30:00Z'),
            ipIn: '127.0.0.1',
            ipOut: '127.0.0.1',
            flags: [],
            status: 'CLOSED',
            currentState: 'OFFLINE',
            segments: [],
            consecutiveIdleSeconds: 0,
          },
        ],
      });

      assert.equal(compliance.lateArrivalMinutes, 25);
      assert.ok(compliance.flags.includes('LATE_ARRIVAL'));
    });

    it('Computes early leave when clock-out precedes end - grace minutes', async () => {
      // Schedule end 18:00 local = 12:30 UTC. User clocks out at 17:30 local = 12:00 UTC (30m early).
      const compliance = await service.computeScheduleCompliance({
        orgId: orgA,
        userId: userEmployee,
        workDate: '2026-10-14',
        sessions: [
          {
            id: crypto.randomUUID(),
            orgId: orgA,
            userId: userEmployee,
            deviceId: 'dev-1',
            workDate: '2026-10-14',
            clockInAt: new Date('2026-10-14T03:30:00Z'), // 09:00 local
            clockOutAt: new Date('2026-10-14T12:00:00Z'), // 17:30 local
            clockInSource: 'AUTO_HEARTBEAT',
            clockOutSource: 'LOGOUT',
            activeSeconds: 27000,
            idleSeconds: 0,
            breakSeconds: 0,
            meetingSeconds: 0,
            netSeconds: 27000,
            lastHeartbeatAt: new Date('2026-10-14T12:00:00Z'),
            ipIn: '127.0.0.1',
            ipOut: '127.0.0.1',
            flags: [],
            status: 'CLOSED',
            currentState: 'OFFLINE',
            segments: [],
            consecutiveIdleSeconds: 0,
          },
        ],
      });

      assert.equal(compliance.earlyLeaveMinutes, 30);
      assert.ok(compliance.flags.includes('EARLY_LEAVE'));
    });

    it('Computes overtime when net hours exceed scheduled expected hours', async () => {
      // Net hours 9.5 hours (34200 seconds) vs 8 hours expected (28800) -> 90 mins overtime
      const compliance = await service.computeScheduleCompliance({
        orgId: orgA,
        userId: userEmployee,
        workDate: '2026-10-14',
        sessions: [
          {
            id: crypto.randomUUID(),
            orgId: orgA,
            userId: userEmployee,
            deviceId: 'dev-1',
            workDate: '2026-10-14',
            clockInAt: new Date('2026-10-14T03:30:00Z'),
            clockOutAt: new Date('2026-10-14T13:30:00Z'),
            clockInSource: 'AUTO_HEARTBEAT',
            clockOutSource: 'LOGOUT',
            activeSeconds: 34200,
            idleSeconds: 0,
            breakSeconds: 0,
            meetingSeconds: 0,
            netSeconds: 34200,
            lastHeartbeatAt: new Date('2026-10-14T13:30:00Z'),
            ipIn: '127.0.0.1',
            ipOut: '127.0.0.1',
            flags: [],
            status: 'CLOSED',
            currentState: 'OFFLINE',
            segments: [],
            consecutiveIdleSeconds: 0,
          },
        ],
      });

      assert.equal(compliance.overtimeMinutes, 90);
      assert.ok(compliance.flags.includes('OVERTIME'));
    });

    it('Suppresses absence and late flags when day is an approved holiday', async () => {
      holidayProvider.addHoliday(orgA, '2026-10-15');

      const compliance = await service.computeScheduleCompliance({
        orgId: orgA,
        userId: userEmployee,
        workDate: '2026-10-15',
        sessions: [], // Zero attendance
      });

      assert.equal(compliance.isHoliday, true);
      assert.equal(compliance.isAbsent, false);
      assert.equal(compliance.expectedSeconds, 0);
    });

    it('Suppresses absence alerts when user is on approved leave', async () => {
      leaveProvider.addLeave(orgA, userEmployee, '2026-10-16');

      const compliance = await service.computeScheduleCompliance({
        orgId: orgA,
        userId: userEmployee,
        workDate: '2026-10-16',
        sessions: [], // Zero attendance
      });

      assert.equal(compliance.isOnLeave, true);
      assert.equal(compliance.isAbsent, false);
      assert.equal(compliance.expectedSeconds, 0);
    });

    it('Flags ABSENT when scheduled day has zero attendance and neither holiday nor leave', async () => {
      const compliance = await service.computeScheduleCompliance({
        orgId: orgA,
        userId: userEmployee,
        workDate: '2026-10-14',
        sessions: [], // Zero attendance on regular Wednesday
      });

      assert.equal(compliance.isAbsent, true);
      assert.ok(compliance.flags.includes('ABSENT'));
    });
  });

  // 3. FR-ATT-015, Section 6.3 & FR-TS-001: Daily Record & Daily Close Job
  describe('FR-ATT-015 & Section 6.3: Daily Close Job & Draft Timesheets (FR-TS-001)', () => {
    it('Executes idempotent daily close job and produces attendance_daily + draft_timesheets', async () => {
      // Run daily close job for 2026-10-14
      const summaries = await service.runDailyCloseJob(orgA, '2026-10-14');
      assert.ok(summaries.length > 0);

      // Verify attendance_daily record persisted for userEmployee
      const daily = await repo.findDailyAttendance(orgA, userEmployee, '2026-10-14');
      assert.ok(daily);
      assert.equal(daily.workDate, '2026-10-14');
      assert.ok(daily.netSeconds > 0);

      // FR-TS-001: Verify draft timesheet was generated
      const timesheet = await repo.findDraftTimesheet(orgA, userEmployee, '2026-10-14');
      assert.ok(timesheet);
      assert.equal(timesheet.status, 'DRAFT');
      assert.equal(timesheet.attendanceMinutes, Math.floor(daily.netSeconds / 60));

      // IDEMPOTENCY TEST: Running daily close job a second time yields exact same result without duplicate errors
      const secondRun = await service.runDailyCloseJob(orgA, '2026-10-14');
      assert.equal(secondRun.length, summaries.length);

      const dailyAfterSecondRun = await repo.findDailyAttendance(orgA, userEmployee, '2026-10-14');
      assert.equal(dailyAfterSecondRun?.netSeconds, daily.netSeconds);
    });
  });

  // 4. FR-ATT-016: Live Attendance Board
  describe('FR-ATT-016: Live Attendance Board with Role Scoping', () => {
    it('HR role can see all users in the organization on the live board', async () => {
      const board = await service.getLiveBoard({
        orgId: orgA,
        callerUserId: userHr,
        callerRole: UserRole.HR,
      });

      // Org A has 5 users seeded
      assert.equal(board.length, 5);
      const userIds = board.map((u) => u.userId);
      assert.ok(userIds.includes(userEmployee));
      assert.ok(userIds.includes(userOtherTeam));
    });

    it('Team Lead role can ONLY see members of their own team (teamAlpha)', async () => {
      const board = await service.getLiveBoard({
        orgId: orgA,
        callerUserId: userLead,
        callerRole: UserRole.TEAM_LEAD,
        callerTeamId: teamAlpha,
      });

      // teamAlpha has userEmployee and userLead
      assert.equal(board.length, 2);
      const userIds = board.map((u) => u.userId);
      assert.ok(userIds.includes(userEmployee));
      assert.ok(userIds.includes(userLead));
      assert.ok(!userIds.includes(userOtherTeam)); // teamBeta user must NOT be visible!
    });
  });

  // 5. FR-ATT-019: Exports (CSV & XLSX)
  describe('FR-ATT-019: Attendance Data Export', () => {
    it('Rejects export request if caller lacks export permission', async () => {
      await assert.rejects(
        async () => {
          await service.exportAttendanceCsv({
            orgId: orgA,
            callerUserId: userEmployee,
            callerRole: UserRole.EMPLOYEE,
            filter: { startDate: '2026-10-01', endDate: '2026-10-14' },
          });
        },
        /Export permission denied/i,
      );
    });

    it('HR exports CSV: returns valid CSV header and rows, and creates an audit log entry', async () => {
      const csv = await service.exportAttendanceCsv({
        orgId: orgA,
        callerUserId: userHr,
        callerRole: UserRole.HR,
        filter: { startDate: '2026-10-01', endDate: '2026-10-14' },
      });

      assert.ok(csv.includes('work_date,user_id,display_name,email,first_in,last_out,net_hours,status'));
      assert.ok(csv.includes('emp@acme.com'));

      // Verify audit log
      const logs = await repo.findAuditLogs(orgA, 'EXPORT');
      assert.equal(logs.length, 1);
      assert.equal(logs[0].action, 'ATTENDANCE_EXPORTED');
      assert.equal((logs[0].after as { format?: string } | null)?.format, 'CSV');
    });

    it('HR exports XLSX with exceljs: returns valid binary buffer and creates an audit log entry', async () => {
      const buffer = await service.exportAttendanceXlsx({
        orgId: orgA,
        callerUserId: userHr,
        callerRole: UserRole.HR,
        filter: { startDate: '2026-10-01', endDate: '2026-10-14' },
      });

      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 100);
      // PK signature for ZIP/XLSX is [0x50, 0x4B, 0x03, 0x04]
      assert.equal(buffer[0], 0x50);
      assert.equal(buffer[1], 0x4b);

      const logs = await repo.findAuditLogs(orgA, 'EXPORT');
      assert.equal(logs.length, 2);
      assert.equal(logs[1].action, 'ATTENDANCE_EXPORTED');
      assert.equal((logs[1].after as { format?: string } | null)?.format, 'XLSX');
    });
  });

  // 6. FR-ATT-020 & FR-AUD-004: Transparency & Monitoring Consent
  describe('FR-ATT-020 & FR-AUD-004: Transparency & Monitoring Consent', () => {
    it('GET /attendance/me/events returns user raw events and plain-language "what we collect" text', async () => {
      // Record a presence event
      await repo.recordPresenceEvent({
        orgId: orgA,
        userId: userEmployee,
        serverTs: new Date('2026-10-14T03:00:00Z'),
        eventType: 'HEARTBEAT',
        state: 'ACTIVE',
        seq: 1,
        ip: '127.0.0.1',
        meta: { activeSeconds: 30, idleSeconds: 0 },
      });

      const transparency = await service.getTransparencyEvents({
        orgId: orgA,
        userId: userEmployee,
      });

      assert.ok(transparency.plainLanguageNotice.length > 50);
      assert.ok(transparency.plainLanguageNotice.includes('No keystroke content'));
      assert.ok(transparency.plainLanguageNotice.includes('No screenshots'));
      assert.equal(transparency.retentionDays, 90);
      assert.ok(transparency.events.length >= 1);
      assert.equal(transparency.events[0].eventType, 'HEARTBEAT');
    });

    it('FR-AUD-004: Stores monitoring notice acceptance with version and server timestamp', async () => {
      const consent = await service.recordMonitoringConsent({
        orgId: orgA,
        userId: userEmployee,
        noticeVersion: 'v1.0.0',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0 TestBrowser',
      });

      assert.ok(consent.id);
      assert.equal(consent.noticeVersion, 'v1.0.0');
      assert.equal(consent.userId, userEmployee);

      const stored = await repo.findMonitoringConsentsByUser(orgA, userEmployee);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].noticeVersion, 'v1.0.0');
    });
  });

  // 7. Security: Row-Level Security & Audit Log Hash Chaining
  describe('Security: RLS & Tamper-Evident Audit Chain', () => {
    it('RLS: Org A context cannot SELECT rows from Org B on any new table', async () => {
      // Insert correction in Org B
      await repo.createCorrection({
        id: crypto.randomUUID(),
        orgId: orgB,
        userId: userOrgB,
        requestedIn: new Date(),
        requestedOut: new Date(),
        reason: 'Org B correction',
        status: CorrectionStatus.PENDING,
        createdAt: new Date(),
      });

      // Query from Org A context must return 0 rows
      const correctionsOrgA = await repo.findPendingCorrections(orgA);
      const bItems = correctionsOrgA.filter((c) => c.orgId === orgB);
      assert.equal(bItems.length, 0);
    });

    it('Audit log hash chain forms a valid tamper-evident cryptographic chain', async () => {
      const isValid = await repo.verifyAuditLogChain(orgA);
      assert.equal(isValid, true);
    });
  });
});
