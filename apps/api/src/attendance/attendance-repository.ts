/**
 * HRVO Attendance Repository Interface and PostgreSQL Implementation
 * Ref: docs/SRS.md Section 7.4, Section 3.4 (RLS)
 */

import pg from 'pg';
import type {
  AttendanceSegment,
  AttendanceSession,
  AttendanceState,
  ClockInSource,
  ClockOutSource,
  SessionStatus,
} from '../../../../packages/shared/src/attendance/types.ts';

const { Pool } = pg;

export interface IAttendanceRepository {
  findOpenSessionByUserId(orgId: string, userId: string): Promise<AttendanceSession | null>;
  findSessionById(orgId: string, sessionId: string): Promise<AttendanceSession | null>;
  saveSession(session: AttendanceSession): Promise<void>;
  findAllOpenSessions(orgId?: string): Promise<AttendanceSession[]>;
  saveSegment(orgId: string, segment: AttendanceSegment, sessionId: string): Promise<void>;
  findSegmentsBySessionId(orgId: string, sessionId: string): Promise<AttendanceSegment[]>;
  hasNonce(orgId: string, userId: string, nonce: string): Promise<boolean>;
  recordNonce(orgId: string, userId: string, nonce: string, now: Date): Promise<void>;
  getLastDeviceSequence(orgId: string, userId: string, deviceId: string): Promise<number>;
  setDeviceSequence(orgId: string, userId: string, deviceId: string, seq: number): Promise<void>;
  saveSessionSecret(sessionId: string, secret: string): Promise<void>;
  findSessionSecret(sessionId: string): Promise<string | null>;
  revokeSessionSecret(sessionId: string): Promise<void>;
  clearAll(): Promise<void>;
}

export class PostgresAttendanceRepository implements IAttendanceRepository {
  private pool: pg.Pool;

  constructor(connectionStringOrConfig?: string | pg.PoolConfig) {
    if (typeof connectionStringOrConfig === 'string') {
      this.pool = new Pool({ connectionString: connectionStringOrConfig });
    } else if (connectionStringOrConfig) {
      this.pool = new Pool(connectionStringOrConfig);
    } else {
      this.pool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5433', 10),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'hrvo_dev',
      });
    }
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Run query within PostgreSQL Row-Level Security tenant context
   */
  private async queryWithRls<T extends pg.QueryResultRow = any>(
    orgId: string | null,
    text: string,
    params: any[] = [],
  ): Promise<pg.QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (orgId) {
        await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
      }
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

  public async findAllOpenSessions(orgId?: string): Promise<AttendanceSession[]> {
    const query = orgId
      ? `SELECT * FROM attendance_sessions WHERE org_id = $1 AND status = 'OPEN'`
      : `SELECT * FROM attendance_sessions WHERE status = 'OPEN'`;
    const params = orgId ? [orgId] : [];
    const res = await this.queryWithRls(orgId || null, query, params);

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

  public async saveSessionSecret(sessionId: string, secret: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_secrets (session_id, secret, created_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET secret = EXCLUDED.secret`,
      [sessionId, secret],
    );
  }

  public async findSessionSecret(sessionId: string): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT secret FROM session_secrets WHERE session_id = $1`,
      [sessionId],
    );
    return res.rows.length > 0 ? res.rows[0].secret : null;
  }

  public async revokeSessionSecret(sessionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM session_secrets WHERE session_id = $1`, [
      sessionId,
    ]);
  }

  public async clearAll(): Promise<void> {
    await this.pool.query(`DELETE FROM attendance_segments`);
    await this.pool.query(`DELETE FROM attendance_sessions`);
    await this.pool.query(`DELETE FROM heartbeat_nonces`);
    await this.pool.query(`DELETE FROM device_sequences`);
    await this.pool.query(`DELETE FROM session_secrets`);
    await this.pool.query(`DELETE FROM users`);
    await this.pool.query(`DELETE FROM organizations`);
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
