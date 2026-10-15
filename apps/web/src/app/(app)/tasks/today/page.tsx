'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Sunrise, Sunset } from 'lucide-react';
import type { Today, TodayItem } from '@hrvo/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { PriorityBadge, StatusBadge, minutesLabel } from '@/components/tasks/badges';
import { TaskViewsNav } from '@/components/tasks/task-views-nav';
import { useConfirmPlan, useSubmitReport, useToday } from '@/lib/planning-queries';
import { formatClock, formatWorkDate } from '@/lib/format';

const REASON: Record<TodayItem['reasons'][number], { label: string; variant: 'default' | 'secondary' | 'warning' | 'destructive' | 'outline' }> = {
  IN_PLAN: { label: 'In my plan', variant: 'default' },
  PLANNED: { label: 'Planned today', variant: 'secondary' },
  DUE_TODAY: { label: 'Due today', variant: 'warning' },
  OVERDUE: { label: 'Overdue', variant: 'destructive' },
  CARRIED_OVER: { label: 'Carried over', variant: 'outline' },
};

/** FR-TASK-003: Today list, start-of-day plan, end-of-day report. */
export default function TodayPage() {
  const today = useToday();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Today{today.data ? ` · ${formatWorkDate(today.data.date)}` : ''}</h1>
      <TaskViewsNav />
      {today.isPending ? <LoadingState label="Loading today" rows={5} /> : null}
      {today.isError ? <ErrorState error={today.error} onRetry={() => void today.refetch()} /> : null}
      {today.data ? <TodayView day={today.data} /> : null}
    </div>
  );
}

function TodayView({ day }: { day: Today }) {
  const confirmed = !!day.plan?.confirmedAt;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {confirmed ? <PlanSummary day={day} /> : <StartOfDay day={day} />}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">On my list</CardTitle>
            <CardDescription>Tasks planned or due today, overdue tasks and carry-overs.</CardDescription>
          </CardHeader>
          <CardContent>
            {day.items.length === 0 ? <EmptyState title="Nothing on your list today" description="Plan tasks for today from the Week view or a task's details." /> : (
              <ul className="divide-y" data-testid="today-items">
                {day.items.map((i) => (
                  <li key={i.task.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <Link href={`/tasks/${i.task.id}`} className="font-medium text-primary underline-offset-4 hover:underline">{i.task.title}</Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {i.reasons.map((r) => <Badge key={r} variant={REASON[r].variant}>{REASON[r].label}</Badge>)}
                        {i.planStatus === 'CARRIED_OVER' ? <Badge variant="outline">Carried to next work day</Badge> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <PriorityBadge priority={i.task.priority} />
                      <StatusBadge status={i.task.status} />
                      <span className="tabular-nums text-muted-foreground">{minutesLabel(i.task.estimateMinutes)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Done today</CardTitle></CardHeader>
          <CardContent>
            {day.doneToday.length === 0 ? <p className="text-sm text-muted-foreground">Nothing completed yet.</p> : (
              <ul className="list-inside list-disc text-sm" data-testid="done-today">
                {day.doneToday.map((t) => <li key={t.id}><Link className="text-primary underline" href={`/tasks/${t.id}`}>{t.title}</Link></li>)}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <EndOfDay day={day} />
    </div>
  );
}

function StartOfDay({ day }: { day: Today }) {
  const confirm = useConfirmPlan(day.date);
  const openItems = day.items.filter((i) => i.task.status !== 'DONE');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(openItems.map((i) => i.task.id)));
  const [goals, setGoals] = useState(day.plan?.goals ?? '');
  const minutes = openItems.filter((i) => chosen.has(i.task.id)).reduce((s, i) => s + (i.task.estimateMinutes ?? 0), 0);
  return (
    <Card data-testid="start-of-day">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Sunrise className="h-4 w-4" aria-hidden="true" />Plan your day</CardTitle>
        <CardDescription>Choose what you will work on today, then confirm. Unchecked tasks stay on your list.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <fieldset className="space-y-1">
          <legend className="sr-only">Tasks for today</legend>
          {openItems.length === 0 ? <p className="text-sm text-muted-foreground">No open tasks yet; you can still set goals.</p> : null}
          {openItems.map((i) => (
            <label key={i.task.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={chosen.has(i.task.id)}
                onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(i.task.id); else n.delete(i.task.id); return n; })} />
              {i.task.title}
            </label>
          ))}
        </fieldset>
        <p className="text-sm text-muted-foreground">Estimated: {minutesLabel(minutes)}</p>
        <div className="space-y-1.5">
          <Label htmlFor="day-goals">Goals for today</Label>
          <Textarea id="day-goals" rows={2} value={goals} onChange={(e) => setGoals(e.target.value)} maxLength={2000} />
        </div>
        {confirm.isError ? <Alert variant="destructive"><AlertDescription>{confirm.error.message}</AlertDescription></Alert> : null}
        <Button disabled={confirm.isPending}
          onClick={() => confirm.mutate({ goals, taskIds: openItems.filter((i) => chosen.has(i.task.id)).map((i) => i.task.id) })}>
          {confirm.isPending ? 'Confirming…' : 'Confirm my plan'}
        </Button>
      </CardContent>
    </Card>
  );
}

function PlanSummary({ day }: { day: Today }) {
  return (
    <Alert variant="success" data-testid="plan-confirmed">
      <AlertDescription>
        Plan confirmed at {formatClock(day.plan!.confirmedAt)}.{day.plan!.goals ? ` Goals: ${day.plan!.goals}` : ''}
      </AlertDescription>
    </Alert>
  );
}

function EndOfDay({ day }: { day: Today }) {
  const report = useSubmitReport(day.date);
  const blocked = day.items.filter((i) => i.task.status === 'BLOCKED').map((i) => `- ${i.task.title}`).join('\n');
  const defaults = useMemo(
    () => ({
      summary: day.plan?.eodSummary ?? day.doneToday.map((t) => `- ${t.title}`).join('\n'),
      blockers: day.plan?.blockers ?? blocked,
      tomorrow: day.plan?.tomorrowPlan ?? '',
    }),
    [day, blocked],
  );
  const [form, setForm] = useState(defaults);
  useEffect(() => setForm(defaults), [defaults]);
  const submitted = day.plan?.submittedAt;
  return (
    <Card data-testid="end-of-day">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Sunset className="h-4 w-4" aria-hidden="true" />End of day report</CardTitle>
        <CardDescription>
          {submitted ? `Submitted at ${formatClock(submitted)}. You can update it today.` : `Unfinished planned tasks move to ${formatWorkDate(day.nextWorkDay)}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); report.mutate(form); }}>
          {(['summary', 'blockers', 'tomorrow'] as const).map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`eod-${k}`}>{k === 'summary' ? 'Done today' : k === 'blockers' ? 'Blocked by' : 'Tomorrow'}</Label>
              <Textarea id={`eod-${k}`} rows={3} value={form[k]} maxLength={4000} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
            </div>
          ))}
          {report.isError ? <Alert variant="destructive"><AlertDescription>{report.error.message}</AlertDescription></Alert> : null}
          {report.isSuccess ? <Alert variant="success"><AlertDescription>Report submitted.</AlertDescription></Alert> : null}
          <Button type="submit" disabled={report.isPending || !form.summary.trim()}>{report.isPending ? 'Submitting…' : submitted ? 'Update report' : 'Submit report'}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
