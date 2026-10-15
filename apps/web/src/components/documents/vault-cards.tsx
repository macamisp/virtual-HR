'use client';

import { useId, useState } from 'react';
import { Copy, Link2, Lock, Scale } from 'lucide-react';
import type { DocumentDetail } from '@hrvo/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingState } from '@/components/state-views';
import { Permission, useCan } from '@/lib/permissions';
import { useAuthStore } from '@/lib/auth-store';
import { useShareLinkMutation, useShareLinks, useVaultMutation } from '@/lib/document-queries';
import { formatDateTime } from '@/lib/format';

/** FR-DOC-006: per-document password (owner or HR), and recovery for vault.recover. */
export function PasswordCard({ doc }: { doc: DocumentDetail }) {
  const me = useAuthStore((s) => s.user?.id);
  const isHr = useCan(Permission.DOCUMENTS_READ_ALL);
  const canRecover = useCan(Permission.VAULT_RECOVER);
  const m = useVaultMutation(doc.id);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const ids = { c: useId(), n: useId(), r: useId() };
  const mayManage = doc.abilities.canManage && (doc.owner.id === me || isHr);
  if (!mayManage && !(canRecover && doc.passwordProtected)) return null;
  const run = (v: Parameters<typeof m.mutate>[0], msg: string) => {
    setDone(null);
    m.mutate(v, { onSuccess: () => { setDone(msg); setCurrent(''); setNext(''); setReason(''); } });
  };
  return (
    <Card data-testid="password-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4" aria-hidden="true" /> Document password</CardTitle>
        <CardDescription>
          {doc.passwordProtected
            ? 'Protected: opening it needs this password as well. The password is never stored.'
            : 'Add a password that is needed, on top of access rights, to open this document. Nobody can read it back; only vault recovery can reset it.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {mayManage ? (
          <form className="space-y-2" aria-label="Document password" onSubmit={(e) => {
            e.preventDefault();
            run({ action: 'set', password: next, currentPassword: doc.passwordProtected ? current : undefined }, doc.passwordProtected ? 'Password changed.' : 'Password set.');
          }}>
            {doc.passwordProtected ? (
              <div className="space-y-1"><Label htmlFor={ids.c}>Current password</Label><Input id={ids.c} type="password" autoComplete="off" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
            ) : null}
            <div className="space-y-1"><Label htmlFor={ids.n}>{doc.passwordProtected ? 'New password' : 'Password (10+ characters)'}</Label><Input id={ids.n} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={next.length < 10 || m.isPending}>{doc.passwordProtected ? 'Change password' : 'Set password'}</Button>
              {doc.passwordProtected ? (
                <Button type="button" size="sm" variant="outline" disabled={!current || m.isPending} onClick={() => run({ action: 'remove', currentPassword: current }, 'Password removed.')}>Remove password</Button>
              ) : null}
            </div>
          </form>
        ) : null}
        {canRecover && doc.passwordProtected ? (
          <form className="space-y-2 border-t pt-3" aria-label="Recover document password" onSubmit={(e) => { e.preventDefault(); run({ action: 'recover', newPassword: next, reason }, 'Password reset. The owner has been told.'); }}>
            <p className="text-sm font-medium">Vault recovery</p>
            <div className="space-y-1"><Label htmlFor={`${ids.n}-r`}>New password</Label><Input id={`${ids.n}-r`} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor={ids.r}>Reason (audited)</Label><Input id={ids.r} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <Button type="submit" size="sm" variant="outline" disabled={next.length < 10 || reason.trim().length < 5 || m.isPending}>Reset password</Button>
          </form>
        ) : null}
        {m.isError ? <Alert variant="destructive"><AlertDescription>{m.error.message}</AlertDescription></Alert> : null}
        {done ? <p className="text-sm text-muted-foreground" role="status">{done}</p> : null}
      </CardContent>
    </Card>
  );
}

/** FR-DOC-017: legal hold blocks deletion and shredding (documents.legal_hold). */
export function LegalHoldCard({ doc }: { doc: DocumentDetail }) {
  const allowed = useCan(Permission.DOCUMENTS_LEGAL_HOLD);
  const m = useVaultMutation(doc.id);
  const [reason, setReason] = useState('');
  const id = useId();
  if (!allowed) return doc.legalHold ? <Alert><Scale className="h-4 w-4" aria-hidden="true" /><AlertTitle>Legal hold</AlertTitle><AlertDescription>This document cannot be deleted while the hold lasts.</AlertDescription></Alert> : null;
  return (
    <Card data-testid="legal-hold">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Scale className="h-4 w-4" aria-hidden="true" /> Legal hold</CardTitle>
        <CardDescription>{doc.legalHold ? 'On hold: it cannot be deleted or shredded, whatever the retention rules.' : 'Place a hold to stop deletion and automatic shredding.'}</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        {doc.legalHold ? (
          <Button size="sm" variant="outline" disabled={m.isPending} onClick={() => m.mutate({ action: 'hold', hold: false })}>Lift hold</Button>
        ) : (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); m.mutate({ action: 'hold', hold: true, reason }, { onSuccess: () => setReason('') }); }}>
            <Label htmlFor={id}>Reason</Label>
            <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button size="sm" type="submit" disabled={reason.trim().length < 5 || m.isPending}>Place hold</Button>
          </form>
        )}
        {m.isError ? <Alert variant="destructive"><AlertDescription>{m.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

/** FR-DOC-010: links for people outside the organisation. The link is shown once. */
export function ShareLinksCard({ doc }: { doc: DocumentDetail }) {
  const links = useShareLinks(doc.id, true);
  const m = useShareLinkMutation(doc.id);
  const [days, setDays] = useState('7');
  const [max, setMax] = useState('');
  const [password, setPassword] = useState('');
  const [viewOnly, setViewOnly] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ids = { d: useId(), m: useId(), p: useId(), v: useId() };
  if (doc.confidentiality === 'RESTRICTED' || doc.passwordProtected) {
    return (
      <Card data-testid="share-links"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4" aria-hidden="true" /> External links</CardTitle>
        <CardDescription>{doc.passwordProtected ? 'Password-protected documents cannot be shared by link.' : 'Restricted documents cannot be shared by link.'}</CardDescription></CardHeader></Card>
    );
  }
  return (
    <Card data-testid="share-links">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4" aria-hidden="true" /> External links</CardTitle>
        <CardDescription>For people without an account. Every opening is logged.{doc.confidentiality === 'CONFIDENTIAL' ? ' Confidential: a link password is required.' : ''}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {created ? (
          <Alert data-testid="new-link">
            <AlertTitle>Link created: copy it now, it is not shown again</AlertTitle>
            <AlertDescription className="break-all">
              <code data-testid="new-link-url">{created}</code>
              <Button size="sm" variant="ghost" className="ml-2" onClick={() => { void navigator.clipboard?.writeText(created); setCopied(true); }}><Copy aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <form className="grid gap-2 sm:grid-cols-2" aria-label="New external link" onSubmit={(e) => {
          e.preventDefault();
          setCopied(false);
          m.mutate({ create: { expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString(), maxDownloads: max ? Number(max) : null, password: password || undefined, viewOnly } }, {
            onSuccess: (r) => { if (r) setCreated(r.url); setPassword(''); },
          });
        }}>
          <div className="space-y-1"><Label htmlFor={ids.d}>Valid for (days, max 90)</Label><Input id={ids.d} type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor={ids.m}>Max openings (optional)</Label><Input id={ids.m} type="number" min={1} max={1000} value={max} onChange={(e) => setMax(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor={ids.p}>Link password{doc.confidentiality === 'CONFIDENTIAL' ? '' : ' (optional)'}</Label><Input id={ids.p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <label className="flex items-center gap-2 self-end text-sm" htmlFor={ids.v}><input id={ids.v} type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} /> View only (watermarked, no download)</label>
          <div className="sm:col-span-2"><Button size="sm" type="submit" disabled={m.isPending || (doc.confidentiality === 'CONFIDENTIAL' && password.length < 8)}>Create link</Button></div>
        </form>
        {m.isError ? <Alert variant="destructive"><AlertDescription>{m.error.message}</AlertDescription></Alert> : null}
        {links.isPending ? <LoadingState label="Loading links" rows={1} /> : null}
        <ul className="divide-y text-sm" data-testid="share-link-list">
          {(links.data?.items ?? []).map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {l.active ? 'Active' : l.revokedAt ? 'Revoked' : 'Expired or used up'} · until {formatDateTime(l.expiresAt)} · opened {l.downloadCount}{l.maxDownloads ? `/${l.maxDownloads}` : ''}
                {l.viewOnly ? ' · view only' : ''}{l.passwordProtected ? ' · password' : ''}
              </span>
              {l.active ? <Button size="sm" variant="ghost" onClick={() => m.mutate({ revoke: l.id })} disabled={m.isPending}>Revoke</Button> : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
