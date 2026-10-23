'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MfaSetupResponseSchema, MfaVerifyResponseSchema } from '@hrvo/shared';
import type { MfaSetupResponse } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/state-views';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { otpauthQrDataUrl } from '@/lib/qr';
import { useUrlToken } from '@/lib/url-token';

function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

function SetupFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const rawReturn = params.get('returnTo');
  const returnTo = rawReturn && rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/attendance';
  const enrollmentToken = useAuthStore((s) => s.enrollmentToken);
  const accessToken = useAuthStore((s) => s.accessToken);
  const setSession = useAuthStore((s) => s.setSession);
  const setEnrollmentToken = useAuthStore((s) => s.setEnrollmentToken);
  // A Google sign-in (FR-AUTH-005) lands here with the enrolment token in the URL fragment.
  const urlToken = useUrlToken();
  useEffect(() => { if (urlToken) setEnrollmentToken(urlToken); }, [urlToken, setEnrollmentToken]);
  const hasToken = !!(enrollmentToken ?? accessToken ?? urlToken);

  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [pendingSession, setPendingSession] = useState<Parameters<typeof setSession>[0] | null>(null);
  const started = useRef(false);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    if (!setup) return;
    let cancelled = false;
    otpauthQrDataUrl(setup.otpauthUrl)
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setup]);

  useEffect(() => {
    // Run once: a second call would replace the secret the user is looking at.
    if (!hasToken || started.current) return;
    started.current = true;
    apiFetch('/auth/2fa/setup', { method: 'POST', auth: 'enrollment', schema: MfaSetupResponseSchema })
      .then(setSetup)
      .catch((err: unknown) => setSetupError(err instanceof Error ? err.message : 'Could not start 2FA setup'));
  }, [hasToken]);

  if (!hasToken) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Set up two-factor authentication</CardTitle>
          <CardDescription>Your setup link has expired. Sign in again to continue.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyError(null);
    setPending(true);
    try {
      const res = await apiFetch('/auth/2fa/verify', {
        method: 'POST',
        auth: 'enrollment',
        body: { code: code.trim() },
        schema: MfaVerifyResponseSchema,
      });
      setRecoveryCodes(res.recoveryCodes);
      if (res.accessToken && res.sessionId && res.sessionSecret && res.user) {
        setPendingSession({ accessToken: res.accessToken, sessionId: res.sessionId, sessionSecret: res.sessionSecret, user: res.user });
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed');
      setCode('');
    } finally {
      setPending(false);
    }
  };

  const finish = () => {
    if (pendingSession) setSession(pendingSession);
    router.replace(pendingSession || accessToken ? returnTo : '/login');
  };

  if (recoveryCodes) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Save your recovery codes</CardTitle>
          <CardDescription>
            Each code works once if you lose your authenticator. They will not be shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul data-testid="recovery-codes" className="grid grid-cols-2 gap-2 rounded-md bg-muted p-4 font-mono text-sm">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved these codes somewhere safe
          </label>
        </CardContent>
        <CardFooter>
          <Button onClick={finish} disabled={!saved}>
            Continue
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={verify} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">Set up two-factor authentication</CardTitle>
          <CardDescription>Required for your role. Add HRVO to an authenticator app, then enter the code it shows.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {setupError ? (
            <Alert variant="destructive">
              <AlertDescription>{setupError}</AlertDescription>
            </Alert>
          ) : null}
          {!setup && !setupError ? <LoadingState label="Generating your secret" rows={2} /> : null}
          {setup ? (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium">1. Scan this QR code with your authenticator app</p>
                {qr ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a generated data: URL; next/image adds nothing here and its optimizer is disabled
                  <img
                    src={qr}
                    width={192}
                    height={192}
                    alt="QR code to add HRVO to your authenticator app. If you can't scan it, enter the key below."
                    data-testid="totp-qr"
                    className="rounded-md border bg-white"
                  />
                ) : qrFailed ? (
                  <p className="text-sm text-muted-foreground">The QR code could not be drawn. Use the key below instead.</p>
                ) : (
                  <LoadingState label="Drawing QR code" rows={1} />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Can&apos;t scan? Enter this key instead</p>
                <p data-testid="totp-secret" className="select-all rounded-md bg-muted p-3 font-mono text-sm tracking-wider">
                  {groupSecret(setup.secret)}
                </p>
                <a href={setup.otpauthUrl} className="text-sm text-primary underline-offset-4 hover:underline">
                  Or open it directly in an authenticator app on this device
                </a>
              </div>
              <p className="text-sm font-medium">2. Enter the 6-digit code</p>
              {verifyError ? (
                <Alert variant="destructive">
                  <AlertDescription>{verifyError}</AlertDescription>
                </Alert>
              ) : null}
              <FormField
                label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </>
          ) : null}
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={!setup || pending || code.trim().length !== 6}>
            {pending ? 'Verifying…' : 'Verify and enable'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function TwoFactorSetupPage() {
  return (
    <Suspense>
      <SetupFlow />
    </Suspense>
  );
}
