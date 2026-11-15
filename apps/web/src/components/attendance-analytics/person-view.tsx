'use client';

import { useState } from 'react';
import type { PersonAnalytics } from '@hrvo/shared';
import { EmptyState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AnalyticsDefinitions, PRESET_LABEL, PRESETS, presetRange, Stat, StatusCell, clock, dateTime, dur, periodLabel } from './shared';
import type { Preset } from './shared';

const STATE_LABEL: Record<string, string> = { ACTIVE: 'Active', IDLE: 'Idle', PAUSED: 'Paused', IN_MEETING: 'In a meeting', ON_BREAK: 'On a break', DISCONNECTED: 'Reconnecting', OFFLINE: 'Offline' };
const END_LABEL: Record<string, string> = { LEFT: 'Left the office', DROPPED: 'Connection lost', SERVER_RESTART: 'Server restarted (ended at the last time seen)' };

/** The date range control of the person pages. */
export function RangeControl({ range, onChange }: { range: { from: string; to: string }; onChange: (r: { from: string; to: string }) => void }) {
  const [preset, setPreset] = useState<Preset>('custom');
  return (
    <form className="flex flex-wrap items-end gap-3" aria-label="Period" onSubmit={(e) => e.preventDefault()}>
      <div className="space-y-1"><Label htmlFor="p-preset">Period</Label>
        <NativeSelect id="p-preset" value={preset} onChange={(e) => { const p = e.target.value as Preset; setPreset(p); if (p !== 'custom') onChange(presetRange(p)); }}>
          {PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
        </NativeSelect></div>
      <div className="space-y-1"><Label htmlFor="p-from">From</Label><Input id="p-from" type="date" value={range.from} onChange={(e) => { setPreset('custom'); onChange({ ...range, from: e.target.value }); }} /></div>
      <div className="space-y-1"><Label htmlFor="p-to">To</Label><Input id="p-to" type="date" value={range.to} onChange={(e) => { setPreset('custom'); onChange({ ...range, to: e.target.value }); }} /></div>
    </form>
  );
}

/**
 * FR-REP-009 (ADR 059): one person's attendance detail: totals, weekly and monthly summaries, each
 * day, the attendance timeline (states only), office connection intervals, meetings and
 * correction requests. Shown to HR and managers in scope, and to the person themselves.
 */
export function PersonAnalyticsView({ data }: { data: PersonAnalytics }) {
  const tz = data.timezone;
  const t = data.total;
  const nothing = t.daysWorked === 0 && t.officeSeconds === 0 && data.days.length === 0;
  return (
    <div className="space-y-4" data-testid="person-analytics">
      <AnalyticsDefinitions retentionDays={data.retentionDays} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="person-summary">
        <Stat label="Work attendance" value={dur(t.workSeconds)} hint={`${t.daysWorked} day${t.daysWorked === 1 ? '' : 's'} worked`} testId="person-total-work" />
        <Stat label="Meeting time" value={dur(t.meetingSeconds)} hint="part of work attendance" testId="person-total-meetings" />
        <Stat label="Office connected" value={dur(t.officeSeconds)} hint="not work time" testId="person-total-office" />
        <Stat label="Late / early leave" value={`${t.lateMinutes} / ${t.earlyLeaveMinutes} min`} />
      </div>
      {nothing ? <EmptyState title="Nothing recorded in this period" description="No attendance, office connection or meetings between these dates." /> : null}
      {data.officeDataFrom > data.from ? <p className="text-sm text-muted-foreground">Office connection times before {data.officeDataFrom} have been deleted (kept {data.retentionDays} days).</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Summary title="Weekly summary" rows={data.weeks} group="week" testId="person-weeks" />
        <Summary title="Monthly summary" rows={data.months} group="month" testId="person-months" />
      </div>

      <Card>
        <CardHeader><CardTitle>Days</CardTitle><CardDescription>Times in {tz}.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {data.days.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No days in this period.</p> : (
            <Table data-testid="person-days">
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>First check-in</TableHead><TableHead>Last check-out</TableHead><TableHead className="text-right">Work attendance</TableHead><TableHead className="text-right">Active</TableHead><TableHead className="text-right">Break</TableHead><TableHead className="text-right">Meeting time</TableHead><TableHead className="text-right">Office connected</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{data.days.map((d) => (
                <TableRow key={d.period}>
                  <TableCell className="whitespace-nowrap">{periodLabel(d.period, 'day')}</TableCell>
                  <TableCell className="tabular-nums">{clock(d.firstIn, tz)}</TableCell>
                  <TableCell className="tabular-nums">{d.status === 'IN_PROGRESS' ? 'Still in' : clock(d.lastOut, tz)}</TableCell>
                  <TableCell className="text-right tabular-nums">{dur(d.workSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{dur(d.activeSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{dur(d.breakSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{dur(d.meetingSeconds)}</TableCell>
                  <TableCell className="text-right tabular-nums">{dur(d.officeSeconds)}</TableCell>
                  <TableCell><StatusCell row={d} />{d.lateMinutes ? <span className="ml-1 text-xs text-muted-foreground">{d.lateMinutes} min late</span> : null}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Attendance timeline</CardTitle><CardDescription>Each state the attendance engine recorded. No location, device or activity detail.</CardDescription></CardHeader>
          <CardContent>
            {data.segments.length === 0 ? <p className="text-sm text-muted-foreground">No attendance recorded.</p> : (
              <ol className="max-h-96 space-y-1 overflow-y-auto text-sm" data-testid="person-segments">
                {data.segments.map((s, i) => (
                  <li key={`${s.startedAt}-${i}`} className="flex flex-wrap justify-between gap-2 border-b py-1 last:border-0">
                    <span>{STATE_LABEL[s.state] ?? s.state}</span>
                    <span className="tabular-nums text-muted-foreground">{dateTime(s.startedAt, tz)} – {s.endedAt ? clock(s.endedAt, tz) : 'now'} · {dur(s.seconds)}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Office connections</CardTitle><CardDescription>When the person was connected to the virtual office. Not work time.</CardDescription></CardHeader>
          <CardContent>
            {data.office.length === 0 ? <p className="text-sm text-muted-foreground">No office connection in this period.</p> : (
              <ol className="max-h-96 space-y-1 overflow-y-auto text-sm" data-testid="person-office">
                {data.office.map((o) => (
                  <li key={o.startedAt} className="flex flex-wrap justify-between gap-2 border-b py-1 last:border-0">
                    <span className="tabular-nums">{dateTime(o.startedAt, tz)} – {o.endedAt ? clock(o.endedAt, tz) : 'connected'}</span>
                    <span className="text-muted-foreground">{dur(o.seconds)}{o.open ? <Badge className="ml-2" variant="default">Connected</Badge> : o.endReason ? ` · ${END_LABEL[o.endReason] ?? o.endReason}` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Meetings</CardTitle><CardDescription>{data.self ? 'Your meetings. Reconnects are counted once.' : 'Meeting titles are shown only to the person. Reconnects are counted once.'}</CardDescription></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {data.meetings.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No meetings in this period.</p> : (
              <Table data-testid="person-meetings">
                <TableHeader><TableRow><TableHead>Meeting</TableHead><TableHead>Joined</TableHead><TableHead>Left</TableHead><TableHead className="text-right">Time</TableHead></TableRow></TableHeader>
                <TableBody>{data.meetings.map((m) => (
                  <TableRow key={m.meetingId}>
                    <TableCell>{m.title ?? ({ INSTANT: 'Call', ROOM: 'Office room call', SCHEDULED: 'Scheduled meeting' } as Record<string, string>)[m.kind] ?? 'Meeting'}</TableCell>
                    <TableCell className="tabular-nums">{dateTime(m.firstJoinedAt, tz)}</TableCell>
                    <TableCell className="tabular-nums">{m.open ? <span title="The server never saw the person leave; counted until the meeting ended">Not recorded</span> : clock(m.lastLeftAt, tz)}</TableCell>
                    <TableCell className="text-right tabular-nums">{dur(m.seconds)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Correction requests</CardTitle></CardHeader>
          <CardContent>
            {data.corrections.length === 0 ? <p className="text-sm text-muted-foreground">No correction requests in this period.</p> : (
              <ul className="space-y-1 text-sm" data-testid="person-corrections">
                {data.corrections.map((c) => (
                  <li key={c.id} className="flex flex-wrap justify-between gap-2 border-b py-1 last:border-0">
                    <span className="tabular-nums">{dateTime(c.requestedIn, tz)} – {clock(c.requestedOut, tz)}</span>
                    <Badge variant={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'destructive' : 'secondary'}>{c.status.charAt(0) + c.status.slice(1).toLowerCase()}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Summary({ title, rows, group, testId }: { title: string; rows: PersonAnalytics['weeks']; group: 'week' | 'month'; testId: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nothing recorded.</p> : (
          <Table data-testid={testId}>
            <TableHeader><TableRow><TableHead>{group === 'week' ? 'Week' : 'Month'}</TableHead><TableHead className="text-right">Days</TableHead><TableHead className="text-right">Work attendance</TableHead><TableHead className="text-right">Meeting time</TableHead><TableHead className="text-right">Office connected</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((r) => (
              <TableRow key={r.period}>
                <TableCell className="whitespace-nowrap">{periodLabel(r.period, group)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.daysWorked}</TableCell>
                <TableCell className="text-right tabular-nums">{dur(r.workSeconds)}</TableCell>
                <TableCell className="text-right tabular-nums">{dur(r.meetingSeconds)}</TableCell>
                <TableCell className="text-right tabular-nums">{dur(r.officeSeconds)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
