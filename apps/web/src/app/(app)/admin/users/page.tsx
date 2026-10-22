'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Permission, ROLE_LABEL } from '@hrvo/shared';
import type { AdminUserRow, OwnershipTransfer } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminUsers, useMyAccess } from '@/lib/admin-queries';
import { useAuthStore } from '@/lib/auth-store';
import { useCan } from '@/lib/permissions';
import { useCreateTransfer, useDecideTransfer, useOrgProfile, useOwnershipTransfers, useRemoveOwner, useSetUserStatus, useUpdateUserProfile } from '@/lib/workspace-queries';

const STATUS_BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = { ACTIVE: 'success', INVITED: 'secondary', SUSPENDED: 'warning', OFFBOARDED: 'destructive' };

function JobTitleCell({ row }: { row: AdminUserRow }) {
  const [value, setValue] = useState(row.jobTitle ?? '');
  const [editing, setEditing] = useState(false);
  const update = useUpdateUserProfile();
  const id = useId();
  if (!editing) {
    return (
      <button type="button" className="text-left text-sm underline-offset-4 hover:underline" onClick={() => setEditing(true)} aria-label={`Edit job title of ${row.displayName ?? row.email}`}>
        {row.jobTitle ?? <span className="text-muted-foreground">Add a job title</span>}
      </button>
    );
  }
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); update.mutate({ userId: row.id, dto: { jobTitle: value.trim() || null } }, { onSuccess: () => setEditing(false) }); }}>
      <label htmlFor={id} className="sr-only">Job title of {row.displayName ?? row.email}</label>
      <Input id={id} value={value} maxLength={100} placeholder="Developer, QA, BA…" onChange={(e) => setValue(e.target.value)} className="h-8 w-40" autoFocus />
      <Button size="sm" type="submit" disabled={update.isPending}>Save</Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => { setEditing(false); setValue(row.jobTitle ?? ''); }}>Cancel</Button>
      {update.isError ? <span role="alert" className="text-xs text-destructive">{update.error.message}</span> : null}
    </form>
  );
}

function StatusActions({ row, self, isOwner, people }: { row: AdminUserRow; self: boolean; isOwner: boolean; people: AdminUserRow[] }) {
  const set = useSetUserStatus();
  const [reassign, setReassign] = useState('');
  const [offboarding, setOffboarding] = useState(false);
  if (self) return <span className="text-xs text-muted-foreground">You cannot change your own status</span>;
  if (row.status === 'OFFBOARDED') return <span className="text-xs text-muted-foreground">Offboarded</span>;
  if (row.isOwner && !isOwner) return <span className="text-xs text-muted-foreground">Only an owner can change an owner</span>;
  const name = row.displayName ?? row.email;
  if (offboarding) {
    return (
      <form className="flex flex-wrap items-center gap-1" onSubmit={(e) => { e.preventDefault(); set.mutate({ userId: row.id, dto: { status: 'OFFBOARDED', ...(reassign ? { reassignTasksTo: reassign } : {}) } }, { onSuccess: () => setOffboarding(false) }); }}>
        <label className="sr-only" htmlFor={`reassign-${row.id}`}>Reassign open tasks of {name} to</label>
        <NativeSelect id={`reassign-${row.id}`} value={reassign} onChange={(e) => setReassign(e.target.value)} className="h-8">
          <option value="">Leave tasks unassigned</option>
          {people.filter((p) => p.id !== row.id && p.status === 'ACTIVE').map((p) => <option key={p.id} value={p.id}>Reassign tasks to {p.displayName ?? p.email}</option>)}
        </NativeSelect>
        <Button size="sm" variant="destructive" type="submit" disabled={set.isPending}>Confirm offboarding</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOffboarding(false)}>Cancel</Button>
      </form>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.status === 'SUSPENDED' ? (
        <Button size="sm" variant="outline" disabled={set.isPending} onClick={() => set.mutate({ userId: row.id, dto: { status: 'ACTIVE' } })}>Reactivate</Button>
      ) : (
        <Button size="sm" variant="outline" disabled={set.isPending} onClick={() => { if (window.confirm(`Suspend ${name}? They are signed out at once and cannot sign in until reactivated.`)) set.mutate({ userId: row.id, dto: { status: 'SUSPENDED' } }); }}>Suspend</Button>
      )}
      <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => setOffboarding(true)}>Offboard…</Button>
      {set.isError ? <span role="alert" className="text-xs text-destructive">{set.error.message}</span> : null}
    </div>
  );
}

function OwnershipCard({ people, meId }: { people: AdminUserRow[]; meId: string }) {
  const transfers = useOwnershipTransfers();
  const create = useCreateTransfer();
  const decide = useDecideTransfer();
  const remove = useRemoveOwner();
  const profile = useOrgProfile();
  const [newOwner, setNewOwner] = useState('');
  const [keep, setKeep] = useState(false);
  const [proof, setProof] = useState('');
  const [proofKind, setProofKind] = useState<'password' | 'totpCode'>('password');
  const [removing, setRemoving] = useState<string | null>(null);
  const ids = { who: useId(), proof: useId(), keep: useId(), kind: useId() };
  const candidates = people.filter((p) => p.status === 'ACTIVE' && !p.isOwner && p.id !== meId);
  const owners = people.filter((p) => p.isOwner && p.status === 'ACTIVE');
  const pending = (transfers.data ?? []).filter((t) => t.status === 'PENDING');
  return (
    <Card data-testid="ownership">
      <CardHeader>
        <CardTitle className="text-base">Ownership</CardTitle>
        <CardDescription>Owners hold everything, including sign-in settings and billing. Ownership moves only when the new owner accepts; the last owner can never be removed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {owners.map((o) => (
            <span key={o.id} className="inline-flex items-center gap-2 rounded border px-2 py-1 text-sm">
              {o.displayName ?? o.email}
              {owners.length > 1 && o.id !== meId ? (
                removing === o.id ? (
                  <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); remove.mutate({ userId: o.id, proof: { [proofKind]: proof } }, { onSuccess: () => { setRemoving(null); setProof(''); } }); }}>
                    <Input type={proofKind === 'password' ? 'password' : 'text'} value={proof} onChange={(e) => setProof(e.target.value)} placeholder={proofKind === 'password' ? 'Your password' : '2FA code'} className="h-7 w-36" aria-label="Confirm with your password or 2FA code" />
                    <Button size="sm" variant="destructive" type="submit" disabled={remove.isPending}>Remove ownership</Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setRemoving(null)}>Cancel</Button>
                  </form>
                ) : <Button size="sm" variant="ghost" onClick={() => setRemoving(o.id)}>Remove ownership…</Button>
              ) : null}
            </span>
          ))}
        </div>
        {remove.isError ? <Alert variant="destructive"><AlertDescription>{remove.error.message}</AlertDescription></Alert> : null}
        {pending.length > 0 ? (
          <ul className="space-y-2" data-testid="pending-transfers">
            {pending.map((t: OwnershipTransfer) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                <span>{t.from.displayName ?? t.from.email} → {t.to.displayName ?? t.to.email}{t.keepOwnership ? ' (shared)' : ''}, waiting until {new Date(t.expiresAt).toLocaleDateString()}</span>
                <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: t.id, decision: 'cancel' })}>Cancel</Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate({ newOwnerId: newOwner, keepOwnership: keep, [proofKind]: proof }, { onSuccess: () => { setProof(''); setNewOwner(''); } }); }}>
          <div className="space-y-1.5">
            <Label htmlFor={ids.who}>Transfer ownership to</Label>
            <NativeSelect id={ids.who} value={newOwner} onChange={(e) => setNewOwner(e.target.value)} required>
              <option value="">Choose a person</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName ?? p.email} ({ROLE_LABEL[p.role]})</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.proof}>Confirm with your {proofKind === 'password' ? 'password' : '2FA code'}</Label>
            <div className="flex gap-1">
              <Input id={ids.proof} type={proofKind === 'password' ? 'password' : 'text'} value={proof} onChange={(e) => setProof(e.target.value)} required autoComplete={proofKind === 'password' ? 'current-password' : 'one-time-code'} />
              <NativeSelect aria-label="Confirmation method" id={ids.kind} value={proofKind} onChange={(e) => setProofKind(e.target.value as 'password' | 'totpCode')} className="w-32"><option value="password">Password</option><option value="totpCode">2FA code</option></NativeSelect>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor={ids.keep}>
            <input id={ids.keep} type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep my ownership too (the workspace gets another owner)
          </label>
          {create.isError ? <Alert variant="destructive" className="sm:col-span-2"><AlertDescription>{create.error.message}</AlertDescription></Alert> : null}
          {create.isSuccess ? <Alert variant="success" className="sm:col-span-2"><AlertDescription>The new owner has been e-mailed. Nothing changes until they accept.</AlertDescription></Alert> : null}
          <div className="sm:col-span-2"><Button type="submit" disabled={create.isPending || !newOwner}>Ask them to take ownership</Button></div>
        </form>
        {profile.data ? <p className="text-xs text-muted-foreground">Owners: {profile.data.ownerCount}. Sign-in settings (Google auto-join, 2FA after Google) are on the <Link className="underline" href="/onboarding">workspace settings</Link> page.</p> : null}
      </CardContent>
    </Card>
  );
}

/** A transfer addressed to the signed-in person. */
function TransfersForMe({ meId }: { meId: string }) {
  const transfers = useOwnershipTransfers();
  const decide = useDecideTransfer();
  const mine = (transfers.data ?? []).filter((t) => t.status === 'PENDING' && t.to.id === meId);
  if (mine.length === 0) return null;
  return (
    <Alert variant="warning" data-testid="transfer-offer">
      <AlertDescription>
        {mine.map((t) => (
          <span key={t.id} className="flex flex-wrap items-center gap-2">
            {t.from.displayName ?? t.from.email} asked you to {t.keepOwnership ? 'become an owner' : 'take over ownership'} of this workspace.
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: t.id, decision: 'accept' })}>Accept ownership</Button>
            <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: t.id, decision: 'cancel' })}>Decline</Button>
          </span>
        ))}
        {decide.isError ? <span role="alert" className="block text-destructive">{decide.error.message}</span> : null}
      </AlertDescription>
    </Alert>
  );
}

export default function UsersPage() {
  const allowed = useCan(Permission.USERS_MANAGE);
  const users = useAdminUsers();
  const access = useMyAccess();
  const meId = useAuthStore((s) => s.user?.id) ?? '';
  const params = useSearchParams();
  const isOwner = access.data?.isOwner ?? false;
  if (!allowed) return <AccessDenied what="Users" />;
  const people = users.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Users</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link href="/admin/invitations">Invitations</Link></Button>
          <Button asChild variant="outline"><Link href="/admin/roles">Roles and permissions</Link></Button>
        </div>
      </div>
      <TransfersForMe meId={meId} />
      {params.get('transfer') && !isOwner ? null : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">People</CardTitle>
          <CardDescription>Job titles are descriptive only. Suspending or offboarding signs the person out at once; offboarding is final.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {users.isPending ? <div className="p-4"><LoadingState label="Loading people" rows={3} /></div> : null}
          {users.isError ? <div className="p-4"><ErrorState error={users.error} onRetry={() => void users.refetch()} /></div> : null}
          {users.data && users.data.length === 0 ? <div className="p-4"><EmptyState title="Nobody yet" description="Invite your first people." /></div> : null}
          {users.data && users.data.length > 0 ? (
            <Table data-testid="users-table">
              <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Job title</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {users.data.map((u) => (
                  <TableRow key={u.id} data-testid="user-row">
                    <TableCell>
                      <div className="font-medium">{u.displayName ?? u.email} {u.isOwner ? <Badge variant="default">Owner</Badge> : null}</div>
                      <div className="text-xs text-muted-foreground">{u.email}{u.mfaEnabled ? ' · 2FA' : ''}{u.emailVerified ? '' : ' · e-mail not verified'}</div>
                    </TableCell>
                    <TableCell>{u.customRoleName ? <>{u.customRoleName} <span className="text-xs text-muted-foreground">({ROLE_LABEL[u.role]})</span></> : ROLE_LABEL[u.role]}</TableCell>
                    <TableCell><JobTitleCell key={`${u.id}:${u.jobTitle ?? ''}`} row={u} /></TableCell>
                    <TableCell><Badge variant={STATUS_BADGE[u.status] ?? 'secondary'}>{u.status.toLowerCase()}</Badge></TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button asChild size="sm" variant="ghost"><Link href={`/admin/users/${u.id}/access`}>Effective access</Link></Button>
                        <StatusActions row={u} self={u.id === meId} isOwner={isOwner} people={people} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
      {isOwner && users.data ? <OwnershipCard people={users.data} meId={meId} /> : null}
    </div>
  );
}
