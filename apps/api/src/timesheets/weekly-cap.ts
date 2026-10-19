/**
 * Weekly hours cap for subcontractors (FR-ORG-004; ADR 034). Hours logged in time entries in the
 * week (Monday to Sunday in the organisation's time zone, a running timer included) against
 * subcontractor_profiles.weekly_hours_cap. Warnings: notifications/weekly-cap-notifications.ts.
 */
import { formatInTimeZone } from 'date-fns-tz';
import { addDaysIso } from '../planning/planning-rules.ts';
import { WEEKLY_CAP_WARN_PERCENT } from '../../../../packages/shared/src/index.ts';
import type { WeeklyCap } from '../../../../packages/shared/src/index.ts';

interface Db { query<R extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }

/** The rule alone: NONE without a (positive) cap, WARN from 80 %, OVER from 100 %. */
export function capStatus(capHours: number | null, loggedMinutes: number): Pick<WeeklyCap, 'level' | 'percent'> {
  if (capHours === null || !(capHours > 0)) return { level: 'NONE', percent: null };
  const percent = Math.round((loggedMinutes / (capHours * 60)) * 1000) / 10;
  return { level: percent >= 100 ? 'OVER' : percent >= WEEKLY_CAP_WARN_PERCENT ? 'WARN' : 'UNDER', percent };
}

/** Monday to Sunday containing `date` (YYYY-MM-DD). */
export function weekOf(date: string): { start: string; end: string } {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay() || 7; // 1 = Monday ... 7 = Sunday
  const start = addDaysIso(date, 1 - dow);
  return { start, end: addDaysIso(start, 6) };
}

export async function weeklyCapStatus(db: Db, orgId: string, userId: string, onDate: string | null, now: Date): Promise<WeeklyCap & { name: string }> {
  const org = (await db.query<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = $1`, [orgId])).rows[0];
  const week = weekOf(onDate ?? formatInTimeZone(now, org?.timezone ?? 'UTC', 'yyyy-MM-dd'));
  const person = (await db.query<{ cap: string | null; name: string }>(
    `SELECT p.weekly_hours_cap::text AS cap, coalesce(u.display_name, u.email) AS name FROM users u
     LEFT JOIN subcontractor_profiles p ON p.user_id = u.id AND u.role = 'SUBCONTRACTOR'
     WHERE u.id = $1`, [userId])).rows[0];
  const capHours = person?.cap ? Number(person.cap) : null;
  const logged = (await db.query<{ minutes: string }>(
    // Stopped entries count their minutes; a running timer counts the time so far.
    `SELECT coalesce(sum(CASE WHEN ended_at IS NULL THEN greatest(0, floor(extract(epoch FROM ($4::timestamptz - started_at)) / 60)) ELSE minutes END), 0)::text AS minutes
     FROM time_entries WHERE user_id = $1 AND work_date BETWEEN $2::date AND $3::date`,
    [userId, week.start, week.end, now])).rows[0];
  const loggedMinutes = Number(logged?.minutes ?? 0);
  return { capHours, weekStart: week.start, weekEnd: week.end, loggedMinutes, ...capStatus(capHours, loggedMinutes), name: person?.name ?? '' };
}
