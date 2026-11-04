'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AcceptInvitationResponseSchema } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/state-views';
import { apiFetch } from '@/lib/api';
import { passwordProblems } from '@/lib/password';
import { useUrlToken } from '@/lib/url-token';
import { GoogleButton } from '@/components/google-button';
import { ssoErrorMessage } from '@/lib/sso';
import { LinkProblem } from '@/components/link-problem';
import { signInHref, useLinkStatus } from '@/lib/account-links';

function AcceptInvitation() {
  const token = useUrlToken();
  const params = useSearchParams();
  const ssoError = params.get('sso') === 'error' ? ssoErrorMessage(params.get('code')) : null;
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(ssoError);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const link = useLinkStatus('invite', token);

  const problems = passwordProblems(password, confirm);
  const nameProblem = displayName.trim().length < 2 ? 'Enter your name (at least 2 characters).' : undefined;

  if (token === undefined) return <LoadingState label="Reading invitation" rows={2} />;

  if (!token) {
    // A Google refusal comes back here without the token (it left the address bar on first read).
    if (ssoError) {
      return (
        <Card data-testid="link-problem">
          <CardHeader>
            <CardTitle className="text-xl">Google did not accept the invitation</CardTitle>
            <CardDescription role="alert">{ssoError}</CardDescription>
          </CardHeader>
          <CardFooter className="flex flex-col items-stretch gap-3">
            <p className="text-sm text-muted-foreground">Open the invitation e-mail again to retry, with a password or with the invited Google account.</p>
            <Button asChild variant="outline"><Link href="/login">Sign in</Link></Button>
          </CardFooter>
        </Card>
      );
    }
    return <LinkProblem kind="invite" state="invalid" token={null} />;
  }
  if (!link.status && !link.error) return <LoadingState label="Checking your invitation" rows={2} />;
  if (link.status && link.status.state !== 'valid') return <LinkProblem kind="invite" state={link.status.state} token={token} email={link.status.email} />;

  if (done) {
    return (
      <Card data-testid="invite-done">
        <CardHeader>
          <CardTitle className="text-xl">Account created</CardTitle>
          <CardDescription>Sign in as <strong>{done}</strong> with the password you just chose. Roles that need two-factor authentication set it up next.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href={signInHref(done)}>Continue to sign in</Link>
          </Button>
        </CardFooter>
      </Card>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameProblem || problems.password || problems.confirm) return;
    setError(null);
    setPending(true);
    try {
      const res = await apiFetch('/auth/invitations/accept', {
        method: 'POST',
        auth: 'none',
        body: { inviteToken: token, displayName: displayName.trim(), password },
        schema: AcceptInvitationResponseSchema,
      });
      setDone(res.user.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept the invitation');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">Accept your invitation</CardTitle>
          <CardDescription>
            {link.status?.workspace ? <>You are joining <strong>{link.status.workspace}</strong> as <strong>{link.status.email}</strong>. </> : null}
            Choose a name and a password for your HRVO account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <FormField label="Your name" autoComplete="name" required value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} error={touched ? nameProblem : null} />
          <FormField label="Password" type="password" autoComplete="new-password" required value={password}
            onChange={(e) => setPassword(e.target.value)} hint="At least 12 characters. Common or breached passwords are refused."
            error={touched ? problems.password : null} />
          <FormField label="Confirm password" type="password" autoComplete="new-password" required value={confirm}
            onChange={(e) => setConfirm(e.target.value)} error={touched ? problems.confirm : null} />
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating account…' : 'Create account'}
          </Button>
          <GoogleButton label="Continue with Google instead" dto={{ mode: 'invite', inviteToken: token, displayName: displayName.trim() || undefined }} onError={setError} />
          <p className="text-center text-xs text-muted-foreground">The Google account must use the invited e-mail address.</p>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function AcceptInvitationPage() {
  return <Suspense><AcceptInvitation /></Suspense>;
}
