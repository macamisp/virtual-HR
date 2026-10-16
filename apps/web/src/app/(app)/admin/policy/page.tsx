'use client';

import { useEffect, useState } from 'react';
import { POLICY_LIMITS } from '@hrvo/shared';
import type { OrgPolicy } from '@hrvo/shared';
import { FormField } from '@/components/form-field';
import { ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePolicy, useSavePolicy } from '@/lib/admin-queries';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAttendanceGuards, useSaveAttendanceGuards } from '@/lib/flag-queries';
import type { AttendanceGuards } from '@hrvo/shared';

const lines = (v: string) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/**
 * ADR 019 (FR-ATT-017/018/021/023): network lists only FLAG for review (never block); empty lists
 * switch the network policy off. Countries come from Cloudflare's country header.
 */
function SafeguardsForm() {
  const guards = useAttendanceGuards(true);
  const save = useSaveAttendanceGuards();
  const [g, setG] = useState<{ cidrs: string; countries: string; challenge: boolean; idle: string; flags: string; reminder: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (guards.data) setG({ cidrs: guards.data.allowedCidrs.join('\n'), countries: guards.data.allowedCountries.join(', '), challenge: guards.data.presenceChallenge, idle: String(guards.data.longIdleAlertMinutes), flags: String(guards.data.flagAlertThreshold), reminder: guards.data.noClockInReminder });
  }, [guards.data]);
  if (guards.isPending) return <LoadingState label="Loading safeguards" rows={2} />;
  if (guards.isError) return <ErrorState error={guards.error} onRetry={() => void guards.refetch()} />;
  if (!g) return null;
  const dto: AttendanceGuards = { allowedCidrs: lines(g.cidrs), allowedCountries: lines(g.countries).map((c) => c.toUpperCase()), presenceChallenge: g.challenge, longIdleAlertMinutes: Number(g.idle) || 0, flagAlertThreshold: Number(g.flags) || 0, noClockInReminder: g.reminder };
  return (
    <form aria-label="Attendance safeguards" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(dto, { onSuccess: () => setSaved(true) }); }}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attendance safeguards</CardTitle>
          <CardDescription>Checks only raise items for a person to review in Attendance review. They never block anyone or change recorded time.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="guard-cidrs">Allowed IP ranges (one per line; empty = any)</Label>
            <Textarea id="guard-cidrs" rows={3} value={g.cidrs} placeholder="203.0.113.0/24" onChange={(e) => setG({ ...g, cidrs: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="guard-countries">Allowed countries (two-letter codes; empty = any)</Label>
            <Textarea id="guard-countries" rows={3} value={g.countries} placeholder="LK, SG" onChange={(e) => setG({ ...g, countries: e.target.value })} />
            <p className="text-xs text-muted-foreground">Needs the API behind Cloudflare with TRUST_PROXY_HEADERS=cloudflare.</p>
          </div>
          <FormField label="Alert the manager after this many minutes paused (0 = off)" type="number" min={0} max={1440} value={g.idle} onChange={(e) => setG({ ...g, idle: e.target.value })} />
          <FormField label="Alert the manager at this many open items in 7 days (0 = off)" type="number" min={0} max={100} value={g.flags} onChange={(e) => setG({ ...g, flags: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={g.challenge} onChange={(e) => setG({ ...g, challenge: e.target.checked })} /> Ask &ldquo;Are you still working?&rdquo; before pausing (60 seconds to answer)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={g.reminder} onChange={(e) => setG({ ...g, reminder: e.target.checked })} /> Remind people who have not clocked in by their start time</label>
        </CardContent>
      </Card>
      <div className="mt-3 flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>Save safeguards</Button>
        {saved ? <p className="text-sm text-muted-foreground" role="status">Safeguards saved.</p> : null}
      </div>
      {save.isError ? <Alert variant="destructive" className="mt-2"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
    </form>
  );
}

type Key = keyof OrgPolicy;
/** Shown in the unit people think in; stored in the API's unit. */
const FIELDS: Array<{ key: Key; label: string; unit: string; factor: number; hint: string; group: 'Attendance' | 'Time and documents' }> = [
  { key: 'idleThresholdSeconds', label: 'Idle after', unit: 'minutes', factor: 60, hint: 'No input for this long while signed in counts as idle.', group: 'Attendance' },
  { key: 'pauseThresholdSeconds', label: 'Pause after', unit: 'minutes', factor: 60, hint: 'Idle this long becomes a pause (not paid). Must be longer than idle.', group: 'Attendance' },
  { key: 'missedHeartbeatTimeoutSeconds', label: 'Missed-heartbeat timeout', unit: 'seconds', factor: 1, hint: 'Silence before a device counts as disconnected.', group: 'Attendance' },
  { key: 'disconnectGraceWindowSeconds', label: 'Reconnect grace', unit: 'seconds', factor: 1, hint: 'A reconnect within this window continues the same session.', group: 'Attendance' },
  { key: 'maxSessionLengthSeconds', label: 'Maximum session', unit: 'hours', factor: 3600, hint: 'Sessions are closed automatically after this long.', group: 'Attendance' },
  { key: 'paidBreakMinutesPerDay', label: 'Paid break per day', unit: 'minutes', factor: 1, hint: 'Break time counted as paid.', group: 'Attendance' },
  { key: 'manualLimitMinutes', label: 'Manual time per day', unit: 'minutes', factor: 1, hint: 'Manual entries beyond this are flagged for review.', group: 'Time and documents' },
  { key: 'variancePct', label: 'Variance alert', unit: '%', factor: 1, hint: 'Timesheet vs attendance difference that raises an alert.', group: 'Time and documents' },
  { key: 'vaultReauthMinutes', label: 'Vault re-authentication', unit: 'minutes', factor: 1, hint: 'How long a re-authentication opens confidential documents.', group: 'Time and documents' },
];

/** FR-ADM-001: organisation policy (SRS 6.4). Changes apply within seconds and are audited. */
export default function PolicyPage() {
  const policy = usePolicy();
  const save = useSavePolicy();
  const [form, setForm] = useState<Record<Key, string> | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (policy.data) setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(policy.data[f.key] / f.factor)])) as Record<Key, string>);
  }, [policy.data]);

  const errors: Partial<Record<Key, string>> = {};
  const values = {} as OrgPolicy;
  if (form) {
    for (const f of FIELDS) {
      const v = Math.round(Number(form[f.key]) * f.factor);
      const lim = POLICY_LIMITS[f.key];
      if (form[f.key].trim() === '' || !Number.isFinite(v) || v < lim.min || v > lim.max) errors[f.key] = `Between ${lim.min / f.factor} and ${lim.max / f.factor} ${f.unit}`;
      values[f.key] = v;
    }
    if (!errors.pauseThresholdSeconds && !errors.idleThresholdSeconds && values.pauseThresholdSeconds <= values.idleThresholdSeconds) errors.pauseThresholdSeconds = 'Must be longer than the idle threshold';
  }
  const invalid = Object.keys(errors).length > 0;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Policy settings</h1>
      {policy.isPending ? <LoadingState label="Loading policy" rows={4} /> : null}
      {policy.isError ? <ErrorState error={policy.error} onRetry={() => void policy.refetch()} /> : null}
      {form ? (
        <form aria-label="Policy settings" className="space-y-4" onSubmit={(e) => { e.preventDefault(); setSaved(false); if (!invalid) save.mutate(values, { onSuccess: () => setSaved(true) }); }}>
          {(['Attendance', 'Time and documents'] as const).map((group) => (
            <Card key={group}>
              <CardHeader>
                <CardTitle className="text-base">{group}</CardTitle>
                {group === 'Attendance' ? <CardDescription>Times come from the server clock. New values apply to the next heartbeat; past days are not recalculated.</CardDescription> : null}
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {FIELDS.filter((f) => f.group === group).map((f) => (
                  <FormField key={f.key} label={`${f.label} (${f.unit})`} type="number" step="any" inputMode="decimal" value={form[f.key]} hint={f.hint} error={errors[f.key] ?? null}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                ))}
              </CardContent>
            </Card>
          ))}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={invalid || save.isPending}>Save policy</Button>
            {saved ? <p className="text-sm text-muted-foreground" role="status">Policy saved.</p> : null}
          </div>
          {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
        </form>
      ) : null}
      <SafeguardsForm />
    </div>
  );
}
