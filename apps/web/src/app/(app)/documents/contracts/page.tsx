'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CONTRACT_STATUSES } from '@hrvo/shared';
import type { Contract } from '@hrvo/shared';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { ScanBadge } from '@/components/documents/badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useContractMutation, useContracts, useDocuments, useShareTargets } from '@/lib/document-queries';
import { formatWorkDate } from '@/lib/format';

const STATUS_LABEL: Record<Contract['status'], string> = { DRAFT: 'Draft', ACTIVE: 'Active', EXPIRED: 'Expired', TERMINATED: 'Terminated' };

function NewContract() {
  const people = useShareTargets(true);
  const docs = useDocuments({ category: 'CONTRACT' });
  const save = useContractMutation();
  const [userId, setUserId] = useState('');
  const [title, setTitle] = useState('');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const [status, setStatus] = useState<Contract['status']>('ACTIVE');
  const [documentId, setDocumentId] = useState('');
  const [done, setDone] = useState(false);
  const ids = { u: useId(), t: useId(), s: useId(), e: useId(), st: useId(), d: useId() };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">New contract</CardTitle><CardDescription>Link the signed document; it is then also linked to the person.</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-3" aria-label="New contract" onSubmit={(e) => {
          e.preventDefault();
          setDone(false);
          save.mutate({ create: { userId, title: title.trim(), scope: '', startDate, endDate: endDate || null, status, renewalNoticeDays: 30, documentId: documentId || null } }, {
            onSuccess: () => { setDone(true); setTitle(''); setDocumentId(''); },
          });
        }}>
          <div className="space-y-1.5"><Label htmlFor={ids.u}>Person</Label>
            <NativeSelect id={ids.u} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {(people.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.email}</option>)}
            </NativeSelect></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor={ids.t}>Title</Label><Input id={ids.t} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor={ids.s}>Start</Label><Input id={ids.s} type="date" value={startDate} onChange={(e) => setStart(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor={ids.e}>End</Label><Input id={ids.e} type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor={ids.st}>Status</Label>
            <NativeSelect id={ids.st} value={status} onChange={(e) => setStatus(e.target.value as Contract['status'])}>{CONTRACT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</NativeSelect></div>
          <div className="space-y-1.5 sm:col-span-3"><Label htmlFor={ids.d}>Signed document</Label>
            <NativeSelect id={ids.d} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
              <option value="">None yet</option>
              {(docs.data?.items ?? []).filter((d) => !d.linkedContract).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
            </NativeSelect></div>
          <div className="space-y-2 sm:col-span-3">
            {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
            {done ? <p className="text-sm text-muted-foreground" role="status">Contract saved.</p> : null}
            <Button type="submit" disabled={!userId || !title.trim() || !startDate || save.isPending}>Save contract</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** SRS 7.4 contracts (minimal until People & Org): HR records them; people see their own. */
export default function ContractsPage() {
  const list = useContracts();
  return (
    <div className="space-y-4">
      <Link href="/documents" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Documents</Link>
      <h1 className="text-2xl font-semibold">Contracts</h1>
      {list.data?.canManage ? <NewContract /> : null}
      {list.isPending ? <LoadingState label="Loading contracts" rows={3} /> : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.data && list.data.items.length === 0 ? <EmptyState title="No contracts" description={list.data.canManage ? 'Record the first one above.' : 'HR has not recorded a contract for you yet.'} /> : null}
      {list.data && list.data.items.length > 0 ? (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table data-testid="contracts">
            <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Contract</TableHead><TableHead>Period</TableHead><TableHead>Status</TableHead><TableHead>Document</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.data.items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.user.displayName ?? c.user.email}</TableCell>
                  <TableCell>{c.title}</TableCell>
                  <TableCell>{formatWorkDate(c.startDate)} – {c.endDate ? formatWorkDate(c.endDate) : 'open-ended'}</TableCell>
                  <TableCell>{STATUS_LABEL[c.status]}</TableCell>
                  <TableCell>{c.document ? <><Link className="text-primary underline-offset-4 hover:underline" href={`/documents/${c.document.id}`}>{c.document.title}</Link> <ScanBadge status={c.document.latestStatus} /></> : <span className="text-muted-foreground">—</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      ) : null}
    </div>
  );
}
