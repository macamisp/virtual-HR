'use client';

import Link from 'next/link';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import type { DocumentSummary } from '@hrvo/shared';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTrash, useVaultMutation } from '@/lib/document-queries';
import { formatDateTime } from '@/lib/format';

const TRASH_DAYS = 30;

function Row({ d }: { d: DocumentSummary }) {
  const m = useVaultMutation(d.id);
  const shredOn = d.deletedAt ? new Date(Date.parse(d.deletedAt) + TRASH_DAYS * 86_400_000).toISOString() : null;
  return (
    <TableRow>
      <TableCell>{d.title}</TableCell>
      <TableCell className="text-sm">{formatDateTime(d.deletedAt)}</TableCell>
      <TableCell className="text-sm">{d.legalHold ? 'Never (legal hold)' : formatDateTime(shredOn)}</TableCell>
      <TableCell>
        <Button size="sm" variant="outline" onClick={() => m.mutate({ action: 'untrash' })} disabled={m.isPending}><RotateCcw aria-hidden="true" /> Restore</Button>
        {m.isError ? <p className="mt-1 text-xs text-destructive">{m.error.message}</p> : null}
      </TableCell>
    </TableRow>
  );
}

/** FR-DOC-017: deleted documents stay restorable for 30 days, then their keys are destroyed. */
export default function TrashPage() {
  const trash = useTrash();
  return (
    <div className="space-y-4">
      <Link href="/documents" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Documents</Link>
      <h1 className="text-2xl font-semibold">Trash</h1>
      <Alert><AlertDescription>Documents here are restorable for {TRASH_DAYS} days. After that their encryption keys are destroyed: no copy, backup or administrator can open them again.</AlertDescription></Alert>
      {trash.isPending ? <LoadingState label="Loading trash" rows={3} /> : null}
      {trash.isError ? <ErrorState error={trash.error} onRetry={() => void trash.refetch()} /> : null}
      {trash.data && trash.data.items.length === 0 ? <EmptyState title="The trash is empty" /> : null}
      {trash.data && trash.data.items.length > 0 ? (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table data-testid="trash">
            <TableHeader><TableRow><TableHead>Document</TableHead><TableHead>Deleted</TableHead><TableHead>Destroyed on</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>{trash.data.items.map((d) => <Row key={d.id} d={d} />)}</TableBody>
          </Table>
        </CardContent></Card>
      ) : null}
    </div>
  );
}
