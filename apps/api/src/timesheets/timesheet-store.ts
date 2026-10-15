/**
 * SQL shared by the attendance daily close (FR-TS-001, SRS 6.3) and the timesheet services.
 * Every function takes a client that already runs under SET LOCAL app.org_id (RLS).
 * Dates are org-local YYYY-MM-DD strings; DATE columns are always read with to_char.
 */
import type pg from 'pg';
import { addDaysIso } from '../planning/planning-rules.ts';
import { periodFor } from './periods.ts';
import type { PeriodKind } from './periods.ts';
import { reconcileDay } from './reconcile.ts';
import { EDITABLE_TIMESHEET_STATUSES } from '../../../../packages/shared/src/timesheets/types.ts';
import type { TimesheetStatus } from '../../../../packages/shared/src/timesheets/types.ts';

type Db = Pick<pg.PoolClient, 'query'>;

export interface OrgTimesheetSettings {
  timezone: string;
  period: PeriodKind;
  periodAnchor: string;
  manualLimitMinutes: number;
  variancePct: number;
  submitDueDays: number;
}

export interface TimesheetRow {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  version: number;
}

export class TimesheetLockedError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(`This timesheet is ${status.toLowerCase()}; its time can no longer be changed`);
    this.status = status;
  }
}

export async function orgSettings(db: Db, orgId: string): Promise<OrgTimesheetSettings> {
  const res = await db.query<{ timezone: string; timesheet_period: PeriodKind; anchor: string; manual_time_limit_minutes: number; timesheet_variance_pct: number; timesheet_submit_due_days: number }>(
    `SELECT timezone, timesheet_period, to_char(timesheet_period_anchor, 'YYYY-MM-DD') AS anchor,
            manual_time_limit_minutes, timesheet_variance_pct, timesheet_submit_due_days
     FROM organizations WHERE id = $1`,
    [orgId],
  );
  const r = res.rows[0];
  if (!r) throw new Error('Organisation not found');
  return {
    timezone: r.timezone,
    period: r.timesheet_period,
    periodAnchor: r.anchor,
    manualLimitMinutes: r.manual_time_limit_minutes,
    variancePct: r.timesheet_variance_pct,
    submitDueDays: r.timesheet_submit_due_days,
  };
}

const TIMESHEET_COLUMNS = `id, user_id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
  to_char(period_end, 'YYYY-MM-DD') AS period_end, status, version`;

function mapTimesheet(r: { id: string; user_id: string; period_start: string; period_end: string; status: TimesheetStatus; version: number }): TimesheetRow {
  return { id: r.id, userId: r.user_id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, version: r.version };
}

/**
 * The user's timesheet covering `date`, created on first use (FR-TS-002). A new period never
 * overlaps an existing one: after a change of period setting it is shortened to fit.
 */
export async function ensureTimesheet(db: Db, orgId: string, userId: string, date: string, settings: OrgTimesheetSettings): Promise<TimesheetRow> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('timesheet:' || $1::text))`, [userId]);
  const existing = await db.query(
    `SELECT ${TIMESHEET_COLUMNS} FROM timesheets
     WHERE org_id = $1 AND user_id = $2 AND period_start <= $3::date AND period_end >= $3::date LIMIT 1`,
    [orgId, userId, date],
  );
  if (existing.rows[0]) return mapTimesheet(existing.rows[0]);

  let { start, end } = periodFor(date, settings.period, settings.periodAnchor);
  const before = await db.query<{ last_end: string | null }>(
    `SELECT to_char(MAX(period_end), 'YYYY-MM-DD') AS last_end FROM timesheets
     WHERE org_id = $1 AND user_id = $2 AND period_end < $3::date AND period_end >= $4::date`,
    [orgId, userId, date, start],
  );
  if (before.rows[0]?.last_end) start = addDaysIso(before.rows[0].last_end, 1);
  const after = await db.query<{ next_start: string | null }>(
    `SELECT to_char(MIN(period_start), 'YYYY-MM-DD') AS next_start FROM timesheets
     WHERE org_id = $1 AND user_id = $2 AND period_start > $3::date AND period_start <= $4::date`,
    [orgId, userId, date, end],
  );
  if (after.rows[0]?.next_start) end = addDaysIso(after.rows[0].next_start, -1);

  const created = await db.query(
    `INSERT INTO timesheets (org_id, user_id, period_start, period_end) VALUES ($1, $2, $3::date, $4::date)
     RETURNING ${TIMESHEET_COLUMNS}`,
    [orgId, userId, start, end],
  );
  return mapTimesheet(created.rows[0]);
}

export async function findTimesheet(db: Db, timesheetId: string): Promise<TimesheetRow | null> {
  const res = await db.query(`SELECT ${TIMESHEET_COLUMNS} FROM timesheets WHERE id = $1`, [timesheetId]);
  return res.rows[0] ? mapTimesheet(res.rows[0]) : null;
}

export function isEditable(status: TimesheetStatus): boolean {
  return EDITABLE_TIMESHEET_STATUSES.includes(status);
}

/**
 * FR-TS-001 / FR-TS-005: recompute one day of the daily draft from attendance sessions and
 * finished time entries, flag the variance, and flag manual entries beyond the daily limit
 * in the order they were added. Totals of the period are refreshed unless it is approved.
 */
export async function refreshDay(db: Db, orgId: string, userId: string, date: string, settings?: OrgTimesheetSettings): Promise<void> {
  const s = settings ?? (await orgSettings(db, orgId));
  const sheet = await ensureTimesheet(db, orgId, userId, date, s);
  const att = await db.query<{ seconds: string }>(
    `SELECT COALESCE(SUM(net_seconds), 0) AS seconds FROM attendance_sessions
     WHERE org_id = $1 AND user_id = $2 AND work_date = $3 AND status NOT IN ('CANCELLED', 'ADJUSTED')`,
    [orgId, userId, date],
  );
  const attendanceMinutes = Math.floor(Number(att.rows[0]?.seconds ?? 0) / 60);
  const entries = await db.query<{ id: string; minutes: number; source: string; flag_reason: string | null }>(
    `SELECT id, minutes, source, flag_reason FROM time_entries
     WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date AND ended_at IS NOT NULL
     ORDER BY created_at, id`,
    [orgId, userId, date],
  );
  let logged = 0;
  let manual = 0;
  const overLimit: string[] = [];
  const withinLimit: string[] = [];
  for (const e of entries.rows) {
    logged += e.minutes;
    if (e.source !== 'MANUAL') continue;
    manual += e.minutes;
    if (manual > s.manualLimitMinutes) {
      if (e.flag_reason !== 'MANUAL_LIMIT') overLimit.push(e.id);
    } else if (e.flag_reason === 'MANUAL_LIMIT') {
      withinLimit.push(e.id);
    }
  }
  const editable = isEditable(sheet.status);
  if (editable && overLimit.length > 0) {
    await db.query(`UPDATE time_entries SET flagged = true, flag_reason = 'MANUAL_LIMIT', updated_at = now() WHERE id = ANY($1::uuid[])`, [overLimit]);
  }
  if (editable && withinLimit.length > 0) {
    await db.query(`UPDATE time_entries SET flagged = false, flag_reason = NULL, updated_at = now() WHERE id = ANY($1::uuid[])`, [withinLimit]);
  }

  const r = reconcileDay({ attendanceMinutes, loggedMinutes: logged, manualMinutes: manual, manualLimitMinutes: s.manualLimitMinutes, variancePct: s.variancePct });
  await db.query(
    `INSERT INTO timesheet_days (org_id, user_id, work_date, timesheet_id, attendance_minutes, logged_minutes, manual_minutes, variance_minutes, variance_pct, flags, updated_at)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::text[], now())
     ON CONFLICT (org_id, user_id, work_date) DO UPDATE SET
       timesheet_id = EXCLUDED.timesheet_id,
       attendance_minutes = EXCLUDED.attendance_minutes,
       logged_minutes = EXCLUDED.logged_minutes,
       manual_minutes = EXCLUDED.manual_minutes,
       variance_minutes = EXCLUDED.variance_minutes,
       variance_pct = EXCLUDED.variance_pct,
       flags = EXCLUDED.flags,
       -- A day that becomes flagged again later deserves a fresh alert.
       alerted_at = CASE WHEN EXCLUDED.flags = '{}' THEN NULL ELSE timesheet_days.alerted_at END,
       updated_at = now()`,
    [orgId, userId, date, sheet.id, attendanceMinutes, logged, manual, r.varianceMinutes, r.variancePct, r.flags],
  );
  if (sheet.status !== 'APPROVED' && sheet.status !== 'LOCKED' && sheet.status !== 'PAID') await refreshTotals(db, sheet.id);
}

/** Header totals of a timesheet from its days and entries. */
export async function refreshTotals(db: Db, timesheetId: string): Promise<void> {
  await db.query(
    `UPDATE timesheets t SET
       attendance_minutes = COALESCE(d.att, 0),
       logged_minutes = COALESCE(e.logged, 0),
       billable_minutes = COALESCE(e.billable, 0),
       variance_minutes = COALESCE(e.logged, 0) - COALESCE(d.att, 0),
       flagged_days = COALESCE(d.flagged, 0),
       updated_at = now()
     FROM (SELECT $1::uuid AS id) k
     LEFT JOIN (
       SELECT timesheet_id, SUM(attendance_minutes)::int AS att, COUNT(*) FILTER (WHERE flags <> '{}')::int AS flagged
       FROM timesheet_days WHERE timesheet_id = $1 GROUP BY timesheet_id
     ) d ON d.timesheet_id = k.id
     LEFT JOIN (
       SELECT timesheet_id, SUM(minutes)::int AS logged, SUM(minutes) FILTER (WHERE billable)::int AS billable
       FROM time_entries WHERE timesheet_id = $1 AND ended_at IS NOT NULL GROUP BY timesheet_id
     ) e ON e.timesheet_id = k.id
     WHERE t.id = k.id`,
    [timesheetId],
  );
}

export interface TimesheetDayRow {
  status: TimesheetStatus;
  timesheetId: string;
  attendanceMinutes: number;
  loggedMinutes: number;
  varianceMinutes: number;
  flags: string[];
}

export async function findDay(db: Db, orgId: string, userId: string, date: string): Promise<TimesheetDayRow | null> {
  const res = await db.query<{ status: TimesheetStatus; timesheet_id: string; attendance_minutes: number; logged_minutes: number; variance_minutes: number; flags: string[] }>(
    `SELECT t.status, d.timesheet_id, d.attendance_minutes, d.logged_minutes, d.variance_minutes, d.flags
     FROM timesheet_days d JOIN timesheets t ON t.id = d.timesheet_id
     WHERE d.org_id = $1 AND d.user_id = $2 AND d.work_date = $3::date`,
    [orgId, userId, date],
  );
  const r = res.rows[0];
  return r
    ? { status: r.status, timesheetId: r.timesheet_id, attendanceMinutes: r.attendance_minutes, loggedMinutes: r.logged_minutes, varianceMinutes: r.variance_minutes, flags: r.flags }
    : null;
}
