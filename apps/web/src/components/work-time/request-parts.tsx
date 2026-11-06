'use client';

import Link from 'next/link';
import type { RequestStatus } from '@hrvo/shared';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { useProjects, useTasks } from '@/lib/task-queries';

export const REQUEST_STATUS_VIEW: Record<RequestStatus, { label: string; variant: 'secondary' | 'success' | 'destructive' | 'outline' }> = {
  PENDING: { label: 'Waiting for a decision', variant: 'secondary' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const v = REQUEST_STATUS_VIEW[status];
  return <Badge variant={v.variant} data-testid={`status-${status}`}>{v.label}</Badge>;
}

export const hours = (m: number) => `${Math.round((m / 60) * 100) / 100} h`;

/** Optional project and one of my tasks (the server checks membership and task rules). */
export function ProjectTaskPicker({ projectId, taskId, onChange, idPrefix }: { projectId: string; taskId: string; onChange: (v: { projectId: string; taskId: string }) => void; idPrefix: string }) {
  const projects = useProjects();
  const tasks = useTasks({ scope: 'mine', includeDone: false });
  const taskOptions = (tasks.data ?? []).filter((t) => !projectId || t.projectId === projectId);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-project`}>Project</Label>
        <NativeSelect id={`${idPrefix}-project`} value={projectId} onChange={(e) => onChange({ projectId: e.target.value, taskId: '' })}>
          <option value="">No project</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-task`}>Task (optional)</Label>
        <NativeSelect id={`${idPrefix}-task`} value={taskId} onChange={(e) => onChange({ projectId, taskId: e.target.value })}>
          <option value="">No task</option>
          {taskOptions.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </NativeSelect>
      </div>
    </div>
  );
}

/** ADR 049 §7: the three manual paths, so people pick the right one. */
export function WhichFormHint() {
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Which form should I use?</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        <li><span className="text-foreground">Onsite work</span>: you worked at a client or site and were not using Virtual-HR. Your manager reviews it; approved time goes into your timesheet. It never changes your attendance.</li>
        <li><span className="text-foreground"><Link className="underline-offset-4 hover:underline" href="/work-time">Add work</Link></span>: you were working, but forgot the timer. It is marked as manual time.</li>
        <li><span className="text-foreground"><Link className="underline-offset-4 hover:underline" href="/attendance">Attendance correction</Link></span>: your clock-in or clock-out was wrong.</li>
        <li><span className="text-foreground"><Link className="underline-offset-4 hover:underline" href="/work-time/overtime">Overtime request</Link></span>: you need approval for hours beyond your schedule.</li>
      </ul>
    </details>
  );
}
