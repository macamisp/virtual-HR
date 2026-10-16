'use client';

/**
 * One shared Socket.IO connection per tab for UI events that are not attendance (ADR 016, 017):
 * call rings, lobby requests and decisions, removals, office broadcasts and chat messages. It uses
 * purpose "office" so it never keeps an attendance session open.
 */
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './env';
import { useAuthStore } from './auth-store';

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let socket: Socket | null = null;

function ensure(): Socket {
  if (socket) return socket;
  socket = io(API_URL, {
    transports: ['websocket'],
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken ?? '', purpose: 'office' }),
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket.on('auth:expired', () => {
    socket?.emit('auth:refresh', { token: useAuthStore.getState().accessToken }, (r: { success: boolean }) => { if (!r?.success) { socket?.disconnect(); socket?.connect(); } });
  });
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
  socket?.disconnect();
  socket = null;
}
