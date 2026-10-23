'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { MessageResponseSchema } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/state-views';
import { apiFetch } from '@/lib/api';
import { useUrlToken } from '@/lib/url-token';

/** The e-mailed link lands here with the token in the fragment; the token is used once. */
export default function VerifyEmailPage() {
  const token = useUrlToken();
  const [state, setState] = useState<'verifying' | 'done' | 'failed'>('verifying');
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (token === undefined || started.current) return;
    started.current = true;
    if (!token) { setState('failed'); setError('This verification link is incomplete.'); return; }
    apiFetch('/auth/email/verify', { method: 'POST', auth: 'none', body: { token }, schema: MessageResponseSchema })
      .then(() => setState('done'))
      .catch((err: unknown) => { setState('failed'); setError(err instanceof Error ? err.message : 'Verification failed'); });
  }, [token]);

  if (state === 'verifying') return <LoadingState label="Verifying your e-mail address" rows={2} />;

  if (state === 'done') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">E-mail verified</CardTitle>
          <CardDescription>Your workspace is open. Sign in to set it up and invite your people.</CardDescription>
        </CardHeader>
        <CardFooter><Button asChild><Link href="/login">Sign in</Link></Button></CardFooter>
      </Card>
    );
  }

  const resend = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      await apiFetch('/auth/email/resend', { method: 'POST', auth: 'none', body: { email: email.trim() }, schema: MessageResponseSchema });
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new link');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={resend} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">Verification link not valid</CardTitle>
          <CardDescription>Links work once and expire after 24 hours. Enter your address to get a new one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {resent ? <Alert variant="success"><AlertDescription>If the address needs verification, a new link has been sent.</AlertDescription></Alert> : null}
          <FormField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending || resent}>{pending ? 'Sending…' : 'Send a new link'}</Button>
          <Link href="/login" className="text-center text-sm text-primary underline-offset-4 hover:underline">Back to sign in</Link>
        </CardFooter>
      </form>
    </Card>
  );
}
