/**
 * Reports and the manager dashboard (SRS 5.10: FR-REP-001..006, 008). ADR 013.
 * Every report is scoped by role and team (reports.team: direct reports and own team;
 * reports.all: the organisation) and exportable as CSV, XLSX or PDF.
 */
import { z } from 'zod';
import { DOCUMENT_CATEGORIES } from '../documents/types.ts';
import { UserRole } from '../auth/types.ts';

const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const isoDate = z.string().datetime({ offset: true });

export const REPORT_FORMATS = ['json', 'csv', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const ReportUserRefSchema = z.object({ id: z.string(), displayName: z.string().nullable(), email: z.string(), teamName: z.string().nullable() });
export type ReportUserRef = z.infer<typeof ReportUserRefSchema>;

// ---------------------------------------------------------------- FR-REP-001 dashboard

export const DashboardSchema = z.object({
  /** Org-local calendar day the numbers are for. */
  today: z.string(),
  scope: z.enum(['team', 'all']),
  peopleInScope: z.number().int(),
  attendance: z.object({
    working: z.number().int(),
    onBreak: z.number().int(),
    finished: z.number().int(),
    notYetIn: z.number().int(),
    onLeaveOrOff: z.number().int(),
  }),
  lateArrivals: z.array(z.object({ user: ReportUserRefSchema, clockInAt: isoDate, expectedStart: z.string(), lateMinutes: z.number().int() })),
  pendingApprovals: z.object({
    timesheets: z.number().int(),
    corrections: z.number().int(),
    oldestSubmittedAt: isoDate.nullable(),
  }),
  overdueTasks: z.array(z.object({ id: z.string(), title: z.string(), dueDate: z.string(), daysOverdue: z.number().int(), assignee: ReportUserRefSchema.nullable(), projectName: z.string().nullable() })),
  overdueTaskCount: z.number().int(),
  expiring: z.array(z.object({
    kind: z.enum(['DOCUMENT', 'CONTRACT']),
    id: z.string(),
    /** "(confidential)" for confidential and restricted documents. */
    title: z.string(),
    user: ReportUserRefSchema.nullable(),
    expiresOn: z.string(),
    daysLeft: z.number().int(),
  })),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

// ---------------------------------------------------------------- common query

export const ReportQuerySchema = z.object({
  from: workDate,
  to: workDate,
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  format: z.enum(REPORT_FORMATS).default('json'),
});

// ---------------------------------------------------------------- FR-REP-002 attendance

export const ATTENDANCE_GROUPS = ['user', 'team', 'day', 'week', 'month'] as const;
export const AttendanceReportQuerySchema = ReportQuerySchema.extend({ groupBy: z.enum(ATTENDANCE_GROUPS).default('user') });
export type AttendanceReportQuery = z.infer<typeof AttendanceReportQuerySchema>;

export const AttendanceReportRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  people: z.number().int(),
  daysPresent: z.number().int(),
  daysLate: z.number().int(),
  lateMinutes: z.number().int(),
  daysEarlyLeave: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  daysAbsent: z.number().int(),
  daysOnLeave: z.number().int(),
  netMinutes: z.number().int(),
  expectedMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
});
export type AttendanceReportRow = z.infer<typeof AttendanceReportRowSchema>;

export const AttendanceReportSchema = z.object({
  groupBy: z.enum(ATTENDANCE_GROUPS),
  from: workDate,
  to: workDate,
  scope: z.enum(['team', 'all']),
  rows: z.array(AttendanceReportRowSchema),
  totals: AttendanceReportRowSchema,
});
export type AttendanceReport = z.infer<typeof AttendanceReportSchema>;

// ---------------------------------------------------------------- FR-REP-003 hours and cost

export const COST_GROUPS = ['user', 'project', 'month'] as const;
export const CostReportQuerySchema = ReportQuerySchema.extend({ groupBy: z.enum(COST_GROUPS).default('user'), projectId: z.string().uuid().optional() });
export type CostReportQuery = z.infer<typeof CostReportQuerySchema>;

export const CostReportRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  people: z.number().int(),
  loggedMinutes: z.number().int(),
  billableMinutes: z.number().int(),
  /** Minutes on approved (or later) timesheets. */
  approvedMinutes: z.number().int(),
  /** Approved amounts per currency, exact decimal text; never summed across currencies. */
  cost: z.record(z.string(), z.string()),
});
export type CostReportRow = z.infer<typeof CostReportRowSchema>;

export const CostReportSchema = z.object({
  groupBy: z.enum(COST_GROUPS),
  from: workDate,
  to: workDate,
  scope: z.enum(['team', 'all']),
  rows: z.array(CostReportRowSchema),
});
export type CostReport = z.infer<typeof CostReportSchema>;

// ---------------------------------------------------------------- FR-REP-004 tasks and workload

export const TaskReportQuerySchema = ReportQuerySchema.extend({ projectId: z.string().uuid().optional() });
export type TaskReportQuery = z.infer<typeof TaskReportQuerySchema>;

export const TaskReportRowSchema = z.object({
  user: ReportUserRefSchema,
  open: z.number().int(),
  inProgress: z.number().int(),
  blocked: z.number().int(),
  /** Completed inside the range. */
  completed: z.number().int(),
  completedOnTime: z.number().int(),
  overdue: z.number().int(),
  /** Remaining estimate on open tasks, minutes. */
  remainingEstimateMinutes: z.number().int(),
  estimateMinutes: z.number().int(),
  actualMinutes: z.number().int(),
  /** Remaining estimate relative to the scope average: 1.0 = average. */
  loadIndex: z.number(),
});
export type TaskReportRow = z.infer<typeof TaskReportRowSchema>;

export const TaskReportSchema = z.object({
  from: workDate,
  to: workDate,
  scope: z.enum(['team', 'all']),
  rows: z.array(TaskReportRowSchema),
  averageRemainingEstimateMinutes: z.number(),
});
export type TaskReport = z.infer<typeof TaskReportSchema>;

// ---------------------------------------------------------------- FR-REP-005 compliance

export const ComplianceQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  /** Only people with at least one finding. */
  onlyIssues: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  format: z.enum(REPORT_FORMATS).default('json'),
});
export type ComplianceQuery = z.infer<typeof ComplianceQuerySchema>;

export const ComplianceRowSchema = z.object({
  user: ReportUserRefSchema,
  role: z.string(),
  missing: z.array(z.enum(DOCUMENT_CATEGORIES)),
  expired: z.array(z.object({ id: z.string(), title: z.string(), category: z.enum(DOCUMENT_CATEGORIES), expiredOn: z.string() })),
  expiringSoon: z.array(z.object({ id: z.string(), title: z.string(), category: z.enum(DOCUMENT_CATEGORIES), expiresOn: z.string() })),
  /** Onboarding does not exist in this release. */
  onboarding: z.literal('NOT_AVAILABLE'),
  compliant: z.boolean(),
});
export type ComplianceRow = z.infer<typeof ComplianceRowSchema>;

export const ComplianceReportSchema = z.object({
  scope: z.enum(['team', 'all']),
  asOf: z.string(),
  rows: z.array(ComplianceRowSchema),
  summary: z.object({ people: z.number().int(), compliant: z.number().int(), withMissing: z.number().int(), withExpired: z.number().int() }),
  canEditRequirements: z.boolean(),
});
export type ComplianceReport = z.infer<typeof ComplianceReportSchema>;

/** Which document categories each role must have on file (HR configures; FR-REP-005). */
export const ComplianceRequirementsSchema = z.object({
  items: z.array(z.object({ role: z.enum(Object.values(UserRole) as [UserRole, ...UserRole[]]), categories: z.array(z.enum(DOCUMENT_CATEGORIES)) })),
});
export type ComplianceRequirements = z.infer<typeof ComplianceRequirementsSchema>;
export const ComplianceRequirementsDtoSchema = ComplianceRequirementsSchema.strict();
export type ComplianceRequirementsDto = z.infer<typeof ComplianceRequirementsDtoSchema>;
