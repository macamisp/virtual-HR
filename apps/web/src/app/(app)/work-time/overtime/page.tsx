'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import type { OvertimeRequestDto } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ActivityNote, WorkTimeNav } from '@/components/work-time/work-time-nav';
import { ProjectTaskPicker } from '@/components/work-time/request-parts';
import { OvertimeRow } from '@/components/work-time/request-rows';
import { Permission, useCan } from '@/lib/permissions';
import { useOvertimeRequests, useRequestOvertime } from '@/lib/work-request-queries';
import { toWorkDate } from '@/lib/format';

function RequestForm() {
  const submit = useRequestOvertime();
  const [date, setDate] = useState(() => toWorkDate(new Date()));
  const [mode, setMode] = useState<'times' | 'duration'>('times');
  const [start, setStart] = useState('17:00');
  const [end, setEnd] = useState('19:00');
  const [minutes, setMinutes] = useState('120');
  const [work, setWork] = useState({ projectId: '', taskId: '' });
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [sent, setSent] = useState(false);
  const valid = description.trim().length >= 3 && reason.trim().length >= 3 && (mode === 'duration' ? Number(minutes) >= 15 : end > start);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Request overtime</CardTitle>
        <CardDescription>Ask before you work extra hours, or report them afterwards (up to 14 days back). Your manager or HR decides; nobody approves their own.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const dto: OvertimeRequestDto = {
              workDate: date,
              ...(mode === 'times' ? { plannedStart: start, plannedEnd: end } : { minutes: Number(minutes) }),
              ...(work.taskId ? { taskId: work.taskId } : work.projectId ? { projectId: work.projectId } : {}),
              workDescription: description.trim(),
              reason: reason.trim(),
              notes,
            };
            setSent(false);
            submit.mutate(dto, { onSuccess: () => { setSent(true); setDescription(''); setReason(''); setNotes(''); } });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ot-date">Day</Label>
              <Input id="ot-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <fieldset className="space-y-1.5 sm:col-span-2">
              <legend className="text-sm font-medium">Planned time</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                <label className="flex items-center gap-1"><input type="radio" name="ot-mode" checked={mode === 'times'} onChange={() => setMode('times')} /> Start and end</label>
                <label className="flex items-center gap-1"><input type="radio" name="ot-mode" checked={mode === 'duration'} onChange={() => setMode('duration')} /> Duration</label>
              </div>
              {mode === 'times' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Start time" type="time" className="w-32" value={start} onChange={(e) => setStart(e.target.value)} />
                  <span aria-hidden="true">–</span>
                  <Input aria-label="End time" type="time" className="w-32" value={end} onChange={(e) => setEnd(e.target.value)} />
                </div>
              ) : (
                <Input aria-label="Minutes" type="number" min={15} max={720} step={15} className="w-32" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              )}
            </fieldset>
          </div>
          <ProjectTaskPicker projectId={work.projectId} taskId={work.taskId} onChange={setWork} idPrefix="ot" />
          <div className="space-y-1.5">
            <Label htmlFor="ot-description">Work to be done</Label>
            <Input id="ot-description" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Production release support" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ot-reason">Why is overtime needed?</Label>
            <Input id="ot-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The release window is after hours" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ot-notes">Notes (optional)</Label>
            <Textarea id="ot-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Button type="submit" disabled={!valid || submit.isPending}><Send aria-hidden="true" /> Send request</Button>
          {submit.isError ? <Alert variant="destructive"><AlertDescription>{submit.error.message}</AlertDescription></Alert> : null}
          {sent ? <p role="status" className="text-sm text-green-700 dark:text-green-400">Sent. Your manager has been told.</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** ADR 049 §2 (FR-WT-007, FR-WT-009): my overtime requests and their history. */
export default function OvertimePage() {
  const canUse = useCan(Permission.TIMESHEETS_USE);
  const mine = useOvertimeRequests('mine', undefined, canUse);
  if (!canUse) return <AccessDenied what="Overtime requests" />;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Overtime</h1>
        <WorkTimeNav />
        <p className="text-sm text-muted-foreground">
          Three different numbers: <strong>worked</strong> overtime is calculated from your attendance and schedule, <strong>requested</strong> is what you ask for,
          and <strong>approved</strong> is what your manager agreed. Requesting overtime does not make it approved or payable by itself.
        </p>
        <ActivityNote />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <RequestForm />
        <Card>
          <CardHeader><CardTitle className="text-base">My requests</CardTitle></CardHeader>
          <CardContent>
            {mine.isPending ? <LoadingState label="Loading requests" rows={2} /> : null}
            {mine.isError ? <ErrorState error={mine.error} onRetry={() => void mine.refetch()} /> : null}
            {mine.data && mine.data.items.length === 0 ? <EmptyState title="No overtime requests yet" /> : null}
            {mine.data && mine.data.items.length > 0 ? <ul className="divide-y rounded-md border" data-testid="my-overtime">{mine.data.items.map((r) => <OvertimeRow key={r.id} r={r} />)}</ul> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
