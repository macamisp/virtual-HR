'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Permission, WEEKDAYS, WEEKDAY_LABEL } from '@hrvo/shared';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { useMyAccess } from '@/lib/admin-queries';
import { useCan } from '@/lib/permissions';
import { useOrgProfile, useSaveOrgProfile } from '@/lib/workspace-queries';
import { InviteForm } from '@/components/invite-form';

const TIMEZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; }
})();

/**
 * Workspace onboarding (ADR 037; FR-ORG-001): company name, time zone and work week, then the
 * first invitations. Also the owner's settings page afterwards (sign-in settings live here).
 */
export default function OnboardingPage() {
  const router = useRouter();
  const allowed = useCan(Permission.ORG_MANAGE);
  const profile = useOrgProfile(allowed);
  const save = useSaveOrgProfile();
  const access = useMyAccess();
  const isOwner = access.data?.isOwner ?? false;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [days, setDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [domain, setDomain] = useState('');
  const [mfaForSso, setMfaForSso] = useState(true);
  const [invited, setInvited] = useState<string[]>([]);
  const ids = { name: useId(), tz: useId(), domain: useId(), mfa: useId() };

  useEffect(() => {
    if (!profile.data) return;
    setName(profile.data.name);
    setTimezone(profile.data.timezone);
    setDays(new Set(profile.data.workWeek));
    setDomain(profile.data.ssoAutoJoinDomain ?? '');
    setMfaForSso(profile.data.mfaForSso);
  }, [profile.data]);

  if (!allowed) return <AccessDenied what="Workspace settings" />;
  if (profile.isPending) return <LoadingState label="Loading your workspace" rows={4} />;
  if (profile.isError) return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  const onboarded = !!profile.data?.onboardedAt;

  const saveBasics = () => save.mutate({ name: name.trim(), timezone, workWeek: [...days].sort() }, { onSuccess: () => setStep(2) });
  const finish = () => save.mutate({ onboarded: true }, { onSuccess: () => { setStep(3); } });

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="onboarding">
      <h1 className="text-2xl font-semibold">{onboarded ? 'Workspace settings' : 'Set up your workspace'}</h1>
      {!onboarded ? <p className="text-sm text-muted-foreground" aria-live="polite">Step {step} of 3</p> : null}

      {step === 1 || onboarded ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Company and working week</CardTitle>
            <CardDescription>The time zone decides each working day; the working days decide expected hours and absences.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor={ids.name}>Company name</Label><Input id={ids.name} value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.tz}>Time zone</Label>
              {TIMEZONES.length > 0 ? (
                <NativeSelect id={ids.tz} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {!TIMEZONES.includes(timezone) && timezone ? <option value={timezone}>{timezone}</option> : null}
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </NativeSelect>
              ) : <Input id={ids.tz} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Berlin" />}
            </div>
            <fieldset>
              <legend className="text-sm font-medium">Working days</legend>
              <div className="mt-1 flex flex-wrap gap-3">
                {WEEKDAYS.map((d) => (
                  <label key={d} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={days.has(Number(d))} onChange={(e) => { const next = new Set(days); if (e.target.checked) next.add(Number(d)); else next.delete(Number(d)); setDays(next); }} /> {WEEKDAY_LABEL[d]}
                  </label>
                ))}
              </div>
            </fieldset>
            {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
          </CardContent>
          <CardFooter>
            <Button onClick={saveBasics} disabled={save.isPending || name.trim().length < 2 || days.size === 0}>{onboarded ? 'Save' : 'Save and continue'}</Button>
            {onboarded && save.isSuccess ? <span className="ml-3 text-sm text-muted-foreground" role="status">Saved.</span> : null}
          </CardFooter>
        </Card>
      ) : null}

      {step === 2 || onboarded ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite your first people</CardTitle>
            <CardDescription>Each person gets an e-mail. You can add more later under Administration → Invitations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <InviteForm onInvited={(email) => setInvited((l) => [...l, email])} />
            {invited.length > 0 ? <p className="text-sm text-muted-foreground">Invited: {invited.join(', ')}</p> : null}
          </CardContent>
          {!onboarded ? (
            <CardFooter className="gap-2">
              <Button onClick={finish} disabled={save.isPending}>Finish setup</Button>
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}

      {onboarded && isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sign-in settings (owners only)</CardTitle>
            <CardDescription>
              {profile.data?.googleSignInAvailable ? 'Google sign-in is available on this server.' : 'Google sign-in is not configured on this server (GOOGLE_CLIENT_ID).'}{' '}
              People join this workspace by invitation. Owners, admins and HR always confirm two-factor authentication, also after a Google sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={ids.domain}>Exception (off unless you fill it in): let Google accounts of your own domain join as Member</Label>
              <Input id={ids.domain} value={domain} placeholder="empty = invitation only (recommended)" onChange={(e) => setDomain(e.target.value)} />
              <p className="text-xs text-muted-foreground">Only the domain of your own e-mail address is accepted, never a public one such as gmail.com.</p>
            </div>
            <label className="flex items-center gap-2 text-sm" htmlFor={ids.mfa}>
              <input id={ids.mfa} type="checkbox" checked={mfaForSso} onChange={(e) => setMfaForSso(e.target.checked)} /> People who turned on 2FA for themselves also enter their code after a Google sign-in
            </label>
          </CardContent>
          <CardFooter>
            <Button variant="outline" onClick={() => save.mutate({ ssoAutoJoinDomain: domain.trim() || null, mfaForSso })} disabled={save.isPending}>Save sign-in settings</Button>
          </CardFooter>
        </Card>
      ) : null}

      {step === 3 && !onboarded ? null : null}
      {step === 3 ? (
        <Card>
          <CardHeader><CardTitle className="text-base">All set</CardTitle><CardDescription>Your workspace is ready.</CardDescription></CardHeader>
          <CardFooter><Button onClick={() => router.replace('/attendance')}>Open HRVO</Button></CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
