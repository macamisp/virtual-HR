/**
 * Media, meetings and their API (SRS 5.4 FR-MEET-001..005, 008, 009, 010, 011; FR-VO-005, 009, 010).
 * ADR 016.
 */
import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });

// ---------------------------------------------------------------- LiveKit tokens

/**
 * What the token is for. The server derives the LiveKit room name itself; the client can never
 * name a room. `room` = the office room the avatar is standing in; `proximity` = the user's
 * current proximity group; `meeting` = an instant or scheduled meeting.
 */
export const MediaTokenRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room') }).strict(),
  z.object({ kind: z.literal('proximity') }).strict(),
  z.object({ kind: z.literal('meeting'), meetingId: z.string().uuid() }).strict(),
]);
export type MediaTokenRequest = z.infer<typeof MediaTokenRequestSchema>;

export const MediaTokenSchema = z.object({
  url: z.string(),
  token: z.string(),
  roomName: z.string(),
  /** What the token grants, so the UI can show it. */
  canPublish: z.boolean(),
  canModerate: z.boolean(),
  expiresAt: isoDate,
  /** Human label: room name, "Nearby", or the meeting title. */
  label: z.string(),
  meetingId: z.string().nullable(),
});
export type MediaToken = z.infer<typeof MediaTokenSchema>;

// ---------------------------------------------------------------- meetings

export const MEETING_TYPES = ['INSTANT', 'ROOM', 'SCHEDULED'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];
export const MEETING_STATUSES = ['SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const ATTENDEE_ROLES = ['HOST', 'COHOST', 'ATTENDEE'] as const;
export type AttendeeRole = (typeof ATTENDEE_ROLES)[number];
export const RECURRENCE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

/** RFC 5545 RRULE subset: FREQ (DAILY/WEEKLY/MONTHLY), INTERVAL 1..12, COUNT 1..100 or UNTIL date, BYDAY for weekly. */
export const RecurrenceSchema = z.object({
  freq: z.enum(RECURRENCE_FREQS),
  interval: z.number().int().min(1).max(12).default(1),
  count: z.number().int().min(1).max(100).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).max(7).optional(),
}).refine((r) => !(r.count && r.until), { message: 'Use either count or until' });
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const MeetingCreateDtoSchema = z
  .object({
    type: z.enum(['INSTANT', 'SCHEDULED']),
    title: z.string().trim().min(1).max(200),
    agenda: z.string().max(10_000).default(''),
    /** Server time decides when instant meetings start; ignored for INSTANT. */
    start: isoDate.optional(),
    end: isoDate.optional(),
    recurrence: RecurrenceSchema.nullable().default(null),
    attendeeIds: z.array(z.string().uuid()).max(49).default([]),
    cohostIds: z.array(z.string().uuid()).max(10).default([]),
    /** Uninvited people wait in the lobby until a host admits them (FR-MEET-005). */
    lobby: z.boolean().default(true),
    sendInvites: z.boolean().default(true),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.type === 'SCHEDULED') {
      if (!m.start || !m.end) ctx.addIssue({ code: 'custom', message: 'A scheduled meeting needs a start and an end', path: ['start'] });
      else if (Date.parse(m.end) <= Date.parse(m.start)) ctx.addIssue({ code: 'custom', message: 'The end must be after the start', path: ['end'] });
      else if (Date.parse(m.end) - Date.parse(m.start) > 12 * 3_600_000) ctx.addIssue({ code: 'custom', message: 'At most 12 hours', path: ['end'] });
    }
  });
export type MeetingCreateDto = z.input<typeof MeetingCreateDtoSchema>;

export const MeetingUpdateDtoSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    agenda: z.string().max(10_000).optional(),
    notes: z.string().max(50_000).optional(),
    start: isoDate.optional(),
    end: isoDate.optional(),
    attendeeIds: z.array(z.string().uuid()).max(49).optional(),
    cohostIds: z.array(z.string().uuid()).max(10).optional(),
    lobby: z.boolean().optional(),
    version: z.number().int().positive(),
  })
  .strict();
export type MeetingUpdateDto = z.infer<typeof MeetingUpdateDtoSchema>;

const PersonRefSchema = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });

export const ActionItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  assignee: PersonRefSchema.nullable(),
  dueDate: z.string().nullable(),
  taskId: z.string().nullable(),
  createdAt: isoDate,
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const MeetingSchema = z.object({
  id: z.string(),
  type: z.enum(MEETING_TYPES),
  status: z.enum(MEETING_STATUSES),
  title: z.string(),
  agenda: z.string(),
  notes: z.string(),
  host: PersonRefSchema,
  roomId: z.string().nullable(),
  scheduledStart: isoDate.nullable(),
  scheduledEnd: isoDate.nullable(),
  startedAt: isoDate.nullable(),
  endedAt: isoDate.nullable(),
  recurrence: z.string().nullable(),
  lobby: z.boolean(),
  attendees: z.array(PersonRefSchema.extend({ role: z.enum(ATTENDEE_ROLES), response: z.enum(['NEEDS_ACTION', 'ACCEPTED', 'DECLINED']) })),
  participants: z.array(PersonRefSchema.extend({ joinedAt: isoDate, leftAt: isoDate.nullable(), durationSeconds: z.number().int() })),
  actionItems: z.array(ActionItemSchema),
  joinUrl: z.string(),
  myRole: z.enum(['HOST', 'COHOST', 'ATTENDEE', 'NONE']),
  canEdit: z.boolean(),
  version: z.number().int(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const MeetingSummarySchema = MeetingSchema.pick({ id: true, type: true, status: true, title: true, host: true, scheduledStart: true, scheduledEnd: true, startedAt: true, myRole: true, recurrence: true });
export const MeetingListSchema = z.object({ items: z.array(MeetingSummarySchema) });

export const MeetingListQuerySchema = z.object({
  scope: z.enum(['upcoming', 'past', 'live']).default('upcoming'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ActionItemDtoSchema = z.object({ text: z.string().trim().min(1).max(500), assigneeId: z.string().uuid().nullable().default(null), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }).strict();
export type ActionItemDto = z.input<typeof ActionItemDtoSchema>;

// ---------------------------------------------------------------- lobby and host controls (FR-MEET-005)

export const LOBBY_STATES = ['WAITING', 'ADMITTED', 'DENIED'] as const;
export const JoinResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('READY'), token: MediaTokenSchema }),
  z.object({ status: z.literal('WAITING'), message: z.string() }),
  z.object({ status: z.literal('DENIED'), message: z.string() }),
]);
export type JoinResult = z.infer<typeof JoinResultSchema>;

export const LobbyEntrySchema = z.object({ userId: z.string(), displayName: z.string().nullable(), email: z.string(), requestedAt: isoDate });
export const LobbySchema = z.object({ items: z.array(LobbyEntrySchema) });

export const LobbyDecisionDtoSchema = z.object({ userId: z.string().uuid(), admit: z.boolean() }).strict();
export const RemoveParticipantDtoSchema = z.object({ userId: z.string().uuid() }).strict();

/** In-meeting data messages over LiveKit's data channel (raise hand, reactions). */
export const MEETING_DATA_TOPIC = 'hrvo';
export type MeetingDataMessage = { type: 'hand'; raised: boolean } | { type: 'muted-by-host' };
