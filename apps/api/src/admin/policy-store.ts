/**
 * FR-ADM-001: reading and writing the per-organisation policy (organizations columns).
 */
import type pg from 'pg';
import type { PrismaService } from '../common/prisma.service.ts';
import type { AttendanceConfig } from '../../../../packages/shared/src/attendance/types.ts';
import type { AttendanceGuards, OrgPolicy } from '../../../../packages/shared/src/admin/types.ts';

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

interface GuardRow {
  att_allowed_cidrs: string[] | null;
  att_allowed_countries: string[] | null;
  att_presence_challenge: boolean;
  att_long_idle_alert_minutes: number;
  att_flag_alert_threshold: number;
  att_no_clockin_reminder: boolean;
}

/** ADR 019: attendance safeguards (network lists, challenge, alerts). */
export async function readAttendanceGuards(db: pg.PoolClient, orgId: string): Promise<AttendanceGuards> {
  const r = (await db.query<GuardRow>(
    `SELECT att_allowed_cidrs, att_allowed_countries, att_presence_challenge, att_long_idle_alert_minutes, att_flag_alert_threshold, att_no_clockin_reminder
     FROM organizations WHERE id = $1`, [orgId])).rows[0];
  if (!r) throw new Error('Organisation not found');
  return {
    allowedCidrs: r.att_allowed_cidrs ?? [], allowedCountries: r.att_allowed_countries ?? [], presenceChallenge: r.att_presence_challenge,
    longIdleAlertMinutes: r.att_long_idle_alert_minutes, flagAlertThreshold: r.att_flag_alert_threshold, noClockInReminder: r.att_no_clockin_reminder,
  };
}

export async function writeAttendanceGuards(db: pg.PoolClient, orgId: string, g: AttendanceGuards): Promise<void> {
  await db.query(
    `UPDATE organizations SET att_allowed_cidrs = $2, att_allowed_countries = $3, att_presence_challenge = $4,
       att_long_idle_alert_minutes = $5, att_flag_alert_threshold = $6, att_no_clockin_reminder = $7 WHERE id = $1`,
    [orgId, g.allowedCidrs, [...new Set(g.allowedCountries)], g.presenceChallenge, g.longIdleAlertMinutes, g.flagAlertThreshold, g.noClockInReminder],
  );
}

/** The attendance part, for AttendanceService.setPolicyProvider. Unknown org = defaults. */
export async function loadAttendancePolicy(prisma: PrismaService, orgId: string): Promise<Partial<AttendanceConfig> | null> {
  try {
    const [p, g] = await prisma.runWithTenantContext(orgId, async (db) => [await readOrgPolicy(db, orgId), await readAttendanceGuards(db, orgId)] as const);
    return {
      orgTimezone: p.timezone,
      missedHeartbeatTimeoutSeconds: p.missedHeartbeatTimeoutSeconds,
      disconnectGraceWindowSeconds: p.disconnectGraceWindowSeconds,
      idleThresholdSeconds: p.idleThresholdSeconds,
      pauseThresholdSeconds: p.pauseThresholdSeconds,
      maxSessionLengthSeconds: p.maxSessionLengthSeconds,
      paidBreakMinutesPerDay: p.paidBreakMinutesPerDay,
      presenceRetentionDays: p.presenceRetentionDays,
      allowedCidrs: g.allowedCidrs,
      allowedCountries: g.allowedCountries,
      presenceChallengeEnabled: g.presenceChallenge,
      longIdleAlertMinutes: g.longIdleAlertMinutes,
      flagAlertThreshold: g.flagAlertThreshold,
      noClockInReminder: g.noClockInReminder,
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'Organisation not found') return null;
    throw err;
  }
}
