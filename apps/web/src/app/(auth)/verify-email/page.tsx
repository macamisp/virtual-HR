'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LinkStatusSchema, MessageResponseSchema, VerifyEmailResponseSchema } from '@hrvo/shared';
import type { LinkState, VerifyEmailResponse } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/state-views';
import { LinkProblem } from '@/components/link-problem';
import { apiFetch } from '@/lib/api';
import { signInHref } from '@/lib/account-links';
import { useUrlToken } from '@/lib/url-token';

/**
 * The confirmation e-mail's button lands here with the token in the fragment (ADR 039). Every
 * outcome ends with a visible next step: Continue to sign in, Sign in, or Send a new link.
 */
export default function VerifyEmailPage() {
  const token = useUrlToken();
  const [done, setDone] = useState<VerifyEmailResponse | null>(null);
  const [problem, setProblem] = useState<{ state: Exclude<LinkState, 'valid'>; email: string | null } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (token === undefined || started.current) return;
    started.current = true;
    if (!token) { setProblem({ state: 'invalid', email: null }); return; }
    apiFetch('/auth/email/verify', { method: 'POST', auth: 'none', body: { token }, schema: VerifyEmailResponseSchema })
      .then(setDone)
      .catch(async () => {
        // Say why: expired, replaced by a newer link, or not a link we know.
        const s = await apiFetch('/auth/links/status', { method: 'POST', auth: 'none', body: { kind: 'verify', token }, schema: LinkStatusSchema }).catch(() => null);
        setProblem({ state: s && s.state !== 'valid' ? s.state : 'invalid', email: s?.email ?? null });
      });
  }, [token]);

  if (done) {
    return (
      <Card data-testid="verify-done">
        <CardHeader>
          <CardTitle className="text-xl">{done.alreadyVerified ? 'Your e-mail is already confirmed' : 'E-mail confirmed'}</CardTitle>
          <CardDescription>
            Your workspace is open. Sign in as <strong>{done.email}</strong> with the password you chose; next you set up two-factor authentication and your workspace.
          </CardDescription>
        </CardHeader>
        <CardFooter><Button asChild><Link href={signInHref(done.email, '/onboarding')}>Continue to sign in</Link></Button></CardFooter>
      </Card>
    );
  }
  if (problem && problem.state !== 'invalid') return <LinkProblem kind="verify" state={problem.state} token={token ?? null} email={problem.email} />;
  if (problem) return <ResendByAddress />;
  return <LoadingState label="Confirming your e-mail address" rows={2} />;
}

/** A link we do not recognise: ask for the address and send a new link there. */
function ResendByAddress() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resend = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const r = await apiFetch('/auth/email/resend', { method: 'POST', auth: 'none', body: { email: email.trim() }, schema: MessageResponseSchema });
      setSent(r.message ?? 'If the address still needs confirming, a new link is on its way.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new link');
    } finally {
      setPending(false);
    }
  };
  return (
    <Card data-testid="link-problem">
      <form onSubmit={resend} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">This confirmation link is not valid</CardTitle>
          <CardDescription>Check that the whole link was copied from the e-mail, or enter your address to get a new one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {sent ? <Alert variant="success"><AlertDescription>{sent}</AlertDescription></Alert> : null}
          <FormField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending || !!sent || !email.trim()}>{pending ? 'Sending…' : sent ? 'New link sent' : 'Send a new link'}</Button>
          <Button asChild variant="outline"><Link href="/login">Sign in</Link></Button>
        </CardFooter>
      </form>
    </Card>
  );
}
