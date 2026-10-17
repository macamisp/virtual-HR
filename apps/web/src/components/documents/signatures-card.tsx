'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { PenLine } from 'lucide-react';
import type { DocumentDetail, SignatureRequest } from '@hrvo/shared';
import { PeoplePicker, type PickedPerson } from '@/components/people-picker';
import { InlineSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { useRequestSignatures, useSignatureRequests } from '@/lib/esign-queries';
import { useAuthStore } from '@/lib/auth-store';

export const SIGN_STATUS: Record<SignatureRequest['status'], { label: string; variant: 'outline' | 'secondary' | 'success' | 'destructive' }> = {
  OPEN: { label: 'Waiting for signatures', variant: 'secondary' },
  COMPLETED: { label: 'Signed', variant: 'success' },
  DECLINED: { label: 'Declined', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};

/** FR-DOC-014 on the document page: the requests on this document, and a form to start one. */
export function SignaturesCard({ doc }: { doc: DocumentDetail }) {
  const list = useSignatureRequests('document', doc.id);
  const create = useRequestSignatures(doc.id);
  const me = useAuthStore((s) => s.user?.id);
  const [signers, setSigners] = useState<PickedPerson[]>([]);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  const msgId = useId();
  const latest = doc.versions[0];
  const signable = latest?.scanStatus === 'CLEAN' && latest.mimeType === 'application/pdf' && !doc.passwordProtected;
  const hasOpen = list.data?.items.some((r) => r.status === 'OPEN');
  if (!doc.abilities.canManage && !list.data?.items.length) return null;
  return (
    <Card data-testid="signatures-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><PenLine className="h-4 w-4" aria-hidden="true" /> Signatures</CardTitle>
        <CardDescription>Ask colleagues to sign this PDF. The signed copy with an audit certificate becomes a new version.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isPending ? <InlineSpinner label="Loading signature requests" /> : null}
        {list.isError ? <Alert variant="destructive"><AlertDescription>{list.error.message}</AlertDescription></Alert> : null}
        {list.data && !list.data.items.length ? <p className="text-sm text-muted-foreground">No signature requests yet.</p> : null}
        {list.data?.items.length ? (
          <ul className="space-y-2 text-sm">
            {list.data.items.map((r) => (
              <li key={r.id} className="rounded border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/signatures/${r.id}`} className="font-medium hover:underline">{formatDateTime(r.createdAt)}</Link>
                  <Badge variant={SIGN_STATUS[r.status].variant}>{SIGN_STATUS[r.status].label}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">{r.signers.filter((s) => s.status === 'SIGNED').length} of {r.signers.length} signed</div>
              </li>
            ))}
          </ul>
        ) : null}
        {doc.abilities.canManage && !hasOpen ? (
          !signable ? (
            <p className="text-xs text-muted-foreground">{doc.passwordProtected ? 'Remove the document password to request signatures.' : 'Only a scanned PDF can be signed.'}</p>
          ) : open ? (
            <form className="space-y-3" aria-label="Request signatures" onSubmit={(e) => { e.preventDefault(); create.mutate({ signerIds: signers.map((s) => s.id), message }, { onSuccess: () => { setOpen(false); setSigners([]); setMessage(''); } }); }}>
              <PeoplePicker label="Signers" value={signers} onChange={setSigners} max={10} excludeId={undefined} />
              {signers.some((s) => s.id === me) ? <p className="text-xs text-muted-foreground">You will sign as well.</p> : null}
              <div className="space-y-1"><Label htmlFor={msgId}>Message</Label><Textarea id={msgId} rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
              {create.isError ? <Alert variant="destructive"><AlertDescription>{create.error.message}</AlertDescription></Alert> : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={!signers.length || create.isPending}>{create.isPending ? 'Sending…' : 'Send request'}</Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              </div>
            </form>
          ) : <Button variant="outline" onClick={() => setOpen(true)}><PenLine aria-hidden="true" /> Request signatures</Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
