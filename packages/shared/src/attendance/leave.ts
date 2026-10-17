/**
 * Leave requests and the public holiday calendar (SRS 5.2 FR-ORG-010, FR-ORG-011; FR-ATT-022;
 * ADR 027). Whole days in the organisation's calendar. Approved leave and holidays set a day's
 * expected time to zero and suppress absence and late flags.
 */
import { z } from 'zod';

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'OTHER'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_TYPE_LABEL: Record<LeaveType, string> = { ANNUAL: 'Annual leave', SICK: 'Sick leave', UNPAID: 'Unpaid leave', OTHER: 'Other' };
export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Longest single request, in calendar days. */
export const LEAVE_MAX_DAYS = 90;
/** How far back a request may start (sick leave is often reported afterwards). */
export const LEAVE_MAX_PAST_DAYS = 60;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });
const Person = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });

export const LeaveRequestDtoSchema = z
  .object({ type: z.enum(LEAVE_TYPES), startDate: isoDay, endDate: isoDay, reason: z.string().trim().max(500).default('') })
  .strict()
  .refine((d) => d.endDate >= d.startDate, { message: 'The end date is before the start date', path: ['endDate'] });
export type LeaveRequestDto = z.input<typeof LeaveRequestDtoSchema>;

export const LeaveDecisionDtoSchema = z.object({ approved: z.boolean(), note: z.string().trim().max(500).default('') }).strict();
export type LeaveDecisionDto = z.input<typeof LeaveDecisionDtoSchema>;

export const LeaveRequestSchema = z.object({
  id: z.string(),
  user: Person,
  type: z.enum(LEAVE_TYPES),
  startDate: isoDay,
  endDate: isoDay,
  /** Calendar days, inclusive. */
  days: z.number().int(),
  reason: z.string(),
  status: z.enum(LEAVE_STATUSES),
  decidedBy: Person.nullable(),
  decidedAt: isoDate.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: isoDate,
  canCancel: z.boolean(),
  canDecide: z.boolean(),
});
export type LeaveRequest = z.infer<typeof LeaveRequestSchema>;
export const LeaveRequestListSchema = z.object({ items: z.array(LeaveRequestSchema) });

export const LeaveListQuerySchema = z.object({ scope: z.enum(['mine', 'team']).default('mine'), status: z.enum(LEAVE_STATUSES).optional() }).strict();
export type LeaveListQuery = z.infer<typeof LeaveListQuerySchema>;

export const HolidaySchema = z.object({ id: z.string(), date: isoDay, name: z.string() });
export type Holiday = z.infer<typeof HolidaySchema>;
export const HolidayListSchema = z.object({ year: z.number().int(), items: z.array(HolidaySchema), defaultsAvailable: z.boolean() });
export type HolidayList = z.infer<typeof HolidayListSchema>;
export const HolidayDtoSchema = z.object({ date: isoDay, name: z.string().trim().min(1).max(100) }).strict();
export type HolidayDto = z.input<typeof HolidayDtoSchema>;
export const HolidayYearSchema = z.object({ year: z.coerce.number().int().min(2020).max(2100) }).strict();
export const HolidayDefaultsDtoSchema = z.object({ year: z.number().int().min(2020).max(2100) }).strict();
