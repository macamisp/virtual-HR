'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SignupResponseSchema } from '@hrvo/shared';
import type { SignupResponse } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/form-field';
import { GoogleButton } from '@/components/google-button';
import { apiFetch } from '@/lib/api';
import { passwordProblems } from '@/lib/password';
import { ssoErrorMessage } from '@/lib/sso';

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

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Check your e-mail</CardTitle>
          <CardDescription>{done.message}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>Workspace <strong>{done.workspace.name}</strong> (address <code>{done.workspace.slug}</code>) is waiting for you at <strong>{email}</strong>. The link works once and expires in 24 hours.</p>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2">
          <Button asChild variant="outline"><Link href="/login">Go to sign in</Link></Button>
        </CardFooter>
      </Card>
    );
  }

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
          <GoogleButton label="Continue with Google" dto={{ mode: 'signup', workspaceName: workspaceName.trim() || 'My workspace', displayName: displayName.trim() || undefined }} onError={setError} />
          <p className="text-center text-xs text-muted-foreground">With Google, the workspace name above is used and no e-mail verification is needed.</p>
          <Link href="/login" className="text-center text-sm text-primary underline-offset-4 hover:underline">Already have an account? Sign in</Link>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function SignupPage() {
  return <Suspense><SignupForm /></Suspense>;
}
