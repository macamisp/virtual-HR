'use client';

import { useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { auditQueryString, useAuditFacets, useAuditLog, useVerifyAudit } from '@/lib/admin-queries';
import type { AuditFilters } from '@/lib/admin-queries';
import { apiDownload, saveBlob } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const PAGE = 50;
/** A local date input as the start of that day in the browser's zone, sent as UTC. */
const dayStart = (d: string, plusDays = 0) => {
  if (!d) return undefined;
  const t = new Date(`${d}T00:00:00`);
  t.setDate(t.getDate() + plusDays);
  return t.toISOString();
};
const json = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v, null, 2));

/** FR-ADM-006: the hash-chained audit log (FR-AUD-001) with filters, CSV export and verification. */
export default function AuditPage() {
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const filters: AuditFilters = { action, entityType, entityId: /^[0-9a-f-]{36}$/i.test(entityId.trim()) ? entityId.trim() : undefined, from: dayStart(from), to: dayStart(to, 1) };
  const log = useAuditLog({ ...filters, offset }, PAGE);
  const facets = useAuditFacets();
  const verify = useVerifyAudit();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const f = await apiDownload(`/audit-logs/export?${auditQueryString(filters)}`);
      saveBlob(f.blob, f.filename);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}><ShieldCheck aria-hidden="true" /> {verify.isPending ? 'Verifying…' : 'Verify chain'}</Button>
          <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}><Download aria-hidden="true" /> Export CSV</Button>
        </div>
      </div>

      {verify.data ? (
        <Alert variant={verify.data.valid ? 'default' : 'destructive'} data-testid="chain-result" role="status">
          <AlertTitle>{verify.data.valid ? 'The chain is intact' : 'The chain is broken'}</AlertTitle>
          <AlertDescription>
            {verify.data.valid
              ? `All ${verify.data.checked} entries match their hashes and links.`
              : `Entry #${verify.data.brokenAtId} does not match: it or an earlier link was changed after it was written. ${verify.data.checked} entries before it are intact.`}
          </AlertDescription>
        </Alert>
      ) : null}
      {verify.isError ? <ErrorState error={verify.error} /> : null}
      {exportError ? <Alert variant="destructive"><AlertDescription>{exportError}</AlertDescription></Alert> : null}

      <form className="flex flex-wrap items-end gap-3" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <div className="space-y-1"><Label htmlFor="f-action">Action</Label>
          <NativeSelect id="f-action" value={action} onChange={(e) => reset(setAction)(e.target.value)}>
            <option value="">All actions</option>
            {facets.data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </NativeSelect></div>
        <div className="space-y-1"><Label htmlFor="f-entity">Entity type</Label>
          <NativeSelect id="f-entity" value={entityType} onChange={(e) => reset(setEntityType)(e.target.value)}>
            <option value="">All types</option>
            {facets.data?.entityTypes.map((a) => <option key={a} value={a}>{a}</option>)}
          </NativeSelect></div>
        <div className="space-y-1"><Label htmlFor="f-id">Entity ID</Label><Input id="f-id" value={entityId} placeholder="UUID" className="w-80" onChange={(e) => reset(setEntityId)(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="f-from">From</Label><Input id="f-from" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="f-to">To</Label><Input id="f-to" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></div>
      </form>

      {log.isPending ? <LoadingState label="Loading audit log" rows={5} /> : null}
      {log.isError ? <ErrorState error={log.error} onRetry={() => void log.refetch()} /> : null}
      {log.data && log.data.length === 0 ? <EmptyState title="No entries" description="Nothing matches these filters." /> : null}
      {log.data && log.data.length > 0 ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table data-testid="audit-table">
              <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Time</TableHead><TableHead>Who</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead>Change</TableHead></TableRow></TableHeader>
              <TableBody>
                {log.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="tabular-nums text-muted-foreground">{r.id}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{formatDateTime(r.created_at)}</TableCell>
                    <TableCell className="text-sm">{r.actor_name ?? r.actor_id}{r.ip ? <div className="text-xs text-muted-foreground">{r.ip}</div> : null}</TableCell>
                    <TableCell><code className="text-xs">{r.action}</code></TableCell>
                    <TableCell className="text-xs"><div>{r.entity_type}</div><div className="text-muted-foreground">{r.entity_id}</div></TableCell>
                    <TableCell>
                      {r.before !== null || r.after !== null ? (
                        <details>
                          <summary className="cursor-pointer text-sm text-primary">Before / after</summary>
                          <div className="mt-1 grid gap-2 md:grid-cols-2">
                            <pre className="max-h-60 overflow-auto rounded bg-muted p-2 text-xs">{json(r.before)}</pre>
                            <pre className="max-h-60 overflow-auto rounded bg-muted p-2 text-xs">{json(r.after)}</pre>
                          </div>
                        </details>
                      ) : <span className="text-sm text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</Button>
        <Button variant="outline" size="sm" disabled={!log.data || log.data.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</Button>
      </div>
    </div>
  );
}
