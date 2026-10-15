/**
 * Planning contracts (FR-TASK-003 Today / daily plan / EOD report, FR-TASK-004 weekly planner,
 * FR-TASK-005 calendar, team workload and saved views).
 */
import { z } from 'zod';
import { TaskSummarySchema, UserRefSchema } from './types.ts';

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });

export const TODAY_REASONS = ['IN_PLAN', 'PLANNED', 'DUE_TODAY', 'OVERDUE', 'CARRIED_OVER'] as const;
export const PLAN_ITEM_STATUSES = ['PLANNED', 'DONE', 'CARRIED_OVER'] as const;

// ---- requests

export const ConfirmPlanDtoSchema = z.object({
  goals: z.string().max(2000).default(''),
  taskIds: z.array(z.string().uuid()).max(50),
});
export type ConfirmPlanDto = z.infer<typeof ConfirmPlanDtoSchema>;

export const EodReportDtoSchema = z.object({
  summary: z.string().trim().min(1, 'Say what you got done').max(4000),
  blockers: z.string().max(4000).default(''),
  tomorrow: z.string().max(4000).default(''),
});
export type EodReportDto = z.infer<typeof EodReportDtoSchema>;

export const WeeklyGoalSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(300),
  done: z.boolean(),
});
export type WeeklyGoal = z.infer<typeof WeeklyGoalSchema>;

export const WeeklyPlanDtoSchema = z.object({
  goals: z.array(WeeklyGoalSchema).max(20),
  capacityMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
});
export type WeeklyPlanDto = z.infer<typeof WeeklyPlanDtoSchema>;

/** Saved task views (FR-TASK-005): a named set of list filters. */
export const SavedViewDtoSchema = z.object({
  name: z.string().trim().min(1).max(60),
  filters: z.object({
    scope: z.enum(['mine', 'reported', 'team', 'all']),
    status: z.string().max(20).optional(),
    projectId: z.string().uuid().optional(),
    priority: z.string().max(10).optional(),
    q: z.string().max(100).optional(),
    includeDone: z.boolean().optional(),
  }),
});
export type SavedViewDto = z.infer<typeof SavedViewDtoSchema>;

// ---- responses

export const DailyPlanSchema = z.object({
  planDate: workDate,
  goals: z.string(),
  confirmedAt: isoDate.nullable(),
  eodSummary: z.string().nullable(),
  blockers: z.string().nullable(),
  tomorrowPlan: z.string().nullable(),
  submittedAt: isoDate.nullable(),
});
export type DailyPlan = z.infer<typeof DailyPlanSchema>;

export const TodayItemSchema = z.object({
  task: TaskSummarySchema,
  reasons: z.array(z.enum(TODAY_REASONS)),
  planStatus: z.enum(PLAN_ITEM_STATUSES).nullable(),
});
export type TodayItem = z.infer<typeof TodayItemSchema>;

export const TodaySchema = z.object({
  date: workDate,
  plan: DailyPlanSchema.nullable(),
  items: z.array(TodayItemSchema),
  doneToday: z.array(TaskSummarySchema),
  nextWorkDay: workDate,
});
export type Today = z.infer<typeof TodaySchema>;

export const WeekDaySchema = z.object({ date: workDate, tasks: z.array(TaskSummarySchema), scheduledMinutes: z.number() });
export const WeekSchema = z.object({
  weekStart: workDate,
  days: z.array(WeekDaySchema).length(7),
  backlog: z.array(TaskSummarySchema),
  carriedOver: z.array(TaskSummarySchema),
  goals: z.array(WeeklyGoalSchema),
  capacityMinutes: z.number(),
  scheduledMinutes: z.number(),
  workingDays: z.array(z.number().int().min(1).max(7)),
});
export type Week = z.infer<typeof WeekSchema>;

export const WorkloadPersonSchema = z.object({
  user: UserRefSchema,
  capacityMinutes: z.number(),
  scheduledMinutes: z.number(),
  perDayMinutes: z.array(z.number()).length(7),
  openTasks: z.number(),
  overdueTasks: z.number(),
  pendingAcceptance: z.number(),
  eodSubmittedToday: z.boolean(),
});
export type WorkloadPerson = z.infer<typeof WorkloadPersonSchema>;
export const WorkloadSchema = z.object({ weekStart: workDate, today: workDate, people: z.array(WorkloadPersonSchema) });
export type Workload = z.infer<typeof WorkloadSchema>;

export const SavedViewSchema = z.object({ id: z.string(), name: z.string(), filters: SavedViewDtoSchema.shape.filters });
export type SavedView = z.infer<typeof SavedViewSchema>;
export const SavedViewListSchema = z.array(SavedViewSchema);
