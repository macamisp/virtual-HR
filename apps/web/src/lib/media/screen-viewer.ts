'use client';

/**
 * Browser helpers for the shared-screen viewer (FR-VO-009, FR-MEET-004; ADR 045): fullscreen,
 * picture-in-picture and a pop-out window. Framework-free. The pop-out is a same-origin blank
 * window that the office page renders into, so it shows the track this page already receives:
 * no second LiveKit connection, no token and no address to leak.
 */
import { RemoteVideoTrack, type ElementInfo, type Track } from 'livekit-client';

/** iOS Safari has no element fullscreen, only fullscreen for a <video>. */
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

export function canFullscreen(doc: Document = document): boolean {
  return doc.fullscreenEnabled === true;
}

export function canVideoFullscreen(video: HTMLVideoElement | null): boolean {
  return !!video && typeof (video as WebkitVideo).webkitEnterFullscreen === 'function';
}

export function enterVideoFullscreen(video: HTMLVideoElement): void {
  (video as WebkitVideo).webkitEnterFullscreen?.();
}

export function canPictureInPicture(doc: Document = document): boolean {
  return doc.pictureInPictureEnabled === true;
}

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3] as const;

/** The next zoom step above (or below) the current scale; `fitScale` is the scale "fit" shows. */
export function nextZoom(current: number | 'fit', fitScale: number, dir: 1 | -1): number {
  const at = current === 'fit' ? fitScale : current;
  const steps = dir > 0 ? ZOOM_STEPS.filter((s) => s > at + 0.001) : ZOOM_STEPS.filter((s) => s < at - 0.001).reverse();
  return steps[0] ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0]);
}

/**
 * Opens (or reuses) the pop-out window for one presenter. Returns null when the browser blocked
 * it. The page's stylesheets are copied in so the viewer looks the same there.
 */
export function openScreenWindow(key: string, title: string): { win: Window; root: HTMLElement } | null {
  const win = window.open('', `hrvo-screen-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`, 'popup,width=1280,height=760');
  if (!win) return null;
  const doc = win.document;
  doc.title = title;
  doc.documentElement.className = document.documentElement.className;
  doc.documentElement.lang = document.documentElement.lang;
  doc.head.replaceChildren(...[...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.cloneNode(true)));
  const meta = doc.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1';
  doc.head.append(meta);
  const root = doc.createElement('div');
  root.style.height = '100%';
  doc.body.replaceChildren(root);
  doc.body.style.margin = '0';
  doc.body.style.height = '100vh';
  doc.body.style.background = '#000';
  return { win, root };
}

/**
 * LiveKit's adaptive stream only sends video that is on screen in *this* window; an element in the
 * pop-out would count as hidden and be paused. This tells LiveKit the pop-out's real size and
 * visibility instead, and counts it like picture-in-picture so the share keeps flowing while the
 * office tab is in the background.
 */
function windowElementInfo(el: HTMLVideoElement, win: Window): ElementInfo {
  let ro: ResizeObserver | null = null;
  const shown = () => !win.closed && win.document.visibilityState === 'visible';
  const info: ElementInfo = {
    element: el,
    width: () => el.clientWidth,
    height: () => el.clientHeight,
    get visible() { return shown(); },
    get pictureInPicture() { return shown(); },
    visibilityChangedAt: 0,
    observe() {
      const obs = new (win as Window & typeof globalThis).ResizeObserver(() => info.handleResize?.());
      obs.observe(el);
      ro = obs;
      win.document.addEventListener('visibilitychange', onVisibility);
    },
    stopObserving() {
      ro?.disconnect();
      ro = null;
      if (!win.closed) win.document.removeEventListener('visibilitychange', onVisibility);
    },
  };
  function onVisibility() { info.visibilityChangedAt = Date.now(); info.handleVisibilityChanged?.(); }
  return info;
}

/** Shows `track` in a <video> that lives in another window; returns the clean-up. */
export function attachInWindow(track: Track, el: HTMLVideoElement, win: Window): () => void {
  // Registered before attach, so LiveKit does not add its own (main-window) visibility check.
  if (track instanceof RemoteVideoTrack) track.observeElementInfo(windowElementInfo(el, win));
  track.attach(el);
  return () => { track.detach(el); };
}
