'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MessageResponseSchema, SignupResponseSchema } from '@hrvo/shared';
import type { SignupResponse } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { GoogleButton } from '@/components/google-button';
import { apiFetch } from '@/lib/api';
import { passwordProblems } from '@/lib/password';
import { ssoErrorMessage } from '@/lib/sso';
import { mailViewerUrl, signInHref } from '@/lib/account-links';

/** ADR 037: anyone creates a workspace and becomes its owner; the workspace opens once the address is verified. */
function SignupForm() {
  const params = useSearchParams();
  const [workspaceName, setWorkspaceName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(params.get('sso') === 'error' ? ssoErrorMessage(params.get('code')) : null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<SignupResponse | null>(null);

  const problems = passwordProblems(password, confirm);
  const nameProblem = workspaceName.trim().length < 2 ? 'Enter the name of your company or team.' : undefined;
  const personProblem = displayName.trim().length < 2 ? 'Enter your name (at least 2 characters).' : undefined;

  if (done) return <CheckYourEmail done={done} email={email.trim()} />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameProblem || personProblem || problems.password || problems.confirm) return;
    setError(null);
    setPending(true);
    try {
      setDone(await apiFetch('/auth/signup', { method: 'POST', auth: 'none', body: { workspaceName: workspaceName.trim(), displayName: displayName.trim(), email: email.trim(), password }, schema: SignupResponseSchema }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workspace');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">Create your workspace</CardTitle>
          <CardDescription>You become the owner. Invite your people once it is set up.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <FormField label="Workspace name" autoComplete="organization" required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} error={touched ? nameProblem : null} hint="Your company or team, e.g. Acme Ltd." />
          <FormField label="Your name" autoComplete="name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={touched ? personProblem : null} />
          <FormField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} hint="A verification link is sent here. Disposable addresses are refused." />
          <FormField label="Password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 12 characters. Common or breached passwords are refused." error={touched ? problems.password : null} />
          <FormField label="Confirm password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={touched ? problems.confirm : null} />
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <Button type="submit" disabled={pending}>{pending ? 'Creating workspace…' : 'Create workspace'}</Button>
          {/* The Google path starts only after the workspace-name step (ADR 037): the name is required, the e-mail and password fields are not. */}
          <GoogleButton label="Continue with Google" disabled={!!nameProblem} dto={{ mode: 'signup', workspaceName: workspaceName.trim(), displayName: displayName.trim() || undefined }} onError={setError} />
          <p className="text-center text-xs text-muted-foreground">
            {nameProblem ? 'Enter the workspace name first to continue with Google.' : 'With Google, the workspace name above is used, no password is needed and no verification e-mail is sent.'}
          </p>
          <Link href="/login" className="text-center text-sm text-primary underline-offset-4 hover:underline">Already have an account? Sign in</Link>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * ADR 039: after signup. Says where the e-mail went, resends it (the button waits as long as the
 * server's per-address cooldown), links to Mailhog in development, and offers sign-in.
 */
function CheckYourEmail({ done, email }: { done: SignupResponse; email: string }) {
  const [wait, setWait] = useState(done.resendAfterSeconds);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const viewer = mailViewerUrl();
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const resend = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await apiFetch('/auth/email/resend', { method: 'POST', auth: 'none', body: { email, workspace: done.workspace.slug }, schema: MessageResponseSchema });
      setNote(r.message ?? 'A new e-mail is on its way.');
      setWait(done.resendAfterSeconds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the e-mail again');
    } finally {
      setPending(false);
    }
  };
  return (
    <Card data-testid="check-your-email">
      <CardHeader>
        <CardTitle className="text-xl">Check your e-mail</CardTitle>
        <CardDescription>We sent a confirmation link to <strong>{email}</strong>.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Open the e-mail &quot;Confirm your e-mail to open {done.workspace.name} on HRVO&quot;.</li>
          <li>Press <strong>Confirm e-mail and sign in</strong> (or open the link written below it).</li>
          <li>Sign in with this address and your password, then set up two-factor authentication.</li>
        </ol>
        <p className="text-muted-foreground">The link works once and expires in 24 hours. Nothing there? Check the spam folder, or send it again.</p>
        {note ? <Alert variant="success"><AlertDescription>{note}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {viewer ? (
          <Alert>
            <AlertDescription>
              Development: e-mails are caught by Mailhog, not delivered. <a href={viewer} target="_blank" rel="noreferrer" className="font-medium underline" data-testid="mail-viewer">Open Mailhog</a>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">
        <Button type="button" variant="outline" onClick={resend} disabled={pending || wait > 0}>
          {pending ? 'Sending…' : wait > 0 ? `Resend e-mail (in ${wait} s)` : 'Resend e-mail'}
        </Button>
        <Button asChild><Link href={signInHref(email, '/onboarding')}>Already confirmed? Sign in</Link></Button>
      </CardFooter>
    </Card>
  );
}

export default function SignupPage() {
  return <Suspense><SignupForm /></Suspense>;
}
