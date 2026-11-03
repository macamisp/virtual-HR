'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, GripHorizontal, Hand, Mic, MicOff, MonitorUp, PhoneOff, PictureInPicture2, Video, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDockStore } from '@/lib/media/dock-store';
import { cn } from '@/lib/utils';
import { useCallController } from './use-call-controller';
import { TileView, useSession } from './call-view';

declare global {
  interface Window {
    /** Document Picture-in-Picture (Chromium 116+). */
    documentPictureInPicture?: { requestWindow(options?: { width?: number; height?: number }): Promise<Window> };
  }
}

const POS_KEY = 'hrvo.call.dock';
const MARGIN = 16;
const STEP = 16;
const MAX_TILES = 4;

function readPos(): { x: number; y: number } | null {
  try { const raw = window.localStorage.getItem(POS_KEY); return raw ? (JSON.parse(raw) as { x: number; y: number }) : null; } catch { return null; }
}
function writePos(p: { x: number; y: number }): void { try { window.localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

/** Keeps the whole box inside the window. */
function clamp(p: { x: number; y: number }, w: number, h: number, win: Window): { x: number; y: number } {
  return { x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, win.innerWidth - w - MARGIN)), y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, win.innerHeight - h - MARGIN)) };
}

export function canDocumentPip(): boolean {
  return typeof window !== 'undefined' && !!window.documentPictureInPicture;
}

/**
 * ADR 046 §3: the floating call window shown on every page where the full call view is not: the
 * people in the call (speaking ring, hand), the microphone and camera state, and the controls.
 * Draggable with the pointer or the arrow keys on its handle; stays inside the viewport; its
 * position is remembered. Where the browser has Document Picture-in-Picture, "Float over other
 * tabs" moves it into a window that stays visible over other tabs and apps (§5).
 */
export function CallDock() {
  const c = useCallController();
  const pathname = usePathname();
  useSession(c.session);
  const cur = c.current;
  const fullView = !!cur && ((cur.kind === 'office' && pathname === '/office') || (cur.kind === 'meeting' && pathname === `/meetings/${cur.meetingId}`));
  const show = !!cur && !!c.session.room && !fullView;
  const [pip, setPip] = useState<{ win: Window; root: HTMLElement } | null>(null);
  const setDock = useDockStore((s) => s.set);

  // The PiP window closes with the call, and the dock comes back to the page when the window is closed.
  useEffect(() => {
    if (!pip) return;
    const onHide = () => setPip(null);
    pip.win.addEventListener('pagehide', onHide);
    return () => { pip.win.removeEventListener('pagehide', onHide); if (!pip.win.closed) pip.win.close(); };
  }, [pip]);
  useEffect(() => { if (!show && pip) setPip(null); }, [show, pip]);
  useEffect(() => { if (!show) setDock({ visible: false, height: 0 }); }, [show, setDock]);
  if (!show || !cur) return null;

  const float = async () => {
    if (!window.documentPictureInPicture) return;
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 360, height: 320 });
      const doc = win.document;
      doc.documentElement.className = document.documentElement.className;
      doc.head.replaceChildren(...[...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.cloneNode(true)));
      doc.title = 'Call';
      const root = doc.createElement('div');
      doc.body.replaceChildren(root);
      doc.body.style.margin = '0';
      doc.body.className = 'bg-background text-foreground';
      setPip({ win, root });
    } catch { /* refused: the in-page dock stays */ }
  };
  if (pip) return createPortal(<DockBody floating onFloat={null} onUnfloat={() => setPip(null)} />, pip.root);
  return <DockBody floating={false} onFloat={canDocumentPip() ? float : null} onUnfloat={null} />;
}

function DockBody({ floating, onFloat, onUnfloat }: { floating: boolean; onFloat: (() => void) | null; onUnfloat: (() => void) | null }) {
  const c = useCallController();
  const router = useRouter();
  useSession(c.session);
  const session = c.session;
  const cur = c.current!;
  const box = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const id = useId();
  const setDock = useDockStore((s) => s.set);

  // First position: remembered, else the bottom-right corner; always inside the window.
  const place = useCallback((p: { x: number; y: number } | null) => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth; const h = el.offsetHeight;
    const next = clamp(p ?? readPos() ?? { x: window.innerWidth - w - MARGIN, y: window.innerHeight - h - MARGIN }, w, h, window);
    setPos(next);
    writePos(next);
    setDock({ visible: true, height: h });
  }, [setDock]);
  useLayoutEffect(() => {
    if (floating) return;
    place(null);
    const onResize = () => place(readPos());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [floating, place]);
  // Report the size again when the number of tiles changes.
  const tiles = session.tiles();
  useEffect(() => { if (!floating && box.current) setDock({ visible: true, height: box.current.offsetHeight }); }, [tiles.length, floating, setDock]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (floating || !pos) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => { if (drag.current && box.current) place({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }); };
  const onPointerUp = () => { drag.current = null; };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (floating || !pos) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
    const v = d[e.key];
    if (v) { e.preventDefault(); place({ x: pos.x + v[0], y: pos.y + v[1] }); }
    else if (e.key === 'Home') { e.preventDefault(); try { window.localStorage.removeItem(POS_KEY); } catch { /* ignore */ } setPos(null); place({ x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER }); }
  };

  const handUp = tiles.find((t) => t.isLocal)?.hand ?? false;
  const shown = tiles.slice(0, MAX_TILES);
  const more = tiles.length - shown.length;
  const back = cur.kind === 'office' ? '/office' : `/meetings/${cur.meetingId}`;
  const status = session.status === 'connected' ? 'Connected' : session.status === 'reconnecting' ? 'Reconnecting…' : session.status === 'connecting' ? 'Connecting…' : session.status;
  const statusText = `${cur.kind === 'office' ? cur.label : cur.title}: ${status}, ${tiles.length} in call. Microphone ${session.micOn ? 'on' : 'off'}, camera ${session.camOn ? 'on' : 'off'}${session.sharing ? ', sharing your screen' : ''}.`;
  return (
    <section
      ref={box}
      role="dialog"
      aria-labelledby={`${id}-t`}
      data-testid="call-dock"
      data-status={session.status}
      data-mic={session.micOn ? 'on' : 'off'}
      data-cam={session.camOn ? 'on' : 'off'}
      className={cn('z-40 w-72 rounded-lg border bg-background p-2 text-foreground shadow-xl', floating ? 'relative m-2' : 'fixed max-w-[calc(100vw-2rem)]', !floating && !pos && 'invisible')}
      style={!floating && pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="flex items-center gap-1">
        {!floating ? (
          <button type="button" aria-label="Move the call window (arrow keys move it, Home resets it)" className="cursor-move rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKeyDown}>
            <GripHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <h2 id={`${id}-t`} className="min-w-0 flex-1 truncate text-sm font-medium">{cur.kind === 'office' ? cur.label : cur.title}</h2>
        {onFloat ? <Button size="sm" variant="ghost" className="h-7 px-1" aria-label="Float over other tabs" title="Float over other tabs" onClick={() => void onFloat()}><PictureInPicture2 aria-hidden="true" /></Button> : null}
        {onUnfloat ? <Button size="sm" variant="ghost" className="h-7 px-1" aria-label="Back to the page" title="Back to the page" onClick={onUnfloat}><PictureInPicture2 aria-hidden="true" /></Button> : null}
      </div>
      <p className="sr-only" aria-live="polite" data-testid="dock-status">{statusText}</p>
      <p className="truncate text-xs text-muted-foreground" aria-hidden="true">{status} · {tiles.length} in call · {session.micOn ? 'Mic on' : 'Mic off'} · {session.camOn ? 'Camera on' : 'Camera off'}</p>
      {c.notice ? <p role="status" className="text-xs text-destructive">{c.notice}</p> : null}
      <div className="mt-1 grid grid-cols-2 gap-1">
        {shown.map((t) => <TileView key={t.identity} t={t} />)}
        {more > 0 ? <p className="grid place-items-center rounded bg-muted text-xs text-muted-foreground" aria-label={`${more} more in the call`}>+{more}</p> : null}
      </div>
      <div role="toolbar" aria-label="Call controls" className="mt-1 flex flex-wrap items-center gap-1">
        <Button size="sm" variant={session.micOn ? 'default' : 'outline'} aria-pressed={session.micOn} aria-label={session.micOn ? 'Mute' : 'Unmute'} title={session.micOn ? 'Mute' : 'Unmute'} onClick={() => void session.toggleMic()}>{session.micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}</Button>
        <Button size="sm" variant={session.camOn ? 'default' : 'outline'} aria-pressed={session.camOn} aria-label="Camera" title="Camera" onClick={() => void session.toggleCam()}>{session.camOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />}</Button>
        <Button size="sm" variant={session.sharing ? 'default' : 'outline'} aria-pressed={session.sharing} aria-label={session.sharing ? 'Stop sharing' : 'Share screen'} title={session.sharing ? 'Stop sharing' : 'Share screen'} onClick={() => void session.toggleShare()}><MonitorUp aria-hidden="true" /></Button>
        <Button size="sm" variant={handUp ? 'default' : 'outline'} aria-pressed={handUp} aria-label={handUp ? 'Lower hand' : 'Raise hand'} title={handUp ? 'Lower hand' : 'Raise hand'} onClick={() => void session.raiseHand(!handUp)}><Hand aria-hidden="true" /></Button>
        <Button size="sm" variant="destructive" aria-label="Leave" title="Leave" onClick={() => void c.leave()}><PhoneOff aria-hidden="true" /></Button>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => { onUnfloat?.(); router.push(back); }}><ArrowLeftRight aria-hidden="true" /> {cur.kind === 'office' ? 'Return to office' : 'Return to meeting'}</Button>
      </div>
    </section>
  );
}
