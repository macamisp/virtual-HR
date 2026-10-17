'use client';

import { useId, useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatWorkDate } from '@/lib/format';
import { useHolidayMutations, useHolidays } from '@/lib/leave-queries';
import { Permission, useCan } from '@/lib/permissions';

/** FR-ORG-011 (ADR 027): the public holiday calendar, Sri Lanka by default, edited by HR. */
export default function HolidaysPage() {
  const allowed = useCan(Permission.HOLIDAYS_MANAGE);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const list = useHolidays(year);
  const { add, remove, loadDefaults } = useHolidayMutations(year);
  const [date, setDate] = useState(`${year}-01-01`);
  const [name, setName] = useState('');
  const ids = { y: useId(), d: useId(), n: useId() };
  if (!allowed) return <AccessDenied what="Public holidays" />;
  const error = add.error ?? remove.error ?? loadDefaults.error;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Public holidays</h1>
        <div className="flex items-center gap-2">
          <Label htmlFor={ids.y}>Year</Label>
          <NativeSelect id={ids.y} value={String(year)} onChange={(e) => { const y = Number(e.target.value); setYear(y); setDate(`${y}-01-01`); }}>{[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}</NativeSelect>
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Calendar {year}</CardTitle><CardDescription>Holidays are excluded from expected working time: no absence or late flags on these days. Changes apply to every person in the organisation.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {list.isPending ? <LoadingState label="Loading holidays" rows={3} /> : null}
          {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
          {list.data && !list.data.items.length ? (
            <EmptyState title={`No holidays for ${year}`} description={list.data.defaultsAvailable ? 'Load the Sri Lanka calendar for this year, or add days one by one.' : 'There is no built-in calendar for this year; add the days one by one.'} />
          ) : null}
          {list.data?.defaultsAvailable ? <Button variant="outline" disabled={loadDefaults.isPending} onClick={() => loadDefaults.mutate()}><Download aria-hidden="true" /> {loadDefaults.isPending ? 'Loading…' : `Load the Sri Lanka ${year} calendar`}</Button> : null}
          {list.data?.items.length ? (
            <Table data-testid="holidays">
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Holiday</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {list.data.items.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{formatWorkDate(h.date)}</TableCell>
                    <TableCell>{h.name}</TableCell>
                    <TableCell className="text-right"><Button size="sm" variant="ghost" aria-label={`Remove ${h.name}`} disabled={remove.isPending} onClick={() => remove.mutate(h.id)}><Trash2 aria-hidden="true" /></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Add a holiday</CardTitle><CardDescription>A date that already exists is renamed.</CardDescription></CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-3" aria-label="Add a holiday" onSubmit={(e) => { e.preventDefault(); add.mutate({ date, name }, { onSuccess: () => setName('') }); }}>
            <div className="space-y-1"><Label htmlFor={ids.d}>Date</Label><Input id={ids.d} type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="min-w-64 flex-1 space-y-1"><Label htmlFor={ids.n}>Name</Label><Input id={ids.n} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <Button type="submit" disabled={add.isPending || !name.trim()}><Plus aria-hidden="true" /> Add</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
