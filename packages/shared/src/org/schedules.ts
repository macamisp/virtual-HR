/**
 * Work schedules (SRS 5.2 FR-ORG-005, 7.4 work_schedules; ADR 032). A schedule belongs to the
 * organisation (the default), a team, or one person; the most specific one in force on a day
 * applies. Changes start on a date (today or later) and end the previous version the day
 * before, so past days keep the schedule they were computed with.
 */
import { z } from 'zod';

export const WEEKDAYS = ['1', '2', '3', '4', '5', '6', '7'] as const; // 1 = Monday
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = { '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday' };

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const ScheduleDaySchema = z
  .object({ start: hhmm, end: hhmm, expectedHours: z.number().min(0.25).max(24) })
  .strict()
  .refine((d) => minutesOf(d.end) > minutesOf(d.start), { message: 'The day must end after it starts (overnight shifts are not supported)', path: ['end'] })
  .refine((d) => d.expectedHours * 60 <= minutesOf(d.end) - minutesOf(d.start), { message: 'Expected hours do not fit between the start and end', path: ['expectedHours'] });
export type ScheduleDay = z.infer<typeof ScheduleDaySchema>;

export const ScheduleScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ORG') }).strict(),
  z.object({ kind: z.literal('TEAM'), teamId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('USER'), userId: z.string().uuid() }).strict(),
]);
export type ScheduleScope = z.infer<typeof ScheduleScopeSchema>;

const grace = z.number().int().min(0).max(240);

export const ScheduleDtoSchema = z
  .object({
    scope: ScheduleScopeSchema,
    days: z.partialRecord(z.enum(WEEKDAYS), ScheduleDaySchema),
    flexible: z.boolean(),
    lateGraceMinutes: grace,
    /** Null: the late-arrival grace also applies to early leave. */
    earlyLeaveGraceMinutes: grace.nullable().default(null),
    /** Null: no limit on break time. */
    breakAllowanceMinutes: z.number().int().min(0).max(600).nullable().default(null),
    effectiveFrom: isoDay,
  })
  .strict()
  .refine((d) => Object.keys(d.days).length > 0, { message: 'Choose at least one working day', path: ['days'] });
export type ScheduleDto = z.input<typeof ScheduleDtoSchema>;

/** Stop this scope's own schedule from a date; the next level (team, then organisation) applies. */
export const ScheduleEndDtoSchema = z.object({ scope: ScheduleScopeSchema, effectiveFrom: isoDay }).strict();
export type ScheduleEndDto = z.input<typeof ScheduleEndDtoSchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  scope: ScheduleScopeSchema,
  days: z.partialRecord(z.enum(WEEKDAYS), z.object({ start: z.string(), end: z.string(), expectedHours: z.number() })),
  flexible: z.boolean(),
  lateGraceMinutes: z.number().int(),
  earlyLeaveGraceMinutes: z.number().int().nullable(),
  breakAllowanceMinutes: z.number().int().nullable(),
  effectiveFrom: isoDay,
  effectiveTo: isoDay.nullable(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/** GET /schedules: every version in force today or starting later, with the names to show them. */
export const ScheduleOverviewSchema = z.object({
  today: isoDay,
  schedules: z.array(ScheduleSchema),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  people: z.array(z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string(), teamId: z.string().nullable() })),
});
export type ScheduleOverview = z.infer<typeof ScheduleOverviewSchema>;

export const scopeKey = (s: ScheduleScope): string => (s.kind === 'ORG' ? 'ORG' : s.kind === 'TEAM' ? `TEAM:${s.teamId}` : `USER:${s.userId}`);
