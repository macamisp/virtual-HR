/**
 * Central runtime configuration read from env (.env / .env.example).
 * In production every security-relevant value is mandatory; the development
 * fallbacks below exist only so local dev and tests run without a .env file.
 */
import type { CookieOptions } from 'express';

const DEV_JWT_SECRET = 'super-secret-jwt-access-key-change-in-production-min-32-chars';
const DEV_CORS_ORIGINS = ['http://localhost:3000'];

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * FR-AUTH-004 escape hatch for local demos only: AUTH_MFA_ENFORCEMENT=off lets roles that need
 * 2FA sign in without enrolling. People who enrolled are still asked for their code. Refused in
 * production; startup logs a warning while it is off.
 */
export function mfaEnforced(env: Record<string, string | undefined> = process.env): boolean {
  if (env.AUTH_MFA_ENFORCEMENT !== 'off') return true;
  if (env.NODE_ENV === 'production') throw new Error('AUTH_MFA_ENFORCEMENT=off is not allowed in production');
  return false;
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (isProduction()) {
    if (!secret || secret.length < 32 || secret === DEV_JWT_SECRET) {
      throw new Error('JWT_SECRET must be set to a unique value of at least 32 characters in production');
    }
    return secret;
  }
  return secret || DEV_JWT_SECRET;
}

/** Comma-separated CORS_ORIGINS; exact-match allow-list, no wildcards. */
export function getCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  const origins = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (origins.includes('*')) {
    throw new Error('CORS_ORIGINS must list explicit origins; "*" is not allowed with credentials');
  }
  if (origins.length === 0) {
    if (isProduction()) {
      throw new Error('CORS_ORIGINS must be set in production');
    }
    return DEV_CORS_ORIGINS;
  }
  return origins;
}

export function isOriginAllowed(origin: string | undefined): boolean {
  // Requests without an Origin header (curl, server-to-server, native clients) are not
  // browser cross-origin requests; CORS does not apply to them.
  if (!origin) return true;
  return getCorsOrigins().includes(origin);
}

export const REFRESH_COOKIE_NAME = 'refreshToken';
export const REFRESH_COOKIE_PATH = '/auth/refresh';
/** Custom header required when /auth/refresh authenticates via cookie (CSRF defence). */
export const CSRF_HEADER = 'x-hrvo-csrf';

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  };
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-route rate limits: `limit` requests per `ttlMs` window per client IP (per user for heartbeats). */
export function getRateLimits() {
  const ttlMs = intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000);
  return {
    login: { limit: intFromEnv('RATE_LIMIT_LOGIN', 10), ttl: ttlMs },
    refresh: { limit: intFromEnv('RATE_LIMIT_REFRESH', 30), ttl: ttlMs },
    passwordReset: { limit: intFromEnv('RATE_LIMIT_PASSWORD_RESET', 5), ttl: ttlMs },
    heartbeat: { limit: intFromEnv('RATE_LIMIT_HEARTBEAT', 10), ttl: ttlMs },
    // FR-DOC-005/006/010: re-authentication, document passwords, public share links.
    vault: { limit: intFromEnv('RATE_LIMIT_VAULT', 20), ttl: ttlMs },
    share: { limit: intFromEnv('RATE_LIMIT_SHARE', 30), ttl: ttlMs },
    // FR-NOTIF-002: public one-click unsubscribe.
    unsubscribe: { limit: intFromEnv('RATE_LIMIT_UNSUBSCRIBE', 20), ttl: ttlMs },
    // ADR 018: redeeming a pairing code (guessing protection) and the agent's token refresh.
    agentPair: { limit: intFromEnv('RATE_LIMIT_AGENT_PAIR', 10), ttl: ttlMs },
    agentToken: { limit: intFromEnv('RATE_LIMIT_AGENT_TOKEN', 30), ttl: ttlMs },
    // ADR 023: OAuth redirects back from Google/Microsoft.
    oauth: { limit: intFromEnv('RATE_LIMIT_OAUTH', 30), ttl: ttlMs },
  };
}
