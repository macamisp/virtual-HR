/**
 * Timesheet contracts (FR-TS-001..006, 009, 011..013): time entries and task timers, periodic
 * timesheets with daily reconciliation, approvals, rates and payable amounts, reports.
 * Money is always a decimal string ("1211.25"), never a number.
 */
import { z } from 'zod';
import { UserRefSchema } from '../tasks/types.ts';

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });
const version = z.number().int().min(1);

export const TIMESHEET_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED', 'PAID'] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];
/** The owner may change entries only while the timesheet is in one of these states. */
export const EDITABLE_TIMESHEET_STATUSES: readonly TimesheetStatus[] = ['DRAFT', 'REJECTED'];

export const ENTRY_SOURCES = ['TIMER', 'MANUAL', 'AUTO_FROM_ATTENDANCE'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** ADR 049 §3-4: where the work was done, and what kind of work it was (fixed lists). */
export const WORK_TYPES = ['OFFICE', 'REMOTE', 'ONSITE'] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const WORK_CATEGORIES = ['DEVELOPMENT', 'DESIGN', 'TESTING', 'REVIEW', 'DOCUMENTATION', 'SUPPORT', 'RESEARCH', 'ADMIN', 'MEETING', 'TRAVEL', 'OTHER'] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];
export const WORK_TYPE_LABEL: Record<WorkType, string> = { OFFICE: 'Office', REMOTE: 'Remote', ONSITE: 'Onsite' };
export const WORK_CATEGORY_LABEL: Record<WorkCategory, string> = {
  DEVELOPMENT: 'Development', DESIGN: 'Design', TESTING: 'Testing', REVIEW: 'Review', DOCUMENTATION: 'Documentation',
  SUPPORT: 'Support', RESEARCH: 'Research', ADMIN: 'Administration', MEETING: 'Meetings', TRAVEL: 'Travel', OTHER: 'Other',
};
/** Local time of day, HH:MM (24 h). */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const entryTitle = z.string().trim().min(2, 'Give the work a short title').max(200);

export const RATE_TYPES = ['HOURLY', 'DAILY', 'FIXED'] as const;
export type RateTypeName = (typeof RATE_TYPES)[number];

export const PERIOD_KINDS = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] as const;
export type PeriodKindName = (typeof PERIOD_KINDS)[number];

export const DAY_FLAGS = ['VARIANCE', 'NO_ATTENDANCE', 'MANUAL_LIMIT'] as const;
export const APPROVAL_ACTIONS = ['SUBMIT', 'APPROVE', 'REJECT', 'REOPEN'] as const;

/** Plain decimal with up to 2 places, as stored in numeric(12,2). */
export const MoneyStringSchema = z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/, 'Use a plain amount such as 25.50');
export const MultiplierStringSchema = z.string().regex(/^[1-9](\.\d{1,2})?$/, 'Use a multiplier from 1.00 to 9.99');
const hoursCap = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/, 'Use hours such as 37.5').refine((v) => Number(v) > 0 && Number(v) <= 168, 'Between 0 and 168 hours');

// ---- requests

export const ManualEntryDtoSchema = z
  .object({
    workDate,
    /** A duration; or give startTime and endTime (org-local, same day) and minutes are computed. */
    minutes: z.number().int().min(1, 'At least one minute').max(24 * 60).optional(),
    startTime: LocalTimeSchema.optional(),
    endTime: LocalTimeSchema.optional(),
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    /** ADR 049 §4 (FR-WT-017): the employee's own name for the work. */
    title: entryTitle.optional(),
    workType: z.enum(WORK_TYPES).optional(),
    category: z.enum(WORK_CATEGORIES).optional(),
    note: z.string().max(2000).default(''),
    /** FR-TS-004: mandatory reason for manual time. */
    reason: z.string().trim().min(3, 'Give a reason for adding time manually').max(500),
    billable: z.boolean().default(true),
  })
  .refine((v) => (v.startTime === undefined) === (v.endTime === undefined), { message: 'Give both a start and an end time', path: ['endTime'] })
  .refine((v) => v.minutes !== undefined || v.startTime !== undefined, { message: 'Give a duration or a start and end time', path: ['minutes'] })
  .refine((v) => !v.startTime || !v.endTime || v.endTime > v.startTime, { message: 'The end must be after the start (same day)', path: ['endTime'] });
export type ManualEntryDto = z.infer<typeof ManualEntryDtoSchema>;

export const UpdateEntryDtoSchema = z
  .object({
    minutes: z.number().int().min(1).max(24 * 60).optional(),
    note: z.string().max(2000).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
    billable: z.boolean().optional(),
    title: entryTitle.nullable().optional(),
    workType: z.enum(WORK_TYPES).nullable().optional(),
    category: z.enum(WORK_CATEGORIES).nullable().optional(),
    /** ADR 049 §4: link a named entry to a task (it had none); the task's rules apply. */
    taskId: z.string().uuid().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
export type UpdateEntryDto = z.infer<typeof UpdateEntryDtoSchema>;

/** ADR 049 §3 (FR-WT-013): a timer on a task, or on a project and/or own title without a task. */
export const StartTimerDtoSchema = z
  .object({
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    title: entryTitle.optional(),
    workType: z.enum(WORK_TYPES).optional(),
    category: z.enum(WORK_CATEGORIES).optional(),
  })
  .refine((v) => !!v.taskId || !!v.title, { message: 'Choose a task or give the work a title', path: ['title'] });
export type StartTimerDto = z.infer<typeof StartTimerDtoSchema>;

export const TimeEntryListQuerySchema = z.object({
  from: workDate,
  to: workDate,
  userId: z.string().uuid().optional(),
});
export type TimeEntryListQuery = z.infer<typeof TimeEntryListQuerySchema>;

export const TimesheetNotesDtoSchema = z.object({ notes: z.string().max(4000), version });
export type TimesheetNotesDto = z.infer<typeof TimesheetNotesDtoSchema>;

export const SubmitTimesheetDtoSchema = z.object({ version });
export type SubmitTimesheetDto = z.infer<typeof SubmitTimesheetDtoSchema>;

export const ApproveTimesheetDtoSchema = z.object({ version, comment: z.string().max(2000).default('') });
export type ApproveTimesheetDto = z.infer<typeof ApproveTimesheetDtoSchema>;

export const RejectTimesheetDtoSchema = z.object({ version, comment: z.string().trim().min(3, 'Tell them what to fix').max(2000) });
export type RejectTimesheetDto = z.infer<typeof RejectTimesheetDtoSchema>;

export const ReopenTimesheetDtoSchema = z.object({ reason: z.string().trim().min(3, 'A reason is required').max(2000) });
export type ReopenTimesheetDto = z.infer<typeof ReopenTimesheetDtoSchema>;

export const TimesheetListQuerySchema = z.object({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  status: z.enum(TIMESHEET_STATUSES).optional(),
  userId: z.string().uuid().optional(),
  from: workDate.optional(),
  to: workDate.optional(),
});
export type TimesheetListQuery = z.infer<typeof TimesheetListQuerySchema>;

export const RateProfileDtoSchema = z.object({
  rateType: z.enum(RATE_TYPES),
  rate: MoneyStringSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code'),
  overtimeMultiplier: MultiplierStringSchema.default('1.50'),
  weeklyHoursCap: hoursCap.nullable().default(null),
});
export type RateProfileDto = z.infer<typeof RateProfileDtoSchema>;

export const ProjectRateDtoSchema = z.object({ rateOverride: MoneyStringSchema.nullable() });
export type ProjectRateDto = z.infer<typeof ProjectRateDtoSchema>;

export const TimesheetSettingsDtoSchema = z.object({
  period: z.enum(PERIOD_KINDS),
  periodAnchor: workDate,
  manualLimitMinutes: z.number().int().min(0).max(8 * 60),
  variancePct: z.number().int().min(5).max(50),
  submitDueDays: z.number().int().min(0).max(14),
});
export type TimesheetSettingsDto = z.infer<typeof TimesheetSettingsDtoSchema>;

export const REPORT_GROUPS = ['user', 'project', 'team', 'period'] as const;
export const TimesheetReportQuerySchema = z.object({
  groupBy: z.enum(REPORT_GROUPS).default('user'),
  from: workDate,
  to: workDate,
  teamId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});
export type TimesheetReportQuery = z.infer<typeof TimesheetReportQuerySchema>;

// ---- responses

export const TimeEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  timesheetId: z.string(),
  taskId: z.string().nullable(),
  /** ADR 049 §3 (FR-WT-015): the task and project names when the time was recorded. */
  taskTitle: z.string().nullable(),
  /** The task's name now, when it was renamed since (else null). */
  taskTitleNow: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  title: z.string().nullable(),
  workType: z.enum(WORK_TYPES).nullable(),
  category: z.enum(WORK_CATEGORIES).nullable(),
  workDate,
  startedAt: isoDate.nullable(),
  endedAt: isoDate.nullable(),
  minutes: z.number(),
  source: z.enum(ENTRY_SOURCES),
  billable: z.boolean(),
  note: z.string(),
  manualReason: z.string().nullable(),
  flagged: z.boolean(),
  flagReason: z.string().nullable(),
  autoStopped: z.boolean(),
  running: z.boolean(),
  editable: z.boolean(),
});
export type TimeEntry = z.infer<typeof TimeEntrySchema>;

export const TimeEntryListSchema = z.object({ items: z.array(TimeEntrySchema) });

export const TimerStateSchema = z.object({
  running: TimeEntrySchema.nullable(),
  /** Server clock, so the client shows elapsed time without trusting its own clock. */
  serverNow: isoDate,
  /** Set when starting a timer stopped another one. */
  stopped: TimeEntrySchema.nullable().optional(),
});
export type TimerState = z.infer<typeof TimerStateSchema>;

export const TimesheetDaySchema = z.object({
  date: workDate,
  attendanceMinutes: z.number(),
  /** ADR 049: the part of attendance spent in verified calls. */
  meetingMinutes: z.number(),
  loggedMinutes: z.number(),
  manualMinutes: z.number(),
  varianceMinutes: z.number(),
  variancePct: z.number().nullable(),
  flags: z.array(z.enum(DAY_FLAGS)),
});
export type TimesheetDay = z.infer<typeof TimesheetDaySchema>;

export const PayableLineSchema = z.object({
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  rate: z.string(),
  regularMinutes: z.number(),
  overtimeMinutes: z.number(),
  amount: z.string(),
});

export const PayableSchema = z.object({
  rateType: z.enum(RATE_TYPES),
  currency: z.string(),
  amount: z.string(),
  regularMinutes: z.number(),
  overtimeMinutes: z.number(),
  days: z.number(),
  lines: z.array(PayableLineSchema),
  /** true once approved (stored); false = live estimate from the current entries. */
  final: z.boolean(),
});
export type Payable = z.infer<typeof PayableSchema>;

export const ApprovalEventSchema = z.object({
  id: z.string(),
  action: z.enum(APPROVAL_ACTIONS),
  actor: UserRefSchema,
  comment: z.string(),
  createdAt: isoDate,
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

export const TimesheetPermissionsSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canSubmit: z.boolean(),
  canApprove: z.boolean(),
  canReopen: z.boolean(),
});
export type TimesheetPermissions = z.infer<typeof TimesheetPermissionsSchema>;

export const TimesheetSummarySchema = z.object({
  id: z.string(),
  user: UserRefSchema,
  periodStart: workDate,
  periodEnd: workDate,
  status: z.enum(TIMESHEET_STATUSES),
  attendanceMinutes: z.number(),
  /** ADR 049: the part of attendance spent in verified calls. */
  meetingMinutes: z.number(),
  loggedMinutes: z.number(),
  billableMinutes: z.number(),
  varianceMinutes: z.number(),
  flaggedDays: z.number(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  submittedAt: isoDate.nullable(),
  approvedAt: isoDate.nullable(),
  version: z.number(),
});
export type TimesheetSummary = z.infer<typeof TimesheetSummarySchema>;

export const TimesheetListSchema = z.object({ items: z.array(TimesheetSummarySchema) });

export const TimesheetDetailSchema = TimesheetSummarySchema.extend({
  notes: z.string(),
  rejectionReason: z.string().nullable(),
  reopenReason: z.string().nullable(),
  approvedBy: UserRefSchema.nullable(),
  submitDueDate: workDate,
  days: z.array(TimesheetDaySchema),
  entries: z.array(TimeEntrySchema),
  approvals: z.array(ApprovalEventSchema),
  payable: PayableSchema.nullable(),
  /** Why there is no amount (no rate profile, or not visible to the viewer). */
  payableNote: z.string().nullable(),
  permissions: TimesheetPermissionsSchema,
  settings: z.object({ variancePct: z.number(), manualLimitMinutes: z.number() }),
});
export type TimesheetDetail = z.infer<typeof TimesheetDetailSchema>;

export const RateProfileSchema = z.object({
  rateType: z.enum(RATE_TYPES),
  rate: z.string(),
  currency: z.string(),
  overtimeMultiplier: z.string(),
  weeklyHoursCap: z.string().nullable(),
  updatedAt: isoDate,
});
export type RateProfile = z.infer<typeof RateProfileSchema>;

export const RatesListSchema = z.object({
  items: z.array(z.object({ user: UserRefSchema, profile: RateProfileSchema.nullable() })),
  projectRates: z.array(z.object({ projectId: z.string(), projectName: z.string(), user: UserRefSchema, rateOverride: z.string().nullable() })),
  canManage: z.boolean(),
});
export type RatesList = z.infer<typeof RatesListSchema>;

export const TimesheetSettingsSchema = TimesheetSettingsDtoSchema;
export type TimesheetSettings = z.infer<typeof TimesheetSettingsSchema>;

export const ReportRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  timesheets: z.number(),
  attendanceMinutes: z.number(),
  /** ADR 049: meeting part of attendance; null when grouped by project (calls have no project). */
  meetingMinutes: z.number().nullable(),
  loggedMinutes: z.number(),
  approvedMinutes: z.number(),
  varianceMinutes: z.number(),
  flaggedDays: z.number(),
  /** Approved cost per currency, e.g. { USD: "1200.00" }; never summed across currencies. */
  cost: z.record(z.string(), z.string()),
  /** Mean hours from submission to approval, null when nothing was approved. */
  avgApprovalHours: z.number().nullable(),
});
export type ReportRow = z.infer<typeof ReportRowSchema>;

export const TimesheetReportSchema = z.object({
  groupBy: z.enum(REPORT_GROUPS),
  from: workDate,
  to: workDate,
  rows: z.array(ReportRowSchema),
});
export type TimesheetReport = z.infer<typeof TimesheetReportSchema>;

/**
 * FR-ORG-004 (ADR 034): hours logged this week (Monday to Sunday, organisation time) against a
 * subcontractor's weekly cap. WARN from 80 %, OVER from 100 %; NONE when there is no cap.
 */
export const WEEKLY_CAP_WARN_PERCENT = 80;
export const WeeklyCapSchema = z.object({
  capHours: z.number().nullable(),
  weekStart: z.string(),
  weekEnd: z.string(),
  loggedMinutes: z.number().int(),
  percent: z.number().nullable(),
  level: z.enum(['NONE', 'UNDER', 'WARN', 'OVER']),
});
export type WeeklyCap = z.infer<typeof WeeklyCapSchema>;
