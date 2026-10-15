'use client';

import { useState } from 'react';
import { TASK_PRIORITIES } from '@hrvo/shared';
import type { TaskDetail, TaskPriority } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/select';
import { FormField } from '@/components/form-field';
import { MarkdownEditor } from '@/components/markdown-editor';
import { useAssignable, useCreateTask, useProjects } from '@/lib/task-queries';
import { useAuthStore } from '@/lib/auth-store';

const PRIORITY_LABEL: Record<TaskPriority, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' };

/** Create a task or subtask (FR-TASK-001). */
export function TaskForm({
  parent,
  defaultPlannedDate,
  onCreated,
  onCancel,
}: {
  parent?: Pick<TaskDetail, 'id' | 'title' | 'projectId'>;
  defaultPlannedDate?: string;
  onCreated: (task: TaskDetail) => void;
  onCancel?: () => void;
}) {
  const me = useAuthStore((s) => s.user);
  const projects = useProjects();
  const [projectId, setProjectId] = useState(parent?.projectId ?? '');
  const assignable = useAssignable(projectId || undefined);
  const create = useCreateTask();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(me?.id ?? '');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [plannedDate, setPlannedDate] = useState(defaultPlannedDate ?? '');
  const [estimateHours, setEstimateHours] = useState('');
  const [labels, setLabels] = useState('');
  const [checklist, setChecklist] = useState('');
  const [touched, setTouched] = useState(false);

  const estimate = estimateHours.trim() === '' ? null : Math.round(Number(estimateHours) * 60);
  const estimateInvalid = estimate !== null && (!Number.isFinite(estimate) || estimate < 0);
  const titleProblem = title.trim() ? null : 'Give the task a title.';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (titleProblem || estimateInvalid) return;
    create.mutate(
      {
        title: title.trim(),
        description,
        projectId: projectId || null,
        parentTaskId: parent?.id ?? null,
        assigneeId: assigneeId || null,
        priority,
        dueDate: dueDate || null,
        plannedDate: plannedDate || null,
        estimateMinutes: estimate,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
        checklist: checklist.split('\n').map((l) => l.trim()).filter(Boolean),
      },
      { onSuccess: onCreated },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={parent ? `New subtask of ${parent.title}` : 'New task'}>
      {create.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{create.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required error={touched ? titleProblem : null} />
      <MarkdownEditor label="Description" value={description} onChange={setDescription} maxLength={20_000} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="task-project">Project</Label>
          <NativeSelect id="task-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!!parent}>
            <option value="">No project</option>
            {(projects.data ?? []).filter((p) => p.status === 'ACTIVE' || p.id === projectId).map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="task-assignee">Assignee</Label>
          <NativeSelect id="task-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} aria-describedby="task-assignee-hint">
            <option value="">Unassigned</option>
            {(assignable.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName ?? u.email}{u.id === me?.id ? ' (me)' : ''}{u.role === 'SUBCONTRACTOR' ? ' · subcontractor' : ''}
              </option>
            ))}
          </NativeSelect>
          <p id="task-assignee-hint" className="text-xs text-muted-foreground">Subcontractors are asked to accept tasks assigned to them.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="task-priority">Priority</Label>
          <NativeSelect id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </NativeSelect>
        </div>
        <FormField label="Estimate (hours)" type="number" min={0} step={0.25} inputMode="decimal" value={estimateHours}
          onChange={(e) => setEstimateHours(e.target.value)} error={touched && estimateInvalid ? 'Enter hours, e.g. 1.5' : null} />
        <FormField label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <FormField label="Planned for" type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} hint="Puts it on that day's Today list." />
      </div>
      <FormField label="Labels" value={labels} onChange={(e) => setLabels(e.target.value)} hint="Comma-separated, e.g. design, urgent-fix" />
      <div className="space-y-1.5">
        <Label htmlFor="task-checklist">Checklist</Label>
        <Textarea id="task-checklist" rows={3} value={checklist} onChange={(e) => setChecklist(e.target.value)} aria-describedby="task-checklist-hint" />
        <p id="task-checklist-hint" className="text-xs text-muted-foreground">One item per line.</p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : parent ? 'Create subtask' : 'Create task'}</Button>
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}
