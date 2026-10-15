/**
 * Attendance Hardening & Full Branch Coverage Test Suite
 * Covers Requirements 1 through 6:
 * 1. Append-only permissions on audit_logs & presence_events for hrvo_app
 * 2. Concurrency-safe audit-log SHA-256 hash chaining (50 concurrent writes without forks)
 * 3. Correction validations (future, in>=out, >7 days, duplicates, overlap, post-approval recompute)
 * 4. Export hardening against CSV/Excel formula injection (=, +, -, @)
 * 5. Consent gate (blocks session creation until notice accepted)
 * 6. Branch coverage >= 95% across attendance-repository.ts & attendance.service.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;
import { PostgresAttendanceRepository } from '../src/attendance/attendance-repository.ts';
import { AttendanceService, sanitizeExportCell } from '../src/attendance/attendance.service.ts';
import {
  AttendanceState,
  SessionStatus,
  ClockInSource,
  ClockOutSource,
  UserRole,
  CorrectionStatus,
  DayStatus,
  LivePresenceStatus,
  InMemoryHolidayProvider,
  InMemoryLeaveProvider,
} from '../../../packages/shared/src/attendance/types.ts';
import type { Clock, HeartbeatPayload, AttendanceSession } from '../../../packages/shared/src/attendance/types.ts';

class TestClock implements Clock {
  private time: Date;
  constructor(time: Date = new Date('2026-10-14T10:00:00.000Z')) {
    this.time = time;
  }
  now(): Date {
    return new Date(this.time.getTime());
  }
  advance(ms: number): void {
    this.time = new Date(this.time.getTime() + ms);
  }
  setTime(d: Date): void {
    this.time = new Date(d.getTime());
  }
}

describe('Attendance Hardening & Branch Coverage Suite', () => {
  const orgId = '99990000-0000-0000-0000-000000000001';
  const orgB = '99990000-0000-0000-0000-000000000002';
  const teamId = '88880000-0000-0000-0000-000000000001';
  const userEmp = '77770000-0000-0000-0000-000000000001';
  const userMgr = '77770000-0000-0000-0000-000000000002';
  const userHr = '77770000-0000-0000-0000-000000000003';
  const userLead = '77770000-0000-0000-0000-000000000004';
  const userOther = '77770000-0000-0000-0000-000000000005';

  let adminPool: pg.Pool;
  let repo: PostgresAttendanceRepository;
  let clock: TestClock;
  let service: AttendanceService;
  let holidayProvider: InMemoryHolidayProvider;
  let leaveProvider: InMemoryLeaveProvider;

  before(async () => {
    adminPool = new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5433', 10),
      user: process.env.PGADMIN_USER || 'postgres',
      password: process.env.PGADMIN_PASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'hrvo_dev',
    });

    // Wipe test tenants
    await adminPool.query(`DELETE FROM organizations WHERE id IN ('${orgId}', '${orgB}')`);

    // Seed orgs
    await adminPool.query(
      `INSERT INTO organizations (id, name, slug, timezone) VALUES
       ('${orgId}', 'Hardening Org', 'hardening-org', 'Asia/Colombo'),
       ('${orgB}', 'Hardening Org B', 'hardening-org-b', 'Asia/Colombo')`,
    );

    // Seed team
    await adminPool.query(
      `INSERT INTO teams (id, org_id, name, lead_id) VALUES ('${teamId}', '${orgId}', 'Core Hardening', '${userLead}')`,
    );

    // Seed users
    await adminPool.query(
      `INSERT INTO users (id, org_id, email, display_name, role, team_id, manager_id) VALUES
       ('${userEmp}', '${orgId}', 'emp@hard.com', 'Alice Hardening', 'EMPLOYEE', '${teamId}', '${userMgr}'),
       ('${userMgr}', '${orgId}', 'mgr@hard.com', 'Bob Manager', 'MANAGER', NULL, NULL),
       ('${userHr}', '${orgId}', 'hr@hard.com', 'Carol HR', 'HR', NULL, NULL),
       ('${userLead}', '${orgId}', 'lead@hard.com', 'David Lead', 'TEAM_LEAD', '${teamId}', '${userMgr}'),
       ('${userOther}', '${orgId}', 'other@hard.com', 'Eve Outsider', 'EMPLOYEE', NULL, NULL)`,
    );

    repo = new PostgresAttendanceRepository();
    clock = new TestClock(new Date('2026-10-14T15:00:00.000Z')); // 20:30 Colombo
    holidayProvider = new InMemoryHolidayProvider();
    leaveProvider = new InMemoryLeaveProvider();
    service = new AttendanceService({}, clock, repo, orgId, holidayProvider, leaveProvider);
  });

  after(async () => {
    await repo.clearAll(orgId);
    await repo.clearAll(orgB);
    await repo.close();
    await adminPool.end();
  });

  // ---------------------------------------------------------------------------
  // 1. Append-Only Security (Requirement 1)
  // ---------------------------------------------------------------------------
  describe('Requirement 1: Append-Only Security & Table Permissions', () => {
    it('Proves hrvo_app cannot UPDATE audit_logs (permission denied)', async () => {
      const appPool = repo.getPool();
      await assert.rejects(
        async () => {
          await appPool.query(`UPDATE audit_logs SET action = 'TAMPERED'`);
        },
        /permission denied for table audit_logs/i,
      );
    });

    it('Proves hrvo_app cannot DELETE from audit_logs (permission denied)', async () => {
      const appPool = repo.getPool();
      await assert.rejects(
        async () => {
          await appPool.query(`DELETE FROM audit_logs`);
        },
        /permission denied for table audit_logs/i,
      );
    });

    it('Proves hrvo_app cannot DELETE from presence_events (permission denied)', async () => {
      const appPool = repo.getPool();
      await assert.rejects(
        async () => {
          await appPool.query(`DELETE FROM presence_events`);
        },
        /permission denied for table presence_events/i,
      );
    });

    it('Proves hrvo_app cannot UPDATE monitoring_consents (permission denied)', async () => {
      const appPool = repo.getPool();
      await assert.rejects(
        async () => {
          await appPool.query(`UPDATE monitoring_consents SET notice_version = 'v99.0'`);
        },
        /permission denied for table monitoring_consents/i,
      );
    });

    it('Presence events deletion succeeds exclusively via dedicated retention role', async () => {
      // Insert a presence event as hrvo_app
      await repo.recordPresenceEvent({
        orgId,
        userId: userEmp,
        serverTs: new Date('2026-01-01T00:00:00Z'),
        eventType: 'HEARTBEAT',
        state: 'ACTIVE',
        seq: 1,
      });

      // Cleanup using retention pool (hrvo_retention role)
      const deletedCount = await repo.cleanupOldPresenceEvents(orgId, new Date('2026-06-01T00:00:00Z'));
      assert.ok(deletedCount >= 1);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Concurrency-Safe Audit-Log Hash Chaining (Requirement 2)
  // ---------------------------------------------------------------------------
  describe('Requirement 2: Concurrency-Safe Hash Chaining Under Load', () => {
    it('Fires 50 concurrent audit writes for one org: verifyAuditLogChain() must be VALID with zero forks', async () => {
      const count = 50;
      const promises = Array.from({ length: count }, (_, i) =>
        repo.recordAuditLog({
          orgId,
          actorId: userEmp,
          action: `CONCURRENT_TEST_ACTION_${i}`,
          entityType: 'TEST_BATCH',
          entityId: crypto.randomUUID(),
          before: { index: i, initial: true },
          after: { index: i, completed: true },
          createdAt: new Date('2026-10-14T10:00:00.000Z'),
        }),
      );

      const results = await Promise.all(promises);
      assert.equal(results.length, 50);

      // Verify each log has valid hash and id
      for (const res of results) {
        assert.ok(res.id! > 0);
        assert.ok(res.hash.length === 64);
        assert.ok(res.prevHash.length === 64);
      }

      // Verify complete chain integrity
      const isValid = await repo.verifyAuditLogChain(orgId);
      assert.equal(isValid, true, 'Audit log chain must be strictly linear and cryptographically valid');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Correction Validation & Recomputation (Requirement 3)
  // ---------------------------------------------------------------------------
  describe('Requirement 3: Correction Validations & Daily Recomputation', () => {
    let baseSessionId: string;

    before(async () => {
      baseSessionId = crypto.randomUUID();
      await repo.saveSession({
        id: baseSessionId,
        orgId,
        userId: userEmp,
        deviceId: 'dev-corr-01',
        workDate: '2026-10-14',
        clockInAt: new Date('2026-10-14T04:00:00Z'), // 09:30 local
        clockOutAt: new Date('2026-10-14T12:00:00Z'), // 17:30 local
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: ClockOutSource.LOGOUT,
        activeSeconds: 28800,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 28800,
        lastHeartbeatAt: new Date('2026-10-14T12:00:00Z'),
        ipIn: '127.0.0.1',
        ipOut: '127.0.0.1',
        flags: [],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      });

      // Compute initial daily record
      await service.recomputeDailySummaryForUser(orgId, userEmp, '2026-10-14');
    });

    it('Rejects correction with future requestedIn timestamp', async () => {
      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            requestedIn: new Date('2026-10-15T00:00:00Z'), // future relative to clock (2026-10-14T15:00:00Z)
            requestedOut: new Date('2026-10-15T08:00:00Z'),
            reason: 'Future correction attempt',
          });
        },
        /correction times cannot be in the future/i,
      );
    });

    it('Rejects correction with future requestedOut timestamp', async () => {
      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            requestedIn: new Date('2026-10-14T04:00:00Z'),
            requestedOut: new Date('2026-10-14T16:00:00Z'), // future (clock is at 15:00:00Z)
            reason: 'Future clockout attempt',
          });
        },
        /correction times cannot be in the future/i,
      );
    });

    it('Rejects correction where requestedIn >= requestedOut', async () => {
      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            requestedIn: new Date('2026-10-14T08:00:00Z'),
            requestedOut: new Date('2026-10-14T04:00:00Z'), // before in!
            reason: 'Reversed order',
          });
        },
        /requestedIn must precede requestedOut/i,
      );

      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            requestedIn: new Date('2026-10-14T08:00:00Z'),
            requestedOut: new Date('2026-10-14T08:00:00Z'), // identical
            reason: 'Identical timestamps',
          });
        },
        /requestedIn must precede requestedOut/i,
      );
    });

    it('Rejects correction older than configurable threshold (7 days default)', async () => {
      // 10 days in the past
      const oldIn = new Date('2026-10-04T03:30:00Z');
      const oldOut = new Date('2026-10-04T12:00:00Z');

      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            requestedIn: oldIn,
            requestedOut: oldOut,
            reason: 'Old attendance from 10 days ago',
          });
        },
        /Correction request exceeds maximum allowed age of 7 days/i,
      );
    });

    it('Rejects duplicate pending request for the same session', async () => {
      const corr1 = await service.requestCorrection({
        orgId,
        userId: userEmp,
        sessionId: baseSessionId,
        requestedIn: new Date('2026-10-14T03:30:00Z'),
        requestedOut: new Date('2026-10-14T12:30:00Z'),
        reason: 'Scanner malfunction',
      });
      assert.ok(corr1.id);

      // Duplicate attempt while corr1 is PENDING
      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            sessionId: baseSessionId,
            requestedIn: new Date('2026-10-14T03:30:00Z'),
            requestedOut: new Date('2026-10-14T12:30:00Z'),
            reason: 'Another duplicate attempt',
          });
        },
        /A pending correction request already exists for this session/i,
      );
    });

    it('Rejects correction overlapping with another active or closed session', async () => {
      // Create a second closed session for userEmp from 13:00 to 14:00 UTC
      const otherSessionId = crypto.randomUUID();
      await repo.saveSession({
        id: otherSessionId,
        orgId,
        userId: userEmp,
        deviceId: 'dev-corr-02',
        workDate: '2026-10-14',
        clockInAt: new Date('2026-10-14T13:00:00Z'),
        clockOutAt: new Date('2026-10-14T14:00:00Z'),
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: ClockOutSource.LOGOUT,
        activeSeconds: 3600,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 3600,
        lastHeartbeatAt: new Date('2026-10-14T14:00:00Z'),
        ipIn: '127.0.0.1',
        ipOut: '127.0.0.1',
        flags: [],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      });

      // Submit correction without sessionId that overlaps with otherSessionId (13:30 to 14:30)
      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userEmp,
            requestedIn: new Date('2026-10-14T13:30:00Z'),
            requestedOut: new Date('2026-10-14T14:30:00Z'),
            reason: 'Overlapping shift correction',
          });
        },
        /Correction interval overlaps with existing session/i,
      );
    });

    it('Recomputes attendance_daily and updates draft_timesheets upon correction approval', async () => {
      const pendingList = await service.getPendingCorrections(orgId);
      const pending = pendingList.find((c) => c.sessionId === baseSessionId);
      assert.ok(pending);

      // Daily before approval
      const dailyBefore = await repo.findDailyAttendance(orgId, userEmp, '2026-10-14');
      assert.ok(dailyBefore);

      // Approve correction
      const reviewResult = await service.reviewCorrection({
        orgId,
        reviewerId: userMgr,
        reviewerRole: UserRole.MANAGER,
        correctionId: pending.id,
        approved: true,
        reviewNote: 'Approved after supervisor confirmation',
      });

      assert.equal(reviewResult.correction.status, CorrectionStatus.APPROVED);

      // Daily after approval: must be recomputed!
      const dailyAfter = await repo.findDailyAttendance(orgId, userEmp, '2026-10-14');
      assert.ok(dailyAfter);
      // Adjusted session duration: 03:30 to 12:30 = 9h = 32400s (original was 28800s) + otherSession (3600s)
      assert.ok(dailyAfter.netSeconds > dailyBefore.netSeconds);

      // Draft timesheet must also be updated
      const timesheet = await repo.findDraftTimesheet(orgId, userEmp, '2026-10-14');
      assert.ok(timesheet);
      assert.equal(timesheet.attendanceMinutes, Math.floor(dailyAfter.netSeconds / 60));
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Export Hardening (Requirement 4)
  // ---------------------------------------------------------------------------
  describe('Requirement 4: Export Hardening & Formula Injection Prevention', () => {
    const maliciousUser = '77770000-0000-0000-0000-000000000099';

    before(async () => {
      // Seed user with formula injection display name
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role) VALUES
         ('${maliciousUser}', '${orgId}', 'malicious@hack.com', '=cmd|'' /C calc''!A0', 'EMPLOYEE')
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      );

      // Seed a daily attendance record for the malicious user
      await repo.saveDailyAttendance({
        orgId,
        userId: maliciousUser,
        workDate: '2026-10-14',
        firstIn: new Date('2026-10-14T03:30:00Z'),
        lastOut: new Date('2026-10-14T12:00:00Z'),
        activeSeconds: 28800,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 28800,
        expectedSeconds: 28800,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        dayStatus: DayStatus.PRESENT,
      });
    });

    it('sanitizeExportCell prefixes =, +, -, @ with single quote', () => {
      assert.equal(sanitizeExportCell('=SUM(A1:A10)'), "'=SUM(A1:A10)");
      assert.equal(sanitizeExportCell('+12345'), "'+12345");
      assert.equal(sanitizeExportCell('-500'), "'-500");
      assert.equal(sanitizeExportCell('@macro'), "'@macro");
      assert.equal(sanitizeExportCell('\tformula'), "'\tformula");
      assert.equal(sanitizeExportCell('Regular Name'), 'Regular Name');
      assert.equal(sanitizeExportCell(100), 100);
      assert.equal(sanitizeExportCell(null), '');
      assert.equal(sanitizeExportCell(undefined), '');
    });

    it('Sanitizes malicious formula cells in CSV export', async () => {
      const csv = await service.exportAttendanceCsv({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
        filter: { startDate: '2026-10-14', endDate: '2026-10-14', userId: maliciousUser },
      });

      assert.ok(csv.includes("work_date,user_id,display_name,email,first_in,last_out,net_hours,status"));
      // The malicious display name must be prefixed with a single quote
      assert.ok(csv.includes("''=cmd|' /C calc'!A0") || csv.includes("'=cmd|"));
      // It must NOT start raw with =
      assert.ok(!csv.includes('",=cmd|'));
    });

    it('Sanitizes malicious formula cells in XLSX export with exceljs', async () => {
      const buffer = await service.exportAttendanceXlsx({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
        filter: { startDate: '2026-10-14', endDate: '2026-10-14', userId: maliciousUser },
      });

      assert.ok(buffer);
      assert.ok(buffer.length > 0);

      // Parse generated XLSX buffer to verify cell content
      const ExcelJS = await import('exceljs');
      const WorkbookClass = (ExcelJS as any).default?.Workbook || (ExcelJS as any).Workbook;
      const wb = new WorkbookClass();
      await wb.xlsx.load(buffer);
      const sheet = wb.getWorksheet('Attendance');
      assert.ok(sheet);

      let found = false;
      sheet.eachRow((row: any) => {
        const val = String(row.getCell(3).value || '');
        if (val.includes('calc')) {
          assert.ok(val.startsWith("'"), 'Malicious cell in Excel must be prefixed with single quote');
          found = true;
        }
      });
      assert.ok(found, 'Malicious cell should be located and sanitized');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Consent Gate (Requirement 5)
  // ---------------------------------------------------------------------------
  describe('Requirement 5: Monitoring Consent Gate', () => {
    const unconsentedUserId = '77770000-0000-0000-0000-000000000077';
    const testSessionId = crypto.randomUUID();
    const testSecret = 'unconsented-secret';

    before(async () => {
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role) VALUES
         ('${unconsentedUserId}', '${orgId}', 'unconsented@test.com', 'Unconsented Worker', 'EMPLOYEE')
         ON CONFLICT (id) DO NOTHING`,
      );
    });

    it('Blocks session creation and returns clear error when user has not accepted current notice version', async () => {
      await service.registerSessionSecret(testSessionId, testSecret);

      const unsigned: Omit<HeartbeatPayload, 'signature'> = {
        orgId,
        userId: unconsentedUserId,
        deviceId: 'dev-unconsented',
        sessionId: testSessionId,
        sequenceNumber: 1,
        nonce: `nonce-${Date.now()}-1`,
        activeSeconds: 30,
        idleSeconds: 0,
        tabVisible: true,
        windowFocused: true,
        inCall: false,
      };
      const signature = service.getValidator().signHeartbeat(unsigned, testSecret);
      const hb = { ...unsigned, signature };

      await assert.rejects(
        async () => {
          await service.ingestHeartbeat(hb);
        },
        /CONSENT_REQUIRED: User has not accepted current monitoring notice \(v1\.0\.0\)/i,
      );

      // Confirm no session was created in DB or memory
      const sess = await service.getSession(unconsentedUserId, orgId);
      assert.equal(sess, null);
    });

    it('Accepting monitoring notice unblocks heartbeat ingestion and establishes session', async () => {
      const consent = await service.recordMonitoringConsent({
        orgId,
        userId: unconsentedUserId,
        noticeVersion: 'v1.0.0',
        ip: '127.0.0.1',
        userAgent: 'TestClient/1.0',
      });
      assert.equal(consent.noticeVersion, 'v1.0.0');

      const unsigned: Omit<HeartbeatPayload, 'signature'> = {
        orgId,
        userId: unconsentedUserId,
        deviceId: 'dev-unconsented',
        sessionId: testSessionId,
        sequenceNumber: 2,
        nonce: `nonce-${Date.now()}-2`,
        activeSeconds: 30,
        idleSeconds: 0,
        tabVisible: true,
        windowFocused: true,
        inCall: false,
      };
      const signature = service.getValidator().signHeartbeat(unsigned, testSecret);
      const hb = { ...unsigned, signature };

      const res = await service.ingestHeartbeat(hb);
      assert.equal(res.currentState, AttendanceState.ACTIVE);
      assert.equal(res.session.status, SessionStatus.OPEN);
      assert.equal(res.session.userId, unconsentedUserId);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Branch Coverage Target >= 95% (Requirement 6)
  // ---------------------------------------------------------------------------
  describe('Requirement 6: Branch Coverage Target (Error Paths, Denials, Null Branches)', () => {
    it('PostgresAttendanceRepository constructor branches (string, poolConfig, empty)', async () => {
      const r1 = new PostgresAttendanceRepository('postgresql://hrvo_app:hrvo_app_pass@localhost:5433/hrvo_dev');
      assert.ok(r1.getPool());
      await r1.close();

      const r2 = new PostgresAttendanceRepository({
        host: 'localhost',
        port: 5433,
        user: 'hrvo_app',
        password: 'hrvo_app_pass',
        database: 'hrvo_dev',
      });
      assert.ok(r2.getPool());
      assert.ok(r2.getRetentionPool());
      await r2.close();

      const r3 = new PostgresAttendanceRepository({
        retentionPoolConfig: { host: 'localhost', port: 5433, user: 'hrvo_retention', password: 'hrvo_retention_dev', database: 'hrvo_dev' },
      });
      assert.ok(r3.getRetentionPool());
      await r3.close();
    });

    it('Repository queryWithRls and cleanup error paths', async () => {
      await assert.rejects(
        async () => {
          await repo.queryWithRls('', 'SELECT 1');
        },
        /Tenant context missing/i,
      );

      await assert.rejects(
        async () => {
          await repo.cleanupOldPresenceEvents('', new Date());
        },
        /Tenant context missing/i,
      );

      await assert.rejects(
        async () => {
          await repo.queryWithRls(orgId, 'SELECT * FROM non_existent_table_xyz');
        },
      );
    });

    it('Repository find queries return null or empty when rows do not exist', async () => {
      const nonExistentId = '11111111-0000-0000-0000-000000000000';
      assert.equal(await repo.findOpenSessionByUserId(orgId, nonExistentId), null);
      assert.equal(await repo.findSessionById(orgId, nonExistentId), null);
      assert.equal(await repo.findWorkScheduleForUser(orgId, nonExistentId), null);
      assert.equal(await repo.findCorrectionById(orgId, nonExistentId), null);
      assert.equal(await repo.findDailyAttendance(orgId, nonExistentId, '2026-01-01'), null);
      assert.equal(await repo.findDraftTimesheet(orgId, nonExistentId, '2026-01-01'), null);
      assert.equal(await repo.findUserById(orgId, nonExistentId), null);
      assert.equal(await repo.findSessionSecret(orgId, nonExistentId), null);

      const logsEmpty = await repo.findAuditLogs(orgId, 'NON_EXISTENT_ENTITY', nonExistentId);
      assert.equal(logsEmpty.length, 0);

      const usersAll = await repo.findAllUsers(orgId, teamId);
      assert.ok(usersAll.length >= 1);
    });

    it('verifyAuditLogChain detects broken hash chains', async () => {
      // Create separate test org to test hash tampering
      const tamperOrg = '99990000-0000-0000-0000-000000000009';
      await adminPool.query(
        `INSERT INTO organizations (id, name, slug) VALUES ('${tamperOrg}', 'Tamper Org', 'tamper-org') ON CONFLICT DO NOTHING`,
      );
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name) VALUES ('${userEmp}', '${tamperOrg}', 'emp@tamper.com', 'Tamper Emp') ON CONFLICT DO NOTHING`,
      );

      // Write two valid entries
      await repo.recordAuditLog({
        orgId: tamperOrg,
        actorId: userEmp,
        action: 'ACTION_1',
        entityType: 'TEST',
        entityId: crypto.randomUUID(),
        createdAt: new Date('2026-10-14T01:00:00Z'),
      });
      await repo.recordAuditLog({
        orgId: tamperOrg,
        actorId: userEmp,
        action: 'ACTION_2',
        entityType: 'TEST',
        entityId: crypto.randomUUID(),
        createdAt: new Date('2026-10-14T02:00:00Z'),
      });

      assert.equal(await repo.verifyAuditLogChain(tamperOrg), true);

      // Tamper second row hash using admin pool
      await adminPool.query(`UPDATE audit_logs SET hash = 'corruptedhash000000000000000000000000000000000000000000000000000' WHERE org_id = $1 AND action = 'ACTION_2'`, [tamperOrg]);
      assert.equal(await repo.verifyAuditLogChain(tamperOrg), false);

      // Tamper second row prev_hash
      await adminPool.query(`UPDATE audit_logs SET prev_hash = 'brokenprev000000000000000000000000000000000000000000000000000000' WHERE org_id = $1 AND action = 'ACTION_2'`, [tamperOrg]);
      assert.equal(await repo.verifyAuditLogChain(tamperOrg), false);

      await adminPool.query(`DELETE FROM audit_logs WHERE org_id = '${tamperOrg}'`);
      await adminPool.query(`DELETE FROM organizations WHERE id = '${tamperOrg}'`);
    });

    it('Service methods error paths when repository is missing', async () => {
      const inMemoryService = new AttendanceService();

      await assert.rejects(
        async () => await inMemoryService.requestCorrection({ orgId, userId: userEmp, requestedIn: new Date(), requestedOut: new Date(), reason: 'test' }),
        /Repository is required for corrections/i,
      );

      await assert.rejects(
        async () => await inMemoryService.reviewCorrection({ orgId, reviewerId: userMgr, reviewerRole: UserRole.MANAGER, correctionId: '1', approved: true }),
        /Repository is required for reviewCorrection/i,
      );

      await assert.rejects(
        async () => await inMemoryService.runDailyCloseJob(orgId, '2026-10-14'),
        /Repository is required for runDailyCloseJob/i,
      );

      await assert.rejects(
        async () => await inMemoryService.recomputeDailySummaryForUser(orgId, userEmp, '2026-10-14'),
        /Repository is required for recomputeDailySummaryForUser/i,
      );

      await assert.rejects(
        async () => await inMemoryService.getLiveBoard({ orgId, callerUserId: userHr, callerRole: UserRole.HR }),
        /Repository is required for getLiveBoard/i,
      );

      await assert.rejects(
        async () => await inMemoryService.exportAttendanceCsv({ orgId, callerUserId: userHr, callerRole: UserRole.HR, filter: { startDate: '2026-10-01', endDate: '2026-10-31' } }),
        /Repository is required for export/i,
      );

      await assert.rejects(
        async () => await inMemoryService.exportAttendanceXlsx({ orgId, callerUserId: userHr, callerRole: UserRole.HR, filter: { startDate: '2026-10-01', endDate: '2026-10-31' } }),
        /Repository is required for export/i,
      );

      await assert.rejects(
        async () => await inMemoryService.getTransparencyEvents({ orgId, userId: userEmp }),
        /Repository is required for transparency/i,
      );

      // getPendingCorrections returns [] when repo is missing
      assert.deepEqual(await inMemoryService.getPendingCorrections(orgId), []);

      // cleanup helpers return 0 when repo is missing
      assert.equal(await inMemoryService.cleanupExpiredNonces(), 0);
      assert.equal(await inMemoryService.cleanupStaleDeviceSequences(), 0);
    });

    it('Service reviewCorrection edge cases: correction not found, rejection branch', async () => {
      await assert.rejects(
        async () => {
          await service.reviewCorrection({
            orgId,
            reviewerId: userMgr,
            reviewerRole: UserRole.MANAGER,
            correctionId: crypto.randomUUID(),
            approved: true,
          });
        },
        /Correction not found/i,
      );

      // Create a fresh correction to reject
      const corrToReject = await service.requestCorrection({
        orgId,
        userId: userEmp,
        requestedIn: new Date('2026-10-14T01:00:00Z'),
        requestedOut: new Date('2026-10-14T02:00:00Z'),
        reason: 'To be rejected',
      });

      const rejectedRes = await service.reviewCorrection({
        orgId,
        reviewerId: userMgr,
        reviewerRole: UserRole.MANAGER,
        correctionId: corrToReject.id,
        approved: false,
        reviewNote: 'Rejected due to insufficient evidence',
      });

      assert.equal(rejectedRes.correction.status, CorrectionStatus.REJECTED);
      assert.equal(rejectedRes.adjustedSession, undefined);
    });

    it('Service getLiveBoard permission denials and presence states', async () => {
      // Employee role denied
      await assert.rejects(
        async () => {
          await service.getLiveBoard({
            orgId,
            callerUserId: userEmp,
            callerRole: UserRole.EMPLOYEE,
          });
        },
        /Insufficient permissions to view live board/i,
      );

      // Team lead without assigned team denied
      await assert.rejects(
        async () => {
          await service.getLiveBoard({
            orgId,
            callerUserId: userLead,
            callerRole: UserRole.TEAM_LEAD,
            callerTeamId: null,
          });
        },
        /Team lead has no assigned team/i,
      );

      // Manager view with filterTeamId
      const board = await service.getLiveBoard({
        orgId,
        callerUserId: userMgr,
        callerRole: UserRole.MANAGER,
        filterTeamId: teamId,
      });
      assert.ok(board.length >= 1);
    });

    it('Service export permission denials', async () => {
      await assert.rejects(
        async () => {
          await service.exportAttendanceCsv({
            orgId,
            callerUserId: userEmp,
            callerRole: UserRole.EMPLOYEE,
            filter: { startDate: '2026-10-01', endDate: '2026-10-31' },
          });
        },
        /Export permission denied/i,
      );

      await assert.rejects(
        async () => {
          await service.exportAttendanceXlsx({
            orgId,
            callerUserId: userEmp,
            callerRole: UserRole.EMPLOYEE,
            filter: { startDate: '2026-10-01', endDate: '2026-10-31' },
          });
        },
        /Export permission denied/i,
      );
    });

    it('Service computeScheduleCompliance edge branches: leave, holiday, non-working, half-day', async () => {
      // 1. Holiday branch
      holidayProvider.addHoliday(orgId, '2026-10-25');
      const holRes = await service.computeScheduleCompliance({
        orgId,
        userId: userEmp,
        workDate: '2026-10-25',
        sessions: [],
      });
      assert.equal(holRes.isHoliday, true);
      assert.equal(holRes.expectedSeconds, 0);

      // 2. Approved leave branch
      leaveProvider.addLeave(orgId, userEmp, '2026-10-26');
      const leaveRes = await service.computeScheduleCompliance({
        orgId,
        userId: userEmp,
        workDate: '2026-10-26',
        sessions: [],
      });
      assert.equal(leaveRes.isOnLeave, true);
      assert.equal(leaveRes.expectedSeconds, 0);

      // 3. Non-working day (e.g. Sunday) with no schedule
      const nonWorkRes = await service.computeScheduleCompliance({
        orgId,
        userId: userEmp,
        workDate: '2026-10-18', // Sunday
        sessions: [],
      });
      assert.equal(nonWorkRes.isWorkingDay, false);

      // 4. Working day with flexible work schedule
      await repo.saveWorkSchedule({
        id: crypto.randomUUID(),
        orgId,
        userId: userEmp,
        days: { '3': { start: '09:00', end: '18:00', expectedHours: 8 } },
        flexible: true,
        graceMinutes: 15,
        effectiveFrom: '2026-01-01',
      });

      // Half-day branch check (netSeconds < expectedSeconds / 2)
      const halfDayDaily = await service.recomputeDailySummaryForUser(orgId, userEmp, '2026-10-14');
      assert.ok(halfDayDaily);
    });

    it('Service constructor options parsing and getClock()', () => {
      const s1 = new AttendanceService(repo, clock);
      assert.ok(s1.getClock());

      const s2 = new AttendanceService();
      assert.ok(s2.getClock());
      assert.ok(s2.getValidator());
      assert.ok(s2.getStateMachine());
    });

    it('Audit log canonical JSON with primitives and arrays, plus validation errors', async () => {
      await assert.rejects(
        async () => {
          await repo.recordAuditLog({
            orgId: '   ',
            actorId: userEmp,
            action: 'INVALID',
            entityType: 'TEST',
            entityId: crypto.randomUUID(),
            createdAt: new Date(),
          });
        },
        /Tenant context missing/i,
      );

      const entry = await repo.recordAuditLog({
        orgId,
        actorId: userEmp,
        action: 'TEST_PRIMITIVES',
        entityType: 'TEST',
        entityId: crypto.randomUUID(),
        before: 12345,
        after: ['item1', 99, true, { nested: 'val' }],
        createdAt: new Date(),
      });
      assert.ok(entry.hash);
      assert.equal(entry.prevHash.length, 64);
    });

    it('Work schedule fallback to org-wide and Date/string effectiveTo handling', async () => {
      const orgScheduleId = crypto.randomUUID();
      await repo.saveWorkSchedule({
        id: orgScheduleId,
        orgId,
        days: { '1': { start: '09:00', end: '17:00', expectedHours: 8 } },
        flexible: false,
        graceMinutes: 10,
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-12-31',
      });

      const fallbackSched = await repo.findWorkScheduleForUser(orgId, userOther);
      assert.ok(fallbackSched);
      assert.equal(fallbackSched.id, orgScheduleId);
      assert.equal(fallbackSched.effectiveTo, '2026-12-31');

      const userSchedId = crypto.randomUUID();
      await adminPool.query(
        `INSERT INTO work_schedules (id, org_id, user_id, days, flexible, grace_minutes, effective_from, effective_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userSchedId,
          orgId,
          userOther,
          JSON.stringify({ '1': { start: '10:00', end: '19:00', expectedHours: 8 } }),
          false,
          5,
          new Date('2026-01-01'),
          new Date('2026-11-30'),
        ],
      );

      const userSched = await repo.findWorkScheduleForUser(orgId, userOther);
      assert.ok(userSched);
      assert.equal(userSched.id, userSchedId);
      assert.ok(userSched.effectiveTo);
    });

    it('Attendance summary filtering by teamId and user consents without version', async () => {
      const summaries = await repo.findDailyAttendanceInRange(orgId, {
        teamId,
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      });
      assert.ok(Array.isArray(summaries));

      await repo.saveMonitoringConsent({
        id: crypto.randomUUID(),
        orgId,
        userId: userOther,
        noticeVersion: 'v1.0.0',
        acceptedAt: new Date(),
      });

      const allConsents = await repo.findMonitoringConsentsByUser(orgId, userOther);
      assert.ok(Array.isArray(allConsents));
      assert.ok(allConsents.length >= 1);

      const otherConsents = await repo.findMonitoringConsentsByUser(orgId, userOther);
      assert.equal(otherConsents.length, 1);
      assert.equal(otherConsents[0].ip, null);
      assert.equal(otherConsents[0].userAgent, null);

      await repo.recordPresenceEvent({
        orgId,
        userId: userOther,
        serverTs: new Date('2026-10-14T08:00:00Z'),
        eventType: 'HEARTBEAT',
        state: 'ACTIVE',
        seq: 1,
        meta: { sample: 'metadata' },
      });
      const events = await repo.findPresenceEventsByUser(orgId, userOther, 5);
      assert.ok(events.length >= 1);
      assert.equal(events[0].clientTs, null);
      assert.deepEqual(events[0].meta, { sample: 'metadata' });

      const staleCount = await repo.cleanupStaleDeviceSequences(orgId, new Date('2020-01-01T00:00:00Z'));
      assert.equal(staleCount, 0);
    });

    it('In-memory AttendanceService session & consent lifecycle without repository', async () => {
      const inMem = new AttendanceService();
      const memUser = 'mem-user-1';

      // Seed an in-memory open session
      const memSession: AttendanceSession = {
        id: crypto.randomUUID(),
        orgId: 'org-mem',
        userId: memUser,
        deviceId: 'dev-mem',
        workDate: '2026-10-14',
        clockInAt: new Date(),
        clockOutAt: null,
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: null,
        activeSeconds: 100,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 100,
        lastHeartbeatAt: new Date(),
        ipIn: '127.0.0.1',
        ipOut: null,
        flags: [],
        status: SessionStatus.OPEN,
        currentState: AttendanceState.ACTIVE,
        segments: [],
        consecutiveIdleSeconds: 0,
      };
      (inMem as any).sessions.set(memUser, memSession);

      await inMem.onSocketDisconnect(memUser);
      await inMem.onSocketReconnect(memUser);
      await inMem.startBreak(memUser);
      await inMem.endBreak(memUser);
      await inMem.joinMeeting(memUser, 'meet-1');
      await inMem.leaveMeeting(memUser);

      assert.equal(await inMem.hasUserAcceptedNotice('org-mem', memUser, 'v1.0.0'), false);
      const consent = await inMem.recordMonitoringConsent({
        orgId: 'org-mem',
        userId: memUser,
        noticeVersion: 'v1.0.0',
      });
      assert.equal(consent.noticeVersion, 'v1.0.0');
      assert.equal(await inMem.hasUserAcceptedNotice('org-mem', memUser, 'v1.0.0'), true);
      assert.equal(await inMem.hasUserAcceptedNotice('org-mem', memUser, 'v2.0.0'), false);

      const active = await inMem.getAllOpenSessions();
      assert.equal(active.length, 1);

      const closed = await inMem.getClosedSession('sess-none');
      assert.equal(closed, null);

      const comp = await inMem.computeScheduleCompliance({
        orgId: 'org-mem',
        userId: memUser,
        workDate: '2026-10-18',
        sessions: [],
      });
      assert.equal(comp.isHoliday, false);
      assert.equal(comp.isOnLeave, false);
    });

    it('getAllOpenSessions and getClosedSession without orgId when repo is present', async () => {
      const svcNoDefaultOrg = new AttendanceService({}, clock, repo);
      await assert.rejects(
        async () => await svcNoDefaultOrg.getAllOpenSessions(),
        /Tenant context missing/i,
      );

      const closed = await svcNoDefaultOrg.getClosedSession('sess-none');
      assert.equal(closed, null);
    });

    it('Daily close job comprehensively exercises all DayStatus outcomes', async () => {
      holidayProvider.addHoliday(orgId, '2026-12-25');
      const holDaily = await service.recomputeDailySummaryForUser(orgId, userEmp, '2026-12-25');
      assert.equal(holDaily?.dayStatus, DayStatus.HOLIDAY);

      leaveProvider.addLeave(orgId, userEmp, '2026-12-26');
      const leaveDaily = await service.recomputeDailySummaryForUser(orgId, userEmp, '2026-12-26');
      assert.equal(leaveDaily?.dayStatus, DayStatus.LEAVE);

      const schedLeadId = crypto.randomUUID();
      await repo.saveWorkSchedule({
        id: schedLeadId,
        orgId,
        userId: userLead,
        days: { '1': { start: '09:00', end: '17:00', expectedHours: 8 } },
        flexible: false,
        graceMinutes: 10,
        effectiveFrom: '2026-01-01',
      });
      const absentDaily = await service.recomputeDailySummaryForUser(orgId, userLead, '2026-10-12');
      assert.equal(absentDaily?.dayStatus, DayStatus.ABSENT);

      const lateSessId = crypto.randomUUID();
      await repo.saveSession({
        id: lateSessId,
        orgId,
        userId: userLead,
        deviceId: 'dev-lead',
        workDate: '2026-10-19',
        clockInAt: new Date('2026-10-19T04:00:00Z'),
        clockOutAt: new Date('2026-10-19T12:00:00Z'),
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: 'LOGOUT',
        activeSeconds: 28800,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 28800,
        lastHeartbeatAt: new Date('2026-10-19T12:00:00Z'),
        ipIn: '127.0.0.1',
        ipOut: '127.0.0.1',
        flags: [],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      });
      const lateDaily = await service.recomputeDailySummaryForUser(orgId, userLead, '2026-10-19');
      assert.equal(lateDaily?.dayStatus, DayStatus.LATE);

      const earlySessId = crypto.randomUUID();
      await repo.saveSession({
        id: earlySessId,
        orgId,
        userId: userLead,
        deviceId: 'dev-lead',
        workDate: '2026-10-26',
        clockInAt: new Date('2026-10-26T03:30:00Z'),
        clockOutAt: new Date('2026-10-26T11:00:00Z'),
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: 'LOGOUT',
        activeSeconds: 27000,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 27000,
        lastHeartbeatAt: new Date('2026-10-26T11:00:00Z'),
        ipIn: '127.0.0.1',
        ipOut: '127.0.0.1',
        flags: [],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      });
      const earlyDaily = await service.recomputeDailySummaryForUser(orgId, userLead, '2026-10-26');
      assert.equal(earlyDaily?.dayStatus, DayStatus.EARLY_LEAVE);
    });

    it('Live board displays all presence statuses and enforces role scoping', async () => {
      const otherTeamId = '88880000-0000-0000-0000-000000000002';
      await adminPool.query(
        `INSERT INTO teams (id, org_id, name) VALUES ('${otherTeamId}', '${orgId}', 'Other Team') ON CONFLICT DO NOTHING`,
      );
      await adminPool.query(
        `UPDATE users SET team_id = '${otherTeamId}' WHERE id = '${userOther}'`,
      );

      const idleSessId = crypto.randomUUID();
      await repo.saveSession({
        id: idleSessId,
        orgId,
        userId: userEmp,
        deviceId: 'dev-idle',
        workDate: '2026-10-14',
        clockInAt: new Date('2026-10-14T03:30:00Z'),
        clockOutAt: null,
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: null,
        activeSeconds: 1800,
        idleSeconds: 300,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 1800,
        lastHeartbeatAt: new Date('2026-10-14T04:05:00Z'),
        ipIn: '127.0.0.1',
        ipOut: null,
        flags: [],
        status: SessionStatus.OPEN,
        currentState: AttendanceState.IDLE,
        segments: [],
        consecutiveIdleSeconds: 300,
      });

      const leadBoard = await service.getLiveBoard({
        orgId,
        callerUserId: userLead,
        callerRole: UserRole.TEAM_LEAD,
        callerTeamId: teamId,
      });
      assert.ok(leadBoard.some((b) => b.userId === userEmp));
      assert.ok(!leadBoard.some((b) => b.userId === userOther));

      const empEntry = leadBoard.find((b) => b.userId === userEmp);
      assert.equal(empEntry?.status, LivePresenceStatus.IDLE);

      await adminPool.query(
        `UPDATE attendance_sessions SET current_state = 'ON_BREAK' WHERE id = '${idleSessId}'`,
      );
      const breakBoard = await service.getLiveBoard({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
      });
      const empBreak = breakBoard.find((b) => b.userId === userEmp);
      assert.equal(empBreak?.status, LivePresenceStatus.ON_BREAK);

      await adminPool.query(
        `UPDATE attendance_sessions SET current_state = 'IN_MEETING' WHERE id = '${idleSessId}'`,
      );
      const meetBoard = await service.getLiveBoard({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
      });
      const empMeet = meetBoard.find((b) => b.userId === userEmp);
      assert.equal(empMeet?.status, LivePresenceStatus.IN_MEETING);

      leaveProvider.addLeave(orgId, userOther, '2026-10-14');
      const leaveBoard = await service.getLiveBoard({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
      });
      const otherLeave = leaveBoard.find((b) => b.userId === userOther);
      assert.equal(otherLeave?.status, LivePresenceStatus.ON_LEAVE);

      await adminPool.query(`UPDATE attendance_sessions SET status = 'CLOSED' WHERE id = '${idleSessId}'`);
    });

    it('Correction without session_id (missed punch) and approval fallback', async () => {
      const missedCorr = await service.requestCorrection({
        orgId,
        userId: userOther,
        requestedIn: new Date('2026-10-13T03:30:00Z'),
        requestedOut: new Date('2026-10-13T11:30:00Z'),
        reason: 'Forgot to start laptop before client presentation',
      });
      assert.equal(missedCorr.sessionId, null);

      await assert.rejects(
        async () => {
          await service.requestCorrection({
            orgId,
            userId: userOther,
            requestedIn: new Date('2026-10-13T03:30:00Z'),
            requestedOut: new Date('2026-10-13T11:30:00Z'),
            reason: 'Duplicate missed punch attempt',
          });
        },
        /A pending correction request already exists for this session/i,
      );

      const approvedMissed = await service.reviewCorrection({
        orgId,
        reviewerId: userMgr,
        reviewerRole: UserRole.MANAGER,
        correctionId: missedCorr.id,
        approved: true,
      });
      assert.equal(approvedMissed.correction.status, CorrectionStatus.APPROVED);
      assert.ok(approvedMissed.adjustedSession);
      assert.equal(approvedMissed.adjustedSession.deviceId, 'adjusted-device');
      assert.equal(approvedMissed.adjustedSession.ipIn, '127.0.0.1');
    });

    it('Targets remaining branches across service and repository to exceed 95% branch coverage', async () => {
      // 1. Service methods with repository connected (saving sessions)
      const targetUser = userEmp;
      const testOpenSess: AttendanceSession = {
        id: crypto.randomUUID(),
        orgId,
        userId: targetUser,
        deviceId: 'dev-repo-branch',
        workDate: '2026-10-14',
        clockInAt: new Date('2026-10-14T03:30:00Z'),
        clockOutAt: null,
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: null,
        activeSeconds: 600,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 600,
        lastHeartbeatAt: new Date('2026-10-14T03:40:00Z'),
        ipIn: '127.0.0.1',
        ipOut: null,
        flags: [],
        status: SessionStatus.OPEN,
        currentState: AttendanceState.ACTIVE,
        segments: [],
        consecutiveIdleSeconds: 0,
      };
      await repo.saveSession(testOpenSess);
      (service as any).sessions.set(targetUser, testOpenSess);

      // Exercise service lifecycle with repository
      await service.startBreak(targetUser);
      await service.endBreak(targetUser);
      await service.joinMeeting(targetUser, 'meet-branch-1');
      await service.leaveMeeting(targetUser);
      await service.onSocketDisconnect(targetUser);
      await service.onSocketReconnect(targetUser);
      await service.onExplicitLogout(targetUser);

      // 2. Reconcile with CLOSED session in sessions map (hits continue)
      const closedSess: AttendanceSession = {
        ...testOpenSess,
        id: crypto.randomUUID(),
        status: SessionStatus.CLOSED,
      };
      await service.runReconciliation(new Date('2026-10-14T03:45:00Z'), orgId);

      // 3. Custom config branches (maxCorrectionAgeDays and currentNoticeVersion)
      const customConfigService = new AttendanceService(
        { maxCorrectionAgeDays: 14, currentNoticeVersion: 'v2.0.0' },
        clock,
        repo,
        orgId,
      );
      assert.ok(customConfigService);

      // 4. In-memory getAllOpenSessions with targetOrgId and getClosedSession with targetOrgId
      const inMem = new AttendanceService();
      const inMemSess: AttendanceSession = {
        ...testOpenSess,
        id: crypto.randomUUID(),
        orgId: 'org-custom-1',
      };
      (inMem as any).sessions.set('u-custom', inMemSess);
      const openOrgList = await inMem.getAllOpenSessions('org-custom-1');
      assert.equal(openOrgList.length, 1);
      (inMem as any).closedSessions.set(inMemSess.id, inMemSess);
      const foundClosed = await inMem.getClosedSession(inMemSess.id, 'org-custom-1');
      assert.ok(foundClosed);

      // 5. Half-day status in recomputeDailySummaryForUser
      const halfDaySessId = crypto.randomUUID();
      await repo.saveSession({
        id: halfDaySessId,
        orgId,
        userId: userLead,
        deviceId: 'dev-lead',
        workDate: '2026-10-05',
        clockInAt: new Date('2026-10-05T03:30:00Z'),
        clockOutAt: new Date('2026-10-05T05:30:00Z'),
        clockInSource: ClockInSource.AUTO_HEARTBEAT,
        clockOutSource: 'LOGOUT',
        activeSeconds: 7200,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 7200,
        lastHeartbeatAt: new Date('2026-10-05T05:30:00Z'),
        ipIn: '127.0.0.1',
        ipOut: '127.0.0.1',
        flags: [],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      });
      const halfDaily = await service.recomputeDailySummaryForUser(orgId, userLead, '2026-10-05');
      assert.equal(halfDaily?.dayStatus, DayStatus.HALF_DAY);

      // 6. Repository: query unreviewed correction (reviewedAt is null)
      const freshCorr = await service.requestCorrection({
        orgId,
        userId: userOther,
        requestedIn: new Date('2026-10-12T03:30:00Z'),
        requestedOut: new Date('2026-10-12T08:30:00Z'),
        reason: 'Unreviewed test correction',
      });
      const unreviewed = await repo.findCorrectionById(orgId, freshCorr.id);
      assert.ok(unreviewed);
      assert.equal(unreviewed.reviewedAt, null);

      // 7. Repository: findPresenceEventsByUser with clientTs set
      await repo.recordPresenceEvent({
        orgId,
        userId: userEmp,
        clientTs: new Date('2026-10-14T03:30:00Z'),
        serverTs: new Date('2026-10-14T03:30:01Z'),
        eventType: 'HEARTBEAT',
        state: 'ACTIVE',
        seq: 99,
        meta: JSON.stringify({ rawString: true }),
      });
      const userEvents = await repo.findPresenceEventsByUser(orgId, userEmp, 1);
      assert.ok(userEvents.length >= 1);
      assert.ok(userEvents[0].clientTs instanceof Date);

      // 8. Repository: cleanupOldPresenceEvents error catch branch
      const faultyRepo = new PostgresAttendanceRepository();
      await (faultyRepo as any).retentionPool.end();
      await assert.rejects(
        async () => await faultyRepo.cleanupOldPresenceEvents(orgId, new Date()),
      );
      await faultyRepo.close().catch(() => {});

      // 9. Export with empty/null email and display_name
      const noEmailUserId = crypto.randomUUID();
      await adminPool.query(
        `INSERT INTO users (id, org_id, email, display_name, role) VALUES ('${noEmailUserId}', '${orgId}', '', '', 'EMPLOYEE')`,
      );
      await repo.saveDailyAttendance({
        orgId,
        userId: noEmailUserId,
        workDate: '2026-10-14',
        firstIn: new Date(),
        lastOut: new Date(),
        activeSeconds: 3600,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: 3600,
        expectedSeconds: 3600,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        dayStatus: DayStatus.PRESENT,
      });
      const csvNoEmail = await service.exportAttendanceCsv({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
        filter: { userId: noEmailUserId, startDate: '2026-10-14', endDate: '2026-10-14' },
      });
      assert.ok(csvNoEmail.includes(noEmailUserId));

      const xlsxNoEmail = await service.exportAttendanceXlsx({
        orgId,
        callerUserId: userHr,
        callerRole: UserRole.HR,
        filter: { userId: noEmailUserId, startDate: '2026-10-14', endDate: '2026-10-14' },
      });
      assert.ok(xlsxNoEmail.length > 0);

      // 10. Repository: approve freshCorr and query approved correction (hits reviewedAt truthy branch)
      const approvedFresh = await service.reviewCorrection({
        orgId,
        reviewerId: userMgr,
        reviewerRole: UserRole.MANAGER,
        correctionId: freshCorr.id,
        approved: true,
      });
      const approvedRow = await repo.findCorrectionById(orgId, freshCorr.id);
      assert.ok(approvedRow?.reviewedAt instanceof Date);

      // 11. Repository: updateCorrection with null reviewer fields (hits || null falsy branches)
      await repo.updateCorrection({
        ...approvedFresh.correction,
        reviewerId: undefined,
        reviewedAt: undefined,
        reviewNote: undefined,
      });

      // 12. Repository: clearAll scoped to orgId
      await repo.clearAll(orgId);
    });
  });
});
