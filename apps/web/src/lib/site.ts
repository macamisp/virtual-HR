/**
 * The public marketing site (ADR 050). The same Next.js app serves the landing page (src/app/welcome)
 * when a request arrives on one of these hosts; on every other host (the app itself, LAN addresses)
 * nothing changes. Each marketing host maps to the app host its "Log in" and "Get started" links
 * open. `site.localhost` is the local preview (browsers resolve *.localhost to this computer).
 *
 * The preview does not redirect other paths to the app: Next.js turns a middleware redirect whose
 * origin equals the server's own address (http://localhost:<port>) into a relative one, which on
 * site.localhost would loop. Production hosts are unaffected (the server listens on an internal
 * address, never app.virtual-hr.site).
 */
const SITE_HOSTS: Readonly<Record<string, { app: string; canonical?: string; preview?: true }>> = {
  'virtual-hr.site': { app: 'app.virtual-hr.site' },
  'www.virtual-hr.site': { app: 'app.virtual-hr.site', canonical: 'virtual-hr.site' },
  'site.localhost': { app: 'localhost', preview: true },
};

/** The canonical public address of the landing page (SEO: canonical link, Open Graph, sitemap). */
export const SITE_URL = 'https://virtual-hr.site';

/** The internal route that renders the landing page. */
export const SITE_ROUTE = '/welcome';

export interface SiteHost {
  /** Origin of the application, e.g. https://app.virtual-hr.site (port kept for local preview). */
  appOrigin: string;
  /** Set when this host should permanently redirect to another marketing host (www → apex). */
  canonicalOrigin: string | null;
  /** Local preview: paths other than the landing page are served as they are, not redirected. */
  preview: boolean;
}

/**
 * Resolves a Host header (with optional port) to its marketing-site settings, or null when the host
 * is not a marketing host. Pure, so the middleware and the page agree.
 */
export function siteHostOf(hostHeader: string | null | undefined, https: boolean): SiteHost | null {
  if (!hostHeader) return null;
  let url: URL;
  try {
    url = new URL(`${https ? 'https' : 'http'}://${hostHeader.trim()}`);
  } catch {
    return null;
  }
  const entry = SITE_HOSTS[url.hostname.toLowerCase()];
  if (!entry) return null;
  // Production marketing hosts are HTTPS only, whatever the proxy reports; the preview keeps the
  // scheme and port it was opened with.
  const origin = (host: string) => (entry.preview ? `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}` : `https://${host}`);
  return {
    appOrigin: origin(entry.app),
    canonicalOrigin: entry.canonical ? origin(entry.canonical) : null,
    preview: entry.preview === true,
  };
}
