'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoginResponseSchema } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

/** Only same-app relative paths; never an absolute URL (open-redirect guard). */
function safeReturnTo(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/attendance';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const setSession = useAuthStore((s) => s.setSession);
  const setEnrollmentToken = useAuthStore((s) => s.setEnrollmentToken);
  const signedOutReason = useAuthStore((s) => s.signedOutReason);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await apiFetch('/auth/login', {
        method: 'POST',
        auth: 'none',
        body: { email, password, ...(step === 'totp' ? { totpCode: totpCode.trim() } : {}) },
        schema: LoginResponseSchema,
      });
      if ('requires2fa' in res) {
        setStep('totp');
      } else if ('requires2faSetup' in res) {
        setEnrollmentToken(res.enrollmentToken);
        router.push(`/2fa/setup?returnTo=${encodeURIComponent(returnTo)}`);
      } else {
        setSession(res);
        router.replace(returnTo);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      if (step === 'totp') setTotpCode('');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">{step === 'credentials' ? 'Sign in' : 'Two-factor authentication'}</CardTitle>
          <CardDescription>
            {step === 'credentials'
              ? 'Use the email address your organisation invited.'
              : 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {signedOutReason && !error ? (
            <Alert variant="warning">
              <AlertDescription>{signedOutReason}</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {step === 'credentials' ? (
            <>
              <FormField
                label="Email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <FormField
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          ) : (
            <FormField
              label="Authentication code"
              inputMode="text"
              autoComplete="one-time-code"
              required
              maxLength={10}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              autoFocus
            />
          )}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Signing in…' : step === 'credentials' ? 'Sign in' : 'Verify'}
          </Button>
          {step === 'credentials' ? (
            <Link href="/forgot-password" className="text-center text-sm text-primary underline-offset-4 hover:underline">
              Forgot your password?
            </Link>
          ) : (
            <Button type="button" variant="ghost" onClick={() => { setStep('credentials'); setTotpCode(''); setError(null); }}>
              Back
            </Button>
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
