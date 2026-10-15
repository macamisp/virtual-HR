/**
 * FR-ADM-001: reading and writing the per-organisation policy (organizations columns).
 */
import type pg from 'pg';
import type { PrismaService } from '../common/prisma.service.ts';
import type { AttendanceConfig } from '../../../../packages/shared/src/attendance/types.ts';
import type { OrgPolicy } from '../../../../packages/shared/src/admin/types.ts';

interface PolicyRow {
  timezone: string;
  att_missed_heartbeat_seconds: number;
  att_disconnect_grace_seconds: number;
  att_idle_seconds: number;
  att_pause_seconds: number;
  att_max_session_seconds: number;
  att_paid_break_minutes: number;
  manual_time_limit_minutes: number;
  timesheet_variance_pct: number;
  vault_reauth_minutes: number;
  retention_presence_days: number;
}

const COLUMNS = `timezone, att_missed_heartbeat_seconds, att_disconnect_grace_seconds, att_idle_seconds, att_pause_seconds,
  att_max_session_seconds, att_paid_break_minutes, manual_time_limit_minutes, timesheet_variance_pct, vault_reauth_minutes, retention_presence_days`;

export async function readOrgPolicy(db: pg.PoolClient, orgId: string): Promise<OrgPolicy & { timezone: string; presenceRetentionDays: number }> {
  const res = await db.query<PolicyRow>(`SELECT ${COLUMNS} FROM organizations WHERE id = $1`, [orgId]);
  const r = res.rows[0];
  if (!r) throw new Error('Organisation not found');
  return {
    timezone: r.timezone,
    presenceRetentionDays: r.retention_presence_days,
    missedHeartbeatTimeoutSeconds: r.att_missed_heartbeat_seconds,
    disconnectGraceWindowSeconds: r.att_disconnect_grace_seconds,
    idleThresholdSeconds: r.att_idle_seconds,
    pauseThresholdSeconds: r.att_pause_seconds,
    maxSessionLengthSeconds: r.att_max_session_seconds,
    paidBreakMinutesPerDay: r.att_paid_break_minutes,
    manualLimitMinutes: r.manual_time_limit_minutes,
    variancePct: r.timesheet_variance_pct,
    vaultReauthMinutes: r.vault_reauth_minutes,
  };
}

export async function writeOrgPolicy(db: pg.PoolClient, orgId: string, p: OrgPolicy): Promise<void> {
  await db.query(
    `UPDATE organizations SET att_missed_heartbeat_seconds = $2, att_disconnect_grace_seconds = $3, att_idle_seconds = $4,
       att_pause_seconds = $5, att_max_session_seconds = $6, att_paid_break_minutes = $7, manual_time_limit_minutes = $8,
       timesheet_variance_pct = $9, vault_reauth_minutes = $10
     WHERE id = $1`,
    [orgId, p.missedHeartbeatTimeoutSeconds, p.disconnectGraceWindowSeconds, p.idleThresholdSeconds, p.pauseThresholdSeconds,
      p.maxSessionLengthSeconds, p.paidBreakMinutesPerDay, p.manualLimitMinutes, p.variancePct, p.vaultReauthMinutes],
  );
}

/** The attendance part, for AttendanceService.setPolicyProvider. Unknown org = defaults. */
export async function loadAttendancePolicy(prisma: PrismaService, orgId: string): Promise<Partial<AttendanceConfig> | null> {
  try {
    const p = await prisma.runWithTenantContext(orgId, (db) => readOrgPolicy(db, orgId));
    return {
      missedHeartbeatTimeoutSeconds: p.missedHeartbeatTimeoutSeconds,
      disconnectGraceWindowSeconds: p.disconnectGraceWindowSeconds,
      idleThresholdSeconds: p.idleThresholdSeconds,
      pauseThresholdSeconds: p.pauseThresholdSeconds,
      maxSessionLengthSeconds: p.maxSessionLengthSeconds,
      paidBreakMinutesPerDay: p.paidBreakMinutesPerDay,
      presenceRetentionDays: p.presenceRetentionDays,
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'Organisation not found') return null;
    throw err;
  }
}
