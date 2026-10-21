'use client';

import { randomUUID } from '@/lib/uuid';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import type { TaskSummary, Week, WeeklyGoal } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/state-views';
import { PriorityBadge, minutesLabel } from '@/components/tasks/badges';
import { TaskViewsNav } from '@/components/tasks/task-views-nav';
import { usePlanTask, useSaveWeek, useWeek } from '@/lib/planning-queries';
import { addDays, formatWorkDate, toWorkDate } from '@/lib/format';
import { cn } from '@/lib/utils';

function shiftWeek(start: string, weeks: number): string {
  const [y, m, d] = start.split('-').map(Number);
  return toWorkDate(addDays(new Date(y!, m! - 1, d!), weeks * 7));
}

/** FR-TASK-004 weekly planner. Drag cards between days, or use "Plan for" / Alt+←/→ on a focused card. */
export default function WeekPage() {
  const [start, setStart] = useState<string | undefined>(undefined);
  const week = useWeek(start);
  const current = week.data?.weekStart;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Week{current ? ` of ${formatWorkDate(current)}` : ''}</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!current} onClick={() => current && setStart(shiftWeek(current, -1))}><ChevronLeft aria-hidden="true" />Previous week</Button>
          <Button variant="outline" size="sm" onClick={() => setStart(undefined)}>This week</Button>
          <Button variant="outline" size="sm" disabled={!current} onClick={() => current && setStart(shiftWeek(current, 1))}>Next week<ChevronRight aria-hidden="true" /></Button>
        </div>
      </div>
      <TaskViewsNav />
      {week.isPending ? <LoadingState label="Loading week" rows={5} /> : null}
      {week.isError ? <ErrorState error={week.error} onRetry={() => void week.refetch()} /> : null}
      {week.data ? <WeekView week={week.data} /> : null}
    </div>
  );
}

function WeekView({ week }: { week: Week }) {
  const plan = usePlanTask();
  const [dragging, setDragging] = useState<TaskSummary | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const dayLabel = (date: string | null) => (date ? formatWorkDate(date) : 'Unscheduled');

  const moveTo = (task: TaskSummary, date: string | null) => {
    if (task.plannedDate === date) return;
    plan.mutate(
      { id: task.id, version: task.version, plannedDate: date },
      {
        onSuccess: () => setMessage({ ok: true, text: `Planned “${task.title}” for ${dayLabel(date)}.` }),
        onError: (err) => setMessage({ ok: false, text: err.message }),
      },
    );
  };

  const shiftBy = (task: TaskSummary, delta: number) => {
    const days = week.days.map((d) => d.date);
    const idx = task.plannedDate ? days.indexOf(task.plannedDate) : delta > 0 ? -1 : days.length;
    const target = days[Math.min(days.length - 1, Math.max(0, idx + delta))];
    if (target) moveTo(task, target);
  };

  const card = (t: TaskSummary) => (
    <li
      key={t.id}
      draggable
      tabIndex={0}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      aria-label={`${t.title}, ${dayLabel(t.plannedDate)}. Alt plus arrow keys move it by a day.`}
      onDragStart={(e) => { setDragging(t); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={() => setDragging(null)}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          shiftBy(t, e.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
      data-testid={`week-card-${t.title}`}
      className="cursor-grab rounded-md border bg-card p-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
    >
      <Link href={`/tasks/${t.id}`} className="block font-medium text-primary underline-offset-4 hover:underline">{t.title}</Link>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
        <PriorityBadge priority={t.priority} />
        <span>{minutesLabel(t.estimateMinutes)}</span>
        {t.status === 'DONE' ? <span className="font-medium text-success">Done</span> : null}
      </div>
      <label className="mt-1 flex items-center gap-1">
        <span className="sr-only">Plan “{t.title}” for</span>
        <span aria-hidden="true">Plan for</span>
        <NativeSelect className="h-7 py-0 text-xs" value={t.plannedDate && week.days.some((d) => d.date === t.plannedDate) ? t.plannedDate : ''}
          onChange={(e) => moveTo(t, e.target.value || null)} disabled={plan.isPending}>
          <option value="">{t.plannedDate && !week.days.some((d) => d.date === t.plannedDate) ? formatWorkDate(t.plannedDate) : 'Unscheduled'}</option>
          {week.days.map((d) => <option key={d.date} value={d.date}>{formatWorkDate(d.date)}</option>)}
        </NativeSelect>
      </label>
    </li>
  );

  const dropZone = (id: string, target: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (dragging) { e.preventDefault(); setOver(id); } },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(null); if (dragging) moveTo(dragging, target); setDragging(null); },
  });

  const pct = week.capacityMinutes > 0 ? Math.round((week.scheduledMinutes / week.capacityMinutes) * 100) : 0;
  const overCapacity = week.scheduledMinutes > week.capacityMinutes;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle className="text-base">Capacity</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div role="meter" aria-label="Scheduled hours against capacity" aria-valuemin={0} aria-valuemax={week.capacityMinutes}
              aria-valuenow={week.scheduledMinutes} aria-valuetext={`${minutesLabel(week.scheduledMinutes)} of ${minutesLabel(week.capacityMinutes)}`}
              className="h-3 w-full overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full', overCapacity ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <p data-testid="capacity-text" className={cn(overCapacity && 'font-medium text-destructive')}>
              Scheduled {minutesLabel(week.scheduledMinutes)} of {minutesLabel(week.capacityMinutes)} ({pct}%){overCapacity ? ' · over capacity' : ''}
            </p>
            <p className="text-xs text-muted-foreground">Scheduled = estimates of tasks planned this week.</p>
          </CardContent>
        </Card>
        <Goals week={week} />
      </div>
      <div aria-live="polite">
        {message ? <Alert variant={message.ok ? 'success' : 'destructive'}><AlertDescription>{message.text}</AlertDescription></Alert> : null}
      </div>
      <div className="grid gap-2 overflow-x-auto md:grid-cols-7" data-testid="week-grid">
        {week.days.map((d, i) => {
          const working = week.workingDays.includes(i + 1);
          return (
            <section key={d.date} aria-labelledby={`day-${d.date}`} data-testid={`day-${d.date}`} {...dropZone(d.date, d.date)}
              className={cn('min-h-[10rem] min-w-[9rem] rounded-lg border p-2', working ? 'bg-muted/30' : 'bg-muted/10 opacity-80', over === d.date && 'border-primary bg-primary/5')}>
              <h2 id={`day-${d.date}`} className="mb-1 text-sm font-semibold">{formatWorkDate(d.date)}</h2>
              <p className="mb-2 text-xs text-muted-foreground">{minutesLabel(d.scheduledMinutes)}{working ? '' : ' · day off'}</p>
              <ul className="space-y-2">{d.tasks.map(card)}</ul>
            </section>
          );
        })}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="carried" {...dropZone('carried', null)} className="rounded-lg border p-3">
          <h2 id="carried" className="mb-2 text-sm font-semibold">Carried over from earlier weeks ({week.carriedOver.length})</h2>
          {week.carriedOver.length === 0 ? <p className="text-xs text-muted-foreground">Nothing carried over.</p> : <ul className="space-y-2">{week.carriedOver.map(card)}</ul>}
        </section>
        <section aria-labelledby="backlog" {...dropZone('backlog', null)} data-testid="backlog"
          className={cn('rounded-lg border p-3', over === 'backlog' && 'border-primary bg-primary/5')}>
          <h2 id="backlog" className="mb-2 text-sm font-semibold">Unscheduled ({week.backlog.length})</h2>
          {week.backlog.length === 0 ? <p className="text-xs text-muted-foreground">Everything is scheduled.</p> : <ul className="space-y-2">{week.backlog.map(card)}</ul>}
        </section>
      </div>
    </div>
  );
}

function Goals({ week }: { week: Week }) {
  const save = useSaveWeek(week.weekStart);
  const [goals, setGoals] = useState<WeeklyGoal[]>(week.goals);
  const [text, setText] = useState('');
  useEffect(() => setGoals(week.goals), [week.goals]);
  const persist = (next: WeeklyGoal[]) => {
    setGoals(next);
    save.mutate({ goals: next });
  };
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle className="text-base">Weekly goals</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {goals.length === 0 ? <p className="text-sm text-muted-foreground">No goals yet.</p> : null}
        <ul className="space-y-1" data-testid="weekly-goals">
          {goals.map((g) => (
            <li key={g.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" id={`goal-${g.id}`} className="h-4 w-4" checked={g.done}
                onChange={(e) => persist(goals.map((x) => (x.id === g.id ? { ...x, done: e.target.checked } : x)))} />
              <label htmlFor={`goal-${g.id}`} className={cn(g.done && 'text-muted-foreground line-through')}>{g.text}</label>
              <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Remove goal ${g.text}`}
                onClick={() => persist(goals.filter((x) => x.id !== g.id))}><X /></Button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || goals.length >= 20) return;
          persist([...goals, { id: randomUUID(), text: text.trim(), done: false }]);
          setText('');
        }}>
          <Label htmlFor="new-goal" className="sr-only">New weekly goal</Label>
          <Input id="new-goal" placeholder="Add a goal for this week" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
          <Button type="submit" variant="secondary" disabled={!text.trim() || save.isPending}><Plus aria-hidden="true" />Add</Button>
        </form>
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {save.isPending ? 'Saving…' : save.isSuccess ? 'Goals saved' : ''}
        </p>
        {save.isError ? <p className="text-sm font-medium text-destructive">{save.error.message}</p> : null}
      </CardContent>
    </Card>
  );
}
