'use client';

import { Suspense, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ROLE_LABEL } from '@hrvo/shared';
import type { UserRole } from '@hrvo/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMyAccess } from '@/lib/admin-queries';
import { useAuthStore } from '@/lib/auth-store';
import { useLinkGoogle, useUnlinkGoogle, useUpdateMyProfile } from '@/lib/workspace-queries';
import { ssoErrorMessage } from '@/lib/sso';

/** FR-AUTH-005: password and/or Google; the last way to sign in cannot be removed. */
function SignInMethods() {
  const access = useMyAccess();
  const params = useSearchParams();
  const link = useLinkGoogle();
  const unlink = useUnlinkGoogle();
  const sso = params.get('sso');
  const m = access.data?.signInMethods;
  if (!m) return null;
  return (
    <Card data-testid="sign-in-methods">
      <CardHeader>
        <CardTitle className="text-base">Sign-in methods</CardTitle>
        <CardDescription>You can sign in with a password, with Google, or both. The last one cannot be removed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {sso === 'linked' ? <Alert variant="success"><AlertDescription>Google is now linked to your account.</AlertDescription></Alert> : null}
        {sso === 'error' ? <Alert variant="destructive"><AlertDescription>{ssoErrorMessage(params.get('code'))}</AlertDescription></Alert> : null}
        {link.isError ? <Alert variant="destructive"><AlertDescription>{link.error.message}</AlertDescription></Alert> : null}
        {unlink.isError ? <Alert variant="destructive"><AlertDescription>{unlink.error.message}</AlertDescription></Alert> : null}
        <p>Password: {m.password ? 'set' : 'not set'}{!m.password ? <span className="text-muted-foreground"> (use &quot;Forgot your password?&quot; on the sign-in page to set one)</span> : null}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span>Google: {m.google ? `linked (${m.googleEmail})` : 'not linked'}</span>
          {m.google
            ? <Button size="sm" variant="outline" disabled={unlink.isPending} onClick={() => unlink.mutate()}>Remove Google</Button>
            : <Button size="sm" variant="outline" disabled={link.isPending} onClick={() => link.mutate()}>Link Google</Button>}
        </p>
      </CardContent>
    </Card>
  );
}

/** Own display name and job title. The job title says what you do; it changes nothing about access. */
export default function ProfilePage() {
  return <Suspense><Profile /></Suspense>;
}

function Profile() {
  const user = useAuthStore((s) => s.user);
  const access = useMyAccess();
  const update = useUpdateMyProfile();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [jobTitle, setJobTitle] = useState('');
  const ids = { name: useId(), title: useId() };
  useEffect(() => { if (access.data) setJobTitle(access.data.jobTitle ?? ''); }, [access.data]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">My profile</h1>
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); update.mutate({ displayName: displayName.trim(), jobTitle: jobTitle.trim() || null }); }}>
          <CardHeader>
            <CardTitle className="text-base">{user?.email}</CardTitle>
            <CardDescription>{access.data ? `${access.data.customRoleName ?? ROLE_LABEL[access.data.role as UserRole]}${access.data.isOwner ? ' · Owner' : ''}` : ''}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor={ids.name}>Display name</Label><Input id={ids.name} value={displayName} minLength={2} maxLength={100} required onChange={(e) => setDisplayName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor={ids.title}>Job title</Label><Input id={ids.title} value={jobTitle} maxLength={100} placeholder="Developer, QA, BA, Tech Lead…" onChange={(e) => setJobTitle(e.target.value)} /><p className="text-xs text-muted-foreground">Shown on your profile card. It does not grant any access.</p></div>
            {update.isError ? <Alert variant="destructive"><AlertDescription>{update.error.message}</AlertDescription></Alert> : null}
            {update.isSuccess ? <Alert variant="success"><AlertDescription>Saved.</AlertDescription></Alert> : null}
          </CardContent>
          <CardFooter><Button type="submit" disabled={update.isPending || displayName.trim().length < 2}>Save</Button></CardFooter>
        </form>
      </Card>
      <SignInMethods />
    </div>
  );
}
