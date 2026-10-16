/**
 * HRVO desktop agent, Electron main process (SRS 5.5 FR-ATT-011, FR-ATT-012; ADR 018).
 *
 * - Reads only the OS idle time (seconds since the last keyboard/mouse input) and the lock state.
 *   Never keystrokes, screens, window titles, files or application names.
 * - A tray icon is always visible while the agent runs; if it cannot be created the agent quits.
 *   Closing the window hides it; quitting stops tracking.
 * - Explicit consent screen before pairing; the accepted notice version is recorded by the server.
 * - Offline: intervals are buffered (encrypted) as monotonic offsets from the last server anchor
 *   and uploaded on reconnect, where they are flagged OFFLINE_SYNCED.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, Tray } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PairDtoSchema } from '../../../packages/shared/src/agent/types.ts';
import type { AgentPlatform, Anchor } from '../../../packages/shared/src/agent/types.ts';
import { AgentLink, ApiRefusal, fetchNotice, pair, trimUrl } from './connection.ts';
import type { LinkState, StoredCredentials } from './connection.ts';
import { INTERVAL_SECONDS, measureInterval, OfflineBuffer } from './tracker.ts';

const VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));
const TEST = process.env.HRVO_AGENT_TEST === '1';
if (process.env.HRVO_AGENT_DATA_DIR) app.setPath('userData', process.env.HRVO_AGENT_DATA_DIR);

// ------------------------------------------------------------------ encrypted storage

const file = (name: string) => join(app.getPath('userData'), name);
function save(name: string, value: unknown): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const json = JSON.stringify(value);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
  const tmp = `${file(name)}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file(name));
}
function load(name: string): unknown {
  if (!existsSync(file(name))) return null;
  try {
    const raw = readFileSync(file(name));
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
  } catch {
    return null;
  }
}
function forget(name: string): void { rmSync(file(name), { force: true }); }
/** On Linux without a keyring Electron falls back to a fixed key; say so instead of pretending. */
function storageNote(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return 'No OS keychain: credentials are stored unencrypted.';
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return 'No OS keychain found: credentials use basic encryption only.';
  return null;
}

const isCreds = (v: unknown): v is StoredCredentials => !!v && typeof v === 'object' &&
  typeof (v as StoredCredentials).apiUrl === 'string' && typeof (v as StoredCredentials).deviceId === 'string' &&
  typeof (v as StoredCredentials).refreshToken === 'string' && typeof (v as StoredCredentials).lastSequence === 'number';

// ------------------------------------------------------------------ state

let creds: StoredCredentials | null = isCreds(load('credentials.bin')) ? (load('credentials.bin') as StoredCredentials) : null;
let buffer = OfflineBuffer.fromJSON(load('offline.bin'));
let link: AgentLink | null = null;
type ShownState = LinkState | 'unpaired';
let linkState: ShownState = creds ? 'connecting' : 'unpaired';
let message: string | null = null;
let lastActivity: 'active' | 'idle' = 'active';
let lastSync: { at: number; accepted: number } | null = null;
let tray: Tray | null = null;
let trayTooltip = '';
let win: BrowserWindow | null = null;
let quitting = false;
let idleOverride: number | null = null;
let lockOverride: boolean | null = null;
let challenge: { id: string; expiresAt: string } | null = null;
let monoOffset = 0;
const mono = () => performance.now() + monoOffset;

function persistBuffer(): void { save('offline.bin', buffer.toJSON()); }

export interface UiState {
  screen: 'setup' | 'status';
  apiUrl: string;
  defaultDeviceName: string;
  status: { link: ShownState; activity: 'active' | 'idle'; email: string | null; buffered: number; lastSync: { at: number; accepted: number } | null; message: string | null; storage: string | null };
  /** FR-ATT-023: an open "Are you still working?" question. */
  challenge: { id: string; expiresAt: string } | null;
}
function uiState(): UiState {
  return {
    screen: creds ? 'status' : 'setup',
    apiUrl: creds?.apiUrl ?? process.env.HRVO_API_URL ?? '',
    defaultDeviceName: hostname().slice(0, 100) || 'My computer',
    status: { link: linkState, activity: lastActivity, email: creds?.email ?? null, buffered: buffer.size, lastSync, message, storage: storageNote() },
    challenge: challenge && Date.parse(challenge.expiresAt) > Date.now() ? challenge : null,
  };
}
function changed(): void {
  updateTray();
  win?.webContents.send('state-changed', uiState());
}

// ------------------------------------------------------------------ tray (always visible)

/** A filled circle drawn in code (no icon files): green tracking, amber idle/offline, grey not paired, red stopped. */
function dot(rgb: [number, number, number], size: number): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const r = size / 2 - 1;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
    const a = Math.max(0, Math.min(1, r - d + 0.5));
    const i = (y * size + x) * 4;
    buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = Math.round(a * 255);
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
function trayLabel(): { text: string; colour: [number, number, number] } {
  switch (linkState) {
    case 'unpaired': return { text: 'Not connected: open the agent to pair it', colour: [140, 140, 140] };
    case 'revoked': return { text: 'Stopped: this device was disconnected', colour: [200, 40, 40] };
    case 'offline': return { text: `Offline: ${buffer.size} interval${buffer.size === 1 ? '' : 's'} saved for later`, colour: [230, 160, 0] };
    case 'connecting': return { text: 'Connecting…', colour: [230, 160, 0] };
    case 'online': return lastActivity === 'active' ? { text: 'Tracking: active', colour: [20, 160, 70] } : { text: 'Tracking: idle', colour: [230, 160, 0] };
  }
}
function updateTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const { text, colour } = trayLabel();
  const img = dot(colour, 16);
  img.addRepresentation({ scaleFactor: 2, buffer: dot(colour, 32).toBitmap(), width: 32, height: 32 });
  tray.setImage(img);
  trayTooltip = `HRVO Agent: ${text}`;
  tray.setToolTip(trayTooltip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text, enabled: false },
    { type: 'separator' },
    { label: 'Show HRVO Agent', click: () => showWindow() },
    { label: 'Quit (stops tracking)', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ------------------------------------------------------------------ window

function showWindow(): void {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 480, height: 680, show: true, title: 'HRVO Agent', autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  void win.loadFile(join(here, 'renderer', 'index.html'));
}

// ------------------------------------------------------------------ tracking

function platform(): AgentPlatform {
  return process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MACOS' : process.platform === 'linux' ? 'LINUX' : 'OTHER';
}

async function syncPending(): Promise<void> {
  if (!link || link.state !== 'online') return;
  for (const batch of buffer.pending()) {
    try {
      const r = await link.upload(batch);
      buffer.acknowledge(batch.batchId);
      persistBuffer();
      lastSync = { at: Date.now(), accepted: r.accepted };
      message = r.accepted < batch.intervals.length
        ? `Synced ${r.accepted} of ${batch.intervals.length} offline intervals (the rest overlapped time already recorded or was too old).`
        : `Synced ${r.accepted} offline interval${r.accepted === 1 ? '' : 's'}. They are marked for your manager's review.`;
    } catch (err) {
      // A refusal of this batch's content can never succeed later: drop it and say so.
      if (err instanceof ApiRefusal && (err.status === 400 || err.status === 409 || err.status === 410)) {
        buffer.acknowledge(batch.batchId);
        persistBuffer();
        message = `Offline time could not be synced: ${err.message}. Ask for a correction in the web app.`;
        continue;
      }
      break; // network: retry on the next tick
    }
  }
  changed();
}

async function tick(): Promise<void> {
  const locked = lockOverride ?? powerMonitor.getSystemIdleState(60) === 'locked';
  const c = measureInterval(idleOverride ?? powerMonitor.getSystemIdleTime(), locked);
  lastActivity = c.activeSeconds > 0 ? 'active' : 'idle';
  if (!link) { changed(); return; }
  const sent = await link.heartbeat(c);
  if (!sent && link.state !== 'revoked') {
    const r = buffer.record(mono(), c);
    if (r === 'BUFFERED') persistBuffer();
    message = r === 'NO_ANCHOR'
      ? 'Offline since the agent started: this time cannot be recorded. Ask for a correction in the web app.'
      : r === 'FULL' ? 'Offline for more than 12 hours: later time is not recorded.' : null;
  } else if (sent && buffer.size > 0) {
    await syncPending();
  }
  changed();
}

function startLink(c: StoredCredentials): void {
  link?.stop();
  link = new AgentLink(c, {
    onState: (s, detail) => {
      linkState = s;
      if (s === 'revoked') {
        message = `${detail ?? 'This device was disconnected'}. Pair it again to continue.`;
        creds = null;
        forget('credentials.bin');
        link = null;
      } else if (s === 'online') {
        message = null;
        void tick(); // fresh anchor right away, then upload what was buffered
      }
      changed();
    },
    onCredentials: (next) => { creds = next; save('credentials.bin', next); },
    onAnchor: (a: Anchor) => buffer.setAnchor(a, mono()),
    onChallenge: (c) => {
      challenge = c;
      showWindow();
      if (Notification.isSupported()) new Notification({ title: 'HRVO: are you still working?', body: 'Answer within a minute, or tracking pauses.' }).show();
      setTimeout(() => { if (challenge?.id === c.id) { challenge = null; changed(); } }, Math.max(0, Date.parse(c.expiresAt) - Date.now()) + 500);
      changed();
    },
  });
  void link.start();
}

// ------------------------------------------------------------------ IPC (renderer has no Node, no network)

ipcMain.handle('state', () => uiState());
ipcMain.handle('notice', async (_e, apiUrl: unknown) => {
  if (typeof apiUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(apiUrl.trim())) throw new Error('Enter the server address, for example https://hr.example.com/api');
  return await fetchNotice(apiUrl);
});
ipcMain.handle('pair', async (_e, input: unknown) => {
  const i = (input ?? {}) as { apiUrl?: unknown; code?: unknown; deviceName?: unknown; consentNoticeVersion?: unknown };
  if (typeof i.apiUrl !== 'string') throw new Error('Missing server address');
  const dto = PairDtoSchema.parse({ code: i.code, deviceName: i.deviceName, platform: platform(), agentVersion: VERSION, consentNoticeVersion: i.consentNoticeVersion });
  const apiUrl = trimUrl(i.apiUrl);
  try {
    const s = await pair(apiUrl, dto);
    creds = { apiUrl, deviceId: s.deviceId, refreshToken: s.refreshToken, email: s.user.email, displayName: s.user.displayName, lastSequence: 0 };
    save('credentials.bin', creds);
    buffer = new OfflineBuffer();
    persistBuffer();
    message = null;
    linkState = 'connecting';
    startLink(creds);
    changed();
    return uiState();
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Pairing failed');
  }
});
ipcMain.handle('disconnect', async () => {
  // Revokes this device on the server; the server's auth:revoked then clears the local credentials.
  if (link) await link.revokeSelf().catch(() => undefined);
  link?.stop();
  link = null;
  creds = null;
  forget('credentials.bin');
  linkState = 'unpaired';
  message = 'This device is disconnected.';
  changed();
  return uiState();
});
ipcMain.handle('challenge-answer', async (_e, id: unknown) => {
  if (typeof id !== 'string' || !challenge || challenge.id !== id || !link) return uiState();
  const ok = await link.answerChallenge(id);
  challenge = null;
  message = ok ? 'Thanks. Tracking continues.' : 'The question had expired. Any input resumes tracking.';
  changed();
  return uiState();
});
ipcMain.handle('quit', () => { quitting = true; app.quit(); });

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.on('before-quit', () => { quitting = true; link?.stop(); });

  void app.whenReady().then(() => {
    try {
      tray = new Tray(dot([140, 140, 140], 16));
      tray.on('click', () => showWindow());
    } catch {
      // FR-ATT-011: never track without a visible tray icon.
      dialog.showErrorBox('HRVO Agent', 'The tray icon could not be shown on this desktop, so the agent will not run. Tracking needs a visible tray icon.');
      app.exit(1);
      return;
    }
    updateTray();
    if (creds) startLink(creds);
    if (!creds || TEST) showWindow();
    setInterval(() => void tick(), INTERVAL_SECONDS * 1000).unref();
    powerMonitor.on('lock-screen', () => { lastActivity = 'idle'; changed(); });

    if (TEST) {
      // Test hooks for Playwright (HRVO_AGENT_TEST=1 only).
      (globalThis as unknown as { __hrvoAgentTest: unknown }).__hrvoAgentTest = {
        state: () => uiState(),
        tray: () => ({ exists: !!tray && !tray.isDestroyed(), tooltip: trayTooltip }),
        setIdle: (s: number | null) => { idleOverride = s; },
        setLocked: (v: boolean | null) => { lockOverride = v; },
        advance: (ms: number) => { monoOffset += ms; },
        tick: () => tick(),
        setOffline: (v: boolean) => link?.setForcedOffline(v),
        setAnchor: (a: Anchor) => buffer.setAnchor(a, mono()),
        deviceId: () => creds?.deviceId ?? null,
      };
    }
  });
}
