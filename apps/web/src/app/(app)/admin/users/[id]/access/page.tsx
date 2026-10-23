'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Permission } from '@hrvo/shared';
import { AccessDenied, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/lib/permissions';
import { useEffectiveAccess } from '@/lib/workspace-queries';

/** FR-AUTH-006: what one person can do (every permission, granted or not) and what they can see. */
export default function EffectiveAccessPage() {
  const params = useParams<{ id: string }>();
  const canUsers = useCan(Permission.USERS_MANAGE);
  const canRoles = useCan(Permission.ROLES_MANAGE);
  const access = useEffectiveAccess(canUsers || canRoles ? params.id : null);
  if (!canUsers && !canRoles) return <AccessDenied what="Effective access" />;
  return (
    <div className="space-y-4" data-testid="effective-access">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Effective access</h1>
        <Button asChild variant="outline"><Link href="/admin/users">Back to users</Link></Button>
      </div>
      {access.isPending ? <LoadingState label="Loading access" rows={4} /> : null}
      {access.isError ? <ErrorState error={access.error} onRetry={() => void access.refetch()} /> : null}
      {access.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{access.data.user.displayName ?? access.data.user.email}</CardTitle>
              <CardDescription>
                {access.data.user.email} · {access.data.user.customRoleName ? `${access.data.user.customRoleName} (based on ${access.data.user.roleLabel})` : access.data.user.roleLabel}
                {access.data.user.isOwner ? ' · Owner' : ''}{access.data.user.jobTitle ? ` · ${access.data.user.jobTitle}` : ''} · {access.data.user.status.toLowerCase()}{access.data.user.mfaEnabled ? ' · 2FA on' : ' · 2FA off'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <h2 className="mb-2 text-sm font-medium">What they can see</h2>
              <ul className="grid gap-1 text-sm sm:grid-cols-2" data-testid="access-areas">
                {access.data.areas.map((a) => (
                  <li key={a.key} className={a.visible ? '' : 'text-muted-foreground line-through'}>{a.visible ? '✓' : '✗'} {a.label}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {access.data.groups.map((g) => (
              <Card key={g.group}>
                <CardHeader><CardTitle className="text-base">{g.group}</CardTitle></CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm">
                    {g.items.map((i) => (
                      <li key={i.permission} className={i.granted ? '' : 'text-muted-foreground'}>
                        <div className="flex items-center gap-2"><Badge variant={i.granted ? 'success' : 'outline'}>{i.granted ? 'Yes' : 'No'}</Badge><span className="font-medium">{i.label}</span></div>
                        <p className="ml-1 text-xs">{i.description}</p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
