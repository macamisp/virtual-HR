'use client';

import Link from 'next/link';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Permission, useCan } from '@/lib/permissions';
import { useSubcontractors } from '@/lib/subcontractor-queries';

/** FR-ORG-002 (ADR 033): HR's list of subcontractor profiles. Tax and bank show only as "on file". */
export default function SubcontractorsPage() {
  const allowed = useCan(Permission.SUBCONTRACTORS_READ);
  const list = useSubcontractors(allowed);
  if (!allowed) return <AccessDenied what="Subcontractor profiles" />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Subcontractors</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Profiles</CardTitle><CardDescription>Opening this list and each profile is recorded in the audit log.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {list.isPending ? <div className="p-4"><LoadingState label="Loading subcontractors" /></div> : null}
          {list.isError ? <div className="p-4"><ErrorState error={list.error} onRetry={() => void list.refetch()} /></div> : null}
          {list.data && !list.data.items.length ? <div className="p-4"><EmptyState title="No subcontractors yet" /></div> : null}
          {list.data?.items.length ? (
            <Table data-testid="subcontractors">
              <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Legal name and company</TableHead><TableHead>Country</TableHead><TableHead>Tax ID</TableHead><TableHead>Bank details</TableHead></TableRow></TableHeader>
              <TableBody>
                {list.data.items.map((s) => (
                  <TableRow key={s.user.id}>
                    <TableCell><Link className="font-medium underline-offset-2 hover:underline" href={`/admin/subcontractors/${s.user.id}`}>{s.user.displayName ?? s.user.email}</Link><span className="block text-xs text-muted-foreground">{s.user.email}</span></TableCell>
                    <TableCell>{s.legalName || '—'}{s.companyName ? <span className="block text-xs text-muted-foreground">{s.companyName}</span> : null}</TableCell>
                    <TableCell>{s.country ?? '—'}</TableCell>
                    <TableCell>{s.hasTaxId ? <Badge variant="success">On file</Badge> : <Badge variant="outline">Missing</Badge>}</TableCell>
                    <TableCell>{s.hasBankDetails ? <Badge variant="success">On file</Badge> : <Badge variant="outline">Missing</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
