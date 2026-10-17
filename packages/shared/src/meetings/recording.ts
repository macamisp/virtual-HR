/**
 * Meeting recording with consent (SRS 5.4 FR-MEET-007, FR-AUD-004; ADR 024). Off unless the
 * organisation enables it; every participant must agree before anything is recorded.
 */
import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });

export const RECORDING_STATUSES = ['CONSENT', 'RECORDING', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED', 'DELETED'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

const Person = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });

export const RecordingSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  status: z.enum(RECORDING_STATUSES),
  startedBy: Person,
  createdAt: isoDate,
  consentDeadline: isoDate,
  startedAt: isoDate.nullable(),
  endedAt: isoDate.nullable(),
  durationSeconds: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  expiresAt: isoDate.nullable(),
  detail: z.string().nullable(),
  /** Who still has to answer (CONSENT only). */
  waitingFor: z.array(Person),
  /** This viewer's latest answer for this recording. */
  myConsent: z.boolean().nullable(),
  canStop: z.boolean(),
  canWatch: z.boolean(),
  canDelete: z.boolean(),
});
export type Recording = z.infer<typeof RecordingSchema>;
export const RecordingListSchema = z.object({ items: z.array(RecordingSchema), enabled: z.boolean() });

export const RecordingConsentDtoSchema = z.object({ granted: z.boolean(), noticeVersion: z.string().max(20) }).strict();
export type RecordingConsentDto = z.infer<typeof RecordingConsentDtoSchema>;

/** Settings (FR-ADM-001 / SRS 13 "recording off by default"). Retention is with the other data types. */
export const RecordingSettingsSchema = z.object({ enabled: z.boolean() }).strict();
export type RecordingSettings = z.infer<typeof RecordingSettingsSchema>;
