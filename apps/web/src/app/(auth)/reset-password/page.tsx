'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MessageResponseSchema } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/state-views';
import { apiFetch } from '@/lib/api';
import { passwordProblems } from '@/lib/password';
import { useUrlToken } from '@/lib/url-token';
import { LinkProblem } from '@/components/link-problem';
import { signInHref, useLinkStatus } from '@/lib/account-links';

export default function ResetPasswordPage() {
  const token = useUrlToken();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const problems = passwordProblems(password, confirm);
  const link = useLinkStatus('reset', token);

  if (token === undefined) return <LoadingState label="Reading reset link" rows={2} />;
  if (!token) return <LinkProblem kind="reset" state="invalid" token={null} />;
  if (!link.status && !link.error) return <LoadingState label="Checking your reset link" rows={2} />;
  if (link.status && link.status.state !== 'valid' && !done) return <LinkProblem kind="reset" state={link.status.state} token={token} email={link.status.email} />;

  if (done) {
    return (
      <Card data-testid="reset-done">
        <CardHeader>
          <CardTitle className="text-xl">Password changed</CardTitle>
          <CardDescription>You have been signed out everywhere. Sign in{link.status?.email ? <> as <strong>{link.status.email}</strong></> : null} with your new password.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href={signInHref(link.status?.email)}>Sign in</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problems.password || problems.confirm) return;
    setError(null);
    setPending(true);
    try {
      await apiFetch('/auth/password/reset', { method: 'POST', auth: 'none', body: { token, newPassword: password }, schema: MessageResponseSchema });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">Choose a new password</CardTitle>
          <CardDescription>All your active sessions will be signed out.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {error} {/expired|invalid/i.test(error) ? <Link href="/forgot-password" className="underline">Send a new link</Link> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <FormField label="New password" type="password" autoComplete="new-password" required value={password}
            onChange={(e) => setPassword(e.target.value)} hint="At least 12 characters. Common or breached passwords are refused."
            error={touched ? problems.password : null} />
          <FormField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm}
            onChange={(e) => setConfirm(e.target.value)} error={touched ? problems.confirm : null} />
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Set new password'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
