'use client';

import { useId, useState } from 'react';
import { DOCUMENT_PERMISSIONS } from '@hrvo/shared';
import type { AclGrantDto, DocumentPermission } from '@hrvo/shared';
import { LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { useAcl, useAclMutation, useShareTargets } from '@/lib/document-queries';
import { formatDateTime } from '@/lib/format';

const PERMISSION_LABEL: Record<DocumentPermission, string> = { VIEW: 'View', DOWNLOAD: 'Download', EDIT: 'Edit', MANAGE: 'Manage' };

/** FR-DOC-009: grants to people, teams or roles, with optional expiry. */
export function SharingCard({ target, title }: { target: { documentId?: string; folderId?: string }; title: string }) {
  const acl = useAcl(target, true);
  const mutate = useAclMutation(target);
  const targets = useShareTargets(true);
  const [type, setType] = useState<AclGrantDto['principalType']>('USER');
  const [who, setWho] = useState('');
  const [perm, setPerm] = useState<DocumentPermission>('VIEW');
  const [expires, setExpires] = useState('');
  const ids = { type: useId(), who: useId(), perm: useId(), exp: useId() };
  const options = type === 'USER' ? (targets.data?.users ?? []).map((u) => ({ v: u.id, l: `${u.displayName ?? u.email} · ${u.role.toLowerCase()}` }))
    : type === 'TEAM' ? (targets.data?.teams ?? []).map((t) => ({ v: t.id, l: t.name }))
    : (targets.data?.roles ?? []).map((r) => ({ v: r, l: r }));
  return (
    <Card data-testid="sharing">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>Subcontractors are only reached by name or by the Subcontractor role, never through a team.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {acl.isPending ? <LoadingState label="Loading access" rows={2} /> : null}
        {acl.data && acl.data.items.length === 0 ? <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p> : null}
        <ul className="divide-y text-sm">
          {(acl.data?.items ?? []).map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{g.principalLabel}: <span className="font-medium">{PERMISSION_LABEL[g.permission]}</span>
                {g.expiresAt ? <span className="text-xs text-muted-foreground"> · {g.expired ? 'expired' : 'until'} {formatDateTime(g.expiresAt)}</span> : null}
                {g.target === 'FOLDER' && target.documentId ? <span className="text-xs text-muted-foreground"> · from folder {g.folderName}</span> : null}</span>
              {g.target === 'FOLDER' && target.documentId ? null : (
                <Button variant="ghost" size="sm" onClick={() => mutate.mutate({ revoke: g.id })} disabled={mutate.isPending}>Remove</Button>
              )}
            </li>
          ))}
        </ul>
        <form className="grid gap-2 sm:grid-cols-4" aria-label="Share" onSubmit={(e) => {
          e.preventDefault();
          if (!who) return;
          mutate.mutate({ grant: { principalType: type, ...(type === 'ROLE' ? { principalRole: who } : { principalId: who }), permission: perm, expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null } }, { onSuccess: () => setWho('') });
        }}>
          <div className="space-y-1"><Label htmlFor={ids.type}>With</Label>
            <NativeSelect id={ids.type} value={type} onChange={(e) => { setType(e.target.value as AclGrantDto['principalType']); setWho(''); }}>
              <option value="USER">A person</option>
              {targets.data?.teams.length ? <option value="TEAM">A team</option> : null}
              {targets.data?.roles.length ? <option value="ROLE">A role</option> : null}
            </NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.who}>{type === 'USER' ? 'Person' : type === 'TEAM' ? 'Team' : 'Role'}</Label>
            <NativeSelect id={ids.who} value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.perm}>Permission</Label>
            <NativeSelect id={ids.perm} value={perm} onChange={(e) => setPerm(e.target.value as DocumentPermission)}>{DOCUMENT_PERMISSIONS.map((p) => <option key={p} value={p}>{PERMISSION_LABEL[p]}</option>)}</NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.exp}>Until (optional)</Label><Input id={ids.exp} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
          <div className="sm:col-span-4"><Button type="submit" disabled={!who || mutate.isPending}>Share</Button></div>
        </form>
        {mutate.isError ? <Alert variant="destructive"><AlertDescription>{mutate.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

