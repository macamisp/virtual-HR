import { followPageHost } from '@hrvo/shared/local-url';

/**
 * Content Security Policy for a page, built per request (src/middleware.ts) so connect-src allows
 * the API, LiveKit and storage at the host the page was opened from (apps/web/src/lib/env.ts:
 * API_URL follows the page host on a local network). Next.js App Router injects inline bootstrap
 * scripts, so script-src needs 'unsafe-inline' until nonce-based CSP is adopted (ADR 006).
 * Everything else is locked down.
 */
export interface CspInput {
  /** The page's host (with port) and whether it was served over https; null outside a request. */
  page: { hostname: string; host: string; https: boolean } | null;
  isDev: boolean;
  apiUrl: string;
  liveKitUrl: string;
  storageUrl: string;
}

const dedupe = (items: string[]) => [...new Set(items.filter(Boolean))];

export function buildCsp({ page, isDev, apiUrl, liveKitUrl, storageUrl }: CspInput): string {
  const api = page ? followPageHost(apiUrl, page) : apiUrl;
  const liveKit = (page ? followPageHost(liveKitUrl, page) : liveKitUrl).replace(/\/$/, '');
  const storage = page ? followPageHost(storageUrl, page) : storageUrl;
  const connect = dedupe([
    "'self'",
    apiUrl, apiUrl.replace(/^http/, 'ws'),
    api, api.replace(/^http/, 'ws'),
    liveKitUrl, liveKitUrl.replace(/^ws/, 'http'),
    liveKit, liveKit.replace(/^ws/, 'http'),
    storageUrl, storage,
    // Next.js dev hot reload connects back to the page's own host.
    ...(isDev && page ? [`${page.https ? 'wss' : 'ws'}://${page.host}`] : isDev ? ['ws://localhost:3000'] : []),
  ]);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // blob: = document previews, fetched with the access token and shown from memory.
    "img-src 'self' data: blob:",
    // blob: = meeting recordings (ADR 024), decrypted by the API and played from memory.
    "media-src 'self' blob:",
    'frame-src blob:',
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** The build-time values the CSP is derived from (NEXT_PUBLIC_* are inlined by Next.js). */
export const CSP_ENV = {
  isDev: process.env.NODE_ENV !== 'production',
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, ''),
  liveKitUrl: (process.env.NEXT_PUBLIC_LIVEKIT_URL ?? 'ws://localhost:7880').replace(/\/$/, ''),
  storageUrl: (process.env.NEXT_PUBLIC_STORAGE_URL ?? '').replace(/\/$/, ''),
};
