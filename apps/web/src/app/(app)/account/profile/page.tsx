'use client';

import { useEffect, useId, useState } from 'react';
import { ROLE_LABEL } from '@hrvo/shared';
import type { UserRole } from '@hrvo/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMyAccess } from '@/lib/admin-queries';
import { useAuthStore } from '@/lib/auth-store';
import { useUpdateMyProfile } from '@/lib/workspace-queries';

/** Own display name and job title. The job title says what you do; it changes nothing about access. */
export default function ProfilePage() {
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
    </div>
  );
}
