'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TASK_STATUSES, TASK_STATUS_LABEL, TASK_TRANSITIONS, canTransition } from '@hrvo/shared';
import type { TaskStatus, TaskSummary } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ErrorState, LoadingState } from '@/components/state-views';
import { AcceptanceBadge, PriorityBadge } from '@/components/tasks/badges';
import { TaskViewsNav } from '@/components/tasks/task-views-nav';
import { Permission, useCan } from '@/lib/permissions';
import { useMoveTask, useTasks, type TaskFilters } from '@/lib/task-queries';
import { formatWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * FR-TASK-005 Kanban board. Mouse: drag a card to another column. Keyboard / screen reader:
 * each card has a "Move to" select listing only the transitions the workflow allows.
 */
export default function BoardPage() {
  const canTeam = useCan(Permission.TASKS_READ_TEAM);
  const [scope, setScope] = useState<TaskFilters['scope']>('mine');
  const tasks = useTasks({ scope, includeDone: true });
  const move = useMoveTask();
  const [dragging, setDragging] = useState<TaskSummary | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const doMove = (task: TaskSummary, to: TaskStatus) => {
    if (task.status === to) return;
    if (!canTransition(task.status, to)) {
      setMessage({ ok: false, text: `“${task.title}” cannot move from ${TASK_STATUS_LABEL[task.status]} to ${TASK_STATUS_LABEL[to]}.` });
      return;
    }
    move.mutate(
      { id: task.id, version: task.version, status: to },
      {
        onSuccess: () => setMessage({ ok: true, text: `Moved “${task.title}” to ${TASK_STATUS_LABEL[to]}.` }),
        onError: (err) => setMessage({ ok: false, text: err.message }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Task board</h1>
      <TaskViewsNav />
      <div role="group" aria-label="Whose tasks" className="flex flex-wrap gap-2">
        {(['mine', 'reported', ...(canTeam ? ['team' as const] : []), 'all'] as const).map((s) => (
          <Button key={s} size="sm" variant={scope === s ? 'default' : 'outline'} aria-pressed={scope === s} onClick={() => setScope(s)}>
            {s === 'mine' ? 'Assigned to me' : s === 'reported' ? 'Created by me' : s === 'team' ? 'My team' : 'All I can see'}
          </Button>
        ))}
      </div>
      <div aria-live="polite">
        {message ? (
          <Alert variant={message.ok ? 'success' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {tasks.isPending ? <LoadingState label="Loading board" rows={4} /> : null}
      {tasks.isError ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : null}
      {tasks.data ? (
        <div className="grid gap-3 overflow-x-auto md:grid-cols-5" data-testid="kanban">
          {TASK_STATUSES.map((status) => {
            const items = tasks.data.filter((t) => t.status === status);
            const allowed = dragging ? canTransition(dragging.status, status) : true;
            return (
              <section
                key={status}
                aria-labelledby={`col-${status}`}
                data-testid={`column-${status}`}
                onDragOver={(e) => {
                  if (dragging && allowed) {
                    e.preventDefault();
                    setOver(status);
                  }
                }}
                onDragLeave={() => setOver((o) => (o === status ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  if (dragging) doMove(dragging, status);
                  setDragging(null);
                }}
                className={cn(
                  'min-h-[12rem] min-w-[14rem] rounded-lg border bg-muted/30 p-2 transition-colors',
                  over === status && 'border-primary bg-primary/5',
                  dragging && !allowed && 'opacity-50',
                )}
              >
                <h2 id={`col-${status}`} className="mb-2 flex items-center justify-between px-1 text-sm font-semibold">
                  {TASK_STATUS_LABEL[status]} <span className="text-xs text-muted-foreground">{items.length}</span>
                </h2>
                {items.length === 0 ? <p className="px-1 py-4 text-center text-xs text-muted-foreground">No tasks</p> : null}
                <ul className="space-y-2">
                  {items.map((t) => (
                    <li
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        setDragging(t);
                        e.dataTransfer.setData('text/plain', t.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDragging(null)}
                      data-testid={`card-${t.title}`}
                      className="cursor-grab rounded-md border bg-card p-2 text-sm shadow-sm active:cursor-grabbing"
                    >
                      <Link href={`/tasks/${t.id}`} className="font-medium text-primary underline-offset-4 hover:underline">{t.title}</Link>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <PriorityBadge priority={t.priority} />
                        <AcceptanceBadge status={t.acceptanceStatus} />
                        {t.dueDate ? <span>Due {formatWorkDate(t.dueDate)}</span> : null}
                        {t.assignee ? <span>· {t.assignee.displayName ?? t.assignee.email}</span> : null}
                      </div>
                      <label className="mt-2 flex items-center gap-2 text-xs">
                        <span className="sr-only">Move “{t.title}” to</span>
                        <span aria-hidden="true">Move to</span>
                        <NativeSelect
                          className="h-8 py-0 text-xs"
                          value=""
                          onChange={(e) => e.target.value && doMove(t, e.target.value as TaskStatus)}
                          disabled={move.isPending}
                        >
                          <option value="">—</option>
                          {TASK_TRANSITIONS[t.status].map((to) => (
                            <option key={to} value={to}>{TASK_STATUS_LABEL[to]}</option>
                          ))}
                        </NativeSelect>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
