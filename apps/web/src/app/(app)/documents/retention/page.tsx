'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CATEGORY_LABEL } from '@hrvo/shared';
import type { RetentionRule } from '@hrvo/shared';
import { ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRetention, useSaveRetention } from '@/lib/document-queries';

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/** FR-DOC-017: per category, keep at least N years; optionally destroy after M years. */
export default function RetentionPage() {
  const rules = useRetention();
  const save = useSaveRetention();
  const [rows, setRows] = useState<RetentionRule[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (rules.data) setRows(rules.data.rules); }, [rules.data]);
  const canManage = rules.data?.canManage ?? false;
  return (
    <div className="space-y-4">
      <Link href="/documents" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Documents</Link>
      <h1 className="text-2xl font-semibold">Retention rules</h1>
      {rules.isPending ? <LoadingState label="Loading rules" rows={4} /> : null}
      {rules.isError ? <ErrorState error={rules.error} onRetry={() => void rules.refetch()} /> : null}
      {rules.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per category</CardTitle>
            <CardDescription>“Keep at least” refuses deletion before that age. “Destroy after” crypto-shreds documents automatically at that age. A legal hold overrides both.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 overflow-x-auto">
            <form aria-label="Retention rules" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate({ rules: rows }, { onSuccess: () => setSaved(true) }); }}>
              <Table data-testid="retention">
                <TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Keep at least (years)</TableHead><TableHead>Destroy after (years)</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={r.category}>
                      <TableCell>{CATEGORY_LABEL[r.category]}</TableCell>
                      <TableCell><Input aria-label={`${CATEGORY_LABEL[r.category]}: keep at least`} type="number" min={1} max={100} disabled={!canManage} value={r.minYears ?? ''}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, minYears: num(e.target.value) } : x)))} className="w-24" /></TableCell>
                      <TableCell><Input aria-label={`${CATEGORY_LABEL[r.category]}: destroy after`} type="number" min={1} max={100} disabled={!canManage} value={r.autoShredYears ?? ''}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, autoShredYears: num(e.target.value) } : x)))} className="w-24" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {canManage ? <Button type="submit" className="mt-3" disabled={save.isPending}>Save rules</Button> : <p className="mt-3 text-sm text-muted-foreground">Only HR managers and admins change these rules.</p>}
            </form>
            {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
            {saved ? <p className="text-sm text-muted-foreground" role="status">Rules saved.</p> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
