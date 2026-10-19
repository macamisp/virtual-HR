/**
 * FR-ORG-004 (ADR 034): at 80 % and at 100 % of a weekly hours cap the subcontractor, their
 * approvers and HR are told once per threshold per week (the notification dedupe key). Used by
 * the time.logged listener and the scheduled check for running timers.
 */
import type pg from 'pg';
import { approversFor } from '../timesheets/timesheets.service.ts';
import { weeklyCapStatus } from '../timesheets/weekly-cap.ts';
import type { NewNotification } from './notifications.service.ts';
import { NotificationType, WEEKLY_CAP_WARN_PERCENT } from '../../../../packages/shared/src/index.ts';

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;

/** Notifications for a crossed threshold; delivery dedupes them per person, week and threshold. */
export async function weeklyCapNotifications(db: pg.PoolClient, orgId: string, userId: string, onDate: string | null, now: Date): Promise<NewNotification[]> {
  const s = await weeklyCapStatus(db, orgId, userId, onDate, now);
  if (s.level !== 'WARN' && s.level !== 'OVER') return [];
  const reached = s.level === 'OVER';
  const threshold = reached ? 100 : WEEKLY_CAP_WARN_PERCENT;
  const hr = (await db.query<{ id: string }>(`SELECT id FROM users WHERE role IN ('HR', 'HR_MANAGER') AND status = 'ACTIVE'`)).rows.map((r) => r.id);
  const others = [...new Set([...(await approversFor(db, userId)), ...hr])].filter((id) => id !== userId);
  const type = reached ? NotificationType.WEEKLY_CAP_REACHED : NotificationType.WEEKLY_CAP_WARNING;
  const detail = `${hours(s.loggedMinutes)} of ${s.capHours} h in the week of ${s.weekStart} (${s.percent}%).`;
  const dedupeKey = `weekly-cap:${userId}:${s.weekStart}:${threshold}`;
  return [
    { userId, type, title: reached ? 'You have reached your weekly hours cap' : `You have logged ${threshold}% of your weekly hours cap`, body: detail, link: '/timesheets', entityType: 'USER', entityId: userId, dedupeKey },
    ...others.map((id) => ({ userId: id, type, title: reached ? `${s.name} has reached their weekly hours cap` : `${s.name} has logged ${threshold}% of their weekly hours cap`, body: detail, link: '/timesheets/review', entityType: 'USER', entityId: userId, dedupeKey })),
  ];
}
