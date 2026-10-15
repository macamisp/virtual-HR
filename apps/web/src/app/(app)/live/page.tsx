'use client';

import { useMemo, useState } from 'react';
import type { LiveBoardEntry } from '@hrvo/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Permission, useCan } from '@/lib/permissions';
import { useLiveBoard } from '@/lib/queries';
import { formatClock, formatDuration } from '@/lib/format';
import { usePresenceStore } from '@/heartbeat/presence-store';

type Bucket = 'IN' | 'IDLE' | 'ON_BREAK' | 'IN_MEETING' | 'ON_LEAVE' | 'NOT_YET_IN' | 'SIGNED_OUT';

const BUCKETS: Array<{ id: Bucket; label: string; variant: BadgeProps['variant'] }> = [
  { id: 'IN', label: 'In', variant: 'success' },
  { id: 'IDLE', label: 'Idle', variant: 'warning' },
  { id: 'ON_BREAK', label: 'On break', variant: 'default' },
  { id: 'IN_MEETING', label: 'In meeting', variant: 'success' },
  { id: 'ON_LEAVE', label: 'On leave', variant: 'secondary' },
  { id: 'NOT_YET_IN', label: 'Not yet in', variant: 'outline' },
  { id: 'SIGNED_OUT', label: 'Signed out', variant: 'secondary' },
];

function bucketOf(r: LiveBoardEntry): Bucket {
  switch (r.status) {
    case 'ACTIVE':
      return 'IN';
    case 'IDLE':
      return 'IDLE';
    case 'ON_BREAK':
      return 'ON_BREAK';
    case 'IN_MEETING':
      return 'IN_MEETING';
    case 'ON_LEAVE':
      return 'ON_LEAVE';
    default:
      return r.hasClockedInToday ? 'SIGNED_OUT' : 'NOT_YET_IN';
  }
}

/** FR-ATT-016: who is in / idle / on break / in meeting / on leave / not yet in, live. */
export default function LiveBoardPage() {
  const allowed = useCan(Permission.ATTENDANCE_READ_TEAM);
  const board = useLiveBoard(allowed);
  const connection = usePresenceStore((s) => s.connection);
  const [filter, setFilter] = useState<Bucket | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  const counts = useMemo(() => {
    const c = Object.fromEntries(BUCKETS.map((b) => [b.id, 0])) as Record<Bucket, number>;
    for (const r of board.data ?? []) c[bucketOf(r)] += 1;
    return c;
  }, [board.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (board.data ?? [])
      .filter((r) => filter === 'ALL' || bucketOf(r) === filter)
      .filter((r) => !q || (r.displayName ?? '').toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
      .sort((a, b) => (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email));
  }, [board.data, filter, search]);

  if (!allowed) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Live board</h1>
        <AccessDenied what="The live board" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Live board</h1>
        <span className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {connection === 'connected' ? 'Live updates on' : 'Live updates paused · refreshing every 30 s'}
        </span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Right now</CardTitle>
          <CardDescription>Statuses update in real time from attendance heartbeats.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
            <Button size="sm" variant={filter === 'ALL' ? 'default' : 'outline'} aria-pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>
              All ({board.data?.length ?? 0})
            </Button>
            {BUCKETS.map((b) => (
              <Button key={b.id} size="sm" variant={filter === b.id ? 'default' : 'outline'} aria-pressed={filter === b.id}
                onClick={() => setFilter(b.id)} data-testid={`filter-${b.id}`}>
                {b.label} ({counts[b.id]})
              </Button>
            ))}
          </div>
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="board-search">Search people</Label>
            <Input id="board-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {board.isPending ? <LoadingState label="Loading live board" rows={4} /> : null}
          {board.isError ? <ErrorState error={board.error} onRetry={() => void board.refetch()} /> : null}
          {board.data && rows.length === 0 ? (
            <EmptyState title={board.data.length === 0 ? 'No one in your scope yet' : 'No one matches this filter'} />
          ) : null}
          {rows.length > 0 ? (
            <Table data-testid="live-board">
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Clocked in</TableHead>
                  <TableHead>Last heartbeat</TableHead>
                  <TableHead className="text-right">Net today</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const b = BUCKETS.find((x) => x.id === bucketOf(r))!;
                  return (
                    <TableRow key={r.userId} data-testid={`board-row-${r.email}`}>
                      <TableCell>
                        <span className="font-medium">{r.displayName ?? r.email}</span>
                        <span className="block text-xs text-muted-foreground">{r.email}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={b.variant} data-testid="board-status">{b.label}</Badge>
                      </TableCell>
                      <TableCell>{formatClock(r.clockInAt)}</TableCell>
                      <TableCell>{formatClock(r.lastHeartbeatAt)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatDuration(r.todayNetSeconds)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
