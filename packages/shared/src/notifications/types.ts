/**
 * In-app notifications (FR-NOTIF-001) for task events and reminders (FR-TASK-011, 016).
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
