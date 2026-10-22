'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoginResponseSchema, MessageResponseSchema, SessionResponseSchema } from '@hrvo/shared';
import type { WorkspaceChoice } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { NativeSelect } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { FormField } from '@/components/form-field';
import { GoogleButton } from '@/components/google-button';
import { LoadingState } from '@/components/state-views';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { refreshSession } from '@/lib/session';
import { ssoErrorMessage } from '@/lib/sso';

/** Only same-app relative paths; never an absolute URL (open-redirect guard). */
function safeReturnTo(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/attendance';
}

/** `#token=…` left by the Google redirect (a 2FA challenge or an enrolment token), read once. */
function takeFragmentToken(): string | null {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = hash.get('token');
  if (token) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const sso = params.get('sso');
  const setSession = useAuthStore((s) => s.setSession);
  const setEnrollmentToken = useAuthStore((s) => s.setEnrollmentToken);
  const signedOutReason = useAuthStore((s) => s.signedOutReason);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [choices, setChoices] = useState<WorkspaceChoice[] | null>(null);
  const [step, setStep] = useState<'credentials' | 'totp' | 'google-totp'>('credentials');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(sso === 'error' ? ssoErrorMessage(params.get('code')) : null);
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState(false);
  const [finishingSso, setFinishingSso] = useState(sso === 'ok');
  const ssoHandled = useRef(false);

  // Coming back from Google (FR-AUTH-005): a session is waiting in the refresh cookie, a 2FA
  // challenge needs a code, or enrolment must happen first.
  useEffect(() => {
    if (!sso || ssoHandled.current) return;
    ssoHandled.current = true;
    if (sso === 'ok') {
      refreshSession().then(() => {
        if (useAuthStore.getState().status === 'authenticated') router.replace(returnTo);
        else { setFinishingSso(false); setError('Google sign-in did not complete. Please try again.'); }
      });
    } else if (sso === 'totp') {
      const token = takeFragmentToken();
      if (token) { setChallengeToken(token); setStep('google-totp'); } else setError(ssoErrorMessage('invalid_state'));
    } else if (sso === 'enroll') {
      const token = takeFragmentToken();
      if (token) { setEnrollmentToken(token); router.replace(`/2fa/setup?returnTo=${encodeURIComponent(returnTo)}`); } else setError(ssoErrorMessage('invalid_state'));
    }
  }, [sso, returnTo, router, setEnrollmentToken]);

  if (finishingSso) return <LoadingState label="Finishing your Google sign-in" rows={2} />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnverified(false);
    setPending(true);
    try {
      if (step === 'google-totp') {
        const res = await apiFetch('/auth/google/totp', { method: 'POST', auth: 'none', body: { challengeToken, code: totpCode.trim() }, schema: SessionResponseSchema });
        setSession(res);
        router.replace(returnTo);
        return;
      }
      const res = await apiFetch('/auth/login', {
        method: 'POST',
        auth: 'none',
        body: { email, password, ...(workspace ? { workspace } : {}), ...(step === 'totp' ? { totpCode: totpCode.trim() } : {}) },
        schema: LoginResponseSchema,
      });
      if ('chooseWorkspace' in res) {
        setChoices(res.workspaces);
        setWorkspace(res.workspaces[0]?.slug ?? '');
      } else if ('requires2fa' in res) {
        setStep('totp');
      } else if ('requires2faSetup' in res) {
        setEnrollmentToken(res.enrollmentToken);
        router.push(`/2fa/setup?returnTo=${encodeURIComponent(returnTo)}`);
      } else {
        setSession(res);
        router.replace(returnTo);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') setUnverified(true);
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      if (step !== 'credentials') setTotpCode('');
    } finally {
      setPending(false);
    }
  };

  const resend = async () => {
    try {
      await apiFetch('/auth/email/resend', { method: 'POST', auth: 'none', body: { email, ...(workspace ? { workspace } : {}) }, schema: MessageResponseSchema });
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new link');
    }
  };

  const totp = step !== 'credentials';
  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">{totp ? 'Two-factor authentication' : 'Sign in'}</CardTitle>
          <CardDescription>
            {totp
              ? 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'
              : 'Use the email address your workspace knows you by.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {signedOutReason && !error ? <Alert variant="warning"><AlertDescription>{signedOutReason}</AlertDescription></Alert> : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {unverified ? (
            <Alert variant="warning">
              <AlertDescription>
                {resent ? 'A new verification link has been sent.' : <>Need a new verification link? <button type="button" className="underline" onClick={resend}>Send it again</button>.</>}
              </AlertDescription>
            </Alert>
          ) : null}
          {step === 'credentials' ? (
            <>
              <FormField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <FormField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              {choices ? (
                <div className="space-y-1.5">
                  <Label htmlFor="workspace">Workspace</Label>
                  <NativeSelect id="workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                    {choices.map((c) => <option key={c.slug} value={c.slug}>{c.name} ({c.slug})</option>)}
                  </NativeSelect>
                  <p className="text-xs text-muted-foreground">This address belongs to several workspaces. Choose the one to open.</p>
                </div>
              ) : null}
            </>
          ) : (
            <FormField label="Authentication code" inputMode="text" autoComplete="one-time-code" required maxLength={10} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} autoFocus />
          )}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Signing in…' : totp ? 'Verify' : choices ? 'Open workspace' : 'Sign in'}
          </Button>
          {step === 'credentials' ? (
            <>
              <GoogleButton dto={{ mode: 'login', returnTo, ...(workspace ? { workspace } : {}) }} onError={setError} />
              <Link href="/forgot-password" className="text-center text-sm text-primary underline-offset-4 hover:underline">Forgot your password?</Link>
              <Link href="/signup" className="text-center text-sm text-primary underline-offset-4 hover:underline">New here? Create a workspace</Link>
            </>
          ) : (
            <Button type="button" variant="ghost" onClick={() => { setStep('credentials'); setTotpCode(''); setError(null); setChallengeToken(null); router.replace('/login'); }}>Back</Button>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
