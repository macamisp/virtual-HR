'use client';

import { useId, useState } from 'react';
import { Download } from 'lucide-react';
import { ROLE_LABEL } from '@hrvo/shared';
import type { PrivacyRequest, UserRole } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiDownload, saveBlob } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';
import { useAnonymisationCheck, useCancelAnonymisation, useCreateAnonymisation, useExecuteAnonymisation, usePeople, usePrivacyRequests } from '@/lib/privacy-queries';

const STATUS: Record<PrivacyRequest['status'], 'secondary' | 'warning' | 'success' | 'outline'> = { PENDING: 'warning', BLOCKED: 'secondary', COMPLETED: 'success', CANCELLED: 'outline' };

function RequestRow({ r }: { r: PrivacyRequest }) {
  const execute = useExecuteAnonymisation();
  const cancel = useCancelAnonymisation();
  const [confirm, setConfirm] = useState('');
  const id = useId();
  const open = r.type === 'ANONYMISE' && (r.status === 'PENDING' || r.status === 'BLOCKED');
  return (
    <TableRow data-testid="privacy-request">
      <TableCell>{r.type === 'EXPORT' ? 'Export' : 'Anonymisation'}</TableCell>
      <TableCell>{r.subject.displayName ?? r.subject.email}<div className="text-xs text-muted-foreground">{r.subject.email}</div></TableCell>
      <TableCell><Badge variant={STATUS[r.status]}>{r.status.toLowerCase()}</Badge>{r.blockers.length ? <div className="mt-1 text-xs text-muted-foreground">{r.blockers.map((b) => b.detail).join(' ')}</div> : null}</TableCell>
      <TableCell className="text-sm">{r.reason}<div className="text-xs text-muted-foreground">{r.requestedBy.displayName ?? r.requestedBy.email} · {formatDateTime(r.createdAt)}</div></TableCell>
      <TableCell>
        {open ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); execute.mutate({ id: r.id, confirmEmail: confirm }); }}>
            <Label htmlFor={id} className="text-xs">Type the person&apos;s email to confirm</Label>
            <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={r.subject.email} />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" type="submit" disabled={execute.isPending || confirm.trim() === ''}>Anonymise now</Button>
              <Button size="sm" variant="ghost" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>Cancel request</Button>
            </div>
            {execute.isError ? <p role="alert" className="text-xs text-destructive">{execute.error.message}</p> : null}
          </form>
        ) : r.result ? <span className="text-xs text-muted-foreground">{Object.entries(r.result).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ')}</span> : null}
      </TableCell>
    </TableRow>
  );
}

/** FR-AUD-002 / 003 for HR: export a person's data, check and run anonymisation with a documented request. */
export default function PrivacyAdminPage() {
  const allowed = useCan(Permission.PRIVACY_MANAGE);
  const people = usePeople(allowed);
  const requests = usePrivacyRequests(allowed);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const check = useAnonymisationCheck(userId);
  const create = useCreateAnonymisation();
  const ids = { person: useId(), reason: useId() };
  const [exportError, setExportError] = useState<string | null>(null);
  if (!allowed) return <AccessDenied what="Privacy requests" />;
  const exportFor = async (format: 'zip' | 'json') => {
    setExportError(null);
    try {
      const f = await apiDownload(`/privacy/subjects/${encodeURIComponent(userId)}/export?format=${format}`);
      saveBlob(f.blob, f.filename);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    }
  };
  const candidates = (people.data ?? []).filter((p) => p.status !== 'ANONYMISED');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Privacy requests</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Person</CardTitle><CardDescription>Export their data (FR-AUD-002) or check what anonymisation would do (FR-AUD-003). Every action is audited.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {people.isPending ? <LoadingState label="Loading people" rows={1} /> : null}
          {people.isError ? <ErrorState error={people.error} onRetry={() => void people.refetch()} /> : null}
          {people.data ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1"><Label htmlFor={ids.person}>Person</Label>
                <NativeSelect id={ids.person} value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">Choose…</option>
                  {candidates.map((p) => <option key={p.id} value={p.id}>{p.display_name ?? p.email} ({ROLE_LABEL[p.role as UserRole] ?? p.role})</option>)}
                </NativeSelect></div>
              <Button variant="outline" disabled={!userId} onClick={() => void exportFor('zip')}><Download aria-hidden="true" /> Export ZIP</Button>
              <Button variant="outline" disabled={!userId} onClick={() => void exportFor('json')}>Export JSON</Button>
            </div>
          ) : null}
          {exportError ? <Alert variant="destructive"><AlertDescription>{exportError}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>

      {userId ? (
        <Card data-testid="anonymisation-check">
          <CardHeader><CardTitle className="text-base">Anonymisation check</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {check.isPending ? <LoadingState label="Checking" rows={3} /> : null}
            {check.isError ? <ErrorState error={check.error} /> : null}
            {check.data ? (
              <>
                {check.data.blockers.length > 0 ? (
                  <Alert variant="destructive"><AlertTitle>Cannot run yet</AlertTitle><AlertDescription><ul className="list-disc pl-4">{check.data.blockers.map((b) => <li key={b.kind}>{b.detail} ({b.count})</li>)}</ul></AlertDescription></Alert>
                ) : <Alert><AlertTitle>Nothing blocks anonymisation</AlertTitle><AlertDescription>Open a request below, then confirm it with the person&apos;s email.</AlertDescription></Alert>}
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Will be removed or replaced</h3>
                    <ul className="space-y-1 text-sm">{check.data.willRemove.map((w) => <li key={w.dataset}><Badge variant="outline" className="mr-1">{w.action.toLowerCase()}</Badge>{w.dataset}: {w.count}</li>)}</ul>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Kept under a pseudonym (legal basis)</h3>
                    <ul className="space-y-1 text-sm">{check.data.retained.map((r) => <li key={r.kind}><span className="font-medium">{r.count}</span> — {r.detail}</li>)}</ul>
                  </div>
                </div>
                <form className="space-y-2" aria-label="Request anonymisation" onSubmit={(e) => { e.preventDefault(); create.mutate({ userId, reason }, { onSuccess: () => setReason('') }); }}>
                  <Label htmlFor={ids.reason}>Reason (recorded in the audit log)</Label>
                  <Textarea id={ids.reason} value={reason} rows={2} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="Leaver process, ticket number, or the person's written request" />
                  <Button type="submit" disabled={create.isPending || reason.trim().length < 5}>Open anonymisation request</Button>
                  {create.isError ? <Alert variant="destructive"><AlertDescription>{create.error.message}</AlertDescription></Alert> : null}
                </form>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">Requests</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {requests.isPending ? <div className="p-4"><LoadingState label="Loading requests" rows={2} /></div> : null}
          {requests.isError ? <div className="p-4"><ErrorState error={requests.error} onRetry={() => void requests.refetch()} /></div> : null}
          {requests.data && requests.data.items.length === 0 ? <div className="p-4"><EmptyState title="No requests yet" /></div> : null}
          {requests.data && requests.data.items.length > 0 ? (
            <Table data-testid="privacy-requests">
              <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Person</TableHead><TableHead>Status</TableHead><TableHead>Reason</TableHead><TableHead>Action</TableHead></TableRow></TableHeader>
              <TableBody>{requests.data.items.map((r) => <RequestRow key={r.id} r={r} />)}</TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
