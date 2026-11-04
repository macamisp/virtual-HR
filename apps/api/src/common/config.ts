/**
 * Central runtime configuration read from env (.env / .env.example).
 * In production every security-relevant value is mandatory; the development
 * fallbacks below exist only so local dev and tests run without a .env file.
 */
import type { CookieOptions } from 'express';

const DEV_JWT_SECRET = 'super-secret-jwt-access-key-change-in-production-min-32-chars';
/**
 * Outside production, the web app may be opened as localhost, 127.0.0.1 or this computer's private
 * network address on port 3000 (a phone on the same Wi-Fi, docs/runbooks/lan-https.md).
 */
const DEV_CORS_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.*.*.*:3000', 'http://172.*.*.*:3000', 'http://192.168.*.*:3000'];

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

/**
 * Comma-separated CORS_ORIGINS. Each entry is an exact origin (https://app.example.com) or, for a
 * local network, a pattern whose host labels or port are `*` (https://192.168.*.*:3443,
 * https://hrvo.local:*). A `*` stands for one host label or the port, never for a dot, so
 * 192.168.*.* does not match 192.168.evil.com. "*" alone is refused, and patterns are refused in
 * production, where every origin must be spelled out.
 */
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
  if (isProduction() && origins.some((o) => o.includes('*'))) {
    throw new Error('CORS_ORIGINS patterns with "*" are not allowed in production; list each origin');
  }
  for (const o of origins) originMatcher(o);
  return origins;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ORIGIN = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/\s:]+)(?::([0-9]{1,5}|\*))?$/i;

/**
 * The test for one CORS_ORIGINS entry (exact origin or `*` pattern). Throws on a malformed entry.
 * In a dotted-decimal pattern (192.168.*.*) a `*` is one number 0-255 wide, so it cannot match
 * `evil.com`; in a name (pc-*.lan) it is part of one label.
 */
export function originMatcher(entry: string): (origin: string) => boolean {
  const m = ORIGIN.exec(entry);
  if (!m) throw new Error(`CORS_ORIGINS entry is not an origin (scheme://host[:port]): ${entry}`);
  const [, scheme, host, port] = m as unknown as [string, string, string, string | undefined];
  if (!entry.includes('*')) {
    const exact = entry.toLowerCase();
    return (origin) => origin.toLowerCase() === exact;
  }
  const labels = host.split('.');
  if (labels.every((l) => l === '*')) throw new Error(`CORS_ORIGINS pattern must name at least one host label: ${entry}`);
  const numeric = labels.length === 4 && labels.every((l) => l === '*' || /^\d{1,3}$/.test(l));
  const hostRe = labels.map((l) => {
    if (numeric) return l === '*' ? '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)' : escapeRegExp(l);
    return l.split('*').map(escapeRegExp).join('[0-9A-Za-z-]*');
  }).join('\\.');
  const portRe = port === undefined ? '' : port === '*' ? ':\\d{1,5}' : `:${port}`;
  const re = new RegExp(`^${scheme}://${hostRe}${portRe}$`, 'i');
  return (origin) => re.test(origin);
}

export function isOriginAllowed(origin: string | undefined): boolean {
  // Requests without an Origin header (curl, server-to-server, native clients) are not
  // browser cross-origin requests; CORS does not apply to them.
  if (!origin) return true;
  return getCorsOrigins().some((entry) => originMatcher(entry)(origin));
}

/**
 * Address the API binds to. HOST unset means 0.0.0.0: every IPv4 interface, so phones and other
 * computers on the network reach it (docs/runbooks/lan-https.md). HOST=:: adds IPv6;
 * HOST=127.0.0.1 keeps it to this computer.
 */
export function listenHost(): string {
  return process.env.HOST?.trim() || '0.0.0.0';
}

export const REFRESH_COOKIE_NAME = 'refreshToken';
export const REFRESH_COOKIE_PATH = '/auth/refresh';
/** Custom header required when /auth/refresh authenticates via cookie (CSRF defence). */
export const CSRF_HEADER = 'x-hrvo-csrf';

/** The web app is served over HTTPS (production, or the LAN proxy in docs/runbooks/lan-https.md). */
export function servedOverHttps(): boolean {
  return isProduction() || /^https:\/\//i.test(process.env.APP_WEB_URL ?? '');
}

/**
 * SameSite of the refresh cookie (ADR 040). Strict by default: the browser sends it only when the
 * web app and the API are the same site. REFRESH_COOKIE_SAMESITE=none is for a web app and an API
 * on two different sites (quick tunnels, docs/runbooks/demo-internet.md): the cookie is then also
 * Secure and Partitioned (kept per top-level site), and /auth/refresh still demands the CSRF
 * header and an allowed Origin, which a cross-site form cannot send. Refused without HTTPS.
 */
export function refreshCookieSameSite(): 'strict' | 'none' {
  const raw = (process.env.REFRESH_COOKIE_SAMESITE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'strict') return 'strict';
  if (raw !== 'none') throw new Error('REFRESH_COOKIE_SAMESITE must be "strict" (default) or "none"');
  if (!servedOverHttps()) throw new Error('REFRESH_COOKIE_SAMESITE=none needs HTTPS: APP_WEB_URL must be an https:// address');
  return 'none';
}

export function refreshCookieOptions(): CookieOptions {
  const sameSite = refreshCookieSameSite();
  return {
    httpOnly: true,
    secure: servedOverHttps(),
    sameSite,
    path: REFRESH_COOKIE_PATH,
    ...(sameSite === 'none' ? { partitioned: true } : {}),
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
    // ADR 037: self-service signup, verification links and Google sign-in starts.
    signup: { limit: intFromEnv('RATE_LIMIT_SIGNUP', 5), ttl: ttlMs },
  };
}
