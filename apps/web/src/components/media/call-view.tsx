'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Hand, Mic, MicOff, MonitorUp, PhoneOff, Signal, Video, VideoOff, WifiOff } from 'lucide-react';
import type { Track } from 'livekit-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { MediaSession, Tile } from '@/lib/media/media-session';
import { cn } from '@/lib/utils';

export function useSession(s: MediaSession | null): void {
  useSyncExternalStore(s?.subscribe ?? noop, s?.getVersion ?? zero, zero);
}
const noop = () => () => undefined;
const zero = () => 0;

function TrackVideo({ track, mirror, label }: { track: Track; mirror?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted aria-label={label} className={cn('h-full w-full object-cover', mirror && '-scale-x-100')} />;
}

const QUALITY_LABEL: Record<Tile['quality'], string> = { excellent: 'Excellent connection', good: 'Good connection', poor: 'Poor connection', lost: 'Connection lost', unknown: 'Connection unknown' };

function TileView({ t, large }: { t: Tile; large?: boolean }) {
  return (
    <figure data-testid={t.isLocal ? 'tile-local' : 'tile-remote'} data-identity={t.identity}
      className={cn('relative overflow-hidden rounded bg-slate-800 text-white', large ? 'aspect-video' : 'aspect-video', t.speaking && 'ring-2 ring-green-500')}>
      {t.camera ? <TrackVideo track={t.camera} mirror={t.isLocal} label={`Video of ${t.name}`} /> : <div className="grid h-full place-items-center text-2xl font-semibold" aria-hidden="true">{t.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}</div>}
      <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/50 px-2 py-1 text-xs">
        {t.micOn ? <Mic className="h-3 w-3" aria-label="Microphone on" /> : <MicOff className="h-3 w-3 text-red-300" aria-label="Muted" />}
        <span className="truncate">{t.name}{t.isLocal ? ' (you)' : ''}</span>
        {t.hand ? <Hand className="h-3 w-3 text-yellow-300" aria-label="Hand raised" /> : null}
        <span className="ml-auto" title={QUALITY_LABEL[t.quality]}>{t.quality === 'poor' || t.quality === 'lost' ? <WifiOff className="h-3 w-3 text-yellow-300" aria-label={QUALITY_LABEL[t.quality]} /> : <Signal className="h-3 w-3" aria-label={QUALITY_LABEL[t.quality]} />}</span>
      </figcaption>
    </figure>
  );
}

/** Audio elements for every remote microphone and screen-share sound (video tiles are muted). */
function RemoteAudio({ session }: { session: MediaSession }) {
  const room = session.room;
  if (!room) return null;
  const tracks: Array<{ key: string; track: Track }> = [];
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) if (pub.track) tracks.push({ key: `${p.identity}-${pub.trackSid}`, track: pub.track });
  }
  return <>{tracks.map((t) => <AudioEl key={t.key} track={t.track} />)}</>;
}

function AudioEl({ track }: { track: Track }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

/**
 * FR-MEET-004/005, FR-VO-009: tiles (a shared screen takes the stage: presentation mode), and
 * controls for microphone, camera, screen share, raise hand, audio-only and leave.
 */
export function CallView({ session, onLeave, compact, extraControls }: { session: MediaSession; onLeave: () => void; compact?: boolean; extraControls?: React.ReactNode }) {
  useSession(session);
  const tiles = session.tiles();
  const presenter = tiles.find((t) => t.screen);
  const handUp = tiles.find((t) => t.isLocal)?.hand ?? false;
  return (
    <section aria-label={`Call: ${session.token?.label ?? ''}`} className="space-y-2" data-testid="call-view" data-status={session.status}>
      {session.status === 'connecting' ? <p className="text-sm text-muted-foreground" role="status">Connecting…</p> : null}
      {session.status === 'reconnecting' ? <p className="text-sm text-muted-foreground" role="status">Reconnecting…</p> : null}
      {session.error ? <Alert variant="destructive"><AlertDescription>{session.error}</AlertDescription></Alert> : null}
      {session.endedReason ? <Alert><AlertDescription>{session.endedReason}</AlertDescription></Alert> : null}
      {session.audioOnly ? <p className="text-xs text-muted-foreground" role="status">Audio only{tiles.find((t) => t.isLocal)?.quality === 'poor' ? ' (your connection is poor)' : ''}.</p> : null}
      {presenter?.screen ? (
        <figure className="overflow-hidden rounded bg-black" data-testid="screen-share">
          <div className="aspect-video"><TrackVideo track={presenter.screen} label={`Screen shared by ${presenter.name}`} /></div>
          <figcaption className="px-2 py-1 text-xs text-white">{presenter.name} is presenting</figcaption>
        </figure>
      ) : null}
      <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4')}>
        {tiles.map((t) => <TileView key={t.identity} t={t} />)}
      </div>
      <RemoteAudio session={session} />
      <div role="toolbar" aria-label="Call controls" className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={session.micOn ? 'default' : 'outline'} aria-pressed={session.micOn} onClick={() => void session.toggleMic()}>{session.micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />} {session.micOn ? 'Mute' : 'Unmute'}</Button>
        <Button size="sm" variant={session.camOn ? 'default' : 'outline'} aria-pressed={session.camOn} onClick={() => void session.toggleCam()}>{session.camOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />} Camera</Button>
        <Button size="sm" variant={session.sharing ? 'default' : 'outline'} aria-pressed={session.sharing} onClick={() => void session.toggleShare()}><MonitorUp aria-hidden="true" /> {session.sharing ? 'Stop sharing' : 'Share screen'}</Button>
        <Button size="sm" variant={handUp ? 'default' : 'outline'} aria-pressed={handUp} onClick={() => void session.raiseHand(!handUp)}><Hand aria-hidden="true" /> {handUp ? 'Lower hand' : 'Raise hand'}</Button>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={session.audioOnly} onChange={(e) => void session.setAudioOnly(e.target.checked)} /> Audio only</label>
        {extraControls}
        <Button size="sm" variant="destructive" onClick={onLeave}><PhoneOff aria-hidden="true" /> Leave</Button>
      </div>
    </section>
  );
}
