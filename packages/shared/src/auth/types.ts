/**
 * HRVO Authentication & RBAC Shared Types and Zod Schemas
 * Ref: docs/SRS.md Section 5.1 (FR-AUTH-001..011) and Section 3.4
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
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: [
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
  ],
  ADMIN: [
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
  ],
  HR_MANAGER: [
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
  ],
  HR: [
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
  ],
  MANAGER: [
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
  ],
  TEAM_LEAD: [
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_TEAM,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.ATTENDANCE_CORRECTIONS_REVIEW,
  ],
  EMPLOYEE: [
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
  ],
  SUBCONTRACTOR: [
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
  ],
  INTERN: [
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
  ],
  AUDITOR: [
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
  ],
};

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role as UserRole];
  if (!perms) return false;
  return perms.includes(permission);
}

// ==================== Zod Validation Schemas ====================

export const LoginDtoSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
  totpCode: z.string().length(6, 'TOTP code must be 6 digits').optional(),
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

export const Verify2faDtoSchema = z.object({
  code: z.string().length(6, '2FA code must be 6 digits'),
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
}

export interface AuthenticatedUser {
  id: string;
  orgId: string;
  email: string;
  role: UserRole;
  displayName?: string;
  teamId?: string | null;
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
