/**
 * ADR 049 §2 overtime requests (FR-WT-007..012) and §7 onsite work requests (FR-WT-023..024).
 * Both are decided by the requester's manager, a team approver or HR, never by the requester.
 * Times of day are org-local; the server turns them into instants with the organisation's zone.
 */
import { z } from 'zod';
/** Local time of day, HH:MM (24 h); kept here so types.ts can import this file without a cycle. */
const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });
const ref = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });

export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };

/** Overtime may be requested ahead (pre-approval) or after the fact. */
export const OVERTIME_PAST_DAYS = 14;
export const OVERTIME_FUTURE_DAYS = 60;
/** Onsite work is reported after it happened, up to this many days back. */
export const ONSITE_PAST_DAYS = 30;
/** Per request and per day across pending and approved onsite requests. */
export const ONSITE_MAX_MINUTES_PER_DAY = 16 * 60;

const text = (min: number, max: number, msg: string) => z.string().trim().min(min, msg).max(max);

export const OvertimeRequestDtoSchema = z
  .object({
    workDate,
    plannedStart: LocalTimeSchema.optional(),
    plannedEnd: LocalTimeSchema.optional(),
    /** A duration, when no planned times are given. */
    minutes: z.number().int().min(15, 'At least 15 minutes').max(720, 'At most 12 hours').optional(),
    projectId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    workDescription: text(3, 500, 'Describe the work'),
    reason: text(3, 500, 'Say why overtime is needed'),
    notes: z.string().max(1000).default(''),
  })
  .refine((v) => (v.plannedStart === undefined) === (v.plannedEnd === undefined), { message: 'Give both a start and an end time', path: ['plannedEnd'] })
  .refine((v) => !v.plannedStart || !v.plannedEnd || v.plannedEnd > v.plannedStart, { message: 'The end must be after the start (same day)', path: ['plannedEnd'] })
  .refine((v) => v.minutes !== undefined || v.plannedStart !== undefined, { message: 'Give planned times or a duration', path: ['minutes'] });
export type OvertimeRequestDto = z.infer<typeof OvertimeRequestDtoSchema>;

export const OvertimeDecisionDtoSchema = z.object({
  approved: z.boolean(),
  /** May be lower than requested; defaults to the requested minutes. */
  approvedMinutes: z.number().int().min(1).max(720).optional(),
  comment: z.string().trim().max(1000).optional(),
});
export type OvertimeDecisionDto = z.infer<typeof OvertimeDecisionDtoSchema>;

export const OnsiteDecisionDtoSchema = z.object({
  approved: z.boolean(),
  comment: z.string().trim().max(1000).optional(),
});
export type OnsiteDecisionDto = z.infer<typeof OnsiteDecisionDtoSchema>;

export const CancelRequestDtoSchema = z.object({ comment: z.string().trim().max(1000).optional() });
export type CancelRequestDto = z.infer<typeof CancelRequestDtoSchema>;

export const RequestListQuerySchema = z.object({
  scope: z.enum(['mine', 'team']).default('mine'),
  status: z.enum(REQUEST_STATUSES).optional(),
  from: workDate.optional(),
  to: workDate.optional(),
});
export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;

export const OvertimeRequestSchema = z.object({
  id: z.string(),
  user: ref,
  workDate,
  plannedStart: z.string().nullable(),
  plannedEnd: z.string().nullable(),
  requestedMinutes: z.number().int(),
  approvedMinutes: z.number().int().nullable(),
  /** Calculated from attendance against the schedule for that day (ADR 032); null before it is known. */
  workedOvertimeMinutes: z.number().int().nullable(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  task: z.object({ id: z.string(), title: z.string() }).nullable(),
  workDescription: z.string(),
  reason: z.string(),
  notes: z.string(),
  status: z.enum(REQUEST_STATUSES),
  decidedBy: ref.nullable(),
  decidedAt: isoDate.nullable(),
  decisionComment: z.string().nullable(),
  cancelledAt: isoDate.nullable(),
  createdAt: isoDate,
  canCancel: z.boolean(),
  canDecide: z.boolean(),
});
export type OvertimeRequest = z.infer<typeof OvertimeRequestSchema>;
export const OvertimeRequestListSchema = z.object({ items: z.array(OvertimeRequestSchema) });

export const OnsiteRequestDtoSchema = z
  .object({
    workDate,
    startTime: LocalTimeSchema,
    endTime: LocalTimeSchema,
    location: text(3, 200, 'Say where you worked'),
    projectId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    description: text(3, 1000, 'Describe the work'),
    reason: text(3, 500, 'Say why it was not recorded in Virtual-HR'),
  })
  .refine((v) => v.endTime > v.startTime, { message: 'The end must be after the start (same day)', path: ['endTime'] });
export type OnsiteRequestDto = z.infer<typeof OnsiteRequestDtoSchema>;

export const OnsiteRequestSchema = z.object({
  id: z.string(),
  user: ref,
  workDate,
  startedAt: isoDate,
  endedAt: isoDate,
  minutes: z.number().int(),
  location: z.string(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  task: z.object({ id: z.string(), title: z.string() }).nullable(),
  description: z.string(),
  reason: z.string(),
  status: z.enum(REQUEST_STATUSES),
  decidedBy: ref.nullable(),
  decidedAt: isoDate.nullable(),
  decisionComment: z.string().nullable(),
  timeEntryId: z.string().nullable(),
  cancelledAt: isoDate.nullable(),
  createdAt: isoDate,
  canCancel: z.boolean(),
  canDecide: z.boolean(),
});
export type OnsiteRequest = z.infer<typeof OnsiteRequestSchema>;
export const OnsiteRequestListSchema = z.object({ items: z.array(OnsiteRequestSchema) });

/** ADR 049 §2: the three overtime numbers of a timesheet period, never merged. */
export const OvertimeSummarySchema = z.object({
  requiresApproval: z.boolean(),
  /** Worked: attendance above the schedule, per day (ADR 032). */
  workedMinutes: z.number().int(),
  requestedMinutes: z.number().int(),
  approvedMinutes: z.number().int(),
});
export type OvertimeSummary = z.infer<typeof OvertimeSummarySchema>;
