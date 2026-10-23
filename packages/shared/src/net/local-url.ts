/**
 * Addresses on a local network (docs/runbooks/lan-https.md).
 *
 * The web app is configured with one API address (NEXT_PUBLIC_API_URL), but a page may be opened
 * as http://localhost:3000 on the computer that runs HRVO and as https://192.168.1.20:3443 on a
 * phone. When the configured address names a local machine (localhost, a private IP, a .local
 * name), the browser talks to the host it loaded the page from instead, on the configured scheme
 * and port. A public address (api.example.com) is never rewritten.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.localhost'];

/** RFC 1918 and link-local IPv4 ranges. */
export function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** localhost, a loopback or private IPv4 address, or a name on a local suffix such as .local. */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (LOOPBACK.has(h) || isPrivateIpv4(h)) return true;
  if (/^\[?fe80:/i.test(h) || /^\[?f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 link-local / ULA
  return LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

export interface PageLocation {
  /** window.location.hostname (IPv6 literals keep their brackets). */
  hostname: string;
}

/**
 * The address a browser should use for `configured`, given the page it loaded. The hostname is
 * replaced by the page's when the configured one is local; scheme, port and path stay as set.
 * An unparsable value is returned unchanged.
 */
export function followPageHost(configured: string, page: PageLocation | null | undefined): string {
  if (!page?.hostname) return configured;
  let url: URL;
  try { url = new URL(configured); } catch { return configured; }
  if (!isLocalHostname(url.hostname) || url.hostname.toLowerCase() === page.hostname.toLowerCase()) return configured;
  if (!isLocalHostname(page.hostname)) return configured;
  url.hostname = page.hostname;
  return url.toString().replace(/\/$/, configured.endsWith('/') ? '/' : '');
}
