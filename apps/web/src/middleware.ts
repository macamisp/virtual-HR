import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, CSP_ENV } from '@/lib/csp';
import { SITE_ROUTE, siteHostOf } from '@/lib/site';

/**
 * Per-request Content Security Policy: connect-src names the API, LiveKit and storage at the host
 * this page was requested from (localhost on the HRVO computer, its network address on a phone).
 * The other security headers are static and come from next.config.mjs.
 */
export function middleware(req: NextRequest): NextResponse {
  const page = pageOf(req);
  const res = sitePage(req, page) ?? NextResponse.next();
  res.headers.set('Content-Security-Policy', buildCsp({ ...CSP_ENV, page }));
  return res;
}

/**
 * ADR 050: on a marketing host (src/lib/site.ts) `/` shows the landing page and every other path
 * goes to the application, so a bookmarked virtual-hr.site/login still works. Returns null on all
 * other hosts, which keeps the application's routing exactly as it was.
 */
function sitePage(req: NextRequest, page: ReturnType<typeof pageOf>): NextResponse | null {
  const site = page ? siteHostOf(page.host, page.https) : null;
  if (!site) return null;
  const { pathname, search } = req.nextUrl;
  if (site.canonicalOrigin) return NextResponse.redirect(`${site.canonicalOrigin}${pathname}${search}`, 308);
  if (pathname === '/') return NextResponse.rewrite(new URL(SITE_ROUTE, req.url));
  if (pathname === '/robots.txt' || pathname === '/sitemap.xml') return NextResponse.rewrite(new URL(`${SITE_ROUTE}${pathname}`, req.url));
  // The landing page's own files (icon, Open Graph image) live under its route.
  if (pathname === SITE_ROUTE || pathname.startsWith(`${SITE_ROUTE}/`) || site.preview) return null;
  return NextResponse.redirect(`${site.appOrigin}${pathname}${search}`, 308);
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
