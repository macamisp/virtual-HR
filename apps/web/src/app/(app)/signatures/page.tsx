'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SignatureRequest } from '@hrvo/shared';
import { SIGN_STATUS } from '@/components/documents/signatures-card';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { useSignatureRequests } from '@/lib/esign-queries';
import { Permission, useCan } from '@/lib/permissions';

type Scope = 'to-sign' | 'sent';

function Row({ r, scope }: { r: SignatureRequest; scope: Scope }) {
  const signed = r.signers.filter((s) => s.status === 'SIGNED').length;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3">
      <div className="min-w-0">
        <Link href={`/signatures/${r.id}`} className="font-medium hover:underline">{r.documentTitle}</Link>{' '}
        <Badge variant={SIGN_STATUS[r.status].variant}>{SIGN_STATUS[r.status].label}</Badge>
        <div className="text-xs text-muted-foreground">
          {scope === 'to-sign' ? `from ${r.requestedBy.displayName ?? r.requestedBy.email}` : `${signed} of ${r.signers.length} signed`} · {formatDateTime(r.createdAt)}
        </div>
      </div>
      {r.canSign ? <Button size="sm" asChild><Link href={`/signatures/${r.id}`}>Review and sign</Link></Button> : null}
    </li>
  );
}

/** FR-DOC-014: documents waiting for my signature, and the requests I sent. */
export default function SignaturesPage() {
  const allowed = useCan(Permission.DOCUMENTS_USE);
  const [scope, setScope] = useState<Scope>('to-sign');
  const list = useSignatureRequests(scope);
  if (!allowed) return <AccessDenied what="Signatures" />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Signatures</h1>
      <div role="tablist" aria-label="Signatures" className="flex gap-1">
        <Button role="tab" size="sm" aria-selected={scope === 'to-sign'} variant={scope === 'to-sign' ? 'default' : 'outline'} onClick={() => setScope('to-sign')}>For me to sign</Button>
        <Button role="tab" size="sm" aria-selected={scope === 'sent'} variant={scope === 'sent' ? 'default' : 'outline'} onClick={() => setScope('sent')}>Sent by me</Button>
      </div>
      <div role="tabpanel">
        {list.isPending ? <LoadingState label="Loading signature requests" /> : null}
        {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
        {list.data && !list.data.items.length ? <EmptyState title={scope === 'to-sign' ? 'Nothing to sign' : 'No requests sent'} description={scope === 'sent' ? 'Open a PDF document and choose “Request signatures”.' : undefined} /> : null}
        {list.data?.items.length ? <ul className="divide-y rounded border" data-testid="signature-list">{list.data.items.map((r) => <Row key={r.id} r={r} scope={scope} />)}</ul> : null}
      </div>
    </div>
  );
}
