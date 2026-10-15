'use client';

import { SessionResponseSchema } from '@hrvo/shared';
import { API_URL } from './env';
import { useAuthStore } from './auth-store';

let inFlight: Promise<boolean> | null = null;

/** Runs `fn` while holding a cross-tab Web Lock (falls back to running directly). */
async function withTabLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
    return (await navigator.locks.request(name, fn)) as T;
  }
  return await fn();
}

/**
 * Exchanges the httpOnly refresh cookie for a new access token (FR-AUTH-003).
 *
 * Single-flight within the tab and serialised across tabs with a Web Lock: refresh tokens
 * rotate, and two tabs presenting the same cookie concurrently would trigger reuse detection
 * and revoke the whole session family.
 */
export function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = withTabLock('hrvo-auth-refresh', async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        // CSRF defence required by the API for cookie-authenticated refresh (ADR 005).
        headers: { 'X-HRVO-CSRF': '1' },
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        useAuthStore.getState().clear();
        return false;
      }
      const parsed = SessionResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        useAuthStore.getState().clear();
        return false;
      }
      useAuthStore.getState().setSession(parsed.data);
      return true;
    } catch {
      // Network failure: keep the current state so the UI can show "reconnecting".
      return useAuthStore.getState().status === 'authenticated';
    }
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Seconds until the JWT expires (reads `exp` only; the signature is the server's business). */
export function secondsUntilExpiry(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp - Date.now() / 1000 : 0;
  } catch {
    return 0;
  }
}

export async function logout(reason: string | null = null): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    }).catch(() => undefined);
  }
  useAuthStore.getState().clear(reason);
}
