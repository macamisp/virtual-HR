/**
 * Wire (JSON) contracts for the attendance REST endpoints used by apps/web.
 * Dates are ISO-8601 strings on the wire. The web client validates every response
 * against these schemas; the API builds its responses from the same types.
 * Ref: docs/SRS.md 8.3, FR-ATT-007, 013, 015, 016, 020; FR-AUD-004.
 */
import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });
const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AttendanceStateSchema = z.enum([
  'OFFLINE',
  'ACTIVE',
  'IDLE',
  'PAUSED',
  'IN_MEETING',
  'ON_BREAK',
  'DISCONNECTED',
]);
export type AttendanceStateWire = z.infer<typeof AttendanceStateSchema>;

export const TimeTotalsSchema = z.object({
  activeSeconds: z.number().int().nonnegative(),
  idleSeconds: z.number().int().nonnegative(),
  breakSeconds: z.number().int().nonnegative(),
  meetingSeconds: z.number().int().nonnegative(),
  netSeconds: z.number().int().nonnegative(),
});
export type TimeTotals = z.infer<typeof TimeTotalsSchema>;

/** GET /attendance/me/today */
export const MyTodaySchema = z.object({
  workDate,
  state: AttendanceStateSchema,
  sessionId: z.string().nullable(),
  trackingSince: isoDate.nullable(),
  onBreakSince: isoDate.nullable(),
  lastHeartbeatAt: isoDate.nullable(),
  totals: TimeTotalsSchema,
  sessionCount: z.number().int().nonnegative(),
  /** AC-04: the latest session today that the server closed for you (connection lost, heartbeats stopped). */
  lastClosed: z.object({ at: isoDate, source: z.string(), minutesUnaccounted: z.number().int().nonnegative() }).nullable(),
  asOf: isoDate,
});
export type MyToday = z.infer<typeof MyTodaySchema>;

/** One row of GET /attendance/me/days */
export const MyDaySchema = TimeTotalsSchema.extend({
  workDate,
  firstIn: isoDate.nullable(),
  lastOut: isoDate.nullable(),
  sessionCount: z.number().int().nonnegative(),
  open: z.boolean(),
  flags: z.array(z.string()),
  dayStatus: z.string().nullable(),
  lateMinutes: z.number().int().nullable(),
  /** FR-ORG-005: break minutes beyond the schedule's allowance on a closed day. */
  excessBreakMinutes: z.number().int().nullable(),
});
export type MyDay = z.infer<typeof MyDaySchema>;
export const MyDaysSchema = z.array(MyDaySchema);

export const MyDaysQuerySchema = z
  .object({ from: workDate, to: workDate })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 62, { message: 'Range is limited to 62 days' });
export type MyDaysQuery = z.infer<typeof MyDaysQuerySchema>;

export const CorrectionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  sessionId: z.string().nullable(),
  requestedIn: isoDate,
  requestedOut: isoDate,
  reason: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  reviewerId: z.string().nullable(),
  reviewedAt: isoDate.nullable(),
  reviewNote: z.string().nullable(),
  createdAt: isoDate,
});
export type Correction = z.infer<typeof CorrectionSchema>;
export const CorrectionListSchema = z.array(CorrectionSchema);

/** GET /attendance/corrections (review queue) */
export const CorrectionQueueItemSchema = CorrectionSchema.extend({
  requesterName: z.string().nullable(),
  requesterEmail: z.string(),
});
export type CorrectionQueueItem = z.infer<typeof CorrectionQueueItemSchema>;
export const CorrectionQueueSchema = z.array(CorrectionQueueItemSchema);

/** GET /attendance/consent */
export const ConsentStatusSchema = z.object({
  accepted: z.boolean(),
  noticeVersion: z.string(),
  acceptedAt: isoDate.nullable(),
});
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

/** GET /attendance/live */
export const LiveBoardEntrySchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  email: z.string(),
  teamId: z.string().nullable(),
  role: z.string(),
  status: z.enum(['ACTIVE', 'IDLE', 'ON_BREAK', 'IN_MEETING', 'ON_LEAVE', 'OFFLINE']),
  currentSessionId: z.string().nullable(),
  clockInAt: isoDate.nullable(),
  lastHeartbeatAt: isoDate.nullable(),
  todayNetSeconds: z.number(),
  hasClockedInToday: z.boolean(),
  /** FR-ORG-005: break time today and the allowance in force today (null: no limit). */
  todayBreakSeconds: z.number(),
  breakAllowanceSeconds: z.number().nullable(),
});
export type LiveBoardEntry = z.infer<typeof LiveBoardEntrySchema>;
export const LiveBoardSchema = z.array(LiveBoardEntrySchema);

/** GET /attendance/me/events (FR-ATT-020) */
export const TransparencySchema = z.object({
  plainLanguageNotice: z.string(),
  noticeVersion: z.string(),
  collectedFields: z.array(z.string()),
  retentionDays: z.number(),
  events: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      serverTs: isoDate,
      eventType: z.string(),
      state: z.string(),
      seq: z.number(),
    }),
  ),
});
export type Transparency = z.infer<typeof TransparencySchema>;

/** POST /attendance/break/start|end */
export const BreakResultSchema = z.object({
  state: AttendanceStateSchema,
  totals: TimeTotalsSchema,
});
export type BreakResult = z.infer<typeof BreakResultSchema>;
