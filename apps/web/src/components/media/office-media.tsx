'use client';

import { useEffect, useRef, useState } from 'react';
import { Headphones } from 'lucide-react';
import { mediaRoute, type MediaTokenRequest, type OfficeSnapshot } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { loadPrefs, type DevicePrefs } from '@/lib/media/devices';
import { MediaSession } from '@/lib/media/media-session';
import { fetchMediaToken } from '@/lib/meeting-queries';
import type { OfficeClient } from '@/lib/office/office-client';
import { CallView, useSession } from './call-view';
import { PreJoin } from './prejoin';

const ENABLED_KEY = 'hrvo.office.media';
function readEnabled(): boolean { try { return window.sessionStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; } }
function writeEnabled(v: boolean): void { try { if (v) window.sessionStorage.setItem(ENABLED_KEY, '1'); else window.sessionStorage.removeItem(ENABLED_KEY); } catch { /* storage unavailable */ } }

/** Which call the avatar's position implies: a closed room, a proximity group, or none (the same rule the server uses). */
export function mediaTarget(client: OfficeClient, snapshot: OfficeSnapshot): { key: string; req: MediaTokenRequest } | null {
  const route = mediaRoute({ roomId: client.self?.roomId ?? null, rooms: snapshot.rooms, roomOnly: client.roomOnly, proximity: client.proximity });
  return route ? { key: route.key, req: { kind: route.kind } } : null;
}

/**
 * FR-VO-005 / FR-VO-010 (ADR 016): walking into a closed room joins its call; standing near people
 * in the open area joins the proximity group's call, with volume falling off with distance.
 * Media starts only after the user has turned it on and passed the device check.
 */
export function OfficeMedia({ client, snapshot }: { client: OfficeClient; snapshot: OfficeSnapshot }) {
  const [enabled, setEnabled] = useState(false);
  const [setup, setSetup] = useState(false);
  const [session] = useState(() => new MediaSession());
  const [notice, setNotice] = useState<string | null>(null);
  const prefs = useRef<DevicePrefs | null>(null);
  const current = useRef<string | null>(null);
  useSession(session);
  useEffect(() => { if (readEnabled()) { prefs.current = loadPrefs(); setEnabled(true); } }, []);
  useEffect(() => () => { void session.disconnect(); }, [session]);

  const target = enabled ? mediaTarget(client, snapshot) : null;
  const key = target?.key ?? null;
  useEffect(() => {
    if (key === current.current) return;
    // Debounced: walking along the edge of a group should not reconnect every tick.
    const t = setTimeout(() => {
      current.current = key;
      setNotice(null);
      if (!key || !target) { void session.disconnect(); return; }
      const go = async (retry: boolean): Promise<void> => {
        try {
          const token = await fetchMediaToken(target.req);
          if (current.current !== key) return;
          await session.connect(token, prefs.current ?? loadPrefs());
        } catch (err) {
          // The server's proximity grouping can lag the client by one tick.
          if (retry && err instanceof ApiError && err.status === 409) { setTimeout(() => void go(false), 1000); return; }
          if (current.current === key) setNotice(err instanceof Error ? err.message : 'Could not join the call');
        }
      };
      void go(true);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Distance falloff for proximity calls (full volume close by, quiet at the edge of the radius).
  useEffect(() => {
    if (!key?.startsWith('prox:')) return;
    const radius = snapshot.office.proximityRadius;
    const t = setInterval(() => {
      const me = client.self;
      if (!me) return;
      const v = new Map<string, number>();
      for (const a of client.avatars.values()) v.set(a.id, 1 - (Math.hypot(a.rx - me.x, a.ry - me.y) / radius) * 0.85);
      session.setVolumes(v);
    }, 300);
    return () => clearInterval(t);
  }, [key, client, session, snapshot.office.proximityRadius]);

  if (!enabled) {
    return setup ? (
      <PreJoin title="Audio and video in the office" joinLabel="Turn on" onCancel={() => setSetup(false)} onJoin={(p) => { prefs.current = p; writeEnabled(true); setEnabled(true); setSetup(false); }} />
    ) : (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Talk to people when you walk into a closed room or stand near them.</p>
        <Button size="sm" variant="outline" onClick={() => setSetup(true)}><Headphones aria-hidden="true" /> Turn on audio and video</Button>
      </div>
    );
  }
  const off = () => { writeEnabled(false); setEnabled(false); current.current = null; void session.disconnect(); };
  return (
    <div className="space-y-2" data-testid="office-media">
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {session.room && key ? (
        <>
          <p className="text-sm font-medium">{key.startsWith('room:') ? session.token?.label ?? 'Room call' : 'Nearby'}</p>
          <CallView session={session} compact onLeave={off} />
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{key ? 'Joining…' : 'Nobody to talk to here. Walk into a room or up to a colleague.'}</p>
          <Button size="sm" variant="ghost" onClick={off}>Turn off</Button>
        </div>
      )}
    </div>
  );
}
