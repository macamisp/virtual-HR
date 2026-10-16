'use client';

import { useId, useState } from 'react';
import { FLAG_META } from '@hrvo/shared';
import type { AttendanceFlag, FlagResolution } from '@hrvo/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime, formatWorkDate } from '@/lib/format';
import { useCommentFlag, useResolveFlag } from '@/lib/flag-queries';

const CATEGORY: Record<AttendanceFlag['category'], string> = { SPOOFING: 'Signal check', NETWORK: 'Network policy', DEVICE: 'Devices', OFFLINE: 'Offline time', SESSION: 'Session' };
const RESOLUTION: Record<FlagResolution, string> = { NO_ACTION: 'No action needed', FOLLOW_UP: 'Followed up with the person' };

/** The evidence in words, from the fields each check records. Only known fields are shown. */
function evidence(f: AttendanceFlag): string[] {
  const d = f.details;
  const out: string[] = [];
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  if (str('ip')) out.push(`IP address ${str('ip')}${str('country') ? ` (${str('country')})` : ''}`);
  if (str('from') && str('to') && num('km') !== null) out.push(`${str('from')} to ${str('to')}: about ${num('km')!.toLocaleString()} km, implying ${num('kmh')!.toLocaleString()} km/h`);
  if (num('count') !== null && num('windowMinutes') !== null) out.push(`${num('count')} times within ${num('windowMinutes')} minutes`);
  if (num('activeSeconds') !== null && str('from')) out.push(`${Math.round(num('activeSeconds')! / 60)} min active, ${formatDateTime(str('from'))} – ${formatDateTime(str('to'))}`);
  if (Array.isArray(d.devices)) out.push(`${(d.devices as unknown[]).length} devices`);
  return out;
}

function ResolveForm({ flag }: { flag: AttendanceFlag }) {
  const resolve = useResolveFlag();
  const [resolution, setResolution] = useState<FlagResolution>('NO_ACTION');
  const [note, setNote] = useState('');
  const ids = { r: useId(), n: useId() };
  return (
    <form className="space-y-2 border-t pt-2" aria-label={`Resolve: ${FLAG_META[flag.kind].label}`} onSubmit={(e) => { e.preventDefault(); resolve.mutate({ id: flag.id, dto: { resolution, note } }); }}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label htmlFor={ids.r}>Outcome</Label>
          <NativeSelect id={ids.r} value={resolution} onChange={(e) => setResolution(e.target.value as FlagResolution)}>
            <option value="NO_ACTION">{RESOLUTION.NO_ACTION}</option><option value="FOLLOW_UP">{RESOLUTION.FOLLOW_UP}</option>
          </NativeSelect></div>
      </div>
      <div className="space-y-1"><Label htmlFor={ids.n}>Note for the record</Label><Textarea id={ids.n} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {resolve.isError ? <p role="alert" className="text-sm text-destructive">{resolve.error.message}</p> : null}
      <Button size="sm" type="submit" disabled={resolve.isPending || note.trim().length < 3}>Resolve</Button>
    </form>
  );
}

function CommentForm({ flag }: { flag: AttendanceFlag }) {
  const comment = useCommentFlag();
  const [text, setText] = useState(flag.userComment ?? '');
  const id = useId();
  return (
    <form className="space-y-1 border-t pt-2" onSubmit={(e) => { e.preventDefault(); comment.mutate({ id: flag.id, dto: { comment: text } }); }}>
      <Label htmlFor={id}>Your explanation (optional)</Label>
      <Textarea id={id} rows={2} maxLength={2000} value={text} placeholder="For example: I was on a VPN" onChange={(e) => setText(e.target.value)} />
      {comment.isError ? <p role="alert" className="text-sm text-destructive">{comment.error.message}</p> : null}
      {comment.isSuccess ? <p role="status" className="text-xs text-muted-foreground">Saved.</p> : null}
      <Button size="sm" variant="outline" type="submit" disabled={comment.isPending || !text.trim()}>Save explanation</Button>
    </form>
  );
}

/** One review flag: what was seen, in plain words, and the evidence. Never a penalty. */
export function FlagCard({ flag, mine }: { flag: AttendanceFlag; mine?: boolean }) {
  const meta = FLAG_META[flag.kind];
  const facts = evidence(flag);
  return (
    <li className="space-y-2 rounded border p-3" data-testid="flag" data-kind={flag.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{meta.label}</span>
        <Badge variant="outline">{CATEGORY[flag.category]}</Badge>
        {flag.status === 'RESOLVED' ? <Badge variant="secondary">Resolved</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground">{formatWorkDate(flag.workDate)} · raised {formatDateTime(flag.createdAt)}</span>
      </div>
      {!mine ? <p className="text-sm">{flag.person.displayName ?? flag.person.email}</p> : null}
      <p className="text-sm text-muted-foreground">{meta.explanation} Nothing was changed or deducted.</p>
      {facts.length ? <ul className="list-inside list-disc text-sm">{facts.map((x) => <li key={x}>{x}</li>)}</ul> : null}
      {flag.userComment && !mine ? <p className="rounded bg-muted p-2 text-sm"><span className="font-medium">Their explanation:</span> {flag.userComment}</p> : null}
      {flag.status === 'RESOLVED' ? (
        <p className="text-sm"><span className="font-medium">{RESOLUTION[flag.resolution!]}</span> by {flag.resolvedBy?.displayName ?? 'a reviewer'} on {formatDateTime(flag.resolvedAt)}: {flag.resolutionNote}</p>
      ) : null}
      {flag.canResolve ? <ResolveForm flag={flag} /> : null}
      {mine && flag.status === 'OPEN' ? <CommentForm flag={flag} /> : null}
    </li>
  );
}
