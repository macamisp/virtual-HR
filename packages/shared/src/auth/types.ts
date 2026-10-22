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
  /** FR-ADM-002: create custom roles and assign them. */
  ROLES_MANAGE: 'roles.manage',
  /** FR-REP-001..008: reports beyond one's own data (scope still follows role and team). */
  REPORTS_TEAM: 'reports.team',
  REPORTS_ALL: 'reports.all',
  /** FR-AUD-002/003: data-subject export and anonymisation. */
  PRIVACY_MANAGE: 'privacy.manage',
  OFFICE_USE: 'office.use',
  MEETINGS_USE: 'meetings.use',
  CHAT_USE: 'chat.use',
  CHAT_PUBLIC_CHANNELS: 'chat.channels.public',
  CHAT_MODERATE: 'chat.moderate',
  BROADCAST: 'office.broadcast',
  /** FR-ATT-011 (ADR 018): pair and manage your own desktop agents. */
  AGENT_USE: 'attendance.agent',
  /** FR-ORG-010 (ADR 027): request leave; decide the team's or everyone's requests. */
  LEAVE_USE: 'leave.use',
  LEAVE_APPROVE_TEAM: 'leave.approve.team',
  LEAVE_APPROVE_ALL: 'leave.approve.all',
  /** FR-ORG-011: the public holiday calendar. */
  HOLIDAYS_MANAGE: 'holidays.manage',
  /** FR-ORG-005: edit work schedules (organisation default, team, person). */
  SCHEDULES_MANAGE: 'schedules.manage',
  /** FR-ORG-002: read subcontractor profiles (identity, contact, emergency contact; tax and bank masked). */
  SUBCONTRACTORS_READ: 'subcontractors.read',
  /** FR-ORG-002: edit subcontractor profiles. */
  SUBCONTRACTORS_MANAGE: 'subcontractors.manage',
  /** FR-ORG-002: reveal anyone's tax ID and bank details in clear (audited). */
  SUBCONTRACTORS_SENSITIVE_READ: 'subcontractors.sensitive.read',
  /**
   * ADR 037: held only by workspace owners (users.is_owner), never through a role: ownership
   * transfer, sign-in settings (Google auto-join, 2FA after SSO) and billing.
   */
  ORG_OWNER: 'org.owner',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.CHAT_MODERATE,
    Permission.BROADCAST,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.LEAVE_APPROVE_ALL,
    Permission.HOLIDAYS_MANAGE,
    Permission.SCHEDULES_MANAGE,
    Permission.SUBCONTRACTORS_READ,
    Permission.SUBCONTRACTORS_MANAGE,
    Permission.SUBCONTRACTORS_SENSITIVE_READ,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
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
    Permission.ROLES_MANAGE,
    Permission.REPORTS_TEAM,
    Permission.REPORTS_ALL,
    Permission.PRIVACY_MANAGE,
  ],
  ADMIN: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.CHAT_MODERATE,
    Permission.BROADCAST,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.LEAVE_APPROVE_ALL,
    Permission.HOLIDAYS_MANAGE,
    Permission.SCHEDULES_MANAGE,
    Permission.SUBCONTRACTORS_READ,
    Permission.SUBCONTRACTORS_MANAGE,
    Permission.SUBCONTRACTORS_SENSITIVE_READ,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
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
    Permission.ROLES_MANAGE,
    Permission.REPORTS_TEAM,
    Permission.REPORTS_ALL,
    Permission.PRIVACY_MANAGE,
  ],
  HR_MANAGER: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.CHAT_MODERATE,
    Permission.BROADCAST,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.LEAVE_APPROVE_ALL,
    Permission.HOLIDAYS_MANAGE,
    Permission.SCHEDULES_MANAGE,
    Permission.SUBCONTRACTORS_READ,
    Permission.SUBCONTRACTORS_MANAGE,
    Permission.SUBCONTRACTORS_SENSITIVE_READ,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
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
    Permission.REPORTS_TEAM,
    Permission.REPORTS_ALL,
    Permission.PRIVACY_MANAGE,
  ],
  HR: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.CHAT_MODERATE,
    Permission.BROADCAST,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.LEAVE_APPROVE_ALL,
    Permission.HOLIDAYS_MANAGE,
    Permission.SCHEDULES_MANAGE,
    Permission.SUBCONTRACTORS_READ,
    Permission.SUBCONTRACTORS_MANAGE,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
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
    Permission.REPORTS_TEAM,
    Permission.REPORTS_ALL,
  ],
  MANAGER: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.BROADCAST,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.LEAVE_APPROVE_TEAM,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
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
    Permission.REPORTS_TEAM,
  ],
  TEAM_LEAD: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.LEAVE_APPROVE_TEAM,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
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
    Permission.REPORTS_TEAM,
  ],
  EMPLOYEE: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.TIMESHEETS_USE,
    Permission.DOCUMENTS_USE,
  ],
  SUBCONTRACTOR: [
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.TIMESHEETS_USE,
    Permission.DOCUMENTS_USE,
  ],
  INTERN: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.LEAVE_USE,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
    Permission.TASKS_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_CORRECTIONS_CREATE,
    Permission.TIMESHEETS_USE,
    Permission.DOCUMENTS_USE,
  ],
  AUDITOR: [
    Permission.CHAT_PUBLIC_CHANNELS,
    Permission.NOTIFICATIONS_READ_OWN,
    Permission.OFFICE_USE,
    Permission.AGENT_USE,
    Permission.MEETINGS_USE,
    Permission.CHAT_USE,
    Permission.ATTENDANCE_READ_OWN,
    Permission.ATTENDANCE_READ_ALL,
    Permission.ATTENDANCE_EXPORT,
    Permission.AUDIT_READ,
    Permission.TIMESHEETS_READ_ALL,
    Permission.DOCUMENTS_USE,
    Permission.REPORTS_TEAM,
    Permission.REPORTS_ALL,
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

/**
 * FR-ADM-002: permissions that need 2FA (FR-AUTH-004) whoever holds them. A custom role may
 * only add them to a base role that already requires 2FA.
 */
export const MFA_SENSITIVE_PERMISSIONS: readonly Permission[] = [
  Permission.ORG_MANAGE,
  Permission.USERS_MANAGE,
  Permission.ROLES_MANAGE,
  Permission.PRIVACY_MANAGE,
  Permission.VAULT_RECOVER,
  Permission.SUBCONTRACTORS_SENSITIVE_READ,
];

export function requiresMfa(role: string, permissions: readonly string[] = []): boolean {
  return isMfaRequiredRole(role) || MFA_SENSITIVE_PERMISSIONS.some((p) => permissions.includes(p));
}

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role as UserRole];
  if (!perms) return false;
  return perms.includes(permission);
}

/**
 * FR-ADM-002: what a user may do. `permissions` is filled by the API's permission resolver
 * (built-in base role + a custom role's additions and removals); without it, the base role's
 * defaults apply. Use this for the signed-in user; hasPermission(role) for other people.
 */
export function userCan(user: { role: string; permissions?: readonly string[] }, permission: Permission): boolean {
  return user.permissions ? user.permissions.includes(permission) : hasPermission(user.role, permission);
}

/** Effective permissions of a custom role. */
export function effectivePermissions(baseRole: string, added: readonly string[] = [], removed: readonly string[] = []): Permission[] {
  const base = ROLE_PERMISSIONS[baseRole as UserRole] ?? [];
  const all = new Set<string>([...base, ...added]);
  for (const r of removed) all.delete(r);
  return [...all].filter((p): p is Permission => (Object.values(Permission) as string[]).includes(p));
}

/**
 * Labels, plain-language descriptions and groups for the roles & permissions screens
 * (FR-ADM-002, FR-AUTH-006). The description says what a person with the permission can do.
 */
export interface PermissionInfo { permission: Permission; label: string; description: string }
export const PERMISSION_GROUPS: ReadonlyArray<{ group: string; items: ReadonlyArray<PermissionInfo> }> = [
  { group: 'Attendance and leave', items: [
    { permission: Permission.ATTENDANCE_READ_OWN, label: 'See own attendance', description: 'See their own clock-in and clock-out times, breaks and daily totals.' },
    { permission: Permission.ATTENDANCE_READ_TEAM, label: 'See team attendance and live board', description: 'See attendance and the live presence board for the people in their team.' },
    { permission: Permission.ATTENDANCE_READ_ALL, label: 'See everyone\'s attendance', description: 'See attendance and the live board for everyone in the workspace.' },
    { permission: Permission.AGENT_USE, label: 'Pair and manage own desktop agents', description: 'Pair the desktop agent on their own computers and remove it again.' },
    { permission: Permission.ATTENDANCE_CORRECTIONS_CREATE, label: 'Request corrections', description: 'Ask for a wrong clock-in or clock-out to be corrected.' },
    { permission: Permission.ATTENDANCE_CORRECTIONS_REVIEW, label: 'Review corrections', description: 'Approve or reject correction requests from the people they manage.' },
    { permission: Permission.ATTENDANCE_EXPORT, label: 'Export attendance', description: 'Download attendance as CSV or Excel files (audited).' },
    { permission: Permission.LEAVE_USE, label: 'Request leave', description: 'Request annual, sick, unpaid or other leave and cancel it before it starts.' },
    { permission: Permission.LEAVE_APPROVE_TEAM, label: 'Decide the team\'s leave requests', description: 'Approve or reject leave for the people in their team.' },
    { permission: Permission.LEAVE_APPROVE_ALL, label: 'Decide everyone\'s leave requests', description: 'Approve or reject leave for anyone in the workspace.' },
    { permission: Permission.HOLIDAYS_MANAGE, label: 'Manage the public holiday calendar', description: 'Add and remove public holidays, which count as non-working days.' },
    { permission: Permission.SCHEDULES_MANAGE, label: 'Manage work schedules', description: 'Set working days, hours and grace minutes for the workspace, teams and people.' },
    { permission: Permission.SUBCONTRACTORS_READ, label: 'Read subcontractor profiles', description: 'See subcontractor identity and contact details; tax and bank details stay masked.' },
    { permission: Permission.SUBCONTRACTORS_MANAGE, label: 'Edit subcontractor profiles', description: 'Edit subcontractor profiles, rates and contracts.' },
    { permission: Permission.SUBCONTRACTORS_SENSITIVE_READ, label: 'Reveal subcontractor tax ID and bank details', description: 'Show tax IDs and bank details in clear. Every reveal is audited and needs 2FA.' },
  ] },
  { group: 'Tasks and projects', items: [
    { permission: Permission.TASKS_USE, label: 'Use tasks', description: 'See and update their own tasks and daily plan.' },
    { permission: Permission.TASKS_ASSIGN, label: 'Assign tasks to others', description: 'Create tasks for other people and reassign them.' },
    { permission: Permission.TASKS_READ_TEAM, label: 'See team tasks', description: 'See every task of the people in their team.' },
    { permission: Permission.TASKS_READ_ALL, label: 'See all tasks', description: 'See every task in the workspace.' },
    { permission: Permission.PROJECTS_MANAGE, label: 'Manage projects', description: 'Create projects, add members and set project rates and hour caps.' },
  ] },
  { group: 'Timesheets', items: [
    { permission: Permission.TIMESHEETS_USE, label: 'Keep a timesheet', description: 'Run the timer, log manual time and submit their own timesheets.' },
    { permission: Permission.TIMESHEETS_APPROVE_TEAM, label: 'Approve team timesheets', description: 'Approve or reject timesheets of the people in their team or projects.' },
    { permission: Permission.TIMESHEETS_APPROVE_ALL, label: 'Approve all timesheets', description: 'Approve or reject any timesheet in the workspace.' },
    { permission: Permission.TIMESHEETS_READ_ALL, label: 'Read all timesheets and rates', description: 'Read every timesheet, rate and timesheet report, without changing them.' },
    { permission: Permission.TIMESHEET_REOPEN, label: 'Reopen approved timesheets', description: 'Send an approved timesheet back for changes.' },
    { permission: Permission.RATES_MANAGE, label: 'Manage rates', description: 'Set hourly, daily and fixed rates and overtime multipliers.' },
  ] },
  { group: 'Documents', items: [
    { permission: Permission.DOCUMENTS_USE, label: 'Use documents', description: 'Upload and open their own documents and the ones shared with them.' },
    { permission: Permission.DOCUMENTS_READ_ALL, label: 'Manage all documents', description: 'Open and manage every document, folder and sharing grant, including confidential HR files.' },
    { permission: Permission.CONTRACTS_MANAGE, label: 'Manage contracts', description: 'Record contracts, link their documents and receive expiry alerts.' },
    { permission: Permission.VAULT_RECOVER, label: 'Recover document passwords', description: 'Reset a lost document password through the key service (audited, needs 2FA).' },
    { permission: Permission.DOCUMENTS_LEGAL_HOLD, label: 'Place legal holds', description: 'Stop documents from being deleted or changed during a legal matter.' },
    { permission: Permission.DOCUMENTS_RETENTION, label: 'Set document retention', description: 'Decide how long each document category is kept.' },
  ] },
  { group: 'Office, meetings and chat', items: [
    { permission: Permission.OFFICE_USE, label: 'Use the virtual office', description: 'Enter the virtual office, move between rooms and start calls.' },
    { permission: Permission.MEETINGS_USE, label: 'Join and schedule meetings', description: 'Schedule meetings, join them and use the meeting chat.' },
    { permission: Permission.BROADCAST, label: 'Broadcast announcements to the office', description: 'Send an announcement that everyone in the office sees.' },
    { permission: Permission.CHAT_USE, label: 'Chat: direct messages and joined channels', description: 'Send direct messages and post in channels they belong to.' },
    { permission: Permission.CHAT_PUBLIC_CHANNELS, label: 'Chat: see and join public channels', description: 'Browse and join the workspace\'s public channels.' },
    { permission: Permission.CHAT_MODERATE, label: 'Chat: archive channels, remove messages', description: 'Archive channels and remove other people\'s messages.' },
  ] },
  { group: 'Reports and privacy', items: [
    { permission: Permission.REPORTS_TEAM, label: 'Team reports and dashboard', description: 'See reports and the dashboard for the people in their team.' },
    { permission: Permission.REPORTS_ALL, label: 'Organisation-wide reports', description: 'See reports for the whole workspace.' },
    { permission: Permission.AUDIT_READ, label: 'Read the audit log', description: 'Read and export the tamper-evident audit log.' },
    { permission: Permission.PRIVACY_MANAGE, label: 'Data-subject export and anonymisation', description: 'Export a person\'s data and anonymise it when they leave.' },
    { permission: Permission.NOTIFICATIONS_READ_OWN, label: 'Notifications', description: 'Receive in-app and e-mail notifications and set quiet hours.' },
  ] },
  { group: 'Administration', items: [
    { permission: Permission.USERS_MANAGE, label: 'Manage users', description: 'Change roles, teams and managers, suspend and offboard people, revoke their sessions.' },
    { permission: Permission.USERS_INVITE, label: 'Invite users', description: 'Invite people by e-mail, resend and revoke invitations.' },
    { permission: Permission.ROLES_MANAGE, label: 'Roles and permissions', description: 'Create custom roles and assign roles to people, within their own permissions.' },
    { permission: Permission.ORG_MANAGE, label: 'Organisation policy and settings', description: 'Change the workspace profile, attendance policy, retention and recording settings.' },
    { permission: Permission.ORG_OWNER, label: 'Workspace ownership', description: 'Transfer ownership, change sign-in settings (Google, 2FA after SSO) and billing. Held by owners only; it cannot be given through a role.' },
  ] },
];

/** The description of one permission, for screens that list permissions outside their group. */
export function permissionInfo(permission: Permission): PermissionInfo {
  for (const g of PERMISSION_GROUPS) for (const i of g.items) if (i.permission === permission) return i;
  return { permission, label: permission, description: '' };
}

/**
 * The parts of the app a set of permissions opens, mirroring the navigation gates in
 * apps/web/src/components/app-shell.tsx, for the "effective access" preview (FR-AUTH-006).
 */
export const ACCESS_AREAS: ReadonlyArray<{ key: string; label: string; anyOf: ReadonlyArray<Permission> }> = [
  { key: 'attendance', label: 'My attendance', anyOf: [Permission.ATTENDANCE_READ_OWN] },
  { key: 'live', label: 'Live board (team or everyone)', anyOf: [Permission.ATTENDANCE_READ_TEAM, Permission.ATTENDANCE_READ_ALL] },
  { key: 'corrections', label: 'Correction review', anyOf: [Permission.ATTENDANCE_CORRECTIONS_REVIEW] },
  { key: 'leave-review', label: 'Leave requests to decide', anyOf: [Permission.LEAVE_APPROVE_TEAM, Permission.LEAVE_APPROVE_ALL] },
  { key: 'office', label: 'Virtual office', anyOf: [Permission.OFFICE_USE] },
  { key: 'meetings', label: 'Meetings', anyOf: [Permission.MEETINGS_USE] },
  { key: 'chat', label: 'Chat', anyOf: [Permission.CHAT_USE] },
  { key: 'tasks', label: 'Tasks', anyOf: [Permission.TASKS_USE] },
  { key: 'projects', label: 'Projects', anyOf: [Permission.PROJECTS_MANAGE, Permission.TASKS_READ_ALL] },
  { key: 'timesheets', label: 'Timesheets', anyOf: [Permission.TIMESHEETS_USE] },
  { key: 'timesheet-approvals', label: 'Timesheet approvals', anyOf: [Permission.TIMESHEETS_APPROVE_TEAM, Permission.TIMESHEETS_APPROVE_ALL] },
  { key: 'documents', label: 'Documents', anyOf: [Permission.DOCUMENTS_USE] },
  { key: 'documents-all', label: 'All documents, including confidential HR files', anyOf: [Permission.DOCUMENTS_READ_ALL] },
  { key: 'reports', label: 'Reports', anyOf: [Permission.REPORTS_TEAM, Permission.REPORTS_ALL] },
  { key: 'admin-people', label: 'Administration: users, teams and invitations', anyOf: [Permission.USERS_MANAGE, Permission.USERS_INVITE] },
  { key: 'admin-roles', label: 'Administration: roles and permissions', anyOf: [Permission.ROLES_MANAGE] },
  { key: 'admin-settings', label: 'Administration: policy, retention, schedules', anyOf: [Permission.ORG_MANAGE, Permission.SCHEDULES_MANAGE] },
  { key: 'admin-audit', label: 'Administration: audit log', anyOf: [Permission.AUDIT_READ] },
  { key: 'admin-privacy', label: 'Administration: privacy requests', anyOf: [Permission.PRIVACY_MANAGE] },
  { key: 'owner', label: 'Workspace ownership and sign-in settings', anyOf: [Permission.ORG_OWNER] },
];

export function visibleAreas(permissions: readonly string[]): Array<{ key: string; label: string; visible: boolean }> {
  return ACCESS_AREAS.map((a) => ({ key: a.key, label: a.label, visible: a.anyOf.some((p) => permissions.includes(p)) }));
}

// ==================== Zod Validation Schemas ====================

export const LoginDtoSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
  /** Which workspace, when the address belongs to several (ADR 037). */
  workspace: z.string().trim().toLowerCase().max(80).optional(),
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
  /** Filled by the permission resolver (FR-ADM-002); absent means the role's defaults. */
  permissions?: Permission[];
  customRoleId?: string | null;
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
