'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { TaskSummary } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/state-views';
import { TaskViewsNav } from '@/components/tasks/task-views-nav';
import { Permission, useCan } from '@/lib/permissions';
import { useTasks, type TaskFilters } from '@/lib/task-queries';
import { addDays, startOfWeek, toWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** FR-TASK-005 calendar: month grid of tasks by due date or planned date. */
export default function CalendarPage() {
  const canTeam = useCan(Permission.TASKS_READ_TEAM);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [by, setBy] = useState<'due' | 'planned'>('due');
  const [scope, setScope] = useState<TaskFilters['scope']>('mine');

  const gridStart = startOfWeek(month);
  const lastOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const gridEnd = addDays(startOfWeek(lastOfMonth), 6);
  const from = toWorkDate(gridStart);
  const to = toWorkDate(gridEnd);
  const tasks = useTasks(by === 'due' ? { scope, dueFrom: from, dueTo: to } : { scope, plannedFrom: from, plannedTo: to });
  const today = toWorkDate(new Date());

  const byDate = useMemo(() => {
    const m = new Map<string, TaskSummary[]>();
    for (const t of tasks.data ?? []) {
      const key = by === 'due' ? t.dueDate : t.plannedDate;
      if (!key) continue;
      m.set(key, [...(m.get(key) ?? []), t]);
    }
    return m;
  }, [tasks.data, by]);

  const weeks: Date[][] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  const title = month.toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Calendar · {title}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft aria-hidden="true" />Previous month</Button>
          <Button variant="outline" size="sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>This month</Button>
          <Button variant="outline" size="sm" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>Next month<ChevronRight aria-hidden="true" /></Button>
        </div>
      </div>
      <TaskViewsNav />
      <div className="flex flex-wrap gap-4">
        <div role="group" aria-label="Show tasks by" className="flex gap-2">
          {(['due', 'planned'] as const).map((b) => (
            <Button key={b} size="sm" variant={by === b ? 'default' : 'outline'} aria-pressed={by === b} onClick={() => setBy(b)}>{b === 'due' ? 'By due date' : 'By planned date'}</Button>
          ))}
        </div>
        <div role="group" aria-label="Whose tasks" className="flex gap-2">
          {(['mine', ...(canTeam ? ['team' as const] : []), 'all'] as const).map((s) => (
            <Button key={s} size="sm" variant={scope === s ? 'default' : 'outline'} aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === 'mine' ? 'Mine' : s === 'team' ? 'My team' : 'All I can see'}
            </Button>
          ))}
        </div>
      </div>
      {tasks.isPending ? <LoadingState label="Loading calendar" rows={5} /> : null}
      {tasks.isError ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} /> : null}
      {tasks.data ? (
        <table className="w-full table-fixed border-collapse text-xs" data-testid="calendar" aria-label={`Tasks in ${title}`}>
          <thead>
            <tr>{WEEKDAYS.map((d) => <th key={d} scope="col" className="border p-1 font-medium text-muted-foreground">{d}</th>)}</tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={toWorkDate(w[0]!)}>
                {w.map((day) => {
                  const key = toWorkDate(day);
                  const items = byDate.get(key) ?? [];
                  const inMonth = day.getMonth() === month.getMonth();
                  return (
                    <td key={key} className={cn('h-24 border p-1 align-top', !inMonth && 'bg-muted/40 text-muted-foreground', key === today && 'ring-2 ring-inset ring-primary')}>
                      <div className="mb-1 font-medium">{day.getDate()}<span className="sr-only"> {day.toLocaleDateString([], { month: 'long' })}</span></div>
                      <ul className="space-y-0.5">
                        {items.slice(0, 3).map((t) => (
                          <li key={t.id} className="truncate">
                            <Link href={`/tasks/${t.id}`} className={cn('text-primary underline-offset-2 hover:underline', t.status === 'DONE' && 'text-muted-foreground line-through')}>{t.title}</Link>
                          </li>
                        ))}
                        {items.length > 3 ? <li className="text-muted-foreground">+{items.length - 3} more</li> : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
