'use client';

import { useId, useState } from 'react';
import { ROLE_DESCRIPTION, ROLE_LABEL, UserRole } from '@hrvo/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { useRoles } from '@/lib/admin-queries';
import { useInviteUser } from '@/lib/workspace-queries';

/** Mirrors the API: an x.all permission covers x.team. */
const holds = (held: readonly string[], p: string) => held.includes(p) || (p.endsWith('.team') && held.includes(`${p.slice(0, -5)}.all`));

/** FR-AUTH-001: invite by e-mail with one role, chosen from the roles the inviter may give. */
export function InviteForm({ onInvited }: { onInvited?: (email: string) => void }) {
  const roles = useRoles();
  const invite = useInviteUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>(UserRole.EMPLOYEE);
  const ids = { email: useId(), role: useId() };
  const grantable = roles.data?.grantable ?? [];
  const builtIn = roles.data?.builtIn ?? [];
  // Only roles whose permissions the inviter holds (the API enforces the same rule).
  const allowedRoles = builtIn.filter((b) => b.role !== UserRole.SUPER_ADMIN && b.permissions.every((p) => holds(grantable, p))).map((b) => b.role);
  return (
    <form className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end" data-testid="invite-form" onSubmit={(e) => {
      e.preventDefault();
      invite.mutate({ email: email.trim(), role }, { onSuccess: () => { onInvited?.(email.trim()); setEmail(''); } });
    }}>
      <div className="space-y-1.5"><Label htmlFor={ids.email}>Email</Label><Input id={ids.email} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div className="space-y-1.5">
        <Label htmlFor={ids.role}>Role</Label>
        <NativeSelect id={ids.role} value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          {allowedRoles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </NativeSelect>
      </div>
      <Button type="submit" disabled={invite.isPending || roles.isPending}>Send invitation</Button>
      <p className="text-xs text-muted-foreground sm:col-span-3">{ROLE_DESCRIPTION[role]}</p>
      {invite.isError ? <Alert variant="destructive" className="sm:col-span-3"><AlertDescription>{invite.error.message}</AlertDescription></Alert> : null}
      {invite.isSuccess ? <Alert variant="success" className="sm:col-span-3"><AlertDescription>Invitation e-mailed to {invite.data.email}. It expires in 7 days.</AlertDescription></Alert> : null}
    </form>
  );
}

