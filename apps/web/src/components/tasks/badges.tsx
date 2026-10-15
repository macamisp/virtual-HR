import { TASK_STATUS_LABEL } from '@hrvo/shared';
import type { TaskPriority, TaskStatus } from '@hrvo/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';

const STATUS_VARIANT: Record<TaskStatus, BadgeProps['variant']> = {
  TODO: 'secondary',
  IN_PROGRESS: 'default',
  IN_REVIEW: 'warning',
  BLOCKED: 'destructive',
  DONE: 'success',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{TASK_STATUS_LABEL[status]}</Badge>;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' };

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <Badge variant={priority === 'URGENT' ? 'destructive' : priority === 'HIGH' ? 'warning' : 'outline'}>
      {PRIORITY_LABEL[priority]}
    </Badge>
  );
}

export function AcceptanceBadge({ status }: { status: string }) {
  if (status === 'PENDING') return <Badge variant="warning">Awaiting acceptance</Badge>;
  if (status === 'DECLINED') return <Badge variant="destructive">Declined</Badge>;
  return null;
}

/** "2h 30m" from minutes; em dash for null. */
export function minutesLabel(m: number | null): string {
  if (m === null) return '—';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h${r ? ` ${r}m` : ''}` : `${r}m`;
}

export function isOverdue(dueDate: string | null, status: TaskStatus, today: string): boolean {
  return !!dueDate && status !== 'DONE' && dueDate < today;
}
