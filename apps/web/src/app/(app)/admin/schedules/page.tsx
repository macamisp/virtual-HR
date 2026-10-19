'use client';

import { useId, useState } from 'react';
import { CalendarClock, Save, Square } from 'lucide-react';
import { WEEKDAYS, WEEKDAY_LABEL, scopeKey } from '@hrvo/shared';
import type { Schedule, ScheduleDay, ScheduleOverview, ScheduleScope, Weekday } from '@hrvo/shared';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { formatWorkDate } from '@/lib/format';
import { useScheduleMutations, useSchedules } from '@/lib/schedule-queries';
import { Permission, useCan } from '@/lib/permissions';

const DEFAULT_DAY: ScheduleDay = { start: '09:00', end: '17:00', expectedHours: 8 };
const inForce = (s: Schedule, day: string) => s.effectiveFrom <= day && (!s.effectiveTo || s.effectiveTo >= day);
const describe = (s: Schedule) => {
  const days = WEEKDAYS.filter((d) => s.days[d]);
  const first = days[0] ? s.days[days[0]]! : null;
  const hours = days.reduce((sum, d) => sum + (s.days[d]?.expectedHours ?? 0), 0);
  return `${days.map((d) => WEEKDAY_LABEL[d].slice(0, 3)).join(', ')}${first ? ` · ${first.start}–${first.end}` : ''} · ${hours} h a week${s.flexible ? ' · flexible' : ''}`;
};

type Row = { works: boolean } & ScheduleDay;

function Editor({ scope, data, current, onSaved }: { scope: ScheduleScope; data: ScheduleOverview; current: Schedule | null; onSaved: (m: string) => void }) {
  const { set, end } = useScheduleMutations();
  const [rows, setRows] = useState<Record<Weekday, Row>>(() => Object.fromEntries(WEEKDAYS.map((d) => {
    const day = current?.days[d];
    return [d, day ? { works: true, ...day } : { works: !current && Number(d) <= 5, ...DEFAULT_DAY }];
  })) as Record<Weekday, Row>);
  const [flexible, setFlexible] = useState(current?.flexible ?? false);
  const [late, setLate] = useState(String(current?.lateGraceMinutes ?? 10));
  const [sameGrace, setSameGrace] = useState(current ? current.earlyLeaveGraceMinutes === null : true);
  const [early, setEarly] = useState(String(current?.earlyLeaveGraceMinutes ?? current?.lateGraceMinutes ?? 10));
  const [allowance, setAllowance] = useState(current?.breakAllowanceMinutes === null || current?.breakAllowanceMinutes === undefined ? '' : String(current.breakAllowanceMinutes));
  const [from, setFrom] = useState(data.today);
  const ids = { flex: useId(), late: useId(), same: useId(), early: useId(), allow: useId(), from: useId() };
  const update = (d: Weekday, patch: Partial<Row>) => setRows((r) => ({ ...r, [d]: { ...r[d], ...patch } }));
  const working = WEEKDAYS.filter((d) => rows[d].works);
  const save = () => set.mutate({
    scope,
    days: Object.fromEntries(working.map((d) => [d, { start: rows[d].start, end: rows[d].end, expectedHours: Number(rows[d].expectedHours) }])),
    flexible,
    lateGraceMinutes: Number(late),
    earlyLeaveGraceMinutes: sameGrace ? null : Number(early),
    breakAllowanceMinutes: allowance.trim() === '' ? null : Number(allowance),
    effectiveFrom: from,
  }, { onSuccess: (s) => onSaved(`Saved. The schedule applies from ${formatWorkDate(s.effectiveFrom)}.`) });
  const error = set.error ?? end.error;
  return (
    <form className="space-y-4" aria-label="Work schedule" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Working days</legend>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2 font-normal">Day</th><th className="pr-2 font-normal">Start</th><th className="pr-2 font-normal">End</th><th className="font-normal">Expected hours</th></tr></thead>
            <tbody>
              {WEEKDAYS.map((d) => (
                <tr key={d} data-testid={`day-${d}`}>
                  <td className="py-1 pr-2"><label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4" checked={rows[d].works} onChange={(e) => update(d, { works: e.target.checked })} />{WEEKDAY_LABEL[d]}</label></td>
                  <td className="pr-2"><Input type="time" aria-label={`${WEEKDAY_LABEL[d]} start`} disabled={!rows[d].works} value={rows[d].start} onChange={(e) => update(d, { start: e.target.value })} className="h-8" /></td>
                  <td className="pr-2"><Input type="time" aria-label={`${WEEKDAY_LABEL[d]} end`} disabled={!rows[d].works} value={rows[d].end} onChange={(e) => update(d, { end: e.target.value })} className="h-8" /></td>
                  <td><Input type="number" aria-label={`${WEEKDAY_LABEL[d]} expected hours`} min={0.25} max={24} step={0.25} disabled={!rows[d].works} value={rows[d].expectedHours} onChange={(e) => update(d, { expectedHours: Number(e.target.value) })} className="h-8 w-24" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>
      <label htmlFor={ids.flex} className="flex items-start gap-2 text-sm">
        <input id={ids.flex} type="checkbox" className="mt-0.5 h-4 w-4" checked={flexible} onChange={(e) => setFlexible(e.target.checked)} />
        <span><span className="font-medium">Flexible hours</span><span className="block text-muted-foreground">Expected hours still count and a working day without attendance is absent, but nobody is flagged late or leaving early.</span></span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label htmlFor={ids.late}>Late-arrival grace (minutes)</Label><Input id={ids.late} type="number" min={0} max={240} required disabled={flexible} value={late} onChange={(e) => setLate(e.target.value)} /></div>
        <div className="space-y-1">
          <Label htmlFor={ids.early}>Early-leave grace (minutes)</Label>
          <Input id={ids.early} type="number" min={0} max={240} required disabled={flexible || sameGrace} value={sameGrace ? late : early} onChange={(e) => setEarly(e.target.value)} />
          <label htmlFor={ids.same} className="flex items-center gap-2 text-xs text-muted-foreground"><input id={ids.same} type="checkbox" className="h-3.5 w-3.5" checked={sameGrace} onChange={(e) => setSameGrace(e.target.checked)} />Same as late arrival</label>
        </div>
        <div className="space-y-1"><Label htmlFor={ids.allow}>Break allowance per day (minutes)</Label><Input id={ids.allow} type="number" min={0} max={600} placeholder="No limit" value={allowance} onChange={(e) => setAllowance(e.target.value)} /><p className="text-xs text-muted-foreground">Breaks beyond it are flagged; net time does not change.</p></div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor={ids.from}>Applies from</Label><Input id={ids.from} type="date" min={data.today} required value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <Button type="submit" disabled={set.isPending || !working.length}><Save aria-hidden="true" /> {set.isPending ? 'Saving…' : 'Save schedule'}</Button>
        {current && scope.kind !== 'ORG' ? (
          <Button type="button" variant="outline" disabled={end.isPending} onClick={() => end.mutate({ scope, effectiveFrom: from }, { onSuccess: () => onSaved(`Stopped from ${formatWorkDate(from)}; the ${scope.kind === 'USER' ? 'team or organisation' : 'organisation'} schedule applies.`) })}>
            <Square aria-hidden="true" /> Stop this schedule
          </Button>
        ) : null}
      </div>
      {!working.length ? <p className="text-sm text-destructive">Choose at least one working day.</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert> : null}
    </form>
  );
}

/** FR-ORG-005 (ADR 032): HR edits the organisation default and team or personal schedules. */
export default function SchedulesPage() {
  const allowed = useCan(Permission.SCHEDULES_MANAGE);
  const overview = useSchedules(allowed);
  const [kind, setKind] = useState<ScheduleScope['kind']>('ORG');
  const [teamId, setTeamId] = useState('');
  const [userId, setUserId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const ids = { kind: useId(), team: useId(), user: useId() };
  const data = overview.data;
  const scope: ScheduleScope | null = kind === 'ORG' ? { kind } : kind === 'TEAM' ? (teamId ? { kind, teamId } : null) : userId ? { kind, userId } : null;
  const versions = data && scope ? data.schedules.filter((s) => scopeKey(s.scope) === scopeKey(scope)) : [];
  if (!allowed) return <AccessDenied what="Work schedules" />;
  const current = data ? versions.find((s) => inForce(s, data.today)) ?? null : null;
  const upcoming = data ? versions.filter((s) => s.effectiveFrom > data.today) : [];
  // Which schedule a person actually works to today.
  const applies = (() => {
    if (!data || kind !== 'USER' || !userId) return null;
    const person = data.people.find((p) => p.id === userId);
    const own = data.schedules.find((s) => s.scope.kind === 'USER' && s.scope.userId === userId && inForce(s, data.today));
    if (own) return 'their own schedule';
    const team = person?.teamId ? data.schedules.find((s) => s.scope.kind === 'TEAM' && s.scope.teamId === person.teamId && inForce(s, data.today)) : undefined;
    if (team) return `the ${data.teams.find((t) => t.id === person?.teamId)?.name ?? 'team'} team schedule`;
    return data.schedules.some((s) => s.scope.kind === 'ORG' && inForce(s, data.today)) ? 'the organisation default' : 'no schedule (no expected hours)';
  })();
  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold"><CalendarClock className="h-6 w-6" aria-hidden="true" /> Work schedules</h1>
      {message ? <Alert><AlertDescription role="status">{message}</AlertDescription></Alert> : null}
      {overview.isPending ? <LoadingState label="Loading schedules" /> : null}
      {overview.isError ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : null}
      {data ? (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Whose schedule</CardTitle><CardDescription>A person&apos;s own schedule wins over their team&apos;s, which wins over the organisation default. Changes apply from a date you choose (today or later); past days keep the schedule they had.</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1"><Label htmlFor={ids.kind}>Schedule for</Label>
                <NativeSelect id={ids.kind} value={kind} onChange={(e) => { setKind(e.target.value as ScheduleScope['kind']); setMessage(null); }}>
                  <option value="ORG">The whole organisation (default)</option><option value="TEAM">A team</option><option value="USER">One person</option>
                </NativeSelect></div>
              {kind === 'TEAM' ? <div className="space-y-1"><Label htmlFor={ids.team}>Team</Label><NativeSelect id={ids.team} value={teamId} onChange={(e) => setTeamId(e.target.value)}><option value="">Choose a team</option>{data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</NativeSelect></div> : null}
              {kind === 'USER' ? <div className="space-y-1"><Label htmlFor={ids.user}>Person</Label><NativeSelect id={ids.user} value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Choose a person</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.email}</option>)}</NativeSelect></div> : null}
            </CardContent>
          </Card>
          {scope ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Schedule</CardTitle>
                <CardDescription data-testid="schedule-current">
                  {current ? <>In force since {formatWorkDate(current.effectiveFrom)}{current.effectiveTo ? ` until ${formatWorkDate(current.effectiveTo)}` : ''}: {describe(current)}.</> : 'No schedule of its own yet.'}
                  {applies ? <> Today this person works to {applies}.</> : null}
                </CardDescription>
                {upcoming.map((u) => <p key={u.id} className="text-sm"><Badge variant="secondary">From {formatWorkDate(u.effectiveFrom)}</Badge> {describe(u)}</p>)}
              </CardHeader>
              <CardContent><Editor key={`${scopeKey(scope)}:${current?.id ?? 'none'}:${upcoming.length}`} scope={scope} data={data} current={upcoming.at(-1) ?? current} onSaved={setMessage} /></CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
