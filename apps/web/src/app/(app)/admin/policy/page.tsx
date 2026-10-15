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
    </div>
  );
}
