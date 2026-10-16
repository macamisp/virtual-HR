'use client';

import { useEffect, useState } from 'react';
import { Laptop, Plus } from 'lucide-react';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAgentDevices, useCreatePairingCode, useRevokeAgent } from '@/lib/agent-queries';
import { formatDateTime } from '@/lib/format';
import { Permission, useCan } from '@/lib/permissions';

const PLATFORM: Record<string, string> = { WINDOWS: 'Windows', MACOS: 'macOS', LINUX: 'Linux', OTHER: 'Other' };

function Countdown({ until, onExpired }: { until: string; onExpired: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) onExpired();
    }, 1000);
    return () => clearInterval(t);
  }, [until, onExpired]);
  return <span>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>;
}

/** FR-ATT-011 (ADR 018): connect a desktop agent with a one-time code; see and disconnect devices. */
export default function AgentsPage() {
  const allowed = useCan(Permission.AGENT_USE);
  const devices = useAgentDevices();
  const create = useCreatePairingCode();
  const revoke = useRevokeAgent();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  if (!allowed) return <AccessDenied what="Desktop agents" />;
  const active = devices.data?.items.filter((d) => !d.revokedAt) ?? [];
  const past = devices.data?.items.filter((d) => d.revokedAt) ?? [];
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">My desktop agents</h1>
      <p className="text-sm text-muted-foreground">
        The optional desktop agent reads only how long your computer has had no keyboard or mouse input, and whether it is locked, so attendance also counts work outside the browser.
        It shows a tray icon whenever it runs. Time recorded while offline is marked for your manager to review.
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connect a desktop agent</CardTitle>
          <CardDescription>Install and open the agent, agree to its notice, then enter this code. The code works once and expires after 5 minutes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {code ? (
            <div className="space-y-1" data-testid="pairing-code">
              <p className="font-mono text-3xl font-semibold tracking-widest" aria-label={`Pairing code ${code.code.split('').join(' ')}`}>{code.code}</p>
              <p className="text-sm text-muted-foreground" role="timer">Expires in <Countdown until={code.expiresAt} onExpired={() => setCode(null)} /></p>
            </div>
          ) : null}
          <Button onClick={() => create.mutate(undefined, { onSuccess: setCode })} disabled={create.isPending}><Plus aria-hidden="true" /> {code ? 'New code' : 'Connect a desktop agent'}</Button>
          {create.isError ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Connected devices</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {devices.isPending ? <LoadingState label="Loading devices" rows={2} /> : null}
          {devices.isError ? <ErrorState error={devices.error} onRetry={() => void devices.refetch()} /> : null}
          {devices.data && !active.length ? <EmptyState title="No desktop agent connected" description="Browser-only attendance works without it." /> : null}
          <ul className="space-y-2" data-testid="agent-devices">
            {active.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-3">
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4" aria-hidden="true" />
                  <div>
                    <p className="font-medium">{d.name} <Badge variant="outline">{PLATFORM[d.platform]}</Badge></p>
                    <p className="text-xs text-muted-foreground">Connected {formatDateTime(d.createdAt)} · last seen {d.lastSeenAt ? formatDateTime(d.lastSeenAt) : 'not yet'} · agent {d.agentVersion}</p>
                  </div>
                </div>
                <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Disconnect ${d.name}? It stops tracking at once.`)) revoke.mutate(d.id); }}>Disconnect</Button>
              </li>
            ))}
          </ul>
          {revoke.isError ? <p role="alert" className="text-sm text-destructive">{revoke.error.message}</p> : null}
          {past.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Disconnected devices ({past.length})</summary>
              <ul className="mt-1 text-muted-foreground">{past.map((d) => <li key={d.id}>{d.name}: disconnected {formatDateTime(d.revokedAt)}</li>)}</ul>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
