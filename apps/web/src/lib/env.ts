import { followPageHost } from '@hrvo/shared/local-url';

/** The configured API address (build-time NEXT_PUBLIC_API_URL). Public by design: it is the browser's API endpoint, not a secret. */
export const CONFIGURED_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/**
 * Base URL of apps/api for this page. When the configured address names this computer (localhost,
 * a private network address, a .local name), the API is reached at the host the page was opened
 * from: http://192.168.1.20:3000 talks to http://192.168.1.20:3001, and https://localhost:3443 on
 * the HRVO computer talks to https://localhost:3444 (docs/runbooks/lan-https.md). The scheme and
 * port stay as configured. A public API address is used as is.
 */
export const API_URL = typeof window === 'undefined' ? CONFIGURED_API_URL : followPageHost(CONFIGURED_API_URL, window.location);

/** FR-ATT-004: heartbeat every 30 seconds. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
