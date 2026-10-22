'use client';

import { Permission, ROLE_LABEL } from '@hrvo/shared';
import type { InvitationRow } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { InviteForm } from '@/components/invite-form';
import { useCan } from '@/lib/permissions';
import { useInvitations, useResendInvitation, useRevokeInvitation } from '@/lib/workspace-queries';

const STATUS_BADGE: Record<InvitationRow['status'], 'secondary' | 'success' | 'warning' | 'destructive'> = { PENDING: 'secondary', ACCEPTED: 'success', EXPIRED: 'warning', REVOKED: 'destructive' };
export default function InvitationsPage() {
  const allowed = useCan(Permission.USERS_INVITE);
  const list = useInvitations(allowed);
  const resend = useResendInvitation();
  const revoke = useRevokeInvitation();
  if (!allowed) return <AccessDenied what="Invitations" />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Invitations</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite someone</CardTitle>
          <CardDescription>They get an e-mail with a link that works once for 7 days. The role is chosen now and can be changed later.</CardDescription>
        </CardHeader>
        <CardContent><InviteForm /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Sent invitations</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {list.isPending ? <div className="p-4"><LoadingState label="Loading invitations" rows={3} /></div> : null}
          {list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => void list.refetch()} /></div> : null}
          {list.data && list.data.length === 0 ? <div className="p-4"><EmptyState title="No invitations yet" /></div> : null}
          {list.data && list.data.length > 0 ? (
            <Table data-testid="invitations-table">
              <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Invited by</TableHead><TableHead>Expires</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {list.data.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.email}</TableCell>
                    <TableCell>{ROLE_LABEL[i.role]}</TableCell>
                    <TableCell><Badge variant={STATUS_BADGE[i.status]}>{i.status.toLowerCase()}</Badge></TableCell>
                    <TableCell>{i.invitedBy.displayName ?? i.invitedBy.email}</TableCell>
                    <TableCell>{new Date(i.expiresAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {i.status === 'PENDING' || i.status === 'EXPIRED' ? (
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate(i.id)}>Resend</Button>
                          <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke the invitation for ${i.email}?`)) revoke.mutate(i.id); }}>Revoke</Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {resend.isError ? <div className="p-4"><Alert variant="destructive"><AlertDescription>{resend.error.message}</AlertDescription></Alert></div> : null}
          {revoke.isError ? <div className="p-4"><Alert variant="destructive"><AlertDescription>{revoke.error.message}</AlertDescription></Alert></div> : null}
        </CardContent>
      </Card>
    </div>
  );
}
