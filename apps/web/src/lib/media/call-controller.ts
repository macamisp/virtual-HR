'use client';

/**
 * ADR 048: the one call of this tab, above the pages. Owns the LiveKit session and the office
 * realtime connection so both survive client-side navigation; pages render from it. Framework-
 * free; React subscribes with subscribe/getVersion (like MediaSession and OfficeClient).
 *
 * - `current` says what the session is for: an office route (a closed room or a proximity group,
 *   chosen by `mediaRoute` as the server does, ADR 044) or a meeting. A meeting wins over the office
 *   route; when it is left the office route applies again. One MediaSession, so never two sessions.
 * - One browser tab owns the call (Web Lock `hrvo-call-owner`, like the heartbeat leader). Another
 *   tab sees "open in another tab" and may take over; the previous owner then leaves.
 */
import { mediaRoute, type MediaToken, type MediaTokenRequest, type OfficeSnapshot } from '@hrvo/shared';
import { ApiError } from '@/lib/api';
import { fetchMediaToken } from '@/lib/meeting-queries';
import { OfficeClient } from '@/lib/office/office-client';
import { loadPrefs, type DevicePrefs } from './devices';
import { MediaSession } from './media-session';

export type Current =
  | { kind: 'office'; key: string; label: string }
  | { kind: 'meeting'; meetingId: string; title: string };

export type LockState = 'none' | 'owner' | 'elsewhere' | 'taken';

const LOCK = 'hrvo-call-owner';
const ENABLED_KEY = 'hrvo.office.media';
const ROUTE_DEBOUNCE_MS = 600;

function readEnabled(): boolean { try { return window.sessionStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; } }
function writeEnabled(v: boolean): void { try { if (v) window.sessionStorage.setItem(ENABLED_KEY, '1'); else window.sessionStorage.removeItem(ENABLED_KEY); } catch { /* storage unavailable */ } }

/** Which call the avatar's position implies: a closed room, a proximity group, or none (the same rule the server uses). */
export function officeRoute(client: OfficeClient): { key: string; label: string; req: MediaTokenRequest } | null {
  const route = mediaRoute({ roomId: client.self?.roomId ?? null, rooms: client.snapshot.rooms, roomOnly: client.roomOnly, proximity: client.proximity });
  if (!route) return null;
  const room = route.kind === 'room' ? client.snapshot.rooms.find((r) => r.id === client.self?.roomId) : null;
  return { key: route.key, label: room?.name ?? 'Nearby', req: { kind: route.kind } };
}

export class CallController {
  readonly session = new MediaSession();
  office: OfficeClient | null = null;
  current: Current | null = null;
  /** Office audio/video turned on (survives a reload of this tab). */
  officeMediaEnabled = false;
  prefs: DevicePrefs | null = null;
  lock: LockState = 'none';
  /** Something to tell the user about the call (could not join, taken over…). */
  notice: string | null = null;
  /** The office page is on screen (its map or list), and whether the map wants the position stream. */
  officeVisible = false;
  officePositions = false;
  /** ADR 048 §7: mute when leaving the office page during an office call. */
  muteOnLeave = false;

  private version = 0;
  private listeners = new Set<() => void>();
  private unsubOffice: (() => void) | null = null;
  private routeTimer: ReturnType<typeof setTimeout> | null = null;
  private routeKey: string | null = null;
  private volumeTimer: ReturnType<typeof setInterval> | null = null;
  private releaseLock: (() => void) | null = null;
  private lockWaiting = false;

  constructor() {
    this.officeMediaEnabled = typeof window !== 'undefined' && readEnabled();
    if (this.officeMediaEnabled) this.prefs = loadPrefs();
    this.session.subscribe(() => {
      // The room ended under us (removed by the host, meeting ended, a LiveKit full reconnect with
      // an expired room token): drop the route so the dock closes. An office call is then joined
      // again with a fresh token at once, not only when the next office event happens to arrive.
      if (this.session.status === 'ended' && this.current) {
        const wasOffice = this.current.kind === 'office';
        this.current = null;
        this.routeKey = null;
        this.release();
        if (wasOffice) setTimeout(() => this.evaluateRoute(), 1000);
      }
      this.changed();
    });
  }

  // ---------------------------------------------------------------- React glue

  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getVersion = (): number => this.version;
  private changed(): void { this.version += 1; for (const l of this.listeners) l(); }

  get inCall(): boolean { return !!this.current && this.session.room !== null; }

  // ---------------------------------------------------------------- office presence (ADR 048 §2)

  /** The office page hands over its snapshot; the client is created once and kept across pages. */
  enterOffice(snapshot: OfficeSnapshot): OfficeClient {
    if (this.office) {
      if (this.office.snapshot !== snapshot) { this.office.snapshot = snapshot; this.office.changed(); }
      return this.office;
    }
    const client = new OfficeClient(snapshot, this.officePositions);
    client.setView(this.officeVisible, this.officePositions);
    this.office = client;
    this.muteOnLeave = snapshot.me.muteOnLeave;
    this.unsubOffice = client.subscribe(() => { this.evaluateRoute(); this.changed(); });
    client.connect();
    this.changed();
    return client;
  }

  /** Leave the office for good: the avatar disappears for everyone and an office call ends. */
  leaveOffice(): void {
    this.unsubOffice?.();
    this.unsubOffice = null;
    this.office?.disconnect();
    this.office = null;
    this.officeVisible = false;
    if (this.current?.kind === 'office') void this.endCall();
    this.changed();
  }

  /** The office page came on or off screen; `positions` only while the map is shown. */
  setOfficeView(visible: boolean, positions: boolean): void {
    const was = this.officeVisible;
    this.officeVisible = visible;
    this.officePositions = positions;
    this.office?.setView(visible, positions);
    if (was && !visible && this.muteOnLeave && this.current?.kind === 'office' && this.session.micOn) void this.session.toggleMic();
    this.changed();
  }

  setMuteOnLeave(v: boolean): void { this.muteOnLeave = v; this.changed(); }

  // ---------------------------------------------------------------- office audio/video (FR-VO-005, FR-MEET-002)

  enableOfficeMedia(prefs: DevicePrefs): void {
    this.prefs = prefs;
    this.session.resetChoices();
    this.officeMediaEnabled = true;
    writeEnabled(true);
    this.notice = null;
    this.evaluateRoute();
    this.changed();
  }

  disableOfficeMedia(): void {
    this.officeMediaEnabled = false;
    writeEnabled(false);
    if (this.current?.kind === 'office') void this.endCall();
    this.routeKey = null;
    this.changed();
  }

  /** The office route this tab should be on now, or null. Debounced: walking along the edge of a group must not reconnect every tick. */
  private evaluateRoute(): void {
    const client = this.office;
    const route = client && this.officeMediaEnabled && this.current?.kind !== 'meeting' ? officeRoute(client) : null;
    const key = route?.key ?? null;
    if (key === this.routeKey) return;
    if (this.routeTimer) clearTimeout(this.routeTimer);
    this.routeTimer = setTimeout(() => {
      this.routeTimer = null;
      if (this.current?.kind === 'meeting') return;
      this.routeKey = key;
      this.notice = null;
      if (!key || !route) { if (this.current?.kind === 'office') void this.endCall(); return; }
      this.current = { kind: 'office', key, label: route.label };
      this.changed();
      void this.connectOffice(key, route.req, true);
    }, ROUTE_DEBOUNCE_MS);
  }

  private async connectOffice(key: string, req: MediaTokenRequest, retry: boolean): Promise<void> {
    if (!(await this.acquire())) return;
    try {
      const token = await fetchMediaToken(req);
      if (this.routeKey !== key) return;
      await this.session.connect(token, this.prefs ?? loadPrefs());
      this.startVolumes(key);
    } catch (err) {
      // The server's proximity grouping can lag the client by one tick.
      if (retry && err instanceof ApiError && err.status === 409) { setTimeout(() => { if (this.routeKey === key) void this.connectOffice(key, req, false); }, 1000); return; }
      if (this.routeKey === key) { this.notice = err instanceof Error ? err.message : 'Could not join the call'; this.changed(); }
    }
  }

  /** FR-VO-005: volume falls off with distance in a proximity call. */
  private startVolumes(key: string): void {
    this.stopVolumes();
    if (!key.startsWith('prox:')) return;
    this.volumeTimer = setInterval(() => {
      const client = this.office;
      const me = client?.self;
      if (!client || !me) return;
      const radius = client.snapshot.office.proximityRadius;
      const v = new Map<string, number>();
      for (const a of client.avatars.values()) v.set(a.id, 1 - (Math.hypot(a.rx - me.x, a.ry - me.y) / radius) * 0.85);
      this.session.setVolumes(v);
    }, 300);
  }
  private stopVolumes(): void { if (this.volumeTimer) clearInterval(this.volumeTimer); this.volumeTimer = null; }

  // ---------------------------------------------------------------- meetings (FR-MEET-002, 005)

  /** Joins a meeting with the token the join flow got; an office call in progress is replaced. */
  async joinMeeting(meeting: { id: string; title: string }, token: MediaToken, prefs: DevicePrefs): Promise<'joined' | 'elsewhere'> {
    this.prefs = prefs;
    this.session.resetChoices();
    this.notice = null;
    if (!(await this.acquire())) return 'elsewhere';
    this.stopVolumes();
    this.routeKey = null;
    this.current = { kind: 'meeting', meetingId: meeting.id, title: meeting.title };
    this.changed();
    await this.session.connect(token, prefs);
    return 'joined';
  }

  /** Leaves whatever call is running; office media stays on, so the office route applies again. */
  async leaveMeeting(): Promise<void> {
    if (this.current?.kind !== 'meeting') return;
    await this.endCall();
    this.evaluateRoute();
  }

  /** The dock's Leave: a meeting is left; an office call is turned off (otherwise it would rejoin at once). */
  async leave(): Promise<void> {
    if (this.current?.kind === 'meeting') await this.leaveMeeting();
    else this.disableOfficeMedia();
  }

  private async endCall(): Promise<void> {
    this.stopVolumes();
    this.current = null;
    this.routeKey = null;
    this.changed();
    await this.session.disconnect();
    this.release();
  }

  /** Sign-out, session revoke: everything down, devices released (ADR 048 §5). */
  async shutdown(): Promise<void> {
    if (this.routeTimer) clearTimeout(this.routeTimer);
    this.routeTimer = null;
    this.officeMediaEnabled = false;
    writeEnabled(false);
    await this.endCall();
    this.leaveOffice();
  }

  // ---------------------------------------------------------------- one tab owns the call (ADR 048 §4)

  private async acquire(): Promise<boolean> {
    if (this.lock === 'owner') return true;
    if (typeof navigator === 'undefined' || !navigator.locks) { this.lock = 'owner'; return true; }
    if (this.lockWaiting) return false;
    this.lockWaiting = true;
    const got = await new Promise<boolean>((resolve) => {
      void navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return Promise.resolve(); }
        resolve(true);
        return new Promise<void>((done) => { this.releaseLock = done; });
      }).catch((err: unknown) => {
        // Another tab took the call over: this one leaves it.
        if (err instanceof DOMException && err.name === 'AbortError') this.onTaken();
      });
    });
    this.lockWaiting = false;
    this.lock = got ? 'owner' : 'elsewhere';
    this.changed();
    return got;
  }

  private release(): void {
    this.releaseLock?.();
    this.releaseLock = null;
    if (this.lock === 'owner' || this.lock === 'elsewhere') this.lock = 'none';
    this.changed();
  }

  private onTaken(): void {
    this.releaseLock = null;
    this.lock = 'taken';
    this.notice = 'This call was taken over by another tab.';
    this.routeKey = null;
    const wasOffice = this.current?.kind === 'office';
    this.current = null;
    this.stopVolumes();
    void this.session.disconnect();
    if (wasOffice) { this.officeMediaEnabled = false; writeEnabled(false); }
    this.changed();
  }

  /** "Take over": steals the lock; the other tab is told and leaves. Then the call is joined here. */
  async takeOver(retryMeeting?: () => Promise<void>): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.locks) return;
    this.lock = 'none';
    this.notice = null;
    await new Promise<void>((resolve) => {
      void navigator.locks.request(LOCK, { steal: true }, (lock) => {
        if (!lock) { resolve(); return Promise.resolve(); }
        this.lock = 'owner';
        resolve();
        return new Promise<void>((done) => { this.releaseLock = done; });
      }).catch((err: unknown) => { if (err instanceof DOMException && err.name === 'AbortError') this.onTaken(); });
    });
    this.changed();
    if (retryMeeting) { await retryMeeting(); return; }
    this.routeKey = null;
    this.evaluateRoute();
  }
}

let singleton: CallController | null = null;
/** One controller per tab (created on first use in the browser). */
export function callController(): CallController {
  if (!singleton) singleton = new CallController();
  return singleton;
}
