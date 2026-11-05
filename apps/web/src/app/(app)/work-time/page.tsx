'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Pause, Play, Plus, Square, Timer } from 'lucide-react';
import { WORK_CATEGORIES, WORK_CATEGORY_LABEL, WORK_TYPES, WORK_TYPE_LABEL } from '@hrvo/shared';
import type { ManualEntryDto, StartTimerDto, TimeEntry, WorkCategory, WorkType } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/select';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { UpcomingMeetings } from '@/components/calendar/upcoming-meetings';
import { ActivityNote, WorkTimeNav } from '@/components/work-time/work-time-nav';
import { useElapsed } from '@/components/timesheets/timer';
import { minutesLabel } from '@/components/tasks/badges';
import { Permission, useCan } from '@/lib/permissions';
import { useProjects, useTasks } from '@/lib/task-queries';
import { useAddManualEntry, useMyEntries, useTimer, useTimerAction } from '@/lib/timesheet-queries';
import { addDays, formatClock, formatDuration, toWorkDate } from '@/lib/format';

const SOURCE_LABEL: Record<TimeEntry['source'], string> = { TIMER: 'Timer', MANUAL: 'Manual', AUTO_FROM_ATTENDANCE: 'Automatic' };

function workLabel(e: Pick<TimeEntry, 'taskTitle' | 'title'>): string {
  return e.title ?? e.taskTitle ?? 'Work';
}

/** Project, task, work type and category pickers shared by the timer and the add-work form. */
function WorkFields({ v, set, idPrefix }: { v: Fields; set: (p: Partial<Fields>) => void; idPrefix: string }) {
  const projects = useProjects();
  const tasks = useTasks({ scope: 'mine', includeDone: false });
  const taskOptions = (tasks.data ?? []).filter((t) => !v.projectId || t.projectId === v.projectId);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-title`}>What are you working on?</Label>
        <Input id={`${idPrefix}-title`} value={v.title} maxLength={200} placeholder="e.g. Fix Login Authentication" onChange={(e) => set({ title: e.target.value })} />
        <p className="text-xs text-muted-foreground">Use your own words, or pick one of your tasks below.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-project`}>Project (optional)</Label>
        <NativeSelect id={`${idPrefix}-project`} value={v.projectId} onChange={(e) => set({ projectId: e.target.value, taskId: '' })}>
          <option value="">No project</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-task`}>My task (optional)</Label>
        <NativeSelect id={`${idPrefix}-task`} value={v.taskId} onChange={(e) => set({ taskId: e.target.value })}>
          <option value="">No task</option>
          {taskOptions.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-type`}>Where</Label>
        <NativeSelect id={`${idPrefix}-type`} value={v.workType} onChange={(e) => set({ workType: e.target.value as WorkType | '' })}>
          <option value="">Not specified</option>
          {WORK_TYPES.map((w) => <option key={w} value={w}>{WORK_TYPE_LABEL[w]}</option>)}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-category`}>Kind of work</Label>
        <NativeSelect id={`${idPrefix}-category`} value={v.category} onChange={(e) => set({ category: e.target.value as WorkCategory | '' })}>
          <option value="">Not specified</option>
          {WORK_CATEGORIES.map((c) => <option key={c} value={c}>{WORK_CATEGORY_LABEL[c]}</option>)}
        </NativeSelect>
      </div>
    </div>
  );
}

interface Fields {
  title: string;
  projectId: string;
  taskId: string;
  workType: WorkType | '';
  category: WorkCategory | '';
}
const EMPTY: Fields = { title: '', projectId: '', taskId: '', workType: '', category: '' };

function common(v: Fields) {
  return {
    ...(v.title.trim() ? { title: v.title.trim() } : {}),
    ...(v.taskId ? { taskId: v.taskId } : v.projectId ? { projectId: v.projectId } : {}),
    ...(v.workType ? { workType: v.workType } : {}),
    ...(v.category ? { category: v.category } : {}),
  };
}

/** FR-WT-013: the running timer (server clock), Pause / Stop / Resume, and starting new work. */
function TimerCard() {
  const timer = useTimer();
  const action = useTimerAction();
  const elapsed = useElapsed(timer.data);
  const [v, setV] = useState<Fields>(EMPTY);
  const running = timer.data?.running ?? null;
  const canStart = !!v.taskId || v.title.trim().length >= 2;

  return (
    <Card data-testid="work-timer">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Timer className="h-4 w-4" aria-hidden="true" /> Timer</CardTitle>
        <CardDescription>Start and stop times come from the server clock. Timers stop on their own when you clock out.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {timer.isPending ? <LoadingState label="Loading timer" rows={1} /> : null}
        {timer.isError ? <ErrorState error={timer.error} onRetry={() => void timer.refetch()} /> : null}
        {running ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3" aria-live="polite">
            <div className="min-w-0">
              <p className="truncate font-medium" data-testid="running-title">{workLabel(running)}</p>
              <p className="text-sm text-muted-foreground">
                {running.projectName ?? 'No project'}{running.workType ? ` · ${WORK_TYPE_LABEL[running.workType]}` : ''}{running.category ? ` · ${WORK_CATEGORY_LABEL[running.category]}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tabular-nums" data-testid="running-elapsed">{formatDuration(elapsed)}</span>
              <Button variant="outline" size="sm" onClick={() => action.mutate({ action: 'stop' })} disabled={action.isPending} aria-label="Pause timer">
                <Pause aria-hidden="true" /> Pause
              </Button>
              <Button variant="secondary" size="sm" onClick={() => action.mutate({ action: 'stop' })} disabled={action.isPending}>
                <Square aria-hidden="true" /> Stop
              </Button>
            </div>
          </div>
        ) : timer.data ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">No timer running.</p>
            <Button variant="outline" size="sm" onClick={() => action.mutate({ action: 'resume' })} disabled={action.isPending}>
              <Play aria-hidden="true" /> Resume last work
            </Button>
          </div>
        ) : null}

        <form
          className="space-y-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canStart) return;
            action.mutate({ action: 'startAny', dto: common(v) as StartTimerDto }, { onSuccess: () => setV(EMPTY) });
          }}
        >
          <WorkFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} idPrefix="timer" />
          <Button type="submit" disabled={!canStart || action.isPending}>
            <Play aria-hidden="true" /> {running ? 'Switch to this work' : 'Start timer'}
          </Button>
        </form>
        {action.isError ? <Alert variant="destructive"><AlertDescription>{action.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

/** FR-WT-017: work recorded under the person's own title, with start/end or a duration. */
function AddWorkCard() {
  const add = useAddManualEntry();
  const [v, setV] = useState<Fields>(EMPTY);
  const [date, setDate] = useState(() => toWorkDate(new Date()));
  const [mode, setMode] = useState<'times' | 'duration'>('times');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [minutes, setMinutes] = useState('60');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const valid = (v.title.trim().length >= 2 || !!v.taskId) && reason.trim().length >= 3 && (mode === 'duration' ? Number(minutes) > 0 : end > start);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add work</CardTitle>
        <CardDescription>
          For work you did without a timer. It is marked as manual, needs a reason, and counts toward your daily manual-time limit.
          Onsite visits outside Virtual-HR go under <Link className="text-primary underline-offset-4 hover:underline" href="/work-time/onsite">Onsite work</Link> for review instead.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const dto: ManualEntryDto = {
              workDate: date,
              ...(mode === 'times' ? { startTime: start, endTime: end } : { minutes: Number(minutes) }),
              ...common(v),
              note,
              reason: reason.trim(),
              billable: true,
            };
            setDone(false);
            add.mutate(dto, { onSuccess: () => { setDone(true); setV(EMPTY); setNote(''); setReason(''); } });
          }}
        >
          <WorkFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} idPrefix="add" />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-date">Day</Label>
              <Input id="add-date" type="date" value={date} max={toWorkDate(new Date())} min={toWorkDate(addDays(new Date(), -31))} onChange={(e) => setDate(e.target.value)} />
            </div>
            <fieldset className="space-y-1.5 sm:col-span-2">
              <legend className="text-sm font-medium">Time</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex items-center gap-1"><input type="radio" name="mode" checked={mode === 'times'} onChange={() => setMode('times')} /> Start and end</label>
                <label className="flex items-center gap-1"><input type="radio" name="mode" checked={mode === 'duration'} onChange={() => setMode('duration')} /> Duration</label>
              </div>
              {mode === 'times' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Start time" type="time" className="w-32" value={start} onChange={(e) => setStart(e.target.value)} />
                  <span aria-hidden="true">–</span>
                  <Input aria-label="End time" type="time" className="w-32" value={end} onChange={(e) => setEnd(e.target.value)} />
                </div>
              ) : (
                <Input aria-label="Minutes" type="number" min={1} max={1440} className="w-32" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              )}
            </fieldset>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-note">Notes (optional)</Label>
            <Textarea id="add-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-reason">Why are you adding this manually?</Label>
            <Input id="add-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Worked offline on the train" />
          </div>
          <Button type="submit" disabled={!valid || add.isPending}><Plus aria-hidden="true" /> Add work</Button>
          {add.isError ? <Alert variant="destructive"><AlertDescription>{add.error.message}</AlertDescription></Alert> : null}
          {done ? <p className="text-sm text-green-700 dark:text-green-400" role="status">Added. It appears in your timesheet as manual time.</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}

function TodayEntries() {
  const today = toWorkDate(new Date());
  const from = toWorkDate(addDays(new Date(), -6));
  const entries = useMyEntries(from, today);
  const byDay = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries.data?.items ?? []) m.set(e.workDate, [...(m.get(e.workDate) ?? []), e]);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries.data]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Last 7 days</CardTitle>
        <CardDescription>Your time entries. Edit or delete them on <Link className="text-primary underline-offset-4 hover:underline" href="/timesheets">My timesheet</Link> while it is open.</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.isPending ? <LoadingState label="Loading entries" rows={2} /> : null}
        {entries.isError ? <ErrorState error={entries.error} onRetry={() => void entries.refetch()} /> : null}
        {entries.data && entries.data.items.length === 0 ? <EmptyState title="No time recorded yet" description="Start a timer or add work above." /> : null}
        <div className="space-y-4" data-testid="recent-entries">
          {byDay.map(([day, items]) => (
            <section key={day} aria-label={day}>
              <h3 className="mb-1 text-sm font-medium">{day} · {minutesLabel(items.reduce((n, e) => n + e.minutes, 0))}</h3>
              <ul className="divide-y rounded-md border">
                {items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{workLabel(e)}{e.title && e.taskTitle ? <span className="font-normal text-muted-foreground"> · {e.taskTitle}</span> : null}</p>
                      <p className="text-xs text-muted-foreground">
                        {e.projectName ?? 'No project'}
                        {e.startedAt ? ` · ${formatClock(e.startedAt)}–${e.endedAt ? formatClock(e.endedAt) : 'now'}` : ''}
                        {e.taskTitleNow ? ` · task now called “${e.taskTitleNow}”` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="outline">{SOURCE_LABEL[e.source]}</Badge>
                      {e.workType ? <Badge variant="secondary">{WORK_TYPE_LABEL[e.workType]}</Badge> : null}
                      {e.category ? <Badge variant="secondary">{WORK_CATEGORY_LABEL[e.category]}</Badge> : null}
                      {e.running ? <Badge variant="success">Running</Badge> : <span className="tabular-nums">{minutesLabel(e.minutes)}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** ADR 049 §8: My work time. */
export default function WorkTimePage() {
  const canUse = useCan(Permission.TIMESHEETS_USE);
  if (!canUse) return <AccessDenied what="Work time" />;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">My work time</h1>
        <WorkTimeNav />
        <ActivityNote />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <TimerCard />
          <AddWorkCard />
        </div>
        <div className="space-y-6">
          <UpcomingMeetings />
          <TodayEntries />
        </div>
      </div>
    </div>
  );
}
