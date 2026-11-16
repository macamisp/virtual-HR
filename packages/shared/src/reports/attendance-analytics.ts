/**
 * HR attendance analytics (FR-REP-009, ADR 059). Three measures, kept apart and never added up:
 *
 * - **Verified work attendance**: the established attendance calculation (sessions and daily
 *   summaries, adjusted and cancelled sessions left out). The only measure that is work time.
 * - **Office connected time**: when the person was connected to the virtual office (avatar
 *   present), from server-timed intervals. Not proof of work; no room, place or activity.
 * - **Confirmed meeting time**: in-meeting time the server confirmed (ADR 049), part of work time.
 *
 * Every figure is in seconds; every timestamp is the server's (ISO 8601, UTC); days are
 * organisation-local calendar days.
 */
import { z } from 'zod';
import { ReportUserRefSchema } from './types.ts';

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });

/** At most this many days per request (the same cap as the other reports). */
export const ANALYTICS_MAX_DAYS = 366;
export const ANALYTICS_GROUPS = ['day', 'week', 'month'] as const;
export type AnalyticsGroup = (typeof ANALYTICS_GROUPS)[number];
export const ANALYTICS_SORTS = ['date', 'name', 'work', 'office', 'meeting', 'tasks'] as const;
export const ANALYTICS_FORMATS = ['json', 'csv', 'xlsx', 'pdf'] as const;

const range = { from: workDate, to: workDate };

export const AttendanceAnalyticsQuerySchema = z.object({
  ...range,
  groupBy: z.enum(ANALYTICS_GROUPS).default('day'),
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  sort: z.enum(ANALYTICS_SORTS).default('date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  format: z.enum(ANALYTICS_FORMATS).default('json'),
}).strict();
export type AttendanceAnalyticsQuery = z.infer<typeof AttendanceAnalyticsQuerySchema>;

export const PersonAnalyticsQuerySchema = z.object(range).strict();
export type PersonAnalyticsQuery = z.infer<typeof PersonAnalyticsQuerySchema>;

/**
 * Day status as the attendance engine recorded it (PRESENT, LATE, EARLY_LEAVE, HALF_DAY, ABSENT,
 * LEAVE, HOLIDAY, REST_DAY), IN_PROGRESS while a session is still open, or NOT_SUMMARISED for a
 * finished day whose daily summary has not been written yet.
 */
export const ANALYTICS_STATUSES = ['PRESENT', 'LATE', 'EARLY_LEAVE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HOLIDAY', 'REST_DAY', 'IN_PROGRESS', 'NOT_SUMMARISED'] as const;
export type AnalyticsStatus = (typeof ANALYTICS_STATUSES)[number];
export const ANALYTICS_STATUS_LABEL: Record<AnalyticsStatus, string> = {
  PRESENT: 'Present', LATE: 'Late', EARLY_LEAVE: 'Early leave', HALF_DAY: 'Half day', ABSENT: 'Absent', LEAVE: 'On leave',
  HOLIDAY: 'Holiday', REST_DAY: 'Rest day', IN_PROGRESS: 'In progress', NOT_SUMMARISED: 'Not yet summarised',
};

/** One person and one day, week or month. */
export const AnalyticsRowSchema = z.object({
  user: ReportUserRefSchema,
  /** The day, the Monday of the week, or the month (YYYY-MM). */
  period: z.string(),
  /** Days in the period with attendance recorded. */
  daysWorked: z.number().int(),
  firstIn: isoDate.nullable(),
  /** Null while a session is open (or no attendance). */
  lastOut: isoDate.nullable(),
  workSeconds: z.number().int(),
  activeSeconds: z.number().int(),
  breakSeconds: z.number().int(),
  meetingSeconds: z.number().int(),
  officeSeconds: z.number().int(),
  lateMinutes: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  /**
   * FR-REP-010: time recorded on tasks (task timer and manual entries), a fourth measure kept apart
   * from verified work, office connected time and meetings, and tasks completed in the period.
   */
  taskSeconds: z.number().int(),
  tasksDone: z.number().int(),
  /** For a day: its status. For a week or month: null (see statusCounts). */
  status: z.enum(ANALYTICS_STATUSES).nullable(),
  statusCounts: z.record(z.string(), z.number().int()),
});
export type AnalyticsRow = z.infer<typeof AnalyticsRowSchema>;

export const AnalyticsSummarySchema = z.object({
  people: z.number().int(),
  peoplePresent: z.number().int(),
  daysWorked: z.number().int(),
  workSeconds: z.number().int(),
  /** Verified work per day worked (0 without any). */
  averageWorkSeconds: z.number().int(),
  meetingSeconds: z.number().int(),
  /** Confirmed meeting time as a whole percentage of verified work time. */
  meetingSharePct: z.number().int(),
  officeSeconds: z.number().int(),
  /** FR-REP-010: recorded task time and tasks completed, everyone in the report together. */
  taskSeconds: z.number().int(),
  tasksDone: z.number().int(),
  statusCounts: z.record(z.string(), z.number().int()),
});
export type AnalyticsSummary = z.infer<typeof AnalyticsSummarySchema>;

/**
 * FR-REP-010: one person's work items in the range: recorded task time by source, task counts and
 * the tasks themselves, timesheets with their submission status, and task activity. Task titles are
 * shown to the person, to anyone who may read all tasks, and to a team lead for their team;
 * otherwise null.
 */
export const PersonWorkSchema = z.object({
  taskTime: z.object({ timerSeconds: z.number().int(), manualSeconds: z.number().int(), entries: z.number().int() }),
  tasks: z.object({ open: z.number().int(), completed: z.number().int(), overdue: z.number().int(), dueInRange: z.number().int() }),
  taskList: z.array(z.object({
    id: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    priority: z.string().nullable(),
    dueDate: workDate.nullable(),
    completedAt: isoDate.nullable(),
    overdue: z.boolean(),
    /** Time recorded on this task within the range. */
    recordedSeconds: z.number().int(),
  })),
  timesheets: z.array(z.object({
    id: z.string(),
    periodStart: workDate,
    periodEnd: workDate,
    status: z.string(),
    submittedAt: isoDate.nullable(),
    approvedAt: isoDate.nullable(),
    loggedMinutes: z.number().int(),
    attendanceMinutes: z.number().int(),
  })),
  activity: z.object({ total: z.number().int(), byType: z.record(z.string(), z.number().int()) }),
});
export type PersonWork = z.infer<typeof PersonWorkSchema>;

const common = {
  from: workDate,
  to: workDate,
  timezone: z.string(),
  /** Office intervals older than the organisation's presence retention are deleted: days before this show none. */
  officeDataFrom: workDate,
  retentionDays: z.number().int(),
};

export const AttendanceAnalyticsSchema = z.object({
  ...common,
  groupBy: z.enum(ANALYTICS_GROUPS),
  scope: z.enum(['team', 'all']),
  canExport: z.boolean(),
  summary: AnalyticsSummarySchema,
  rows: z.array(AnalyticsRowSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRows: z.number().int(),
  /** The people and teams the viewer may filter by (their report scope). */
  people: z.array(ReportUserRefSchema.extend({ teamId: z.string().nullable() })),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type AttendanceAnalytics = z.infer<typeof AttendanceAnalyticsSchema>;

export const PersonAnalyticsSchema = z.object({
  ...common,
  user: ReportUserRefSchema,
  /** The viewer is the person (meeting titles are shown only to them, as elsewhere). */
  self: z.boolean(),
  days: z.array(AnalyticsRowSchema),
  weeks: z.array(AnalyticsRowSchema),
  months: z.array(AnalyticsRowSchema),
  total: AnalyticsRowSchema,
  /** Attendance time by state (ACTIVE, IN_MEETING, ON_BREAK, IDLE, …), segment by segment; no IP, device or location. */
  segments: z.array(z.object({ workDate, state: z.string(), startedAt: isoDate, endedAt: isoDate.nullable(), seconds: z.number().int() })),
  office: z.array(z.object({ startedAt: isoDate, endedAt: isoDate.nullable(), seconds: z.number().int(), open: z.boolean(), endReason: z.string().nullable() })),
  meetings: z.array(z.object({
    meetingId: z.string(),
    /** Null for anyone but the person themselves. */
    title: z.string().nullable(),
    kind: z.string(),
    firstJoinedAt: isoDate,
    lastLeftAt: isoDate.nullable(),
    /** Union of the person's connections to the meeting (reconnects counted once), within the range. */
    seconds: z.number().int(),
    /** A connection the server never saw end (capped at the meeting's end or now). */
    open: z.boolean(),
  })),
  corrections: z.array(z.object({ id: z.string(), requestedIn: isoDate, requestedOut: isoDate, status: z.string(), createdAt: isoDate, reviewedAt: isoDate.nullable() })),
  work: PersonWorkSchema,
});
export type PersonAnalytics = z.infer<typeof PersonAnalyticsSchema>;
