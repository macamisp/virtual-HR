/**
 * LAN HTTPS settings (docs/runbooks/lan-https.md). Everything a browser on another device needs
 * comes from one value, LAN_HOST, so no URL can be left on http:// or ws:// by mistake. The proxy
 * (scripts/lan-proxy.ts, or Caddy with LAN_PROXY=caddy) terminates TLS with the certificate from
 * `npm run lan:certs` on these ports and forwards to the services on this computer.
 */

export interface LanInput {
  /** IPv4 address or local hostname that other devices use, e.g. 192.168.1.20 or hrvo.local. */
  host: string;
  webPort?: number;
  apiPort?: number;
  livekitPort?: number;
  storagePort?: number;
  /** Local ports the proxy forwards to; default LAN_UPSTREAMS (read from .env by scripts/lan.ts). */
  upstreams?: Partial<Record<keyof typeof LAN_UPSTREAMS, number>>;
}

export const LAN_DEFAULT_PORTS = { webPort: 3443, apiPort: 3444, livekitPort: 7443, storagePort: 8443 } as const;

/** What sits behind each proxy port on this computer. */
export const LAN_UPSTREAMS = { webPort: 3000, apiPort: 3001, livekitPort: 7880, storagePort: 8333 } as const;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A bare IPv4 address or hostname (no scheme, port or path), lower-cased. */
export function parseLanHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  const looksNumeric = /^[\d.]+$/.test(host);
  if (!host || (looksNumeric ? !IPV4.test(host) : !HOSTNAME.test(host))) {
    throw new Error(`LAN_HOST must be an IPv4 address or a hostname such as 192.168.1.20 or hrvo.local (got ${JSON.stringify(raw)})`);
  }
  return host;
}

function origin(scheme: 'https' | 'wss', host: string, port: number): string {
  return port === 443 ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

/**
 * The environment for the API and the web app behind the proxy. The web app's CSP connect-src is
 * built from the NEXT_PUBLIC_* values here (apps/web/next.config.mjs), so it follows as well.
 */
export function lanEnv(input: LanInput): Record<string, string> {
  const host = parseLanHost(input.host);
  const p: Record<keyof typeof LAN_DEFAULT_PORTS, number> = {
    webPort: input.webPort ?? LAN_DEFAULT_PORTS.webPort,
    apiPort: input.apiPort ?? LAN_DEFAULT_PORTS.apiPort,
    livekitPort: input.livekitPort ?? LAN_DEFAULT_PORTS.livekitPort,
    storagePort: input.storagePort ?? LAN_DEFAULT_PORTS.storagePort,
  };
  const up = { ...LAN_UPSTREAMS, ...input.upstreams };
  const web = origin('https', host, p.webPort);
  const storage = origin('https', host, p.storagePort);
  return {
    LAN_HOST: host,
    LAN_WEB_PORT: String(p.webPort),
    LAN_API_PORT: String(p.apiPort),
    LAN_LIVEKIT_PORT: String(p.livekitPort),
    LAN_STORAGE_PORT: String(p.storagePort),
    LAN_WEB_UPSTREAM: String(up.webPort),
    LAN_API_UPSTREAM: String(up.apiPort),
    LAN_LIVEKIT_UPSTREAM: String(up.livekitPort),
    LAN_STORAGE_UPSTREAM: String(up.storagePort),
    APP_WEB_URL: web,
    // This computer may also open the proxy as localhost or 127.0.0.1 (the certificate covers both).
    CORS_ORIGINS: [web, origin('https', 'localhost', p.webPort), origin('https', '127.0.0.1', p.webPort)].join(','),
    NEXT_PUBLIC_API_URL: origin('https', host, p.apiPort),
    NEXT_PUBLIC_LIVEKIT_URL: origin('wss', host, p.livekitPort),
    // The API hands LIVEKIT_URL to browsers (media tokens), so it must be the wss:// proxy address;
    // its own server-side calls stay on plain http to the LiveKit container.
    LIVEKIT_URL: origin('wss', host, p.livekitPort),
    LIVEKIT_HTTP_URL: `http://127.0.0.1:${up.livekitPort}`,
    NEXT_PUBLIC_STORAGE_URL: storage,
    // Presigned upload URLs are signed for the address the browser uses.
    S3_PUBLIC_ENDPOINT: storage,
    // The proxy runs on this computer: trust its X-Forwarded-For, so rate limits and audit see the device's IP.
    TRUST_PROXY: 'loopback',
    // The API, the web dev server and the proxy accept connections on every interface.
    HOST: '0.0.0.0',
    LAN_BIND: '0.0.0.0',
  };
}

/** Browser-facing settings that are still plain http:// or ws:// (mixed content on an HTTPS page). */
export function insecureUrls(env: Record<string, string | undefined>): string[] {
  const keys = ['APP_WEB_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_LIVEKIT_URL', 'LIVEKIT_URL', 'NEXT_PUBLIC_STORAGE_URL', 'S3_PUBLIC_ENDPOINT'];
  const bad = keys.filter((k) => /^(http|ws):\/\//i.test(env[k] ?? ''));
  if ((env.CORS_ORIGINS ?? '').split(',').some((o) => /^http:\/\//i.test(o.trim()))) bad.push('CORS_ORIGINS');
  return bad;
}
