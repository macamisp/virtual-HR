/**
 * Simple in-app e-signature (SRS 5.8 FR-DOC-014; ADR 022). Not a qualified or advanced electronic
 * signature: draw or type, with re-authentication, consent, and a tamper-evident audit certificate.
 */
import { z } from 'zod';

export const ESIGN_CONSENT = {
  version: 'v1.0.0',
  text: 'I agree to sign this document electronically. My drawn or typed signature, together with my identity, the time, my IP address and the document fingerprint, has the same meaning to me as a handwritten signature.',
} as const;

export const SIGNATURE_STATUSES = ['OPEN', 'COMPLETED', 'DECLINED', 'CANCELLED'] as const;
export const SIGNER_STATUSES = ['PENDING', 'SIGNED', 'DECLINED'] as const;

export const SignatureRequestDtoSchema = z.object({
  signerIds: z.array(z.string().uuid()).min(1).max(10),
  message: z.string().trim().max(1000).default(''),
}).strict();
export type SignatureRequestDto = z.input<typeof SignatureRequestDtoSchema>;

/** A drawn signature: PNG, at most 150 KB; or a typed name. */
export const SignDtoSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('DRAW'), imagePng: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(210_000), consentVersion: z.string(), consent: z.literal(true) }).strict(),
  z.object({ method: z.literal('TYPE'), typedName: z.string().trim().min(2).max(100), consentVersion: z.string(), consent: z.literal(true) }).strict(),
]);
export type SignDto = z.infer<typeof SignDtoSchema>;

export const DeclineSignatureDtoSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const Person = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });
export const SignatureRequestSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  status: z.enum(SIGNATURE_STATUSES),
  message: z.string(),
  requestedBy: Person,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  sourceSha256: z.string(),
  signedVersionId: z.string().nullable(),
  signedSha256: z.string().nullable(),
  signers: z.array(Person.extend({ status: z.enum(SIGNER_STATUSES), signedAt: z.string().nullable(), method: z.enum(['DRAW', 'TYPE']).nullable(), declineReason: z.string().nullable() })),
  /** For the viewer: may sign now / may cancel. */
  canSign: z.boolean(),
  canCancel: z.boolean(),
});
export type SignatureRequest = z.infer<typeof SignatureRequestSchema>;
export const SignatureRequestListSchema = z.object({ items: z.array(SignatureRequestSchema) });

export const SignatureVerificationSchema = z.object({
  requestId: z.string(),
  status: z.enum(SIGNATURE_STATUSES),
  /** The signed source version still has the fingerprint recorded when signing was requested. */
  sourceIntact: z.boolean(),
  /** The stored signed version's fingerprint equals the one recorded when it was produced. */
  signedIntact: z.boolean().nullable(),
  signedSha256: z.string().nullable(),
  events: z.array(z.object({ at: z.string(), what: z.string() })),
});
export type SignatureVerification = z.infer<typeof SignatureVerificationSchema>;
