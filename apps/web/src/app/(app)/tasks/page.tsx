'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { TASK_PRIORITIES, TASK_STATUSES, TASK_STATUS_LABEL } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { AcceptanceBadge, PriorityBadge, StatusBadge, isOverdue, minutesLabel } from '@/components/tasks/badges';
import { TaskViewsNav } from '@/components/tasks/task-views-nav';
import { Permission, useCan } from '@/lib/permissions';
import { useProjects, useTasks, type TaskFilters } from '@/lib/task-queries';
import { useSavedViewMutation, useSavedViews } from '@/lib/planning-queries';
import { formatWorkDate, toWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const SCOPES: Array<{ id: TaskFilters['scope']; label: string; permission?: 'team' | 'all' }> = [
  { id: 'mine', label: 'Assigned to me' },
  { id: 'reported', label: 'Created by me' },
  { id: 'team', label: 'My team', permission: 'team' },
  { id: 'all', label: 'All I can see' },
];

/** FR-TASK-005: My Tasks list with filters. */
export default function MyTasksPage() {
  const canTeam = useCan(Permission.TASKS_READ_TEAM);
  const [filters, setFilters] = useState<TaskFilters>({ scope: 'mine', includeDone: false });
  const tasks = useTasks(filters);
  const projects = useProjects();
  const today = toWorkDate(new Date());
  const set = (patch: Partial<TaskFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <Button asChild>
          <Link href="/tasks/new"><Plus aria-hidden="true" />New task</Link>
        </Button>
      </div>
      <TaskViewsNav />
      <div role="group" aria-label="Whose tasks" className="flex flex-wrap gap-2">
        {SCOPES.filter((s) => s.permission !== 'team' || canTeam).map((s) => (
          <Button key={s.id} size="sm" variant={filters.scope === s.id ? 'default' : 'outline'} aria-pressed={filters.scope === s.id} onClick={() => set({ scope: s.id })}>
            {s.label}
          </Button>
        ))}
      </div>
      <SavedViewsBar filters={filters} onApply={(f) => setFilters(f)} />
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5 lg:col-span-2">
            <Label htmlFor="f-q">Search titles</Label>
            <Input id="f-q" type="search" value={filters.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-status">Status</Label>
            <NativeSelect id="f-status" value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
              <option value="">Any</option>
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-project">Project</Label>
            <NativeSelect id="f-project" value={filters.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || undefined })}>
              <option value="">Any</option>
              {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-priority">Priority</Label>
            <NativeSelect id="f-priority" value={filters.priority ?? ''} onChange={(e) => set({ priority: e.target.value || undefined })}>
              <option value="">Any</option>
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}
            </NativeSelect>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={filters.includeDone !== false} onChange={(e) => set({ includeDone: e.target.checked })} />
            Show done tasks
          </label>
        </CardContent>
      </Card>

      {tasks.isPending ? <LoadingState label="Loading tasks" rows={5} /> : null}
      {tasks.isError ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : null}
      {tasks.data && tasks.data.length === 0 ? (
        <EmptyState title="No tasks here" description={filters.scope === 'mine' ? 'Tasks assigned to you will appear here.' : 'Try another filter.'} />
      ) : null}
      {tasks.data && tasks.data.length > 0 ? (
        <Table data-testid="task-list">
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Planned</TableHead>
              <TableHead className="text-right">Estimate / actual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.data.map((t) => {
              const overdue = isOverdue(t.dueDate, t.status, today);
              const over = t.estimateMinutes !== null && t.actualMinutes !== null && t.actualMinutes > t.estimateMinutes;
              return (
                <TableRow key={t.id} data-testid={`task-row-${t.title}`}>
                  <TableCell className="max-w-[24rem]">
                    <Link href={`/tasks/${t.id}`} className="font-medium text-primary underline-offset-4 hover:underline">{t.title}</Link>
                    <span className="block text-xs text-muted-foreground">
                      {t.projectCode ? `${t.projectCode} · ` : ''}
                      {t.checklistTotal > 0 ? `${t.checklistDone}/${t.checklistTotal} checklist · ` : ''}
                      {t.labels.join(', ')}
                    </span>
                    <AcceptanceBadge status={t.acceptanceStatus} />
                  </TableCell>
                  <TableCell><StatusBadge status={t.status} /></TableCell>
                  <TableCell><PriorityBadge priority={t.priority} /></TableCell>
                  <TableCell>{t.assignee ? t.assignee.displayName ?? t.assignee.email : <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                  <TableCell className={cn(overdue && 'font-medium text-destructive')}>
                    {t.dueDate ? formatWorkDate(t.dueDate) : '—'}{overdue ? ' (overdue)' : ''}
                  </TableCell>
                  <TableCell>{t.plannedDate ? formatWorkDate(t.plannedDate) : '—'}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', over && 'font-medium text-destructive')}>
                    {minutesLabel(t.estimateMinutes)} / {minutesLabel(t.actualMinutes)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

/** FR-TASK-005 saved views: named filter sets per user. */
function SavedViewsBar({ filters, onApply }: { filters: TaskFilters; onApply: (f: TaskFilters) => void }) {
  const views = useSavedViews();
  const change = useSavedViewMutation();
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="saved-view">Saved views</Label>
        <NativeSelect id="saved-view" className="w-56" value={selected} onChange={(e) => {
          setSelected(e.target.value);
          const v = views.data?.find((x) => x.id === e.target.value);
          if (v) onApply({ ...v.filters, scope: v.filters.scope });
        }}>
          <option value="">{views.isPending ? 'Loading…' : views.data?.length ? 'Choose a view' : 'No saved views'}</option>
          {(views.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </NativeSelect>
      </div>
      {selected ? (
        <Button variant="ghost" size="sm" onClick={() => change.mutate({ deleteId: selected }, { onSuccess: () => setSelected('') })}>Delete view</Button>
      ) : null}
      <form className="flex items-end gap-2" onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const { scope, status, projectId, priority, q, includeDone } = filters;
        change.mutate({ save: { name: name.trim(), filters: { scope, status, projectId, priority, q, includeDone } } }, { onSuccess: () => setName('') });
      }}>
        <div className="space-y-1.5">
          <Label htmlFor="view-name">Save current filters as</Label>
          <Input id="view-name" className="w-48" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={!name.trim() || change.isPending}>Save view</Button>
      </form>
      {change.isError ? <p className="text-sm font-medium text-destructive">{change.error.message}</p> : null}
    </div>
  );
}

