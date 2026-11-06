import { SITE_URL } from '@/lib/site';

/** robots.txt of the marketing host (ADR 050; the middleware maps /robots.txt there to this route). */
export function GET(): Response {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}
