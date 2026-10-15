/**
 * Administration (FR-ADM-001, 002, 004, 006) and consent records (FR-AUD-004). ADR 011.
 */
import { z } from 'zod';
import { Permission, UserRole } from '../auth/types.ts';

// ---------------------------------------------------------------- FR-ADM-001 policy

/** SRS 6.4 ranges. The database enforces the same limits. */
export const POLICY_LIMITS = {
  missedHeartbeatTimeoutSeconds: { min: 60, max: 180 },
  disconnectGraceWindowSeconds: { min: 30, max: 300 },
  idleThresholdSeconds: { min: 120, max: 1800 },
  pauseThresholdSeconds: { min: 300, max: 3600 },
  maxSessionLengthSeconds: { min: 8 * 3600, max: 18 * 3600 },
  paidBreakMinutesPerDay: { min: 0, max: 240 },
  manualLimitMinutes: { min: 0, max: 480 },
  variancePct: { min: 5, max: 50 },
  vaultReauthMinutes: { min: 1, max: 60 },
} as const;

const limited = (k: keyof typeof POLICY_LIMITS) => z.number().int().min(POLICY_LIMITS[k].min).max(POLICY_LIMITS[k].max);

export const OrgPolicySchema = z
  .object({
    missedHeartbeatTimeoutSeconds: limited('missedHeartbeatTimeoutSeconds'),
    disconnectGraceWindowSeconds: limited('disconnectGraceWindowSeconds'),
    idleThresholdSeconds: limited('idleThresholdSeconds'),
    pauseThresholdSeconds: limited('pauseThresholdSeconds'),
    maxSessionLengthSeconds: limited('maxSessionLengthSeconds'),
    paidBreakMinutesPerDay: limited('paidBreakMinutesPerDay'),
    manualLimitMinutes: limited('manualLimitMinutes'),
    variancePct: limited('variancePct'),
    vaultReauthMinutes: limited('vaultReauthMinutes'),
  })
  .strict()
  .refine((p) => p.pauseThresholdSeconds > p.idleThresholdSeconds, { message: 'The pause threshold must be longer than the idle threshold', path: ['pauseThresholdSeconds'] });
export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

// ---------------------------------------------------------------- FR-ADM-004 retention

export const RETENTION_LIMITS = {
  presenceDays: { min: 30, max: 730 },
  notificationsDays: { min: 30, max: 1825 },
} as const;

export const RetentionSettingsSchema = z
  .object({
    presenceDays: z.number().int().min(RETENTION_LIMITS.presenceDays.min).max(RETENTION_LIMITS.presenceDays.max),
    notificationsDays: z.number().int().min(RETENTION_LIMITS.notificationsDays.min).max(RETENTION_LIMITS.notificationsDays.max),
  })
  .strict();
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

export const RetentionOverviewSchema = z.object({
  presenceDays: z.number().int(),
  notificationsDays: z.number().int(),
  /** Document categories with a rule (FR-DOC-017); set on the documents retention page. */
  documentRules: z.number().int(),
  /** Data types that do not exist yet in this release. */
  notAvailable: z.array(z.string()),
});
export type RetentionOverview = z.infer<typeof RetentionOverviewSchema>;

// ---------------------------------------------------------------- FR-ADM-002 roles

export const ROLE_LABEL: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  HR_MANAGER: 'HR manager',
  HR: 'HR',
  MANAGER: 'Manager',
  TEAM_LEAD: 'Team lead',
  EMPLOYEE: 'Employee',
  SUBCONTRACTOR: 'Subcontractor',
  INTERN: 'Intern',
  AUDITOR: 'Auditor',
};

const permissionValues = Object.values(Permission) as [Permission, ...Permission[]];
/** A custom role cannot be based on SUPER_ADMIN (platform staff only). */
export const CUSTOM_ROLE_BASES = Object.values(UserRole).filter((r) => r !== UserRole.SUPER_ADMIN) as [UserRole, ...UserRole[]];

export const CustomRoleDtoSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).default(''),
    baseRole: z.enum(CUSTOM_ROLE_BASES),
    addedPermissions: z.array(z.enum(permissionValues)).max(64).default([]),
    removedPermissions: z.array(z.enum(permissionValues)).max(64).default([]),
    /** Optimistic concurrency on update. */
    version: z.number().int().positive().optional(),
  })
  .strict();
export type CustomRoleDto = z.input<typeof CustomRoleDtoSchema>;

const roleValues = Object.values(UserRole) as [UserRole, ...UserRole[]];
const permissionList = z.array(z.enum(permissionValues));

export const CustomRoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  baseRole: z.enum(roleValues),
  addedPermissions: permissionList,
  removedPermissions: permissionList,
  permissions: permissionList,
  userCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type CustomRole = z.infer<typeof CustomRoleSchema>;

export const RolesOverviewSchema = z.object({
  builtIn: z.array(z.object({ role: z.enum(roleValues), permissions: permissionList })),
  custom: z.array(CustomRoleSchema),
  /** What the signed-in admin may grant (their own permissions). */
  grantable: permissionList,
});
export type RolesOverview = z.infer<typeof RolesOverviewSchema>;

export const AssignRoleDtoSchema = z
  .object({
    role: z.enum(roleValues),
    customRoleId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type AssignRoleDto = z.input<typeof AssignRoleDtoSchema>;

export const AdminUserRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(roleValues),
  status: z.string(),
  customRoleId: z.string().nullable(),
  customRoleName: z.string().nullable(),
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;
export const AdminUserListSchema = z.array(AdminUserRowSchema);

export const MyAccessSchema = z.object({
  role: z.enum(roleValues),
  customRoleName: z.string().nullable(),
  permissions: permissionList,
});
export type MyAccess = z.infer<typeof MyAccessSchema>;

// ---------------------------------------------------------------- FR-ADM-006 audit viewer

export const AuditQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().trim().max(80).regex(/^[A-Z0-9_]*$/i).optional(),
  entityType: z.string().trim().max(80).regex(/^[A-Z0-9_]*$/i).optional(),
  entityId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  actor_id: z.string(),
  actor_name: z.string().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  ip: z.string().nullable(),
  created_at: z.string(),
  hash: z.string(),
});
export type AuditRow = z.infer<typeof AuditRowSchema>;
export const AuditListSchema = z.array(AuditRowSchema);

export const AuditFacetsSchema = z.object({ actions: z.array(z.string()), entityTypes: z.array(z.string()) });
export type AuditFacets = z.infer<typeof AuditFacetsSchema>;

export const AuditVerificationSchema = z.object({
  valid: z.boolean(),
  checked: z.number().int(),
  /** The first entry whose hash or link does not match, when invalid. */
  brokenAtId: z.string().nullable(),
});
export type AuditVerification = z.infer<typeof AuditVerificationSchema>;

// ---------------------------------------------------------------- FR-AUD-004 consents

export const CONSENT_TYPES = ['MONITORING', 'RECORDING', 'AI'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/** Current notice version per consent type. The monitoring notice is FR-ATT-020's. */
export const CONSENT_NOTICES: Record<ConsentType, { version: string; title: string; summary: string }> = {
  MONITORING: { version: 'v1.0.0', title: 'Attendance monitoring', summary: 'Presence signals (activity, tab visibility, calls) decide attendance states. No screenshots, keystrokes or content.' },
  RECORDING: { version: 'v1.0.0', title: 'Meeting recording', summary: 'Meetings you join may be recorded when every participant is told. Recordings are kept per the retention settings.' },
  AI: { version: 'v1.0.0', title: 'AI features', summary: 'Summaries and suggestions may process task and meeting text. Nothing is used to train models.' },
};

/** Recording and AI consents can be given and withdrawn here; monitoring is accepted in the attendance notice. */
export const ConsentDtoSchema = z
  .object({
    type: z.enum(['RECORDING', 'AI']),
    granted: z.boolean(),
    noticeVersion: z.string().trim().max(20),
  })
  .strict();
export type ConsentDto = z.infer<typeof ConsentDtoSchema>;

export const ConsentRecordSchema = z.object({
  id: z.string(),
  type: z.enum(CONSENT_TYPES),
  granted: z.boolean(),
  noticeVersion: z.string(),
  at: z.string(),
});
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

export const ConsentOverviewSchema = z.object({
  type: z.enum(CONSENT_TYPES),
  currentVersion: z.string(),
  /** Latest decision for the current notice version; null = never asked or an older version. */
  granted: z.boolean().nullable(),
  history: z.array(ConsentRecordSchema),
});
export type ConsentOverview = z.infer<typeof ConsentOverviewSchema>;
export const ConsentListSchema = z.array(ConsentOverviewSchema);
