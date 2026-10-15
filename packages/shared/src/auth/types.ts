/**
 * HRVO Authentication & RBAC Shared Types and Zod Schemas
 * Ref: docs/SRS.md Section 5.1 (FR-AUTH-001..012) and Section 3.4
 */

import { z } from 'zod';

export const UserRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  HR_MANAGER: 'HR_MANAGER',
  HR: 'HR',
  MANAGER: 'MANAGER',
  TEAM_LEAD: 'TEAM_LEAD',
  EMPLOYEE: 'EMPLOYEE',
  SUBCONTRACTOR: 'SUBCONTRACTOR',
  INTERN: 'INTERN',
  AUDITOR: 'AUDITOR',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const Permission = {
  ATTENDANCE_READ_OWN: 'attendance.read.own',
  ATTENDANCE_READ_TEAM: 'attendance.read.team',
  ATTENDANCE_READ_ALL: 'attendance.read.all',
  ATTENDANCE_CORRECTIONS_CREATE: 'attendance.corrections.create',
  ATTENDANCE_CORRECTIONS_REVIEW: 'attendance.corrections.review',
  ATTENDANCE_EXPORT: 'attendance.export',
  AUDIT_READ: 'audit.read',
  USERS_MANAGE: 'users.manage',
  USERS_INVITE: 'users.invite',
  ORG_MANAGE: 'org.manage',
  // FR-TASK: tasks.use = own tasks (every role except the read-only auditor); the rest widen scope.
  TASKS_USE: 'tasks.use',
  NOTIFICATIONS_READ_OWN: 'notifications.read.own',
  TASKS_ASSIGN: 'tasks.assign',
  TASKS_READ_TEAM: 'tasks.read.team',
  TASKS_READ_ALL: 'tasks.read.all',
  PROJECTS_MANAGE: 'projects.manage',
  // FR-TS: timesheets.use = own timers, entries and timesheets (every role except the auditor).
  TIMESHEETS_USE: 'timesheets.use',
  TIMESHEETS_APPROVE_TEAM: 'timesheets.approve.team',
  TIMESHEETS_APPROVE_ALL: 'timesheets.approve.all',
  /** Read-only view of every timesheet, rate and report (HR, admins, Finance/Auditor). */
  TIMESHEETS_READ_ALL: 'timesheets.read.all',
  /** FR-TS-011: the SRS name for reopening an approved timesheet. */
  TIMESHEET_REOPEN: 'timesheet.reopen',
  RATES_MANAGE: 'rates.manage',
  // FR-DOC: documents.use = own, linked and shared documents (every role).
  DOCUMENTS_USE: 'documents.use',
  /** HR and admins: every document (MANAGE), folders, grants. */
  DOCUMENTS_READ_ALL: 'documents.read.all',
  /** SRS 7.4 contracts (minimal until the People & Org slice). */
  CONTRACTS_MANAGE: 'contracts.manage',
  /** FR-DOC-006 / SRS 10.1 step 5: reset a lost document password through the KMS escrow. */
  VAULT_RECOVER: 'vault.recover',
  /** FR-DOC-017: place and lift legal holds; manage retention rules. */
  DOCUMENTS_LEGAL_HOLD: 'documents.legal_hold',
  DOCUMENTS_RETENTION: 'documents.retention',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
    Permission.USERS_MANAGE,
    Permission.USERS_INVITE,
    Permission.ORG_MANAGE,
    Permission.TASKS_ASSIGN,
    Permission.TASKS_READ_TEAM,
    Permission.TASKS_READ_ALL,
    Permission.PROJECTS_MANAGE,
    Permission.TIMESHEETS_USE,
    Permission.TIMESHEETS_APPROVE_ALL,
    Permission.TIMESHEETS_READ_ALL,
    Permission.RATES_MANAGE,
    Permission.TIMESHEET_REOPEN,
    Permission.DOCUMENTS_USE,
    Permission.DOCUMENTS_READ_ALL,
    Permission.CONTRACTS_MANAGE,
    Permission.VAULT_RECOVER,
    Permission.DOCUMENTS_LEGAL_HOLD,
    Permission.DOCUMENTS_RETENTION,
  ],
  ADMIN: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
    Permission.USERS_MANAGE,
    Permission.USERS_INVITE,
    Permission.ORG_MANAGE,
    Permission.TASKS_ASSIGN,
    Permission.TASKS_READ_TEAM,
    Permission.TASKS_READ_ALL,
    Permission.PROJECTS_MANAGE,
    Permission.TIMESHEETS_USE,
    Permission.TIMESHEETS_APPROVE_ALL,
    Permission.TIMESHEETS_READ_ALL,
    Permission.RATES_MANAGE,
    Permission.TIMESHEET_REOPEN,
    Permission.DOCUMENTS_USE,
    Permission.DOCUMENTS_READ_ALL,
    Permission.CONTRACTS_MANAGE,
    Permission.DOCUMENTS_LEGAL_HOLD,
    Permission.DOCUMENTS_RETENTION,
  ],
  HR_MANAGER: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
    Permission.USERS_MANAGE,
    Permission.USERS_INVITE,
    Permission.ORG_MANAGE,
    Permission.TASKS_ASSIGN,
    Permission.TASKS_READ_TEAM,
    Permission.TASKS_READ_ALL,
    Permission.PROJECTS_MANAGE,
    Permission.TIMESHEETS_USE,
    Permission.TIMESHEETS_APPROVE_ALL,
    Permission.TIMESHEETS_READ_ALL,
    Permission.RATES_MANAGE,
    Permission.TIMESHEET_REOPEN,
    Permission.DOCUMENTS_USE,
    Permission.DOCUMENTS_READ_ALL,
    Permission.CONTRACTS_MANAGE,
    Permission.VAULT_RECOVER,
    Permission.DOCUMENTS_LEGAL_HOLD,
    Permission.DOCUMENTS_RETENTION,
  ],
  HR: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
    Permission.USERS_MANAGE,
    Permission.USERS_INVITE,
    Permission.ORG_MANAGE,
    Permission.TASKS_ASSIGN,
    Permission.TASKS_READ_TEAM,
    Permission.TASKS_READ_ALL,
    Permission.PROJECTS_MANAGE,
    Permission.TIMESHEETS_USE,
    Permission.TIMESHEETS_APPROVE_ALL,
    Permission.TIMESHEETS_READ_ALL,
    Permission.RATES_MANAGE,
    Permission.DOCUMENTS_USE,
    Permission.DOCUMENTS_READ_ALL,
    Permission.CONTRACTS_MANAGE,
  ],
  MANAGER: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
    Permission.TASKS_ASSIGN,
    Permission.TASKS_READ_TEAM,
    Permission.PROJECTS_MANAGE,
    Permission.TIMESHEETS_USE,
    Permission.TIMESHEETS_APPROVE_TEAM,
    Permission.DOCUMENTS_USE,
  ],
  TEAM_LEAD: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
    Permission.TASKS_ASSIGN,
    Permission.TASKS_READ_TEAM,
    Permission.TIMESHEETS_USE,
    Permission.TIMESHEETS_APPROVE_TEAM,
    Permission.DOCUMENTS_USE,
  ],
  EMPLOYEE: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.TIMESHEETS_USE,
    Permission.DOCUMENTS_USE,
  ],
  SUBCONTRACTOR: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.TIMESHEETS_USE,
    Permission.DOCUMENTS_USE,
  ],
  INTERN: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.TIMESHEETS_USE,
    Permission.DOCUMENTS_USE,
  ],
  AUDITOR: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
    Permission.TIMESHEETS_READ_ALL,
    Permission.DOCUMENTS_USE,
  ],
};

/** Roles for which TOTP 2FA is mandatory before a full access token is issued (FR-AUTH-004). */
export const MFA_REQUIRED_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.HR,
];

export function isMfaRequiredRole(role: string): boolean {
  return (MFA_REQUIRED_ROLES as readonly string[]).includes(role);
}

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role as UserRole];
  if (!perms) return false;
  return perms.includes(permission);
}

// ==================== Zod Validation Schemas ====================

export const LoginDtoSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
  // 6-digit TOTP code or a 10-hex-char recovery code (FR-AUTH-004)
  totpCode: z
    .string()
    .regex(/^(\d{6}|[0-9a-f]{10})$/, 'Expected a 6-digit TOTP code or a recovery code')
    .optional(),
});
export type LoginDto = z.infer<typeof LoginDtoSchema>;

export const InviteUserDtoSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(UserRole).default(UserRole.EMPLOYEE),
  teamId: z.string().uuid().optional(),
});
export type InviteUserDto = z.infer<typeof InviteUserDtoSchema>;

export const SignupInvitationDtoSchema = z.object({
  inviteToken: z.string().min(10, 'Invalid invitation token'),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters long')
    .max(128),
  displayName: z.string().min(2).max(100),
});
export type SignupInvitationDto = z.infer<typeof SignupInvitationDtoSchema>;

const NewPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters long')
  .max(128);

export const PasswordForgotDtoSchema = z.object({
  email: z.string().email(),
});
export type PasswordForgotDto = z.infer<typeof PasswordForgotDtoSchema>;

export const PasswordResetDtoSchema = z.object({
  token: z.string().min(32).max(128),
  newPassword: NewPasswordSchema,
});
export type PasswordResetDto = z.infer<typeof PasswordResetDtoSchema>;

export const Verify2faDtoSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '2FA code must be 6 digits'),
});
export type Verify2faDto = z.infer<typeof Verify2faDtoSchema>;

export const CorrectionRequestDtoSchema = z.object({
  sessionId: z.string().uuid().optional(),
  requestedIn: z.string().datetime(),
  requestedOut: z.string().datetime(),
  reason: z.string().min(5, 'Reason must be at least 5 characters long'),
  evidenceDocumentId: z.string().uuid().optional(),
});
export type CorrectionRequestDto = z.infer<typeof CorrectionRequestDtoSchema>;

export const ReviewCorrectionDtoSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  reviewNote: z.string().optional(),
});
export type ReviewCorrectionDto = z.infer<typeof ReviewCorrectionDtoSchema>;

export const AttendanceConsentDtoSchema = z.object({
  noticeVersion: z.string().min(1),
});
export type AttendanceConsentDto = z.infer<typeof AttendanceConsentDtoSchema>;

export const AttendanceExportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});
export type AttendanceExportQuery = z.infer<typeof AttendanceExportQuerySchema>;

// ==================== Interfaces ====================

export interface JwtPayload {
  sub: string;           // userId
  orgId: string;         // organizationId
  email: string;
  role: UserRole;
  displayName?: string;
  teamId?: string | null;
  sid?: string;          // auth_sessions.id; absent on MFA enrollment tokens
  exp?: number;
}

/**
 * 'access': full API access token (aud hrvo-api).
 * 'mfa_enroll': short-lived token that can only call /auth/2fa/setup and /auth/2fa/verify
 * (aud hrvo-mfa-enroll), issued to mandatory-2FA roles that have not enrolled yet.
 */
export type TokenType = 'access' | 'mfa_enroll';

export interface AuthenticatedUser {
  id: string;
  orgId: string;
  email: string;
  role: UserRole;
  displayName?: string;
  teamId?: string | null;
  sessionId?: string;
  tokenType?: TokenType;
}

export interface AuthTokens {
  accessToken: string;
  sessionId: string;
  sessionSecret?: string; // HMAC secret issued at login for WebSocket heartbeat signing
  user: {
    id: string;
    orgId: string;
    email: string;
    role: string;
    displayName?: string;
  };
}

export interface MfaSetupResponse {
  secret: string;
  otpauthUrl: string;
}
