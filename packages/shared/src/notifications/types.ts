/**
 * In-app notifications (FR-NOTIF-001) for task events and reminders (FR-TASK-011, 016) and
 * timesheet approvals, reminders and variance alerts (FR-TS-005, 012).
 */
import { z } from 'zod';

export const NotificationType = {
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_ACCEPTANCE_REQUESTED: 'TASK_ACCEPTANCE_REQUESTED',
  TASK_ACCEPTED: 'TASK_ACCEPTED',
  TASK_DECLINED: 'TASK_DECLINED',
  TASK_MENTIONED: 'TASK_MENTIONED',
  TASK_STATUS: 'TASK_STATUS',
  TASK_DUE_SOON_24H: 'TASK_DUE_SOON_24H',
  TASK_DUE_SOON_1H: 'TASK_DUE_SOON_1H',
  TASK_OVERDUE: 'TASK_OVERDUE',
  TASK_ESCALATED: 'TASK_ESCALATED',
  WEEKLY_SUMMARY: 'WEEKLY_SUMMARY',
  // FR-TS-005 / FR-TS-012
  TIMESHEET_SUBMITTED: 'TIMESHEET_SUBMITTED',
  TIMESHEET_APPROVED: 'TIMESHEET_APPROVED',
  TIMESHEET_REJECTED: 'TIMESHEET_REJECTED',
  TIMESHEET_REOPENED: 'TIMESHEET_REOPENED',
  TIMESHEET_SUBMIT_REMINDER: 'TIMESHEET_SUBMIT_REMINDER',
  TIMESHEET_OVERDUE: 'TIMESHEET_OVERDUE',
  TIMESHEET_APPROVAL_REMINDER: 'TIMESHEET_APPROVAL_REMINDER',
  TIMESHEET_VARIANCE: 'TIMESHEET_VARIANCE',
  // FR-DOC-013 / FR-DOC-015
  DOCUMENT_INFECTED: 'DOCUMENT_INFECTED',
  DOCUMENT_REJECTED: 'DOCUMENT_REJECTED',
  DOCUMENT_EXPIRING: 'DOCUMENT_EXPIRING',
  // AC-16 / FR-ORG: contract end date approaching
  CONTRACT_EXPIRING: 'CONTRACT_EXPIRING',
  // FR-DOC-006 / FR-DOC-010
  DOCUMENT_PASSWORD_LOCKOUT: 'DOCUMENT_PASSWORD_LOCKOUT',
  DOCUMENT_PASSWORD_RECOVERED: 'DOCUMENT_PASSWORD_RECOVERED',
  SHARE_LINK_LOCKED: 'SHARE_LINK_LOCKED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  readAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListSchema = z.object({
  items: z.array(NotificationSchema),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const NotificationListQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

// ---------------------------------------------------------------- FR-NOTIF-002 / 004 preferences

export type NotificationGroup = 'Tasks' | 'Timesheets' | 'Documents' | 'Security';

/**
 * Labels, groups and criticality. Critical types (security and data-safety events) are always
 * delivered on both channels and ignore quiet hours; they cannot be unsubscribed (FR-NOTIF-002).
 */
export const NOTIFICATION_TYPE_META: Record<NotificationType, { label: string; group: NotificationGroup; critical?: boolean }> = {
  TASK_ASSIGNED: { label: 'Task assigned to me', group: 'Tasks' },
  TASK_ACCEPTANCE_REQUESTED: { label: 'Task waiting for my acceptance', group: 'Tasks' },
  TASK_ACCEPTED: { label: 'My task was accepted', group: 'Tasks' },
  TASK_DECLINED: { label: 'My task was declined', group: 'Tasks' },
  TASK_MENTIONED: { label: 'Mentioned in a comment', group: 'Tasks' },
  TASK_STATUS: { label: 'Task status changed', group: 'Tasks' },
  TASK_DUE_SOON_24H: { label: 'Task due tomorrow', group: 'Tasks' },
  TASK_DUE_SOON_1H: { label: 'Task due within the hour', group: 'Tasks' },
  TASK_OVERDUE: { label: 'Task overdue', group: 'Tasks' },
  TASK_ESCALATED: { label: 'Unaccepted task escalated to me', group: 'Tasks' },
  WEEKLY_SUMMARY: { label: 'Weekly summary', group: 'Tasks' },
  TIMESHEET_SUBMITTED: { label: 'Timesheet submitted for my approval', group: 'Timesheets' },
  TIMESHEET_APPROVED: { label: 'My timesheet was approved', group: 'Timesheets' },
  TIMESHEET_REJECTED: { label: 'My timesheet was rejected', group: 'Timesheets' },
  TIMESHEET_REOPENED: { label: 'My timesheet was reopened', group: 'Timesheets' },
  TIMESHEET_SUBMIT_REMINDER: { label: 'Reminder to submit my timesheet', group: 'Timesheets' },
  TIMESHEET_OVERDUE: { label: 'My timesheet is overdue', group: 'Timesheets' },
  TIMESHEET_APPROVAL_REMINDER: { label: 'Reminder to approve timesheets', group: 'Timesheets' },
  TIMESHEET_VARIANCE: { label: 'Timesheet differs from attendance', group: 'Timesheets' },
  DOCUMENT_REJECTED: { label: 'My upload was rejected', group: 'Documents' },
  DOCUMENT_EXPIRING: { label: 'A document is expiring', group: 'Documents' },
  CONTRACT_EXPIRING: { label: 'A contract is ending soon', group: 'Documents' },
  DOCUMENT_INFECTED: { label: 'Malware found in an upload', group: 'Security', critical: true },
  DOCUMENT_PASSWORD_LOCKOUT: { label: 'Document password lockout', group: 'Security', critical: true },
  DOCUMENT_PASSWORD_RECOVERED: { label: 'Document password recovered by HR', group: 'Security', critical: true },
  SHARE_LINK_LOCKED: { label: 'Share link locked after wrong passwords', group: 'Security', critical: true },
};

export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPE_META) as [NotificationType, ...NotificationType[]];
export const CRITICAL_NOTIFICATION_TYPES: readonly NotificationType[] = NOTIFICATION_TYPES.filter((t) => NOTIFICATION_TYPE_META[t].critical);
export const isCriticalNotification = (type: string): boolean => (CRITICAL_NOTIFICATION_TYPES as readonly string[]).includes(type);

/** "HH:mm" in the user's own timezone. */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

export const QuietHoursSchema = z.object({ start: clock, end: clock }).refine((q) => q.start !== q.end, { message: 'Start and end must differ' });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const NotificationPreferenceItemSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  label: z.string(),
  group: z.enum(['Tasks', 'Timesheets', 'Documents', 'Security']),
  critical: z.boolean(),
  inApp: z.boolean(),
  email: z.boolean(),
});
export type NotificationPreferenceItem = z.infer<typeof NotificationPreferenceItemSchema>;

export const NotificationPreferencesSchema = z.object({
  /** null = the organisation's timezone applies. */
  timezone: z.string().nullable(),
  orgTimezone: z.string(),
  quietHours: QuietHoursSchema.nullable(),
  items: z.array(NotificationPreferenceItemSchema),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const NotificationPreferencesDtoSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64).nullable(),
    quietHours: QuietHoursSchema.nullable(),
    items: z.array(z.object({ type: z.enum(NOTIFICATION_TYPES), inApp: z.boolean(), email: z.boolean() }).strict()).max(64),
  })
  .strict();
export type NotificationPreferencesDto = z.infer<typeof NotificationPreferencesDtoSchema>;

export const UnsubscribeDtoSchema = z.object({ token: z.string().trim().min(20).max(400) }).strict();
export type UnsubscribeDto = z.infer<typeof UnsubscribeDtoSchema>;

export const UnsubscribeResultSchema = z.object({ type: z.enum(NOTIFICATION_TYPES), label: z.string() });
export type UnsubscribeResult = z.infer<typeof UnsubscribeResultSchema>;
