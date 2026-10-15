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

export default function ResetPasswordPage() {
  const token = useUrlToken();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const problems = passwordProblems(password, confirm);

  if (token === undefined) return <LoadingState label="Reading reset link" rows={2} />;
  if (!token) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          This reset link is incomplete. <Link href="/forgot-password" className="underline">Request a new one</Link>.
        </AlertDescription>
      </Alert>
    );
  }

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password changed</CardTitle>
          <CardDescription>You have been signed out everywhere. Sign in with your new password.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href="/login">Sign in</Link>
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
                {error} {/expired|invalid/i.test(error) ? <Link href="/forgot-password" className="underline">Request a new link</Link> : null}
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
