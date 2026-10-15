/**
 * Task management contracts shared by apps/api and apps/web.
 * Ref: docs/SRS.md 5.7 (FR-TASK-001..008, 011, 016) and 7.4 (projects, tasks).
 */
import { z } from 'zod';

export const TaskStatus = {
  TODO: 'TODO',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const TASK_STATUSES = Object.values(TaskStatus) as [TaskStatus, ...TaskStatus[]];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

/**
 * FR-TASK-002 default workflow. Every move is logged in task_activity.
 * DONE can be reopened to IN_PROGRESS.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  TODO: ['IN_PROGRESS', 'BLOCKED', 'DONE'],
  IN_PROGRESS: ['TODO', 'IN_REVIEW', 'BLOCKED', 'DONE'],
  IN_REVIEW: ['IN_PROGRESS', 'BLOCKED', 'DONE'],
  BLOCKED: ['TODO', 'IN_PROGRESS'],
  DONE: ['IN_PROGRESS'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
}

export const TaskPriority = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', URGENT: 'URGENT' } as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];
export const TASK_PRIORITIES = Object.values(TaskPriority) as [TaskPriority, ...TaskPriority[]];

/** FR-TASK-007: subcontractor acceptance. NOT_REQUIRED for self-assigned and non-subcontractor tasks. */
export const AcceptanceStatus = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
} as const;
export type AcceptanceStatus = (typeof AcceptanceStatus)[keyof typeof AcceptanceStatus];

export const ProjectStatus = { ACTIVE: 'ACTIVE', ON_HOLD: 'ON_HOLD', DONE: 'DONE', ARCHIVED: 'ARCHIVED' } as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

/** Activity types written to task_activity (FR-TASK-002, 006). */
export const TaskActivityType = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  ESCALATED: 'ESCALATED',
  COMMENTED: 'COMMENTED',
  CHECKLIST_CHANGED: 'CHECKLIST_CHANGED',
  ATTACHMENT_ADDED: 'ATTACHMENT_ADDED',
  ATTACHMENT_REMOVED: 'ATTACHMENT_REMOVED',
  DELETED: 'DELETED',
} as const;
export type TaskActivityType = (typeof TaskActivityType)[keyof typeof TaskActivityType];

// ==================== Request DTOs ====================

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const uuid = z.string().uuid();
const label = z.string().trim().min(1).max(40).regex(/^[^,]+$/, 'Labels cannot contain commas');

export const MAX_DESCRIPTION_LENGTH = 20_000;

export const CreateTaskDtoSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).default(''),
  projectId: uuid.nullable().optional(),
  parentTaskId: uuid.nullable().optional(),
  assigneeId: uuid.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
  dueDate: workDate.nullable().optional(),
  plannedDate: workDate.nullable().optional(),
  estimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  labels: z.array(label).max(20).default([]),
  checklist: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
});
export type CreateTaskDto = z.infer<typeof CreateTaskDtoSchema>;

/** Partial update with optimistic concurrency: `version` must match the stored version. */
export const UpdateTaskDtoSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    projectId: uuid.nullable().optional(),
    assigneeId: uuid.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    dueDate: workDate.nullable().optional(),
    plannedDate: workDate.nullable().optional(),
    estimateMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
    labels: z.array(label).max(20).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'Nothing to update' });
export type UpdateTaskDto = z.infer<typeof UpdateTaskDtoSchema>;

export const DeclineTaskDtoSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(1000) });
export type DeclineTaskDto = z.infer<typeof DeclineTaskDtoSchema>;

export const CommentDtoSchema = z.object({ body: z.string().trim().min(1).max(10_000) });
export type CommentDto = z.infer<typeof CommentDtoSchema>;

export const ChecklistItemDtoSchema = z.object({ text: z.string().trim().min(1).max(300) });
export const ChecklistUpdateDtoSchema = z
  .object({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional() })
  .refine((v) => v.text !== undefined || v.done !== undefined, { message: 'Nothing to update' });

/** Attachments are references until the Documents module provides storage (FR-DOC). */
export const AttachmentDtoSchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), { message: 'Only https:// links are allowed' }),
  mimeType: z.string().max(100).optional(),
  sizeBytes: z.number().int().min(0).max(10_000_000_000).optional(),
});
export type AttachmentDto = z.infer<typeof AttachmentDtoSchema>;

export const TaskListQuerySchema = z.object({
  scope: z.enum(['mine', 'reported', 'team', 'all']).default('mine'),
  status: z.enum(TASK_STATUSES).optional(),
  projectId: uuid.optional(),
  assigneeId: uuid.optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  label: z.string().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  dueFrom: workDate.optional(),
  dueTo: workDate.optional(),
  plannedFrom: workDate.optional(),
  plannedTo: workDate.optional(),
  includeDone: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const ProjectDtoSchema = z.object({
  name: z.string().trim().min(2).max(200),
  code: z.string().trim().min(2).max(30).regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use capital letters, digits, - or _'),
  clientName: z.string().trim().max(200).nullable().optional(),
  managerId: uuid.nullable().optional(),
  billable: z.boolean().default(false),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'DONE', 'ARCHIVED']).default('ACTIVE'),
  startDate: workDate.nullable().optional(),
  endDate: workDate.nullable().optional(),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;
export const ProjectUpdateDtoSchema = ProjectDtoSchema.partial();
export type ProjectUpdateDto = z.infer<typeof ProjectUpdateDtoSchema>;

export const ProjectMemberDtoSchema = z.object({ userId: uuid });

// ==================== Response (wire) schemas ====================

const isoDate = z.string().datetime({ offset: true });

export const UserRefSchema = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string(), role: z.string() });
export type UserRef = z.infer<typeof UserRefSchema>;

export const ChecklistItemSchema = z.object({ id: z.string(), text: z.string(), done: z.boolean(), sortOrder: z.number() });
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const TaskSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  projectId: z.string().nullable(),
  projectCode: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  assignee: UserRefSchema.nullable(),
  reporter: UserRefSchema,
  acceptanceStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'ACCEPTED', 'DECLINED']),
  dueDate: workDate.nullable(),
  plannedDate: workDate.nullable(),
  estimateMinutes: z.number().nullable(),
  actualMinutes: z.number().nullable(),
  labels: z.array(z.string()),
  checklistDone: z.number(),
  checklistTotal: z.number(),
  subtaskCount: z.number(),
  completedAt: isoDate.nullable(),
  updatedAt: isoDate,
  version: z.number(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export const TaskListSchema = z.array(TaskSummarySchema);

export const TaskPermissionsSchema = z.object({
  canEdit: z.boolean(),
  canChangeStatus: z.boolean(),
  canAssign: z.boolean(),
  canRespond: z.boolean(),
  canDelete: z.boolean(),
  canComment: z.boolean(),
});
export type TaskPermissions = z.infer<typeof TaskPermissionsSchema>;

export const TaskDetailSchema = TaskSummarySchema.extend({
  description: z.string(),
  declineReason: z.string().nullable(),
  acceptedAt: isoDate.nullable(),
  escalatedAt: isoDate.nullable(),
  createdAt: isoDate,
  checklist: z.array(ChecklistItemSchema),
  subtasks: z.array(TaskSummarySchema),
  attachments: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      mimeType: z.string().nullable(),
      sizeBytes: z.number().nullable(),
      addedBy: UserRefSchema,
      createdAt: isoDate,
    }),
  ),
  permissions: TaskPermissionsSchema,
  overrun: z.boolean(),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TaskCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: UserRefSchema,
  mentions: z.array(UserRefSchema),
  createdAt: isoDate,
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;
export const TaskCommentListSchema = z.array(TaskCommentSchema);

export const TaskActivitySchema = z.object({
  id: z.union([z.string(), z.number()]),
  type: z.string(),
  actor: UserRefSchema,
  data: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
});
export type TaskActivity = z.infer<typeof TaskActivitySchema>;
export const TaskActivityListSchema = z.array(TaskActivitySchema);

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  clientName: z.string().nullable(),
  manager: UserRefSchema.nullable(),
  billable: z.boolean(),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'DONE', 'ARCHIVED']),
  startDate: workDate.nullable(),
  endDate: workDate.nullable(),
  memberCount: z.number(),
  isMember: z.boolean(),
});
export type Project = z.infer<typeof ProjectSchema>;
export const ProjectListSchema = z.array(ProjectSchema);
export const ProjectMembersSchema = z.array(UserRefSchema);
export const UserRefListSchema = z.array(UserRefSchema);

// ==================== Mentions ====================

/** Mentions are written as @[Display Name](user:<uuid>) by the web composer. */
export const MENTION_PATTERN = /@\[([^\]\n]{1,100})\]\(user:([0-9a-f-]{36})\)/gi;

export function extractMentionIds(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_PATTERN)) ids.add(m[2]!.toLowerCase());
  return [...ids];
}
