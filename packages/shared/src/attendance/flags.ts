/**
 * Attendance review flags (FR-ATT-017, FR-ATT-018, FR-ATT-012, FR-ATT-009; ADR 019).
 * A flag asks a person to look; it never changes recorded time and never penalises anyone.
 */
import { z } from 'zod';

export const FLAG_CATEGORIES = ['SPOOFING', 'NETWORK', 'DEVICE', 'OFFLINE', 'SESSION'] as const;
export type FlagCategory = (typeof FLAG_CATEGORIES)[number];

/** Plain-language text shown to reviewers AND to the person flagged. */
export const FLAG_META = {
  INVALID_HEARTBEATS: { category: 'SPOOFING', label: 'Rejected activity signals', explanation: 'Several activity signals failed the signature, replay or order checks. This can be a script imitating the app, or an old tab after a password change.' },
  HEARTBEAT_FLOOD: { category: 'SPOOFING', label: 'Too many activity signals', explanation: 'More activity signals arrived than the app sends. This can be an automated sender or several tabs misbehaving.' },
  UNBROKEN_FULL_ACTIVITY: { category: 'SPOOFING', label: 'Unbroken input for hours', explanation: 'Keyboard or mouse input was reported in every second for three hours or more, which is unusual for a person.' },
  PERIODIC_ACTIVITY: { category: 'SPOOFING', label: 'Machine-like input pattern', explanation: 'Identical short bursts of input arrived at a perfectly regular interval, as a "mouse jiggler" produces.' },
  ACTIVITY_WITHOUT_FOCUS: { category: 'SPOOFING', label: 'Input while the app was hidden', explanation: 'The browser reported input while the app was neither visible nor focused, which the app itself cannot see.' },
  IMPOSSIBLE_TRAVEL: { category: 'SPOOFING', label: 'Impossible travel', explanation: 'Activity came from two countries further apart than anyone could travel in the time between them. VPNs often cause this.' },
  MULTI_DEVICE: { category: 'DEVICE', label: 'Several devices at once', explanation: 'Two devices were active at the same time. Time was not counted twice.' },
  IP_NOT_ALLOWED: { category: 'NETWORK', label: 'Outside the allowed networks', explanation: "Activity came from an IP address outside the organisation's allowed ranges." },
  COUNTRY_NOT_ALLOWED: { category: 'NETWORK', label: 'Outside the allowed countries', explanation: "Activity came from a country that is not on the organisation's list." },
  ANONYMIZER: { category: 'NETWORK', label: 'Anonymising network', explanation: 'Activity came through the Tor network.' },
  OFFLINE_SYNCED: { category: 'OFFLINE', label: 'Time recorded offline', explanation: 'The desktop agent recorded this time without a connection and sent it later.' },
  MAX_LENGTH: { category: 'SESSION', label: 'Very long session', explanation: 'A session reached the maximum length and was closed at the last activity.' },
} as const satisfies Record<string, { category: FlagCategory; label: string; explanation: string }>;
export type FlagKind = keyof typeof FLAG_META;
export const FLAG_KINDS = Object.keys(FLAG_META) as FlagKind[];

export const FLAG_STATUSES = ['OPEN', 'RESOLVED'] as const;
export const FLAG_RESOLUTIONS = ['NO_ACTION', 'FOLLOW_UP'] as const;
export type FlagResolution = (typeof FLAG_RESOLUTIONS)[number];

export const AttendanceFlagSchema = z.object({
  id: z.string(),
  kind: z.enum(FLAG_KINDS as [FlagKind, ...FlagKind[]]),
  category: z.enum(FLAG_CATEGORIES),
  person: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() }),
  sessionId: z.string().nullable(),
  workDate: z.string(),
  details: z.record(z.string(), z.unknown()),
  status: z.enum(FLAG_STATUSES),
  resolution: z.enum(FLAG_RESOLUTIONS).nullable(),
  resolutionNote: z.string().nullable(),
  resolvedBy: z.object({ id: z.string(), displayName: z.string().nullable() }).nullable(),
  resolvedAt: z.string().nullable(),
  userComment: z.string().nullable(),
  createdAt: z.string(),
  canResolve: z.boolean(),
});
export type AttendanceFlag = z.infer<typeof AttendanceFlagSchema>;
export const AttendanceFlagListSchema = z.object({ items: z.array(AttendanceFlagSchema) });

export const FlagQuerySchema = z.object({
  scope: z.enum(['mine', 'review']).default('review'),
  status: z.enum(FLAG_STATUSES).default('OPEN'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type FlagQuery = z.infer<typeof FlagQuerySchema>;

export const ResolveFlagDtoSchema = z.object({
  resolution: z.enum(FLAG_RESOLUTIONS),
  note: z.string().trim().min(3, 'Add a short note for the record').max(2000),
}).strict();
export type ResolveFlagDto = z.infer<typeof ResolveFlagDtoSchema>;

export const FlagCommentDtoSchema = z.object({ comment: z.string().trim().min(1).max(2000) }).strict();
export type FlagCommentDto = z.infer<typeof FlagCommentDtoSchema>;

/** FR-ATT-023: the socket event and its reply. */
export interface PresenceChallenge { id: string; expiresAt: string }
export const ChallengeResponseDtoSchema = z.object({ challengeId: z.string().uuid() }).strict();
