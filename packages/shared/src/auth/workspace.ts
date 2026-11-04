/**
 * Self-service workspaces, owners, Google sign-in, invitations and effective access
 * (FR-AUTH-001, 005, 006, 009; FR-ORG-001, 009; ADR 037). Request and response contracts for
 * apps/api and apps/web; the rules themselves live in framework-free services.
 */
import { z } from 'zod';
import { Permission, UserRole } from './types.ts';

const email = z.string().trim().toLowerCase().email().max(320);
const password = z.string().min(12, 'Password must be at least 12 characters long').max(128);
const displayName = z.string().trim().min(2).max(100);
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/, 'Use letters, numbers and dashes');
const uuid = z.string().uuid();
const roleValues = Object.values(UserRole) as [UserRole, ...UserRole[]];
const permissionValues = Object.values(Permission) as [Permission, ...Permission[]];

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const timeZone = z.string().trim().max(64).refine(isValidTimeZone, 'Not a known time zone');

// ---------------------------------------------------------------- signup and e-mail verification

export const WorkspaceSignupDtoSchema = z
  .object({
    workspaceName: z.string().trim().min(2).max(200),
    email,
    password,
    displayName,
    /** Reserved for a CAPTCHA provider (ADR 037): verified by the API when one is configured. */
    captchaToken: z.string().max(4096).optional(),
  })
  .strict();
export type WorkspaceSignupDto = z.infer<typeof WorkspaceSignupDtoSchema>;

export const VerifyEmailDtoSchema = z.object({ token: z.string().min(32).max(128) }).strict();
export type VerifyEmailDto = z.infer<typeof VerifyEmailDtoSchema>;

export const ResendVerificationDtoSchema = z.object({ email, workspace: slug.optional() }).strict();
export type ResendVerificationDto = z.infer<typeof ResendVerificationDtoSchema>;

export const SignupResponseSchema = z.object({
  success: z.literal(true),
  /** The workspace address; the person signs in once the e-mail is verified. */
  workspace: z.object({ name: z.string(), slug: z.string() }),
  message: z.string(),
  /** ADR 039: the "Resend e-mail" button stays disabled this long after each e-mail. */
  resendAfterSeconds: z.number().int().min(0),
});
export type SignupResponse = z.infer<typeof SignupResponseSchema>;

// ---------------------------------------------------------------- e-mailed links (ADR 039)

/** verify: confirm a new owner's address; invite: accept an invitation; reset: new password. */
export const LINK_KINDS = ['verify', 'invite', 'reset'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LinkTokenDtoSchema = z.object({ kind: z.enum(LINK_KINDS), token: z.string().min(32).max(128) }).strict();
export type LinkTokenDto = z.infer<typeof LinkTokenDtoSchema>;

/** What an e-mailed link can still do. `revoked`: an invitation withdrawn, or an account no longer active. */
export const LINK_STATES = ['valid', 'used', 'expired', 'revoked', 'invalid'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const LinkStatusSchema = z.object({
  state: z.enum(LINK_STATES),
  /** The address the link was sent to (the holder of the link received it there); null when unknown. */
  email: z.string().nullable(),
  workspace: z.string().nullable(),
  /** verify links: the address is confirmed already (for instance, the link was opened twice). */
  alreadyVerified: z.boolean(),
});
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

export const VerifyEmailResponseSchema = z.object({ success: z.literal(true), email: z.string(), alreadyVerified: z.boolean() });
export type VerifyEmailResponse = z.infer<typeof VerifyEmailResponseSchema>;

/** A sign-in that needs the person to say which workspace they mean. */
export const WorkspaceChoiceSchema = z.object({ slug: z.string(), name: z.string() });
export type WorkspaceChoice = z.infer<typeof WorkspaceChoiceSchema>;

// ---------------------------------------------------------------- Google sign-in (FR-AUTH-005)

/** link: a signed-in person adds Google to their account from the profile page. */
export const GOOGLE_SIGNIN_MODES = ['login', 'signup', 'invite', 'link'] as const;
export type GoogleSigninMode = (typeof GOOGLE_SIGNIN_MODES)[number];

export const GoogleStartDtoSchema = z
  .object({
    mode: z.enum(GOOGLE_SIGNIN_MODES),
    /** Page to return to after a sign-in (a path on the web app). */
    returnTo: z.string().max(500).regex(/^\/(?!\/)/, 'Must be a path').optional(),
    /** login: which workspace, when the address belongs to several. */
    workspace: slug.optional(),
    /** signup: the new workspace. */
    workspaceName: z.string().trim().min(2).max(200).optional(),
    displayName: displayName.optional(),
    /** invite: the invitation being accepted; the Google address must match it. */
    inviteToken: z.string().min(10).max(128).optional(),
  })
  .strict()
  .refine((d) => d.mode !== 'signup' || !!d.workspaceName, { message: 'A workspace name is required', path: ['workspaceName'] })
  .refine((d) => d.mode !== 'invite' || !!d.inviteToken, { message: 'The invitation token is required', path: ['inviteToken'] });
export type GoogleStartDto = z.infer<typeof GoogleStartDtoSchema>;

export const GoogleStartResponseSchema = z.object({ authorizeUrl: z.string().url() });

/** Second step of a Google sign-in for a role that needs 2FA: the challenge token plus the code. */
/** Which ways a person can sign in (FR-AUTH-005); the last one cannot be removed. */
export const SignInMethodsSchema = z.object({ password: z.boolean(), google: z.boolean(), googleEmail: z.string().nullable() });
export type SignInMethods = z.infer<typeof SignInMethodsSchema>;

export const GoogleTotpDtoSchema = z
  .object({ challengeToken: z.string().min(20).max(2048), code: z.string().regex(/^(\d{6}|[0-9a-f]{10})$/, 'Expected a 6-digit code or a recovery code') })
  .strict();
export type GoogleTotpDto = z.infer<typeof GoogleTotpDtoSchema>;

/** Last step of a Google sign-in (ADR 042): the single-use handoff token the callback left in the URL fragment. */
export const GoogleCompleteDtoSchema = z.object({ handoffToken: z.string().min(20).max(2048) }).strict();
export type GoogleCompleteDto = z.infer<typeof GoogleCompleteDtoSchema>;

/** Result codes carried back to the web app after the Google redirect (`?sso=` and `&code=`). */
export const GOOGLE_RESULT_CODES = ['ok', 'totp', 'enroll', 'linked', 'email_mismatch', 'no_account', 'unverified_email', 'denied', 'invalid_state', 'failed', 'choose_workspace', 'not_configured', 'account_inactive', 'invitation_invalid', 'redirect_uri_mismatch', 'already_linked', 'token_invalid'] as const;
export type GoogleResultCode = (typeof GOOGLE_RESULT_CODES)[number];

// ---------------------------------------------------------------- invitations (FR-AUTH-001)

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const InvitationRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(roleValues),
  teamId: z.string().nullable(),
  status: z.enum(INVITATION_STATUSES),
  invitedBy: z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() }),
  expiresAt: z.string(),
  lastSentAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InvitationRow = z.infer<typeof InvitationRowSchema>;
export const InvitationListSchema = z.array(InvitationRowSchema);

// ---------------------------------------------------------------- people (FR-ORG-009, job titles)

/** ANONYMISED: the row stays as a pseudonymous key after FR-AUD-003 anonymisation. */
export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED', 'ANONYMISED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const UserStatusDtoSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'OFFBOARDED']),
    /** OFFBOARDED: who takes over their open tasks (otherwise they become unassigned). */
    reassignTasksTo: uuid.optional(),
  })
  .strict();
export type UserStatusDto = z.infer<typeof UserStatusDtoSchema>;

export const ProfileUpdateDtoSchema = z
  .object({
    displayName: displayName.optional(),
    /** Descriptive only (Developer, QA, BA, Tech Lead, ...); grants no access. */
    jobTitle: z.string().trim().max(100).nullable().optional(),
  })
  .strict();
export type ProfileUpdateDto = z.infer<typeof ProfileUpdateDtoSchema>;

// ---------------------------------------------------------------- organisation profile (FR-ORG-001)

const workWeek = z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((d) => new Set(d).size === d.length, 'A day is listed twice');

export const OrgProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  workWeek: z.array(z.number().int()),
  onboardedAt: z.string().nullable(),
  /** Owner-only sign-in settings (FR-AUTH-005). */
  ssoAutoJoinDomain: z.string().nullable(),
  mfaForSso: z.boolean(),
  ownerCount: z.number().int(),
  googleSignInAvailable: z.boolean(),
});
export type OrgProfile = z.infer<typeof OrgProfileSchema>;

export const OrgProfileUpdateDtoSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    timezone: timeZone.optional(),
    workWeek: workWeek.optional(),
    /** The onboarding wizard is finished. */
    onboarded: z.literal(true).optional(),
    /** Owner only: Google accounts on this domain may join without an invitation; null = off. */
    ssoAutoJoinDomain: z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Use a domain such as example.com').nullable().optional(),
    /** Owner only: roles that need 2FA also need it after a Google sign-in. */
    mfaForSso: z.boolean().optional(),
  })
  .strict();
export type OrgProfileUpdateDto = z.infer<typeof OrgProfileUpdateDtoSchema>;

// ---------------------------------------------------------------- ownership

export const OwnershipTransferDtoSchema = z
  .object({
    newOwnerId: uuid,
    /** false (default): the current owner steps down to Admin once the transfer is accepted. */
    keepOwnership: z.boolean().default(false),
    /** Re-authentication: the current password, or a 2FA code for accounts without a password. */
    password: z.string().min(1).max(128).optional(),
    totpCode: z.string().regex(/^(\d{6}|[0-9a-f]{10})$/).optional(),
  })
  .strict()
  .refine((d) => !!d.password || !!d.totpCode, { message: 'Confirm with your password or a 2FA code', path: ['password'] });
export type OwnershipTransferDto = z.input<typeof OwnershipTransferDtoSchema>;

export const OWNERSHIP_TRANSFER_STATUSES = ['PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'] as const;
const person = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string() });
export const OwnershipTransferSchema = z.object({
  id: z.string(),
  from: person,
  to: person,
  keepOwnership: z.boolean(),
  status: z.enum(OWNERSHIP_TRANSFER_STATUSES),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type OwnershipTransfer = z.infer<typeof OwnershipTransferSchema>;
export const OwnershipTransferListSchema = z.array(OwnershipTransferSchema);

/** Removing someone's ownership (they stay a super admin unless demoted separately). */
export const OwnerRemoveDtoSchema = z.object({ password: z.string().min(1).max(128).optional(), totpCode: z.string().regex(/^(\d{6}|[0-9a-f]{10})$/).optional() }).strict();

// ---------------------------------------------------------------- effective access (FR-AUTH-006)

export const EffectiveAccessSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    role: z.enum(roleValues),
    roleLabel: z.string(),
    customRoleName: z.string().nullable(),
    isOwner: z.boolean(),
    jobTitle: z.string().nullable(),
    status: z.enum(USER_STATUSES),
    mfaEnabled: z.boolean(),
  }),
  permissions: z.array(z.enum(permissionValues)),
  groups: z.array(z.object({
    group: z.string(),
    items: z.array(z.object({ permission: z.enum(permissionValues), label: z.string(), description: z.string(), granted: z.boolean() })),
  })),
  /** What the person can see in the app, derived from the permissions. */
  areas: z.array(z.object({ key: z.string(), label: z.string(), visible: z.boolean() })),
});
export type EffectiveAccess = z.infer<typeof EffectiveAccessSchema>;
