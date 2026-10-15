'use client';

import { useId, useState } from 'react';
import { MoneyStringSchema, MultiplierStringSchema, PERIOD_KINDS, RATE_TYPES } from '@hrvo/shared';
import type { RateProfile, RatesList, TimesheetSettings, UserRef } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Permission, useCan } from '@/lib/permissions';
import { useRateMutation, useRates, useTimesheetSettings, useUpdateTimesheetSettings } from '@/lib/timesheet-queries';

const PERIOD_LABEL = { WEEKLY: 'Weekly', BIWEEKLY: 'Every two weeks', MONTHLY: 'Monthly' } as const;
const RATE_LABEL = { HOURLY: 'Hourly', DAILY: 'Daily', FIXED: 'Fixed per period' } as const;

function RateRow({ user, profile, canManage }: { user: UserRef; profile: RateProfile | null; canManage: boolean }) {
  const save = useRateMutation();
  const [rateType, setRateType] = useState<RateProfile['rateType']>(profile?.rateType ?? 'HOURLY');
  const [rate, setRate] = useState(profile?.rate ?? '');
  const [currency, setCurrency] = useState(profile?.currency ?? 'USD');
  const [multiplier, setMultiplier] = useState(profile?.overtimeMultiplier ?? '1.50');
  const [cap, setCap] = useState(profile?.weeklyHoursCap ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const base = useId();
  const name = user.displayName ?? user.email;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!MoneyStringSchema.safeParse(rate).success) return setError('Enter the rate as a plain amount, e.g. 25.50.');
    if (!/^[A-Z]{3}$/.test(currency)) return setError('Use a 3-letter currency code, e.g. USD.');
    if (!MultiplierStringSchema.safeParse(multiplier).success) return setError('The overtime multiplier is between 1.00 and 9.99.');
    setError(null);
    setSaved(false);
    save.mutate(
      { userId: user.id, profile: { rateType, rate, currency, overtimeMultiplier: multiplier, weeklyHoursCap: cap.trim() ? cap.trim() : null } },
      { onSuccess: () => setSaved(true) },
    );
  };

  if (!canManage) {
    return (
      <li className="py-2 text-sm">
        <span className="font-medium">{name}</span>: {profile ? `${RATE_LABEL[profile.rateType]} ${profile.currency} ${profile.rate}, overtime × ${profile.overtimeMultiplier}${profile.weeklyHoursCap ? `, cap ${profile.weeklyHoursCap} h/week` : ''}` : 'no rate set'}
      </li>
    );
  }
  return (
    <li className="py-3">
      <form onSubmit={submit} noValidate aria-label={`Rate for ${name}`} className="grid items-end gap-2 sm:grid-cols-6">
        <p className="font-medium sm:col-span-6">{name}</p>
        <div className="space-y-1"><Label htmlFor={`${base}-t`}>Rate type</Label>
          <NativeSelect id={`${base}-t`} value={rateType} onChange={(e) => setRateType(e.target.value as RateProfile['rateType'])}>
            {RATE_TYPES.map((r) => <option key={r} value={r}>{RATE_LABEL[r]}</option>)}
          </NativeSelect></div>
        <div className="space-y-1"><Label htmlFor={`${base}-r`}>Rate</Label><Input id={`${base}-r`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`${base}-c`}>Currency</Label><Input id={`${base}-c`} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
        <div className="space-y-1"><Label htmlFor={`${base}-m`}>Overtime ×</Label><Input id={`${base}-m`} inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`${base}-h`}>Weekly cap (h)</Label><Input id={`${base}-h`} inputMode="decimal" value={cap} placeholder="schedule" onChange={(e) => setCap(e.target.value)} /></div>
        <Button type="submit" disabled={save.isPending}>Save</Button>
        {error ? <p className="text-sm font-medium text-destructive sm:col-span-6" role="alert">{error}</p> : null}
        {save.isError ? <Alert variant="destructive" className="sm:col-span-6"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
        {saved ? <p className="text-sm text-muted-foreground sm:col-span-6" role="status">Saved. New amounts use this rate; approved timesheets keep theirs.</p> : null}
      </form>
    </li>
  );
}

function OverrideRow({ row, canManage }: { row: RatesList['projectRates'][number]; canManage: boolean }) {
  const save = useRateMutation();
  const [value, setValue] = useState(row.rateOverride ?? '');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const label = `${row.projectName} · ${row.user.displayName ?? row.user.email}`;
  if (!canManage) return <li className="py-2 text-sm">{label}: {row.rateOverride ?? 'profile rate'}</li>;
  return (
    <li className="py-2">
      <form className="flex flex-wrap items-end gap-2" noValidate aria-label={`Project rate for ${label}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() && !MoneyStringSchema.safeParse(value.trim()).success) return setError('Enter a plain amount, or leave empty for the profile rate.');
          setError(null);
          save.mutate({ userId: row.user.id, projectId: row.projectId, rate: { rateOverride: value.trim() || null } });
        }}>
        <div className="space-y-1">
          <Label htmlFor={id}>{label}</Label>
          <Input id={id} inputMode="decimal" value={value} placeholder="profile rate" onChange={(e) => setValue(e.target.value)} className="w-40" />
        </div>
        <Button type="submit" variant="outline" disabled={save.isPending}>Save</Button>
        {error ? <p className="w-full text-sm font-medium text-destructive" role="alert">{error}</p> : null}
        {save.isError ? <p className="w-full text-sm text-destructive">{save.error.message}</p> : null}
      </form>
    </li>
  );
}

function SettingsCard({ settings }: { settings: TimesheetSettings }) {
  const save = useUpdateTimesheetSettings();
  const [s, setS] = useState(settings);
  const [saved, setSaved] = useState(false);
  const ids = { p: useId(), a: useId(), m: useId(), v: useId(), d: useId() };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Timesheet policy</CardTitle>
        <CardDescription>Applies to the whole organisation. A new period length applies to timesheets created from now on.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" noValidate aria-label="Timesheet policy"
          onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(s, { onSuccess: () => setSaved(true) }); }}>
          <div className="space-y-1"><Label htmlFor={ids.p}>Period</Label>
            <NativeSelect id={ids.p} value={s.period} onChange={(e) => setS({ ...s, period: e.target.value as TimesheetSettings['period'] })}>
              {PERIOD_KINDS.map((k) => <option key={k} value={k}>{PERIOD_LABEL[k]}</option>)}
            </NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.a}>Two-week periods start on (a Monday)</Label>
            <Input id={ids.a} type="date" value={s.periodAnchor} onChange={(e) => setS({ ...s, periodAnchor: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor={ids.m}>Manual time per day before flagging (minutes)</Label>
            <Input id={ids.m} type="number" min={0} max={480} value={s.manualLimitMinutes} onChange={(e) => setS({ ...s, manualLimitMinutes: Number(e.target.value) })} /></div>
          <div className="space-y-1"><Label htmlFor={ids.v}>Variance alert (%)</Label>
            <Input id={ids.v} type="number" min={5} max={50} value={s.variancePct} onChange={(e) => setS({ ...s, variancePct: Number(e.target.value) })} /></div>
          <div className="space-y-1"><Label htmlFor={ids.d}>Submit within (days after period end)</Label>
            <Input id={ids.d} type="number" min={0} max={14} value={s.submitDueDays} onChange={(e) => setS({ ...s, submitDueDays: Number(e.target.value) })} /></div>
          <div className="space-y-2 sm:col-span-2">
            {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
            {saved ? <p className="text-sm text-muted-foreground" role="status">Policy saved.</p> : null}
            <Button type="submit" disabled={save.isPending}>Save policy</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** FR-TS-009 rates (HR edits, Finance/Auditor reads) and the org timesheet policy. */
export default function RatesPage() {
  const canManage = useCan(Permission.RATES_MANAGE);
  const canRead = useCan(Permission.TIMESHEETS_READ_ALL);
  const canOrg = useCan(Permission.ORG_MANAGE);
  const rates = useRates(canManage || canRead);
  const settings = useTimesheetSettings(canOrg);
  if (!canManage && !canRead) return <AccessDenied what="Rates" />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Rates and timesheet policy</h1>
      {rates.isPending ? <LoadingState label="Loading rates" rows={3} /> : null}
      {rates.isError ? <ErrorState error={rates.error} onRetry={() => void rates.refetch()} /> : null}
      {rates.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Subcontractor rates</CardTitle>
              <CardDescription>Payable = approved hours × rate; hours above the weekly cap (or work schedule, else 40 h) are paid × the overtime multiplier.</CardDescription>
            </CardHeader>
            <CardContent>
              {rates.data.items.length === 0 ? <EmptyState title="No active subcontractors" /> : (
                <ul className="divide-y" data-testid="rates-list">
                  {rates.data.items.map((i) => <RateRow key={i.user.id} user={i.user} profile={i.profile} canManage={rates.data.canManage} />)}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Project rates</CardTitle>
              <CardDescription>Optional per-project rate for a subcontractor, in their profile&apos;s rate type and currency.</CardDescription>
            </CardHeader>
            <CardContent>
              {rates.data.projectRates.length === 0 ? <EmptyState title="No subcontractors on projects yet" /> : (
                <ul className="divide-y">{rates.data.projectRates.map((r) => <OverrideRow key={`${r.projectId}:${r.user.id}`} row={r} canManage={rates.data.canManage} />)}</ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
      {canOrg ? (
        settings.isPending ? <LoadingState label="Loading policy" rows={2} /> : settings.isError ? <ErrorState error={settings.error} /> : <SettingsCard settings={settings.data} />
      ) : null}
    </div>
  );
}
