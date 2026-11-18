/**
 * LiveKit endpoints a browser may connect to (ADR 067).
 *
 * The API names the media server in every token (LIVEKIT_URL). The web build's Content Security
 * Policy must already allow that address, so during a switch between media servers (LiveKit Cloud
 * and the self-hosted server) the build lists both: NEXT_PUBLIC_LIVEKIT_URL plus
 * NEXT_PUBLIC_LIVEKIT_EXTRA_URLS. Switching or rolling back then changes only the API's environment.
 */

const strip = (u: string) => u.replace(/\/+$/, '');

/** A comma or whitespace separated list; only ws:// and wss:// URLs are kept. */
export function parseLiveKitUrlList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\/[^\s/]+/i.test(s))
    .map(strip);
}

/** connect-src entries for the primary endpoint and every extra one, in ws and http form, once each. */
export function liveKitConnectSources(primary: string, extras: readonly string[]): string[] {
  const out: string[] = [];
  for (const u of [primary, ...extras].map(strip).filter(Boolean)) {
    for (const v of [u, u.replace(/^ws/i, 'http')]) if (!out.includes(v)) out.push(v);
  }
  return out;
}
