'use client';

import { create } from 'zustand';
import type { SessionResponse, SessionUser } from '@hrvo/shared';

export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

/**
 * Session state lives in memory only: no localStorage/sessionStorage persistence, so the
 * access token and heartbeat secret disappear with the tab. A reload restores the session
 * through the httpOnly refresh cookie (lib/session.ts).
 */
interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  sessionId: string | null;
  sessionSecret: string | null;
  user: SessionUser | null;
  /** Short-lived token that only allows /auth/2fa/setup and /auth/2fa/verify (FR-AUTH-004). */
  enrollmentToken: string | null;
  /** Shown on the login page after a forced sign-out. */
  signedOutReason: string | null;
  setSession: (s: SessionResponse) => void;
  setEnrollmentToken: (token: string | null) => void;
  clear: (reason?: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  accessToken: null,
  sessionId: null,
  sessionSecret: null,
  user: null,
  enrollmentToken: null,
  signedOutReason: null,
  setSession: (s) =>
    set({
      status: 'authenticated',
      accessToken: s.accessToken,
      sessionId: s.sessionId,
      sessionSecret: s.sessionSecret,
      user: s.user,
      enrollmentToken: null,
      signedOutReason: null,
    }),
  setEnrollmentToken: (token) => set({ enrollmentToken: token }),
  clear: (reason = null) =>
    set({
      status: 'anonymous',
      accessToken: null,
      sessionId: null,
      sessionSecret: null,
      user: null,
      enrollmentToken: null,
      signedOutReason: reason,
    }),
}));
