'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Play, Square, Timer } from 'lucide-react';
import type { TimerState } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Permission, useCan } from '@/lib/permissions';
import { useTimer, useTimerAction } from '@/lib/timesheet-queries';
import { formatDuration } from '@/lib/format';

/**
 * Seconds the running timer has run, by the SERVER clock: the offset between serverNow and
 * the local clock at fetch time corrects a wrong local clock (times are never sent back).
 */
function useElapsed(state: TimerState | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (state) setOffset(Date.parse(state.serverNow) - Date.now());
  }, [state]);
  const running = state?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!running?.startedAt) return 0;
  return Math.max(0, (now + offset - Date.parse(running.startedAt)) / 1000);
}

/** FR-TS-003 on the task page: start / stop, and which other task is running. */
export function TaskTimerCard({ taskId, canLog, blockedReason }: { taskId: string; canLog: boolean; blockedReason?: string }) {
  const allowed = useCan(Permission.TIMESHEETS_USE);
  const timer = useTimer(allowed);
  const action = useTimerAction();
  const elapsed = useElapsed(timer.data);
  if (!allowed) return null;
  const running = timer.data?.running ?? null;
  const here = running?.taskId === taskId;

  return (
    <Card data-testid="task-timer">
      <CardHeader><CardTitle className="text-base">Timer</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {here ? (
          <p aria-live="polite">Running for <span className="font-medium tabular-nums" data-testid="timer-elapsed">{formatDuration(elapsed)}</span></p>
        ) : running ? (
          <p className="text-muted-foreground">Running on <Link className="text-primary underline-offset-4 hover:underline" href={`/tasks/${running.taskId}`}>{running.taskTitle ?? 'another task'}</Link>. Starting here stops it.</p>
        ) : (
          <p className="text-muted-foreground">Not running. Timers stop on their own when you clock out.</p>
        )}
        {here ? (
          <Button variant="outline" onClick={() => action.mutate({ action: 'stop', taskId })} disabled={action.isPending}>
            <Square aria-hidden="true" /> Stop timer
          </Button>
        ) : (
          <Button onClick={() => action.mutate({ action: 'start', taskId })} disabled={!canLog || action.isPending || timer.isPending}>
            <Play aria-hidden="true" /> Start timer
          </Button>
        )}
        {!canLog && blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
        {action.isError ? <Alert variant="destructive"><AlertDescription>{action.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

/** Header indicator for the running timer, with a one-click stop. */
export function TimerBadge() {
  const allowed = useCan(Permission.TIMESHEETS_USE);
  const timer = useTimer(allowed);
  const action = useTimerAction();
  const elapsed = useElapsed(timer.data);
  const running = timer.data?.running;
  if (!allowed || !running) return null;
  return (
    <div className="hidden items-center gap-1 rounded-md border px-2 py-1 text-sm lg:flex" data-testid="timer-badge">
      <Timer className="h-4 w-4 text-primary" aria-hidden="true" />
      <Link href={`/tasks/${running.taskId}`} className="max-w-40 truncate hover:underline" title={running.taskTitle ?? undefined}>
        {running.taskTitle ?? 'Task'}
      </Link>
      <span className="tabular-nums text-muted-foreground">{formatDuration(elapsed)}</span>
      <Button variant="ghost" size="sm" className="h-7 px-2" aria-label="Stop timer" onClick={() => action.mutate({ action: 'stop' })} disabled={action.isPending}>
        <Square aria-hidden="true" />
      </Button>
    </div>
  );
}
