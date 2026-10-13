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
} from '../../../../packages/shared/src/attendance/types.ts';

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
  clearAll(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresRepositoryOptions {
  appPoolConfig?: pg.PoolConfig;
  adminPoolConfig?: pg.PoolConfig;
}

export class PostgresAttendanceRepository implements IAttendanceRepository {
  private pool: pg.Pool;      // Application pool (runs as non-superuser 'hrvo_app' with NOBYPASSRLS)
  private adminPool: pg.Pool; // Admin pool (runs as owner 'postgres' for migrations & test wipe ONLY)

  constructor(options?: string | pg.PoolConfig | PostgresRepositoryOptions) {
    if (typeof options === 'string') {
      this.pool = new Pool({ connectionString: options });
      this.adminPool = new Pool({ connectionString: options });
    } else if (options && ('appPoolConfig' in options || 'adminPoolConfig' in options)) {
      const opts = options as PostgresRepositoryOptions;
      this.pool = new Pool(
        opts.appPoolConfig || {
          host: process.env.PGHOST || 'localhost',
          port: parseInt(process.env.PGPORT || '5433', 10),
          user: process.env.PGAPP_USER || 'hrvo_app',
          password: process.env.PGAPP_PASSWORD || 'hrvo_app_pass',
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
    } else if (options) {
      // Direct PoolConfig passed
      this.pool = new Pool(options as pg.PoolConfig);
      this.adminPool = new Pool({
        ...(options as pg.PoolConfig),
        user: process.env.PGADMIN_USER || process.env.PGUSER || 'postgres',
        password: process.env.PGADMIN_PASSWORD || process.env.PGPASSWORD || 'postgres',
      });
    } else {
      // Default: Connect as non-superuser hrvo_app
      this.pool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGAPP_USER || 'hrvo_app',
        password: process.env.PGAPP_PASSWORD || 'hrvo_app_pass',
        database: process.env.PGDATABASE || 'hrvo_dev',
      });
      this.adminPool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGADMIN_USER || process.env.PGUSER || 'postgres',
        password: process.env.PGADMIN_PASSWORD || process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'hrvo_dev',
      });
    }
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  public getAdminPool(): pg.Pool {
    return this.adminPool;
  }

  public async close(): Promise<void> {
    await this.pool.end();
    await this.adminPool.end();
  }

  /**
   * Run query within PostgreSQL Row-Level Security tenant context.
   *
   * Enforces:
   * 1. Transaction wrapping (BEGIN ... COMMIT/ROLLBACK)
   * 2. Mandatory orgId validation (fails immediately if orgId is missing or empty)
   * 3. Calling SELECT set_config('app.org_id', $1, true) BEFORE executing any query
   */
  public async queryWithRls<T extends pg.QueryResultRow = any>(
    orgId: string,
    text: string,
    params: any[] = [],
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
      flags: r.flags || [],
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

  /**
   * Admin wipe used ONLY for test teardown and fixture reset (runs via adminPool)
   */
  public async clearAll(): Promise<void> {
    await this.adminPool.query(`DELETE FROM attendance_segments`);
    await this.adminPool.query(`DELETE FROM attendance_sessions`);
    await this.adminPool.query(`DELETE FROM heartbeat_nonces`);
    await this.adminPool.query(`DELETE FROM device_sequences`);
    await this.adminPool.query(`DELETE FROM session_secrets`);
    await this.adminPool.query(`DELETE FROM users`);
    await this.adminPool.query(`DELETE FROM organizations`);
  }

  private mapRowToSession(row: any, segments: AttendanceSegment[]): AttendanceSession {
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
      flags: row.flags || [],
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
