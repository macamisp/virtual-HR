'use client';

import Link from 'next/link';
import { useState } from 'react';
import { MessageResponseSchema } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { apiFetch } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch('/auth/password/forgot', { method: 'POST', auth: 'none', body: { email }, schema: MessageResponseSchema });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <CardDescription>We will email a link that is valid for 30 minutes and can be used once.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sent ? (
            <Alert variant="success">
              <AlertDescription>If an account exists for {email}, a reset link is on its way. Check your inbox.</AlertDescription>
            </Alert>
          ) : (
            <>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <FormField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </>
          )}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          {!sent ? (
            <Button type="submit" disabled={pending || !email.includes('@')}>
              {pending ? 'Sending…' : 'Send reset link'}
            </Button>
          ) : null}
          <Link href="/login" className="text-center text-sm text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
