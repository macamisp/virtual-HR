/**
 * Wire (JSON) contracts for /auth endpoints, validated by apps/web.
 * Refresh tokens never appear in any body: the API sets them only as the httpOnly cookie.
 * The schemas are strict about it (`refreshToken` is rejected if it ever reappears).
 * Ref: docs/SRS.md 5.1 (FR-AUTH-001..004, 008), ADR 005.
 */
import { z } from 'zod';

export const SessionUserSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  email: z.string(),
  displayName: z.string().nullable().optional(),
  role: z.string(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/** Successful login / refresh / 2FA-enrollment completion. */
/** Fails validation if a body ever carries a refresh token (FR-AUTH-003). */
const noRefreshToken = { refreshToken: z.never().optional() };

export const SessionResponseSchema = z.object({
  accessToken: z.string(),
  sessionId: z.string(),
  sessionSecret: z.string(),
  user: SessionUserSchema,
  ...noRefreshToken,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const LoginResponseSchema = z.union([
  SessionResponseSchema,
  z.object({ requires2fa: z.literal(true), message: z.string().optional() }),
  z.object({ requires2faSetup: z.literal(true), enrollmentToken: z.string(), message: z.string().optional() }),
]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const MfaSetupResponseSchema = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type MfaSetupResponse = z.infer<typeof MfaSetupResponseSchema>;

export const MfaVerifyResponseSchema = z.object({
  ...noRefreshToken,
  success: z.literal(true),
  recoveryCodes: z.array(z.string()),
  accessToken: z.string().optional(),
  sessionId: z.string().optional(),
  sessionSecret: z.string().optional(),
  user: SessionUserSchema.optional(),
});
export type MfaVerifyResponse = z.infer<typeof MfaVerifyResponseSchema>;

export const AcceptInvitationResponseSchema = z.object({ success: z.literal(true), user: SessionUserSchema, ...noRefreshToken });
export const MessageResponseSchema = z.object({ success: z.boolean(), message: z.string().optional() });
