// @ts-check
import { fileURLToPath } from 'node:url';
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const wsUrl = apiUrl.replace(/^http/, 'ws');
// Browsers upload documents straight to object storage through presigned URLs (ADR 009).
const storageUrl = process.env.NEXT_PUBLIC_STORAGE_URL ?? '';
const isDev = process.env.NODE_ENV !== 'production';
// LiveKit signalling (wss) and its HTTP validate endpoint (ADR 016).
const liveKitUrl = (process.env.NEXT_PUBLIC_LIVEKIT_URL ?? 'ws://localhost:7880').replace(/\/$/, '');
const liveKitHttp = liveKitUrl.replace(/^ws/, 'http');

// Next.js App Router injects inline bootstrap scripts, so script-src needs 'unsafe-inline'
// until nonce-based CSP is adopted (ADR 006). Everything else is locked down.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // blob: = document previews, fetched with the access token and shown from memory.
  "img-src 'self' data: blob:",
  "frame-src blob:",
  "font-src 'self'",
  `connect-src 'self' ${apiUrl} ${wsUrl} ${liveKitUrl} ${liveKitHttp}${storageUrl ? ` ${storageUrl}` : ''}${isDev ? ' ws://localhost:3000' : ''}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Playwright builds into its own folder so it never overwrites a running dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Container images (docker/web.Dockerfile) use the standalone server; `next start` does not.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone', outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)) } : {}),
  poweredByHeader: false,
  transpilePackages: ['@hrvo/shared'],
  // The image optimizer is unused and has had RCE/DoS advisories; keep it off.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // Meetings (ADR 016): camera, microphone, screen share and speaker choice for this origin only.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), display-capture=(self), speaker-selection=(self), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
