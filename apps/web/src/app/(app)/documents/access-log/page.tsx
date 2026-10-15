'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { ACCESS_ACTIONS, AccessLogListSchema } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiDownload, apiFetch, saveBlob } from '@/lib/api';
import { Permission, useCan } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format';

/** FR-DOC-012: the organisation-wide document access trail for audit readers, exportable. */
export default function DocumentAccessLogPage() {
  const allowed = useCan(Permission.AUDIT_READ);
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = action ? `?action=${action}` : '';
  const log = useQuery({
    queryKey: ['documents', 'access-logs', action],
    queryFn: () => apiFetch(`/documents/access-logs${q}`, { schema: AccessLogListSchema }),
    enabled: allowed,
  });
  if (!allowed) return <AccessDenied what="The document access log" />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Document access log</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor="log-action">Action</Label>
          <NativeSelect id="log-action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            {ACCESS_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </NativeSelect></div>
        <Button variant="outline" onClick={() => {
          setError(null);
          apiDownload(`/documents/access-logs${q ? `${q}&` : '?'}format=csv&limit=1000`).then((f) => saveBlob(f.blob, f.filename)).catch((e: Error) => setError(e.message));
        }}><Download aria-hidden="true" /> Export CSV</Button>
      </div>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {log.isPending ? <LoadingState label="Loading access log" rows={4} /> : null}
      {log.isError ? <ErrorState error={log.error} onRetry={() => void log.refetch()} /> : null}
      {log.data && log.data.items.length === 0 ? <EmptyState title="No entries" /> : null}
      {log.data && log.data.items.length > 0 ? (
        <Card><CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Action</TableHead><TableHead>Document</TableHead><TableHead>User</TableHead><TableHead>IP</TableHead></TableRow></TableHeader>
            <TableBody>
              {log.data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-sm">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>{e.action}</TableCell>
                  <TableCell>{e.documentTitle ?? '—'}{e.versionNo ? ` (v${e.versionNo})` : ''}</TableCell>
                  <TableCell>{e.user ? (e.user.displayName ?? e.user.email) : 'virus scanner'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.ip ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      ) : null}
    </div>
  );
}
