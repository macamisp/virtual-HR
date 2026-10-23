'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { LinkKind, LinkState } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { renewLink, signInHref } from '@/lib/account-links';

const WHAT: Record<LinkKind, string> = { verify: 'confirmation link', invite: 'invitation', reset: 'password reset link' };

/** ADR 039: an e-mailed link that no longer works says why in plain words and offers the next step. */
export function LinkProblem({ kind, state, token, email }: { kind: LinkKind; state: Exclude<LinkState, 'valid'>; token: string | null; email?: string | null }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const what = WHAT[kind];
  const title = state === 'used'
    ? (kind === 'invite' ? 'This invitation was already accepted' : `This ${what} was already used`)
    : state === 'expired' ? `This ${what} has expired`
    : state === 'revoked' ? (kind === 'invite' ? 'This invitation was withdrawn' : 'This account is not active')
    : `This ${what} is not valid`;
  const description = state === 'used'
    ? (kind === 'invite' ? 'Your account exists. Sign in with the address the invitation was sent to.' : 'Links work once. Send yourself a new one, or sign in if you are done.')
    : state === 'expired' ? 'Links work for a limited time. We can send a new one to the address this one was sent to.'
    : state === 'revoked' ? (kind === 'invite' ? 'Ask the person who invited you for a new invitation.' : 'Contact your administrator.')
    : 'Check that the whole link was copied from the e-mail, or ask for a new one.';
  // Renewing needs the old link; an invitation can be renewed only once it has expired.
  const canRenew = !!token && (state === 'expired' || (state === 'used' && kind !== 'invite'));
  const renew = async () => {
    if (!token) return;
    setPending(true);
    setError(null);
    try {
      setSent(await renewLink(kind, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new link');
    } finally {
      setPending(false);
    }
  };
  return (
    <Card data-testid="link-problem">
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sent ? <Alert variant="success"><AlertDescription>{sent}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-3">
        {canRenew ? <Button type="button" onClick={renew} disabled={pending || !!sent}>{pending ? 'Sending…' : sent ? 'New link sent' : 'Send a new link'}</Button> : null}
        {kind === 'reset' && !canRenew && state !== 'revoked' ? <Button asChild><Link href="/forgot-password">Send a new link</Link></Button> : null}
        <Button asChild variant={canRenew ? 'outline' : 'default'}><Link href={signInHref(email)}>Sign in</Link></Button>
      </CardFooter>
    </Card>
  );
}
