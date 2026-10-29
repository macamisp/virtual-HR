'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  Eye, ExternalLink, Maximize, Maximize2, Minimize, Minimize2, MonitorOff, PictureInPicture2, Scan, Square, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { Track } from 'livekit-client';
import { Button } from '@/components/ui/button';
import {
  attachInWindow, canFullscreen, canPictureInPicture, canVideoFullscreen, enterVideoFullscreen, nextZoom, openScreenWindow,
} from '@/lib/media/screen-viewer';
import { cn } from '@/lib/utils';

type Zoom = 'fit' | number;

/** One toolbar button: icon always, text from `md` up in the large views, tooltip and label always. */
function Tool({ label, icon, onClick, pressed, disabled, title, showText, variant = 'ghost', testId }: {
  label: string; icon: React.ReactNode; onClick: () => void; pressed?: boolean; disabled?: boolean; title?: string; showText?: boolean;
  variant?: 'ghost' | 'destructive'; testId?: string;
}) {
  return (
    <Button type="button" size="sm" variant={variant} aria-label={label} title={title ?? label} aria-pressed={pressed} disabled={disabled} onClick={onClick} data-testid={testId}
      className={cn('h-8 px-2', variant === 'ghost' && 'text-white hover:bg-white/15 hover:text-white', pressed && 'bg-white/20')}>
      {icon}{showText ? <span className="hidden md:inline">{label}</span> : null}
    </Button>
  );
}

/**
 * The shared screen, attached with LiveKit (adaptive stream follows the element's size, so a larger
 * view receives a sharper layer). Fit keeps the whole screen visible at its own aspect ratio;
 * a zoom level shows it at that multiple of its real pixel size, scrollable.
 */
function ScreenVideo({ track, label, zoom, onFitScale, videoRef, win }: {
  track: Track; label: string; zoom: Zoom; onFitScale?: (s: number) => void; videoRef?: React.RefObject<HTMLVideoElement | null>; win?: Window;
}) {
  const own = useRef<HTMLVideoElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    if (videoRef) videoRef.current = el;
    const done = win ? attachInWindow(track, el, win) : (track.attach(el), () => { track.detach(el); });
    const onSize = () => setSize({ w: el.videoWidth, h: el.videoHeight });
    el.addEventListener('resize', onSize);
    el.addEventListener('loadedmetadata', onSize);
    onSize();
    return () => {
      el.removeEventListener('resize', onSize);
      el.removeEventListener('loadedmetadata', onSize);
      done();
      if (videoRef?.current === el) videoRef.current = null;
    };
  }, [track, videoRef, win]);
  useEffect(() => {
    const b = box.current;
    if (!b || !onFitScale || !size.w) return;
    const report = () => onFitScale(Math.min(b.clientWidth / size.w, b.clientHeight / size.h));
    const ro = new ((win ?? window) as Window & typeof globalThis).ResizeObserver(report);
    ro.observe(b);
    report();
    return () => ro.disconnect();
  }, [onFitScale, size, win]);
  const zoomed = zoom !== 'fit' && size.w > 0;
  return (
    <div ref={box} className={cn('h-full w-full', zoomed ? 'overflow-auto' : 'grid place-items-center overflow-hidden')} data-testid="screen-stage" data-zoom={zoom === 'fit' ? 'fit' : String(zoom)}>
      <video ref={own} autoPlay playsInline muted aria-label={label}
        className={zoomed ? 'max-w-none' : 'h-full w-full object-contain'}
        style={zoomed ? { width: size.w * zoom, height: size.h * zoom } : undefined} />
    </div>
  );
}

/** Fit, actual size and zoom (large views only). */
function ZoomTools({ zoom, setZoom, fitScale, showText }: { zoom: Zoom; setZoom: (z: Zoom) => void; fitScale: number; showText?: boolean }) {
  return (
    <>
      <Tool label="Fit to screen" icon={<Scan aria-hidden="true" />} pressed={zoom === 'fit'} onClick={() => setZoom('fit')} showText={showText} />
      <Tool label="Actual size" icon={<Square aria-hidden="true" />} pressed={zoom === 1} onClick={() => setZoom(1)} showText={showText} />
      <Tool label="Zoom shared screen out" title="Zoom out" icon={<ZoomOut aria-hidden="true" />} onClick={() => setZoom(nextZoom(zoom, fitScale, -1))} />
      <span className="min-w-[3.5rem] text-center text-xs tabular-nums" aria-live="polite" data-testid="screen-zoom">{zoom === 'fit' ? `Fit ${Math.round(fitScale * 100)}%` : `${Math.round(zoom * 100)}%`}</span>
      <Tool label="Zoom shared screen in" title="Zoom in" icon={<ZoomIn aria-hidden="true" />} onClick={() => setZoom(nextZoom(zoom, fitScale, 1))} />
    </>
  );
}

/** The pop-out window's content (rendered from this page into the other window's document). */
function PopoutView({ track, name, win, onClose }: { track: Track; name: string; win: Window; onClose: () => void }) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [fitScale, setFitScale] = useState(1);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const doc = win.document;
    const on = () => setFull(!!doc.fullscreenElement);
    doc.addEventListener('fullscreenchange', on);
    return () => doc.removeEventListener('fullscreenchange', on);
  }, [win]);
  const toggleFull = () => {
    const doc = win.document;
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else void frame.current?.requestFullscreen().catch(() => undefined);
  };
  return (
    <div ref={frame} className="flex h-full flex-col bg-black text-white" data-testid="screen-popout">
      <div role="toolbar" aria-label="Shared screen controls" className="flex flex-wrap items-center gap-1 bg-black/80 px-2 py-1">
        <span className="mr-auto truncate text-sm">{name} is presenting</span>
        <ZoomTools zoom={zoom} setZoom={setZoom} fitScale={fitScale} showText />
        <Tool label={full ? 'Exit full screen' : 'Full screen'} icon={full ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />} pressed={full}
          disabled={!canFullscreen(win.document)} title={canFullscreen(win.document) ? undefined : 'Full screen is not available in this browser'} onClick={toggleFull} showText />
        <Tool label="Close window" icon={<X aria-hidden="true" />} onClick={onClose} showText />
      </div>
      <div className="min-h-0 flex-1"><ScreenVideo track={track} label={`Screen shared by ${name}`} zoom={zoom} onFitScale={setFitScale} win={win} /></div>
    </div>
  );
}

/**
 * FR-VO-009 / FR-MEET-004 (ADR 045): a shared screen in the office or a meeting, with ways to see it
 * properly: expand over the page, browser full screen, a separate window, picture-in-picture, fit,
 * actual size and zoom. All of them only change how this viewer shows the track it already
 * receives; none reconnects. Closing the viewer hides it for you; only the presenter can stop
 * the share.
 */
export function ScreenShareViewer({ track, name, isLocal, reconnecting, onStopSharing }: {
  track: Track; name: string; isLocal: boolean; reconnecting?: boolean; onStopSharing?: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [pip, setPip] = useState(false);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [fitScale, setFitScale] = useState(1);
  const [popout, setPopout] = useState<{ win: Window; root: HTMLElement } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [caps, setCaps] = useState({ full: false, pip: false });
  const inlineVideo = useRef<HTMLVideoElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  const expandBtn = useRef<HTMLDivElement | null>(null);
  const fullFrom = useRef<'inline' | 'expanded'>('inline');
  const label = `Screen shared by ${name}`;

  // Feature detection after mount (the server render has no document).
  useEffect(() => { setCaps({ full: canFullscreen(), pip: canPictureInPicture() }); }, []);

  // Full screen: follow the browser (Escape exits) and go back to the layout it started from.
  useEffect(() => {
    const on = () => {
      const now = !!overlay.current && document.fullscreenElement === overlay.current;
      setFull(now);
      if (!now && fullFrom.current === 'inline') setExpanded(false);
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // Escape closes the expanded view (in full screen the browser takes Escape first).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.fullscreenElement) setExpanded(false); };
    document.addEventListener('keydown', onKey);
    overlay.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const back = expandBtn.current?.querySelector<HTMLButtonElement>('button');
    return () => {
      document.removeEventListener('keydown', onKey);
      back?.focus();
    };
  }, [expanded]);

  // Picture-in-picture follows the browser's own window too.
  useEffect(() => {
    const v = inlineVideo.current;
    if (!v || hidden) return;
    const enter = () => setPip(true);
    const leave = () => setPip(false);
    v.addEventListener('enterpictureinpicture', enter);
    v.addEventListener('leavepictureinpicture', leave);
    return () => { v.removeEventListener('enterpictureinpicture', enter); v.removeEventListener('leavepictureinpicture', leave); };
  }, [hidden, track]);

  // The pop-out: notice when the person closes it; close it when the share ends or this page goes.
  useEffect(() => {
    if (!popout) return;
    const { win } = popout;
    const gone = () => setPopout((p) => (p?.win === win ? null : p));
    win.addEventListener('pagehide', gone);
    const poll = setInterval(() => { if (win.closed) gone(); }, 1000);
    const closeIt = () => { if (!win.closed) win.close(); };
    window.addEventListener('pagehide', closeIt);
    return () => {
      clearInterval(poll);
      window.removeEventListener('pagehide', closeIt);
      if (!win.closed) win.removeEventListener('pagehide', gone);
    };
  }, [popout]);
  const popoutRef = useRef(popout);
  popoutRef.current = popout;
  useEffect(() => () => {
    const w = popoutRef.current?.win;
    if (w && !w.closed) w.close();
    if (document.pictureInPictureElement && document.pictureInPictureElement === inlineVideo.current) void document.exitPictureInPicture().catch(() => undefined);
  }, []);

  const closePopout = useCallback(() => {
    const w = popoutRef.current?.win;
    setPopout(null);
    if (w && !w.closed) w.close();
  }, []);

  const toggleFull = () => {
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (!caps.full) {
      // iPhone Safari: only the <video> itself can go full screen.
      if (canVideoFullscreen(inlineVideo.current) && inlineVideo.current) enterVideoFullscreen(inlineVideo.current);
      else setNotice('Full screen is not available in this browser. Use Expand instead.');
      return;
    }
    fullFrom.current = expanded ? 'expanded' : 'inline';
    flushSync(() => setExpanded(true));
    void overlay.current?.requestFullscreen().catch(() => setNotice('The browser did not allow full screen.'));
  };

  const togglePip = async () => {
    const v = inlineVideo.current;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v) await v.requestPictureInPicture();
    } catch { setNotice('Picture-in-picture is not available right now.'); }
  };

  const togglePopout = () => {
    if (popout) { closePopout(); return; }
    const opened = openScreenWindow(name, label);
    if (!opened) { setNotice('Your browser blocked the new window. Allow pop-ups for this site, or use Expand.'); return; }
    setNotice(null);
    if (document.fullscreenElement) void document.exitFullscreen();
    setExpanded(false);
    setPopout(opened);
    opened.win.focus();
  };

  const closeViewer = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    closePopout();
    setExpanded(false);
    setHidden(true);
  };

  const stopTool = isLocal && onStopSharing
    ? <Tool label="Stop presenting" title="Stop sharing your screen (everyone stops seeing it)" icon={<MonitorOff aria-hidden="true" />} variant="destructive" onClick={onStopSharing} showText={expanded} testId="screen-stop" />
    : null;
  const fullTitle = caps.full ? undefined : 'Full screen is not available in this browser';
  const pipTitle = caps.pip ? undefined : 'Picture-in-picture is not available in this browser';

  if (hidden) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded bg-slate-900 px-2 py-1 text-xs text-white" data-testid="screen-share" data-viewer="closed">
        <span className="mr-auto">{name} is presenting</span>
        <Tool label="Show shared screen" icon={<Eye aria-hidden="true" />} onClick={() => setHidden(false)} showText />
        {stopTool}
      </div>
    );
  }

  const tools = (big: boolean) => (
    <>
      <div ref={big ? undefined : expandBtn} className="contents">
        <Tool label={expanded ? 'Minimize' : 'Expand'} title={expanded ? 'Back to the office (Esc)' : 'Expand shared screen'} icon={expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          pressed={expanded} onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); setExpanded(!expanded); }} showText={big} />
      </div>
      <Tool label={full ? 'Exit full screen' : 'Full screen'} icon={full ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />} pressed={full} title={fullTitle} onClick={toggleFull} showText={big} />
      <Tool label={popout ? 'Close new window' : 'Open in new window'} icon={<ExternalLink aria-hidden="true" />} pressed={!!popout} onClick={togglePopout} showText={big} />
      <Tool label={pip ? 'Exit picture-in-picture' : 'Picture-in-picture'} icon={<PictureInPicture2 aria-hidden="true" />} pressed={pip} disabled={!caps.pip} title={pipTitle} onClick={() => void togglePip()} showText={big} />
      {big ? <ZoomTools zoom={zoom} setZoom={setZoom} fitScale={fitScale} showText /> : null}
      {stopTool}
      <Tool label="Close viewer" title="Close viewer (the share continues)" icon={<X aria-hidden="true" />} onClick={closeViewer} showText={big} />
    </>
  );
  const status = reconnecting ? <span role="status" className="rounded bg-yellow-500/90 px-1.5 text-xs text-black">Reconnecting…</span> : null;

  return (
    <figure className="overflow-hidden rounded bg-black" data-testid="screen-share" data-viewer={expanded ? 'expanded' : popout ? 'popout' : 'inline'}>
      <div className="relative aspect-video">
        <ScreenVideo track={track} label={label} zoom="fit" videoRef={inlineVideo} />
        {popout ? <p className="absolute inset-x-0 top-0 bg-black/70 px-2 py-1 text-center text-xs text-white" role="status">Also open in a separate window</p> : null}
      </div>
      <figcaption className="flex flex-wrap items-center gap-1 px-2 py-1 text-xs text-white">
        <span className="mr-auto truncate">{name}{isLocal ? ' (you) are' : ' is'} presenting</span>
        {status}
        <span role="toolbar" aria-label="Shared screen controls" className="flex flex-wrap items-center">{tools(false)}</span>
      </figcaption>
      {notice ? <p role="alert" className="flex items-center gap-2 bg-slate-800 px-2 py-1 text-xs text-white">{notice}<button type="button" className="ml-auto underline" onClick={() => setNotice(null)}>Dismiss</button></p> : null}
      {expanded ? createPortal(
        <div ref={overlay} role="dialog" aria-modal="true" aria-label={label} data-testid="screen-viewer-expanded" data-fullscreen={full ? 'true' : 'false'}
          className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-black text-white">
          <div role="toolbar" aria-label="Expanded shared screen controls" className="flex flex-wrap items-center gap-1 bg-black/80 px-2 py-1">
            <span className="mr-auto truncate text-sm">{name}{isLocal ? ' (you) are' : ' is'} presenting</span>
            {status}
            {tools(true)}
          </div>
          <div className="min-h-0 flex-1"><ScreenVideo track={track} label={`${label} (expanded)`} zoom={zoom} onFitScale={setFitScale} /></div>
        </div>,
        document.body,
      ) : null}
      {popout ? createPortal(<PopoutView track={track} name={name} win={popout.win} onClose={closePopout} />, popout.root) : null}
    </figure>
  );
}
