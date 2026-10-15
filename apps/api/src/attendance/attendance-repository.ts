/**
 * PostgreSQL Implementation of IAttendanceRepository with Row-Level Security (RLS)
 * Ref: docs/SRS.md Section 7.4, Security Rules & AGENTS.md
 *
 * Rules Enforced:
 * 1. Connects as non-superuser application role 'hrvo_app' (NOBYPASSRLS, not table owner).
 * 2. Every query runs inside a transaction (BEGIN ... COMMIT/ROLLBACK).
 * 3. Calls SELECT set_config('app.org_id', $1, true) BEFORE executing any query.
 * 4. Rejects any query attempt without a valid org context.
 * 5. FORCE ROW LEVEL SECURITY enabled on every tenant table.
 */

import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;
import {
  AttendanceState,
  ClockInSource,
  ClockOutSource,
  SessionStatus,
} from '../../../../packages/shared/src/attendance/types.ts';
import type {
  AttendanceSegment,
  AttendanceSession,
  WorkSchedule,
  AttendanceCorrection,
  AttendanceDaily,
  DraftTimesheet,
  AuditLogEntry,
  MonitoringConsent,
  AttendanceExportFilter,
} from '../../../../packages/shared/src/attendance/types.ts';

/** A raw presence event as shown to the user (FR-ATT-020). */
export interface PresenceEventRecord {
  id: string;
  serverTs: Date;
  clientTs: Date | null;
  eventType: string;
  state: string;
  seq: number;
  ip: string | null;
  meta: Record<string, unknown> | null;
}

export interface CorrectionRequester {
  requesterName: string | null;
  requesterEmail: string;
  requesterManagerId: string | null;
  requesterTeamId: string | null;
}

export interface IAttendanceRepository {
  findOpenSessionByUserId(orgId: string, userId: string): Promise<AttendanceSession | null>;
  findSessionById(orgId: string, sessionId: string): Promise<AttendanceSession | null>;
  findAllOpenSessions(orgId: string): Promise<AttendanceSession[]>;
  saveSession(session: AttendanceSession): Promise<void>;
  saveSegment(orgId: string, seg: AttendanceSegment, sessionId: string): Promise<void>;
  findSegmentsBySessionId(orgId: string, sessionId: string): Promise<AttendanceSegment[]>;
  hasNonce(orgId: string, userId: string, nonce: string): Promise<boolean>;
  recordNonce(orgId: string, userId: string, nonce: string, now: Date): Promise<void>;
  getLastDeviceSequence(orgId: string, userId: string, deviceId: string): Promise<number>;
  setDeviceSequence(orgId: string, userId: string, deviceId: string, seq: number): Promise<void>;
  saveSessionSecret(orgId: string, sessionId: string, secret: string): Promise<void>;
  findSessionSecret(orgId: string, sessionId: string): Promise<string | null>;
  revokeSessionSecret(orgId: string, sessionId: string): Promise<void>;
  cleanupExpiredNonces(orgId: string, olderThan: Date): Promise<number>;
  cleanupStaleDeviceSequences(orgId: string, olderThan: Date): Promise<number>;
  
  // Work Schedules (FR-ATT-014)
  saveWorkSchedule(schedule: WorkSchedule): Promise<void>;
  findWorkScheduleForUser(orgId: string, userId: string): Promise<WorkSchedule | null>;

  // Corrections (FR-ATT-013)
  createCorrection(correction: AttendanceCorrection): Promise<void>;
  findCorrectionById(orgId: string, id: string): Promise<AttendanceCorrection | null>;
  updateCorrection(correction: AttendanceCorrection): Promise<void>;
  findPendingCorrections(orgId: string): Promise<AttendanceCorrection[]>;
  findCorrectionsByUser(orgId: string, userId: string): Promise<AttendanceCorrection[]>;

  // Daily Records & Timesheets (FR-ATT-015 & FR-TS-001)
  saveDailyAttendance(record: AttendanceDaily): Promise<void>;
  findDailyAttendance(orgId: string, userId: string, workDate: string): Promise<AttendanceDaily | null>;
  findDailyAttendanceInRange(orgId: string, filter: AttendanceExportFilter): Promise<AttendanceDaily[]>;
  findSessionsByDate(orgId: string, workDate: string): Promise<AttendanceSession[]>;
  findSessionsByUserInRange(orgId: string, userId: string, fromDate: string, toDate: string): Promise<AttendanceSession[]>;
  findPendingCorrectionsWithRequester(orgId: string): Promise<Array<AttendanceCorrection & CorrectionRequester>>;
  saveDraftTimesheet(timesheet: DraftTimesheet): Promise<void>;
  findDraftTimesheet(orgId: string, userId: string, workDate: string): Promise<DraftTimesheet | null>;

  // Users & Teams (FR-ATT-016)
  findUserById(orgId: string, userId: string): Promise<{ id: string; orgId: string; email: string; displayName: string; role: string; teamId: string | null; managerId: string | null } | null>;
  findAllUsers(orgId: string, teamId?: string): Promise<Array<{ id: string; orgId: string; email: string; displayName: string; role: string; teamId: string | null; managerId: string | null }>>;

  // Audit Logs (FR-AUD-001)
  recordAuditLog(entry: Omit<AuditLogEntry, 'id' | 'prevHash' | 'hash'>): Promise<AuditLogEntry>;
  findAuditLogs(orgId: string, entityType?: string, entityId?: string): Promise<AuditLogEntry[]>;
  verifyAuditLogChain(orgId: string): Promise<boolean>;

  // Transparency & Consent (FR-ATT-020 & FR-AUD-004)
  saveMonitoringConsent(consent: MonitoringConsent): Promise<void>;
  findMonitoringConsentsByUser(orgId: string, userId: string): Promise<MonitoringConsent[]>;
  recordPresenceEvent(event: { orgId: string; userId: string; sessionId?: string; serverTs: Date; clientTs?: Date; eventType: string; state: string; seq: number; ip?: string; meta?: Record<string, unknown> }): Promise<void>;
  findPresenceEventsByUser(orgId: string, userId: string, limit?: number): Promise<PresenceEventRecord[]>;
  cleanupOldPresenceEvents(orgId: string, olderThan: Date): Promise<number>;

  clearAll(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresRepositoryOptions {
  appPoolConfig?: pg.PoolConfig;
  adminPoolConfig?: pg.PoolConfig;
  retentionPoolConfig?: pg.PoolConfig;
}

export class PostgresAttendanceRepository implements IAttendanceRepository {
  private pool: pg.Pool;          // Application pool (runs as non-superuser 'hrvo_app' with NOBYPASSRLS)
  private adminPool: pg.Pool;     // Admin pool (runs as owner 'postgres' for migrations & test wipe ONLY)
  private retentionPool: pg.Pool; // Dedicated retention role pool ('hrvo_retention' for pruning append-only events)

  constructor(options?: string | pg.PoolConfig | PostgresRepositoryOptions) {
    if (typeof options === 'string') {
      this.pool = new Pool({ connectionString: options });
      this.adminPool = new Pool({ connectionString: options });
      this.retentionPool = new Pool({ connectionString: options });
    } else if (options && ('appPoolConfig' in options || 'adminPoolConfig' in options || 'retentionPoolConfig' in options)) {
      const opts = options as PostgresRepositoryOptions;
      this.pool = new Pool(
        opts.appPoolConfig || {
          host: process.env.PGHOST || 'localhost',
          port: parseInt(process.env.PGPORT || '5433', 10),
          user: process.env.PGUSER || 'hrvo_app',
          password: process.env.PGPASSWORD || 'hrvo_app_pass',
          database: process.env.PGDATABASE || 'hrvo_dev',
        },
      );
      this.adminPool = new Pool(
        opts.adminPoolConfig || {
          host: process.env.PGHOST || 'localhost',
          port: parseInt(process.env.PGPORT || '5433', 10),
          user: process.env.PGADMIN_USER || process.env.PGUSER || 'postgres',
          password: process.env.PGADMIN_PASSWORD || process.env.PGPASSWORD || 'postgres',
          database: process.env.PGDATABASE || 'hrvo_dev',
        },
      );
      this.retentionPool = new Pool(
        opts.retentionPoolConfig || {
          host: process.env.PGHOST || 'localhost',
          port: parseInt(process.env.PGPORT || '5433', 10),
          user: process.env.PGRETENTION_USER || 'hrvo_retention',
          password: process.env.PGRETENTION_PASSWORD || 'hrvo_retention_dev',
          database: process.env.PGDATABASE || 'hrvo_dev',
        },
      );
    } else if (options) {
      // Direct PoolConfig passed
      this.pool = new Pool(options as pg.PoolConfig);
      this.adminPool = new Pool({
        ...(options as pg.PoolConfig),
        user: process.env.PGADMIN_USER || process.env.PGUSER || 'postgres',
        password: process.env.PGADMIN_PASSWORD || process.env.PGPASSWORD || 'postgres',
      });
      this.retentionPool = new Pool({
        ...(options as pg.PoolConfig),
        user: process.env.PGRETENTION_USER || 'hrvo_retention',
        password: process.env.PGRETENTION_PASSWORD || 'hrvo_retention_dev',
      });
    } else {
      // Default: Connect as non-superuser hrvo_app
      this.pool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGUSER || 'hrvo_app',
        password: process.env.PGPASSWORD || 'hrvo_app_pass',
        database: process.env.PGDATABASE || 'hrvo_dev',
      });
      this.adminPool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGADMIN_USER || process.env.PGUSER || 'postgres',
        password: process.env.PGADMIN_PASSWORD || process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'hrvo_dev',
      });
      this.retentionPool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGRETENTION_USER || 'hrvo_retention',
        password: process.env.PGRETENTION_PASSWORD || 'hrvo_retention_dev',
        database: process.env.PGDATABASE || 'hrvo_dev',
      });
    }
  }

  /**
   * Run query within PostgreSQL Row-Level Security tenant context.
   *
   * Enforces:
   * 1. Transaction wrapping (BEGIN ... COMMIT/ROLLBACK)
   * 2. Mandatory orgId validation (fails immediately if orgId is missing or empty)
   * 3. Calling SELECT set_config('app.org_id', $1, true) BEFORE executing any query
   */
  public async queryWithRls<T extends pg.QueryResultRow = pg.QueryResultRow>(
    orgId: string,
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    if (!orgId || typeof orgId !== 'string' || orgId.trim() === '') {
      throw new Error('Tenant context missing: orgId must be provided for all repository queries');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const res = await client.query<T>(text, params);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async findOpenSessionByUserId(
    orgId: string,
    userId: string,
  ): Promise<AttendanceSession | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_sessions WHERE org_id = $1 AND user_id = $2 AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
      [orgId, userId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    const segments = await this.findSegmentsBySessionId(orgId, row.id);
    return this.mapRowToSession(row, segments);
  }

  public async findSessionById(
    orgId: string,
    sessionId: string,
  ): Promise<AttendanceSession | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_sessions WHERE org_id = $1 AND id = $2`,
      [orgId, sessionId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    const segments = await this.findSegmentsBySessionId(orgId, row.id);
    return this.mapRowToSession(row, segments);
  }

  public async findAllOpenSessions(orgId: string): Promise<AttendanceSession[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_sessions WHERE org_id = $1 AND status = 'OPEN'`,
      [orgId],
    );

    const sessions: AttendanceSession[] = [];
    for (const row of res.rows) {
      const segments = await this.findSegmentsBySessionId(row.org_id, row.id);
      sessions.push(this.mapRowToSession(row, segments));
    }
    return sessions;
  }

  public async saveSession(session: AttendanceSession): Promise<void> {
    await this.queryWithRls(
      session.orgId,
      `INSERT INTO attendance_sessions (
        id, org_id, user_id, device_id, work_date, clock_in_at, clock_out_at,
        clock_in_source, clock_out_source, active_seconds, idle_seconds, break_seconds,
        meeting_seconds, net_seconds, last_heartbeat_at, ip_in, ip_out, flags,
        status, current_state, previous_state, grace_timer_expires_at, consecutive_idle_seconds, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP
      )
      ON CONFLICT (id) DO UPDATE SET
        clock_out_at = EXCLUDED.clock_out_at,
        clock_out_source = EXCLUDED.clock_out_source,
        active_seconds = EXCLUDED.active_seconds,
        idle_seconds = EXCLUDED.idle_seconds,
        break_seconds = EXCLUDED.break_seconds,
        meeting_seconds = EXCLUDED.meeting_seconds,
        net_seconds = EXCLUDED.net_seconds,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        ip_out = EXCLUDED.ip_out,
        flags = EXCLUDED.flags,
        status = EXCLUDED.status,
        current_state = EXCLUDED.current_state,
        previous_state = EXCLUDED.previous_state,
        grace_timer_expires_at = EXCLUDED.grace_timer_expires_at,
        consecutive_idle_seconds = EXCLUDED.consecutive_idle_seconds,
        updated_at = CURRENT_TIMESTAMP`,
      [
        session.id,
        session.orgId,
        session.userId,
        session.deviceId,
        session.workDate,
        session.clockInAt,
        session.clockOutAt,
        session.clockInSource,
        session.clockOutSource,
        session.activeSeconds,
        session.idleSeconds,
        session.breakSeconds,
        session.meetingSeconds,
        session.netSeconds,
        session.lastHeartbeatAt,
        session.ipIn,
        session.ipOut,
        session.flags,
        session.status,
        session.currentState,
        session.previousState || null,
        session.graceTimerExpiresAt || null,
        session.consecutiveIdleSeconds,
      ],
    );

    // Save all segments
    for (const seg of session.segments) {
      await this.saveSegment(session.orgId, seg, session.id);
    }
  }

  public async saveSegment(
    orgId: string,
    seg: AttendanceSegment,
    sessionId: string,
  ): Promise<void> {
    await this.queryWithRls(
      orgId,
      `INSERT INTO attendance_segments (
        id, org_id, session_id, state, started_at, ended_at, duration_seconds, meeting_id, flags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        ended_at = EXCLUDED.ended_at,
        duration_seconds = EXCLUDED.duration_seconds,
        flags = EXCLUDED.flags`,
      [
        seg.id,
        orgId,
        sessionId,
        seg.state,
        seg.startedAt,
        seg.endedAt,
        seg.durationSeconds,
        seg.meetingId || null,
        seg.flags,
      ],
    );
  }

  public async findSegmentsBySessionId(
    orgId: string,
    sessionId: string,
  ): Promise<AttendanceSegment[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_segments WHERE org_id = $1 AND session_id = $2 ORDER BY started_at ASC`,
      [orgId, sessionId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      state: r.state as AttendanceState,
      startedAt: new Date(r.started_at),
      endedAt: r.ended_at ? new Date(r.ended_at) : null,
      durationSeconds: r.duration_seconds,
      meetingId: r.meeting_id || null,
      flags: r.flags,
    }));
  }

  public async hasNonce(orgId: string, userId: string, nonce: string): Promise<boolean> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT 1 FROM heartbeat_nonces WHERE org_id = $1 AND user_id = $2 AND nonce = $3`,
      [orgId, userId, nonce],
    );
    return res.rows.length > 0;
  }

  public async recordNonce(
    orgId: string,
    userId: string,
    nonce: string,
    now: Date,
  ): Promise<void> {
    await this.queryWithRls(
      orgId,
      `INSERT INTO heartbeat_nonces (org_id, user_id, nonce, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [orgId, userId, nonce, now],
    );
  }

  public async getLastDeviceSequence(
    orgId: string,
    userId: string,
    deviceId: string,
  ): Promise<number> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT last_sequence FROM device_sequences WHERE org_id = $1 AND user_id = $2 AND device_id = $3`,
      [orgId, userId, deviceId],
    );
    return res.rows.length > 0 ? res.rows[0].last_sequence : 0;
  }

  public async setDeviceSequence(
    orgId: string,
    userId: string,
    deviceId: string,
    seq: number,
  ): Promise<void> {
    await this.queryWithRls(
      orgId,
      `INSERT INTO device_sequences (org_id, user_id, device_id, last_sequence, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, user_id, device_id) DO UPDATE SET
         last_sequence = EXCLUDED.last_sequence,
         updated_at = CURRENT_TIMESTAMP`,
      [orgId, userId, deviceId, seq],
    );
  }

  public async saveSessionSecret(orgId: string, sessionId: string, secret: string): Promise<void> {
    await this.queryWithRls(
      orgId,
      `INSERT INTO session_secrets (session_id, org_id, secret, created_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET secret = EXCLUDED.secret, org_id = EXCLUDED.org_id`,
      [sessionId, orgId, secret],
    );
  }

  public async findSessionSecret(orgId: string, sessionId: string): Promise<string | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT secret FROM session_secrets WHERE org_id = $1 AND session_id = $2`,
      [orgId, sessionId],
    );
    return res.rows.length > 0 ? res.rows[0].secret : null;
  }

  public async revokeSessionSecret(orgId: string, sessionId: string): Promise<void> {
    await this.queryWithRls(
      orgId,
      `DELETE FROM session_secrets WHERE org_id = $1 AND session_id = $2`,
      [orgId, sessionId],
    );
  }

  /**
   * Cleanup job for heartbeat_nonces: Deletes nonces older than specified date (e.g. 5 minutes)
   */
  public async cleanupExpiredNonces(orgId: string, olderThan: Date): Promise<number> {
    const res = await this.queryWithRls(
      orgId,
      `DELETE FROM heartbeat_nonces WHERE org_id = $1 AND created_at < $2`,
      [orgId, olderThan],
    );
    return res.rowCount || 0;
  }

  /**
   * Cleanup job for device_sequences: Deletes stale device sequences inactive past threshold
   */
  public async cleanupStaleDeviceSequences(orgId: string, olderThan: Date): Promise<number> {
    const res = await this.queryWithRls(
      orgId,
      `DELETE FROM device_sequences WHERE org_id = $1 AND updated_at < $2`,
      [orgId, olderThan],
    );
    return res.rowCount || 0;
  }

  // Work Schedules (FR-ATT-014)
  public async saveWorkSchedule(schedule: WorkSchedule): Promise<void> {
    await this.queryWithRls(
      schedule.orgId,
      `INSERT INTO work_schedules (id, org_id, user_id, team_id, days, flexible, grace_minutes, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         team_id = EXCLUDED.team_id,
         days = EXCLUDED.days,
         flexible = EXCLUDED.flexible,
         grace_minutes = EXCLUDED.grace_minutes,
         effective_from = EXCLUDED.effective_from,
         effective_to = EXCLUDED.effective_to`,
      [
        schedule.id,
        schedule.orgId,
        schedule.userId || null,
        schedule.teamId || null,
        JSON.stringify(schedule.days),
        schedule.flexible,
        schedule.graceMinutes,
        schedule.effectiveFrom,
        schedule.effectiveTo || null,
      ],
    );
  }

  public async findWorkScheduleForUser(orgId: string, userId: string): Promise<WorkSchedule | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT ws.* FROM work_schedules ws
       LEFT JOIN users u ON u.id = $2 AND u.team_id = ws.team_id
       WHERE ws.org_id = $1 AND (ws.user_id = $2 OR (ws.team_id IS NOT NULL AND ws.team_id = u.team_id) OR (ws.user_id IS NULL AND ws.team_id IS NULL))
       ORDER BY ws.user_id NULLS LAST, ws.team_id NULLS LAST
       LIMIT 1`,
      [orgId, userId],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      orgId: r.org_id,
      userId: r.user_id,
      teamId: r.team_id,
      days: r.days,
      flexible: r.flexible,
      graceMinutes: r.grace_minutes,
      effectiveFrom: r.effective_from instanceof Date
        ? `${r.effective_from.getFullYear()}-${String(r.effective_from.getMonth() + 1).padStart(2, '0')}-${String(r.effective_from.getDate()).padStart(2, '0')}`
        : r.effective_from,
      effectiveTo: r.effective_to instanceof Date
        ? `${r.effective_to.getFullYear()}-${String(r.effective_to.getMonth() + 1).padStart(2, '0')}-${String(r.effective_to.getDate()).padStart(2, '0')}`
        : null,
    };
  }

  // Corrections (FR-ATT-013)
  public async createCorrection(c: AttendanceCorrection): Promise<void> {
    await this.queryWithRls(
      c.orgId,
      `INSERT INTO attendance_corrections (id, org_id, user_id, session_id, requested_in, requested_out, reason, evidence_document_id, status, reviewer_id, reviewed_at, review_note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        c.id,
        c.orgId,
        c.userId,
        c.sessionId || null,
        c.requestedIn,
        c.requestedOut,
        c.reason,
        c.evidenceDocumentId || null,
        c.status,
        c.reviewerId || null,
        c.reviewedAt || null,
        c.reviewNote || null,
        c.createdAt,
      ],
    );
  }

  public async findCorrectionById(orgId: string, id: string): Promise<AttendanceCorrection | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_corrections WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRowToCorrection(res.rows[0]);
  }

  public async updateCorrection(c: AttendanceCorrection): Promise<void> {
    await this.queryWithRls(
      c.orgId,
      `UPDATE attendance_corrections SET
         status = $3,
         reviewer_id = $4,
         reviewed_at = $5,
         review_note = $6
       WHERE org_id = $1 AND id = $2`,
      [
        c.orgId,
        c.id,
        c.status,
        c.reviewerId || null,
        c.reviewedAt || null,
        c.reviewNote || null,
      ],
    );
  }

  public async findPendingCorrections(orgId: string): Promise<AttendanceCorrection[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_corrections WHERE org_id = $1 AND status = 'PENDING' ORDER BY created_at ASC`,
      [orgId],
    );
    return res.rows.map(this.mapRowToCorrection);
  }

  public async findCorrectionsByUser(orgId: string, userId: string): Promise<AttendanceCorrection[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_corrections WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [orgId, userId],
    );
    return res.rows.map(this.mapRowToCorrection);
  }

  private mapRowToCorrection(row: pg.QueryResultRow): AttendanceCorrection {
    return {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      sessionId: row.session_id || null,
      requestedIn: new Date(row.requested_in),
      requestedOut: new Date(row.requested_out),
      reason: row.reason,
      evidenceDocumentId: row.evidence_document_id || null,
      status: row.status,
      reviewerId: row.reviewer_id || null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
      reviewNote: row.review_note || null,
      createdAt: new Date(row.created_at),
    };
  }

  // Daily Records & Timesheets (FR-ATT-015 & FR-TS-001)
  public async saveDailyAttendance(r: AttendanceDaily): Promise<void> {
    await this.queryWithRls(
      r.orgId,
      `INSERT INTO attendance_daily (
         org_id, user_id, work_date, first_in, last_out, active_seconds, idle_seconds,
         break_seconds, meeting_seconds, net_seconds, expected_seconds, late_minutes,
         early_leave_minutes, overtime_minutes, day_status, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, user_id, work_date) DO UPDATE SET
         first_in = EXCLUDED.first_in,
         last_out = EXCLUDED.last_out,
         active_seconds = EXCLUDED.active_seconds,
         idle_seconds = EXCLUDED.idle_seconds,
         break_seconds = EXCLUDED.break_seconds,
         meeting_seconds = EXCLUDED.meeting_seconds,
         net_seconds = EXCLUDED.net_seconds,
         expected_seconds = EXCLUDED.expected_seconds,
         late_minutes = EXCLUDED.late_minutes,
         early_leave_minutes = EXCLUDED.early_leave_minutes,
         overtime_minutes = EXCLUDED.overtime_minutes,
         day_status = EXCLUDED.day_status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        r.orgId,
        r.userId,
        r.workDate,
        r.firstIn,
        r.lastOut,
        r.activeSeconds,
        r.idleSeconds,
        r.breakSeconds,
        r.meetingSeconds,
        r.netSeconds,
        r.expectedSeconds,
        r.lateMinutes,
        r.earlyLeaveMinutes,
        r.overtimeMinutes,
        r.dayStatus,
      ],
    );
  }

  public async findDailyAttendance(orgId: string, userId: string, workDate: string): Promise<AttendanceDaily | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_daily WHERE org_id = $1 AND user_id = $2 AND work_date = $3`,
      [orgId, userId, workDate],
    );
    if (res.rows.length === 0) return null;
    return this.mapRowToDaily(res.rows[0]);
  }

  public async findDailyAttendanceInRange(orgId: string, filter: AttendanceExportFilter): Promise<AttendanceDaily[]> {
    let query = `SELECT d.*, u.display_name, u.email FROM attendance_daily d JOIN users u ON u.id = d.user_id WHERE d.org_id = $1 AND d.work_date >= $2 AND d.work_date <= $3`;
    const params: unknown[] = [orgId, filter.startDate, filter.endDate];
    if (filter.userId) {
      params.push(filter.userId);
      query += ` AND d.user_id = $${params.length}`;
    }
    if (filter.teamId) {
      params.push(filter.teamId);
      query += ` AND u.team_id = $${params.length}`;
    }
    query += ` ORDER BY d.work_date ASC, u.display_name ASC`;
    const res = await this.queryWithRls(orgId, query, params);
    return res.rows.map(this.mapRowToDaily);
  }

  public async findSessionsByDate(orgId: string, workDate: string): Promise<AttendanceSession[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_sessions WHERE org_id = $1 AND work_date = $2 ORDER BY clock_in_at ASC`,
      [orgId, workDate],
    );
    const sessions: AttendanceSession[] = [];
    for (const row of res.rows) {
      const segments = await this.findSegmentsBySessionId(orgId, row.id);
      sessions.push(this.mapRowToSession(row, segments));
    }
    return sessions;
  }

  /** Sessions (without segments) for one user with work_date in [fromDate, toDate]. */
  public async findSessionsByUserInRange(orgId: string, userId: string, fromDate: string, toDate: string): Promise<AttendanceSession[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM attendance_sessions
       WHERE org_id = $1 AND user_id = $2 AND work_date >= $3 AND work_date <= $4
       ORDER BY clock_in_at ASC`,
      [orgId, userId, fromDate, toDate],
    );
    return res.rows.map((row) => this.mapRowToSession(row, []));
  }

  /** Pending corrections joined with the requester (for the manager review queue). */
  public async findPendingCorrectionsWithRequester(orgId: string): Promise<Array<AttendanceCorrection & CorrectionRequester>> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT c.*, u.display_name AS requester_name, u.email AS requester_email,
              u.manager_id AS requester_manager_id, u.team_id AS requester_team_id
       FROM attendance_corrections c JOIN users u ON u.id = c.user_id
       WHERE c.org_id = $1 AND c.status = 'PENDING'
       ORDER BY c.created_at ASC`,
      [orgId],
    );
    return res.rows.map((row) => ({
      ...this.mapRowToCorrection(row),
      requesterName: row.requester_name ?? null,
      requesterEmail: row.requester_email,
      requesterManagerId: row.requester_manager_id ?? null,
      requesterTeamId: row.requester_team_id ?? null,
    }));
  }

  private mapRowToDaily(row: pg.QueryResultRow): AttendanceDaily {
    return {
      orgId: row.org_id,
      userId: row.user_id,
      workDate: row.work_date,
      firstIn: row.first_in ? new Date(row.first_in) : null,
      lastOut: row.last_out ? new Date(row.last_out) : null,
      activeSeconds: row.active_seconds,
      idleSeconds: row.idle_seconds,
      breakSeconds: row.break_seconds,
      meetingSeconds: row.meeting_seconds,
      netSeconds: row.net_seconds,
      expectedSeconds: row.expected_seconds,
      lateMinutes: row.late_minutes,
      earlyLeaveMinutes: row.early_leave_minutes,
      overtimeMinutes: row.overtime_minutes,
      dayStatus: row.day_status,
      displayName: row.display_name,
      email: row.email,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  public async saveDraftTimesheet(t: DraftTimesheet): Promise<void> {
    await this.queryWithRls(
      t.orgId,
      `INSERT INTO draft_timesheets (
         id, org_id, user_id, work_date, period_start, period_end, status,
         attendance_minutes, logged_minutes, billable_minutes, variance_minutes, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, user_id, work_date) DO UPDATE SET
         attendance_minutes = EXCLUDED.attendance_minutes,
         logged_minutes = EXCLUDED.logged_minutes,
         billable_minutes = EXCLUDED.billable_minutes,
         variance_minutes = EXCLUDED.variance_minutes,
         status = EXCLUDED.status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        t.id,
        t.orgId,
        t.userId,
        t.workDate,
        t.periodStart,
        t.periodEnd,
        t.status,
        t.attendanceMinutes,
        t.loggedMinutes,
        t.billableMinutes,
        t.varianceMinutes,
      ],
    );
  }

  public async findDraftTimesheet(orgId: string, userId: string, workDate: string): Promise<DraftTimesheet | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM draft_timesheets WHERE org_id = $1 AND user_id = $2 AND work_date = $3 LIMIT 1`,
      [orgId, userId, workDate],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      orgId: r.org_id,
      userId: r.user_id,
      workDate: r.work_date,
      periodStart: String(r.period_start),
      periodEnd: String(r.period_end),
      status: r.status,
      attendanceMinutes: r.attendance_minutes,
      loggedMinutes: r.logged_minutes,
      billableMinutes: r.billable_minutes,
      varianceMinutes: r.variance_minutes,
    };
  }

  // Users & Teams (FR-ATT-016)
  public async findUserById(orgId: string, userId: string): Promise<{ id: string; orgId: string; email: string; displayName: string; role: string; teamId: string | null; managerId: string | null } | null> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT id, org_id, email, display_name, role, team_id, manager_id FROM users WHERE org_id = $1 AND id = $2`,
      [orgId, userId],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      orgId: r.org_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      teamId: r.team_id,
      managerId: r.manager_id,
    };
  }

  public async findAllUsers(orgId: string, teamId?: string): Promise<Array<{ id: string; orgId: string; email: string; displayName: string; role: string; teamId: string | null; managerId: string | null }>> {
    let query = `SELECT id, org_id, email, display_name, role, team_id, manager_id FROM users WHERE org_id = $1`;
    const params: unknown[] = [orgId];
    if (teamId) {
      params.push(teamId);
      query += ` AND team_id = $2`;
    }
    query += ` ORDER BY display_name ASC`;
    const res = await this.queryWithRls(orgId, query, params);
    return res.rows.map((r: pg.QueryResultRow) => ({
      id: r.id,
      orgId: r.org_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      teamId: r.team_id,
      managerId: r.manager_id,
    }));
  }

  // Audit Logs (FR-AUD-001)
  public static canonicalJson(obj: unknown): string {
    if (obj === null || obj === undefined) return '{}';
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return '[' + obj.map((item) => (typeof item === 'object' ? PostgresAttendanceRepository.canonicalJson(item) : JSON.stringify(item))).join(',') + ']';
    }
    const record = obj as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const pairs: string[] = [];
    for (const k of sortedKeys) {
      const val = record[k];
      if (val === undefined) continue;
      const valStr = typeof val === 'object' && val !== null ? PostgresAttendanceRepository.canonicalJson(val) : JSON.stringify(val);
      pairs.push(`${JSON.stringify(k)}:${valStr}`);
    }
    return '{' + pairs.join(',') + '}';
  }

  public async recordAuditLog(entry: Omit<AuditLogEntry, 'id' | 'prevHash' | 'hash'>): Promise<AuditLogEntry> {
    if (!entry.orgId || entry.orgId.trim() === '') {
      throw new Error('Tenant context missing: orgId is required for audit logs');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [entry.orgId]);

      // Advisory transaction lock per organization: serializes audit log appends within the same tenant
      // while allowing parallel appends across different organizations.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('audit_logs:' || $1::text))`, [entry.orgId]);

      const lastRes = await client.query(
        `SELECT hash FROM audit_logs WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
        [entry.orgId],
      );
      const prevHash = lastRes.rows.length > 0
        ? lastRes.rows[0].hash
        : '0000000000000000000000000000000000000000000000000000000000000000';

      const beforeStr = PostgresAttendanceRepository.canonicalJson(entry.before);
      const afterStr = PostgresAttendanceRepository.canonicalJson(entry.after);
      const payload = `${prevHash}|${entry.orgId}|${entry.actorId}|${entry.action}|${entry.entityType}|${entry.entityId}|${beforeStr}|${afterStr}|${entry.createdAt.toISOString()}`;
      const hash = crypto.createHash('sha256').update(payload).digest('hex');

      const insertRes = await client.query(
        `INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, before, after, ip, user_agent, prev_hash, hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          entry.orgId,
          entry.actorId,
          entry.action,
          entry.entityType,
          entry.entityId,
          beforeStr,
          afterStr,
          entry.ip || null,
          entry.userAgent || null,
          prevHash,
          hash,
          entry.createdAt,
        ],
      );

      await client.query('COMMIT');

      return {
        id: Number(insertRes.rows[0].id),
        ...entry,
        prevHash,
        hash,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async findAuditLogs(orgId: string, entityType?: string, entityId?: string): Promise<AuditLogEntry[]> {
    let query = `SELECT * FROM audit_logs WHERE org_id = $1`;
    const params: unknown[] = [orgId];
    if (entityType) {
      params.push(entityType);
      query += ` AND entity_type = $${params.length}`;
    }
    if (entityId) {
      params.push(entityId);
      query += ` AND entity_id = $${params.length}`;
    }
    query += ` ORDER BY id ASC`;
    const res = await this.queryWithRls(orgId, query, params);
    return res.rows.map((r: pg.QueryResultRow) => ({
      id: Number(r.id),
      orgId: r.org_id,
      actorId: r.actor_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      before: r.before,
      after: r.after,
      ip: r.ip,
      userAgent: r.user_agent,
      prevHash: r.prev_hash,
      hash: r.hash,
      createdAt: new Date(r.created_at),
    }));
  }

  public async verifyAuditLogChain(orgId: string): Promise<boolean> {
    const logs = await this.findAuditLogs(orgId);
    let expectedPrev = '0000000000000000000000000000000000000000000000000000000000000000';
    for (const log of logs) {
      if (log.prevHash !== expectedPrev) return false;
      const beforeStr = PostgresAttendanceRepository.canonicalJson(log.before);
      const afterStr = PostgresAttendanceRepository.canonicalJson(log.after);
      const payload = `${log.prevHash}|${log.orgId}|${log.actorId}|${log.action}|${log.entityType}|${log.entityId}|${beforeStr}|${afterStr}|${log.createdAt.toISOString()}`;
      const computedHash = crypto.createHash('sha256').update(payload).digest('hex');
      if (log.hash !== computedHash) return false;
      expectedPrev = log.hash;
    }
    return true;
  }

  // Transparency & Consent (FR-ATT-020 & FR-AUD-004)
  public async saveMonitoringConsent(c: MonitoringConsent): Promise<void> {
    await this.queryWithRls(
      c.orgId,
      `INSERT INTO monitoring_consents (id, org_id, user_id, notice_version, accepted_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.id, c.orgId, c.userId, c.noticeVersion, c.acceptedAt, c.ip || null, c.userAgent || null],
    );
  }

  public async findMonitoringConsentsByUser(orgId: string, userId: string): Promise<MonitoringConsent[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM monitoring_consents WHERE org_id = $1 AND user_id = $2 ORDER BY accepted_at DESC`,
      [orgId, userId],
    );
    return res.rows.map((r: pg.QueryResultRow) => ({
      id: r.id,
      orgId: r.org_id,
      userId: r.user_id,
      noticeVersion: r.notice_version,
      acceptedAt: new Date(r.accepted_at),
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  }

  public async recordPresenceEvent(e: { orgId: string; userId: string; sessionId?: string; serverTs: Date; clientTs?: Date; eventType: string; state: string; seq: number; ip?: string; meta?: Record<string, unknown> }): Promise<void> {
    await this.queryWithRls(
      e.orgId,
      `INSERT INTO presence_events (org_id, user_id, session_id, server_ts, client_ts, event_type, state, seq, ip, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.orgId,
        e.userId,
        e.sessionId || null,
        e.serverTs,
        e.clientTs || null,
        e.eventType,
        e.state,
        e.seq,
        e.ip || null,
        JSON.stringify(e.meta || {}),
      ],
    );
  }

  public async findPresenceEventsByUser(orgId: string, userId: string, limit: number = 100): Promise<PresenceEventRecord[]> {
    const res = await this.queryWithRls(
      orgId,
      `SELECT * FROM presence_events WHERE org_id = $1 AND user_id = $2 ORDER BY server_ts DESC LIMIT $3`,
      [orgId, userId, limit],
    );
    return res.rows.map((r: pg.QueryResultRow) => ({
      id: r.id,
      serverTs: new Date(r.server_ts),
      clientTs: r.client_ts ? new Date(r.client_ts) : null,
      eventType: r.event_type,
      state: r.state,
      seq: Number(r.seq),
      ip: r.ip,
      meta: r.meta,
    }));
  }

  /**
   * Admin wipe used ONLY for test teardown and fixture reset (runs via adminPool)
   */
  public async clearAll(orgId?: string): Promise<void> {
    if (orgId) {
      await this.adminPool.query(`DELETE FROM monitoring_consents WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM presence_events WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM audit_logs WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM draft_timesheets WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM attendance_daily WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM attendance_corrections WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM work_schedules WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM attendance_segments WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM attendance_sessions WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM heartbeat_nonces WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM device_sequences WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM session_secrets WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM users WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM teams WHERE org_id = $1`, [orgId]);
      await this.adminPool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    } else {
      await this.adminPool.query(`DELETE FROM monitoring_consents`);
      await this.adminPool.query(`DELETE FROM presence_events`);
      await this.adminPool.query(`DELETE FROM audit_logs`);
      await this.adminPool.query(`DELETE FROM draft_timesheets`);
      await this.adminPool.query(`DELETE FROM attendance_daily`);
      await this.adminPool.query(`DELETE FROM attendance_corrections`);
      await this.adminPool.query(`DELETE FROM work_schedules`);
      await this.adminPool.query(`DELETE FROM attendance_segments`);
      await this.adminPool.query(`DELETE FROM attendance_sessions`);
      await this.adminPool.query(`DELETE FROM heartbeat_nonces`);
      await this.adminPool.query(`DELETE FROM device_sequences`);
      await this.adminPool.query(`DELETE FROM session_secrets`);
      await this.adminPool.query(`DELETE FROM users`);
      await this.adminPool.query(`DELETE FROM teams`);
      await this.adminPool.query(`DELETE FROM organizations`);
    }
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  public getAdminPool(): pg.Pool {
    return this.adminPool;
  }

  public getRetentionPool(): pg.Pool {
    return this.retentionPool;
  }

  public async cleanupOldPresenceEvents(orgId: string, olderThan: Date): Promise<number> {
    if (!orgId || orgId.trim() === '') {
      throw new Error('Tenant context missing: orgId is required');
    }
    const client = await this.retentionPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      const res = await client.query(
        `DELETE FROM presence_events WHERE org_id = $1 AND server_ts < $2`,
        [orgId, olderThan],
      );
      await client.query('COMMIT');
      return res.rowCount || 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
    await this.adminPool.end();
    await this.retentionPool.end();
  }

  private mapRowToSession(row: pg.QueryResultRow, segments: AttendanceSegment[]): AttendanceSession {
    return {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      deviceId: row.device_id,
      workDate: row.work_date,
      clockInAt: new Date(row.clock_in_at),
      clockOutAt: row.clock_out_at ? new Date(row.clock_out_at) : null,
      clockInSource: row.clock_in_source as ClockInSource,
      clockOutSource: row.clock_out_source as ClockOutSource | null,
      activeSeconds: row.active_seconds,
      idleSeconds: row.idle_seconds,
      breakSeconds: row.break_seconds,
      meetingSeconds: row.meeting_seconds,
      netSeconds: row.net_seconds,
      lastHeartbeatAt: new Date(row.last_heartbeat_at),
      ipIn: row.ip_in,
      ipOut: row.ip_out || null,
      flags: row.flags,
      status: row.status as SessionStatus,
      currentState: row.current_state as AttendanceState,
      previousState: (row.previous_state as AttendanceState) || undefined,
      segments,
      graceTimerExpiresAt: row.grace_timer_expires_at
        ? new Date(row.grace_timer_expires_at)
        : null,
      consecutiveIdleSeconds: row.consecutive_idle_seconds,
    };
  }
}
