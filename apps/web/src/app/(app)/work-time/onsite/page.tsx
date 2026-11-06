'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ActivityNote, WorkTimeNav } from '@/components/work-time/work-time-nav';
import { ProjectTaskPicker, WhichFormHint } from '@/components/work-time/request-parts';
import { OnsiteRow } from '@/components/work-time/request-rows';
import { Permission, useCan } from '@/lib/permissions';
import { useOnsiteRequests, useRequestOnsite } from '@/lib/work-request-queries';
import { addDays, toWorkDate } from '@/lib/format';

/** ADR 049 §7 (FR-WT-023, FR-WT-024): onsite work done without Virtual-HR, sent for review. */
export default function OnsitePage() {
  const canUse = useCan(Permission.TIMESHEETS_USE);
  const mine = useOnsiteRequests('mine', undefined, canUse);
  const submit = useRequestOnsite();
  const [date, setDate] = useState(() => toWorkDate(addDays(new Date(), -1)));
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [location, setLocation] = useState('');
  const [work, setWork] = useState({ projectId: '', taskId: '' });
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);
  if (!canUse) return <AccessDenied what="Onsite work" />;
  const valid = end > start && location.trim().length >= 3 && description.trim().length >= 3 && reason.trim().length >= 3;
  const span = end > start ? (Number(end.slice(0, 2)) * 60 + Number(end.slice(3))) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3))) : 0;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Onsite work</h1>
        <WorkTimeNav />
        <ActivityNote />
      </div>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Report onsite work</CardTitle>
            <CardDescription>
              For work at a client or site when you were not using Virtual-HR. Your manager or HR reviews it. Approved time is added to your timesheet as
              onsite work; it is never turned into attendance.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <WhichFormHint />
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                setSent(false);
                submit.mutate({
                  workDate: date, startTime: start, endTime: end, location: location.trim(),
                  ...(work.taskId ? { taskId: work.taskId } : work.projectId ? { projectId: work.projectId } : {}),
                  description: description.trim(), reason: reason.trim(),
                }, { onSuccess: () => { setSent(true); setDescription(''); setReason(''); } });
              }}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="os-date">Day</Label>
                  <Input id="os-date" type="date" value={date} max={toWorkDate(new Date())} min={toWorkDate(addDays(new Date(), -30))} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="os-start">Start</Label>
                  <Input id="os-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="os-end">End</Label>
                  <Input id="os-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground" aria-live="polite">Duration: {span > 0 ? `${Math.floor(span / 60)} h ${span % 60} min` : '—'} (times in your organisation&apos;s time zone)</p>
              <div className="space-y-1.5">
                <Label htmlFor="os-location">Onsite or client location</Label>
                <Input id="os-location" value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Client HQ, Colombo 03" />
              </div>
              <ProjectTaskPicker projectId={work.projectId} taskId={work.taskId} onChange={setWork} idPrefix="os" />
              <div className="space-y-1.5">
                <Label htmlFor="os-description">What did you do?</Label>
                <Textarea id="os-description" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="os-reason">Why was it not recorded in Virtual-HR?</Label>
                <Input id="os-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No laptop on site" />
              </div>
              <Button type="submit" disabled={!valid || submit.isPending}><Send aria-hidden="true" /> Send for review</Button>
              {submit.isError ? <Alert variant="destructive"><AlertDescription>{submit.error.message}</AlertDescription></Alert> : null}
              {sent ? <p role="status" className="text-sm text-green-700 dark:text-green-400">Sent for review.</p> : null}
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">My onsite reports</CardTitle></CardHeader>
          <CardContent>
            {mine.isPending ? <LoadingState label="Loading" rows={2} /> : null}
            {mine.isError ? <ErrorState error={mine.error} onRetry={() => void mine.refetch()} /> : null}
            {mine.data && mine.data.items.length === 0 ? <EmptyState title="Nothing reported yet" /> : null}
            {mine.data && mine.data.items.length > 0 ? <ul className="divide-y rounded-md border" data-testid="my-onsite">{mine.data.items.map((r) => <OnsiteRow key={r.id} r={r} />)}</ul> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
