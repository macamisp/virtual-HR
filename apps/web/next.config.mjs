// @ts-check
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

// The Content Security Policy is set per request in src/middleware.ts (its connect-src follows the
// host the page was opened from, docs/runbooks/lan-https.md). The static headers are below.

// Hosts other than localhost that may load the dev server's /_next/* assets: this computer's own
// network addresses, plus LAN_HOST (a fixed address or a name such as hrvo.local).
const localAddresses = Object.values(networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);
const allowedDevOrigins = [...new Set([...localAddresses, process.env.LAN_HOST ?? ''].filter(Boolean))];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Playwright builds into its own folder so it never overwrites a running dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Container images (docker/web.Dockerfile) use the standalone server; `next start` does not.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone', outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)) } : {}),
  poweredByHeader: false,
  allowedDevOrigins,
  transpilePackages: ['@hrvo/shared'],
  // The image optimizer is unused and has had RCE/DoS advisories; keep it off.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
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
