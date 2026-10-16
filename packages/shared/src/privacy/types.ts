/**
 * Data-subject rights (SRS 5.12): export (FR-AUD-002) and anonymisation with legal-retention
 * checks (FR-AUD-003). ADR 014.
 */
import { z } from 'zod';

export const PRIVACY_REQUEST_TYPES = ['EXPORT', 'ANONYMISE'] as const;
export const PRIVACY_REQUEST_STATUSES = ['PENDING', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const BLOCKER_KINDS = ['OPEN_ATTENDANCE_SESSION', 'PENDING_CORRECTION', 'SUBMITTED_TIMESHEET', 'UNPAID_TIMESHEET', 'ACTIVE_CONTRACT', 'LEGAL_HOLD'] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** Something that must be resolved before anonymisation can run. */
export const BlockerSchema = z.object({
  kind: z.enum(BLOCKER_KINDS),
  count: z.number().int(),
  detail: z.string(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

/** Data that is kept, pseudonymously, because of a legal basis; shown so HR can explain it. */
export const RetainedSchema = z.object({
  kind: z.enum(['RETAINED_DOCUMENTS', 'AUDIT_LOG', 'CONSENT_RECORDS', 'FINANCIAL_RECORDS']),
  count: z.number().int(),
  detail: z.string(),
});
export type Retained = z.infer<typeof RetainedSchema>;

export const AnonymisationCheckSchema = z.object({
  subject: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string(), role: z.string(), status: z.string() }),
  blockers: z.array(BlockerSchema),
  retained: z.array(RetainedSchema),
  /** What will be removed or replaced, per data set. */
  willRemove: z.array(z.object({ dataset: z.string(), count: z.number().int(), action: z.enum(['DELETE', 'REPLACE', 'SHRED', 'REVOKE']) })),
  canProceed: z.boolean(),
});
export type AnonymisationCheck = z.infer<typeof AnonymisationCheckSchema>;

export const PrivacyRequestSchema = z.object({
  id: z.string(),
  type: z.enum(PRIVACY_REQUEST_TYPES),
  status: z.enum(PRIVACY_REQUEST_STATUSES),
  subject: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() }),
  requestedBy: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() }),
  reason: z.string(),
  blockers: z.array(BlockerSchema),
  result: z.record(z.string(), z.number()).nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type PrivacyRequest = z.infer<typeof PrivacyRequestSchema>;
export const PrivacyRequestListSchema = z.object({ items: z.array(PrivacyRequestSchema) });

export const CreateAnonymisationDtoSchema = z
  .object({
    userId: z.string().uuid(),
    /** Why: the request from the person, a leaver process, a court order… Audited. */
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export type CreateAnonymisationDto = z.infer<typeof CreateAnonymisationDtoSchema>;

export const ExecuteAnonymisationDtoSchema = z
  .object({
    /** Must repeat the subject's email as a confirmation; irreversible. */
    confirmEmail: z.string().trim().email(),
  })
  .strict();
export type ExecuteAnonymisationDto = z.infer<typeof ExecuteAnonymisationDtoSchema>;

/** Sections of a data-subject export; each becomes one JSON file in the archive. */
export const EXPORT_SECTIONS = ['profile', 'consents', 'attendance', 'timesheets', 'tasks', 'documents', 'notifications', 'sessions', 'audit'] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];
