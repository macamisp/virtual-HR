/** Base URL of apps/api. Public by design: it is the browser's API endpoint, not a secret. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/** FR-ATT-004: heartbeat every 30 seconds. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
