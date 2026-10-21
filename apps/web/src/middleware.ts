import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, CSP_ENV } from '@/lib/csp';

/**
 * Per-request Content Security Policy: connect-src names the API, LiveKit and storage at the host
 * this page was requested from (localhost on the HRVO computer, its network address on a phone).
 * The other security headers are static and come from next.config.mjs.
 */
export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  res.headers.set('Content-Security-Policy', buildCsp({ ...CSP_ENV, page: pageOf(req) }));
  return res;
}

/**
 * The host the browser used, from the Host header: `req.nextUrl` carries the address the server
 * is bound to (0.0.0.0 when listening on every interface), not the one the page was opened at.
 */
function pageOf(req: NextRequest): { hostname: string; host: string; https: boolean } | null {
  const host = req.headers.get('host')?.trim();
  if (!host) return null;
  const https = req.headers.get('x-forwarded-proto') === 'https' || req.nextUrl.protocol === 'https:';
  try {
    const u = new URL(`${https ? 'https' : 'http'}://${host}`);
    return { hostname: u.hostname, host: u.host, https };
  } catch {
    return null;
  }
}

export const config = {
  // Documents and API routes; static assets and images are served without the policy.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
