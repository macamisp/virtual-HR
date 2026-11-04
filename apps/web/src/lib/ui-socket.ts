'use client';

/**
 * One shared Socket.IO connection per tab for UI events that are not attendance (ADR 016, 017):
 * call rings, lobby requests and decisions, removals, office broadcasts and chat messages. It uses
 * purpose "office" so it never keeps an attendance session open.
 */
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './env';
import { useAuthStore } from './auth-store';
import { refreshSession, secondsUntilExpiry } from './session';

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let socket: Socket | null = null;
let unsubAuth: (() => void) | null = null;

function ensure(): Socket {
  if (socket) return socket;
  socket = io(API_URL, {
    transports: ['websocket'],
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken ?? '', purpose: 'office' }),
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  // ADR 048 §8: the same recovery as the office socket. The server kicks a socket when its token
  // expires and Socket.IO never reconnects from a kick or a refused handshake by itself; and every
  // refreshed token is handed to the live socket so an idle tab is not kicked in the first place.
  let denied = 0;
  let reconnecting = false;
  const extend = async () => {
    const s = socket;
    const token = useAuthStore.getState().accessToken;
    if (!s || !token) return;
    if (!s.connected) { s.connect(); return; }
    const connection = s.id;
    const r = await s.timeout(10_000).emitWithAck('auth:refresh', { token }).catch(() => null) as { success: boolean } | null;
    if (socket !== s || s.id !== connection) return; // a reply about an earlier connection
    if (!r?.success) { s.disconnect(); void reconnect(); }
  };
  const reconnect = async (afterMs = 0) => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      if (afterMs) await new Promise((r) => setTimeout(r, afterMs));
      const token = useAuthStore.getState().accessToken;
      if (!token || secondsUntilExpiry(token) < 30) { if (!(await refreshSession())) return; }
      if (socket && !socket.connected) socket.connect();
    } finally { reconnecting = false; }
  };
  socket.on('connect', () => { denied = 0; });
  socket.on('disconnect', (reason) => { if (reason === 'io server disconnect') void reconnect(); });
  socket.on('connect_error', (err) => { if (err.message === 'Unauthorized') { denied += 1; void reconnect(Math.min(30_000, 2_000 * denied)); } });
  socket.on('auth:expired', () => undefined); // the server disconnects next; the disconnect handler reconnects
  unsubAuth?.();
  unsubAuth = useAuthStore.subscribe((state, prev) => { if (state.accessToken && state.accessToken !== prev.accessToken) void extend(); });
  socket.onAny((event: string, payload: unknown) => { for (const h of handlers.get(event) ?? []) h(payload); });
  return socket;
}

/** Subscribe to a server event; returns the unsubscribe function. */
export function onUiEvent<T>(event: string, handler: (payload: T) => void): () => void {
  ensure();
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(handler as Handler);
  handlers.set(event, set);
  return () => set.delete(handler as Handler);
}

export function closeUiSocket(): void {
  unsubAuth?.();
  unsubAuth = null;
  socket?.disconnect();
  socket = null;
}
