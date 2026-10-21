/**
 * HTTPS reverse proxy for the local network (docs/runbooks/lan-https.md), started by
 * `npm run lan:up`. Node only, no packages: one TLS listener per public port, forwarding to the
 * plain-HTTP service on this computer, WebSockets included (attendance heartbeat, office,
 * LiveKit signalling, Next.js hot reload). Reads .env.lan (written by `npm run lan:env`) and the
 * certificate from .lan-https/certs (issued by `npm run lan:certs`).
 *
 *   node --experimental-strip-types scripts/lan-proxy.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CERTS = join(ROOT, '.lan-https', 'certs');

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env: Record<string, string | undefined> = { ...readEnvFile(join(ROOT, '.env.lan')), ...process.env };
if (!env.LAN_HOST) { console.error('No .env.lan: run npm run lan:env (or npm run lan:up) first.'); process.exit(1); }
if (!existsSync(join(CERTS, 'cert.pem'))) { console.error('No certificate yet: run npm run lan:certs (or npm run lan:up) first.'); process.exit(1); }

const bind = env.LAN_BIND || '0.0.0.0';
const num = (name: string, fallback: number) => Number(env[name]) || fallback;
const routes = [
  { name: 'web app', port: num('LAN_WEB_PORT', 3443), upstream: num('LAN_WEB_UPSTREAM', 3000) },
  { name: 'API', port: num('LAN_API_PORT', 3444), upstream: num('LAN_API_UPSTREAM', 3001) },
  { name: 'LiveKit', port: num('LAN_LIVEKIT_PORT', 7443), upstream: num('LAN_LIVEKIT_UPSTREAM', 7880) },
  { name: 'storage', port: num('LAN_STORAGE_PORT', 8443), upstream: num('LAN_STORAGE_UPSTREAM', 8333) },
];
const tlsOptions = { cert: readFileSync(join(CERTS, 'cert.pem')), key: readFileSync(join(CERTS, 'key.pem')) };

/** Headers that describe one hop, not the message; the proxy sets its own. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwarded(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && !k.startsWith('x-forwarded-') && k !== 'x-real-ip') out[k] = v;
  const ip = req.socket.remoteAddress ?? '';
  out['x-forwarded-for'] = ip;
  out['x-real-ip'] = ip;
  out['x-forwarded-proto'] = 'https';
  out['x-forwarded-host'] = req.headers.host ?? '';
  return out;
}

function unavailable(res: http.ServerResponse, route: typeof routes[number], err: NodeJS.ErrnoException): void {
  if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`HRVO LAN proxy: the ${route.name} on 127.0.0.1:${route.upstream} is not answering (${err.code ?? err.message}). Is npm run lan:up still running?\n`);
}

for (const route of routes) {
  const server = https.createServer({ ...tlsOptions, requestTimeout: 0, headersTimeout: 60_000 }, (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: route.upstream, method: req.method, path: req.url, headers: forwarded(req) }, (ur) => {
      const headers = { ...ur.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage, headers);
      ur.pipe(res);
      ur.on('error', () => res.destroy());
    });
    up.on('error', (e) => unavailable(res, route, e));
    req.on('error', () => up.destroy());
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  });

  // WebSocket (and any other Upgrade): hand the raw request to the service and pipe both ways.
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(route.upstream, '127.0.0.1');
    up.on('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (/^x-forwarded-|^x-real-ip$/i.test(name)) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      const ip = req.socket.remoteAddress ?? '';
      lines.push(`X-Forwarded-For: ${ip}`, `X-Real-IP: ${ip}`, 'X-Forwarded-Proto: https', `X-Forwarded-Host: ${req.headers.host ?? ''}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const drop = () => { socket.destroy(); up.destroy(); };
    up.on('error', drop);
    socket.on('error', drop);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });

  // A device that does not trust the certificate fails its handshake here; that is expected and
  // the runbook's Part 2 explains the fix. It is counted, not logged per attempt.
  let rejectedHandshakes = 0;
  server.on('tlsClientError', (err: NodeJS.ErrnoException) => {
    if (++rejectedHandshakes === 1 || rejectedHandshakes % 50 === 0) {
      console.log(`[${route.name}] ${rejectedHandshakes} TLS handshake(s) failed (${err.code ?? err.message}): a device that does not trust the certificate yet? docs/runbooks/lan-https.md, Part 2`);
    }
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(`[${route.name}] cannot listen on ${bind}:${route.port}: ${e.code ?? e.message}${e.code === 'EADDRINUSE' ? ' (another proxy still running? npm run lan:down)' : ''}`);
    process.exit(1);
  });
  server.listen(route.port, bind, () => console.log(`[${route.name}] https://${env.LAN_HOST}:${route.port} -> http://127.0.0.1:${route.upstream} (listening on ${bind})`));
}

const stop = () => { console.log('LAN proxy stopping'); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
