/**
 * LAN HTTPS helper (docs/runbooks/lan-https.md). Run through npm:
 *
 *   npm run lan:env        write .env.lan from LAN_HOST (or this computer's address)
 *   npm run lan:certs      issue the certificate for LAN_HOST, this computer's other addresses,
 *                          localhost, 127.0.0.1 and ::1 (one certificate, many names)
 *   npm run lan:check      verify every URL is https/wss with a trusted certificate, and that a
 *                          real browser sees a secure context
 *   npm run lan:share-ca   let a phone download the root certificate for 10 minutes
 *
 * The root that signs the certificate: mkcert's, when mkcert is installed (`mkcert -install` makes
 * this computer's browsers trust it); otherwise a local certificate authority made with OpenSSL in
 * .lan-https/ca.pem (its key never leaves this folder). Once a root exists it is kept, so devices
 * that trust it keep trusting every later certificate (new IP, renewal). Certificates are always
 * verified against that root; TLS verification is never switched off.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { insecureUrls, lanEnv, LAN_UPSTREAMS, parseLanHost } from './lan-config.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, '.lan-https');
const CERTS = join(STATE, 'certs');
const ENV_FILE = join(ROOT, '.env.lan');
const RUNBOOK = 'docs/runbooks/lan-https.md';

let failures = 0;
const ok = (msg: string) => console.log(`  OK    ${msg}`);
const fail = (msg: string, fix?: string) => { failures += 1; console.log(`  FAIL  ${msg}${fix ? `\n        -> ${fix}` : ''}`); };
const warn = (msg: string) => console.log(`  NOTE  ${msg}`);

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function detectHost(): string {
  try {
    const route = execFileSync('ip', ['-4', 'route', 'get', '1.1.1.1'], { encoding: 'utf8' });
    const m = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(route);
    if (m) return m[1]!;
  } catch { /* no ip(8): fall through */ }
  throw new Error('Could not find this computer\'s LAN address. Set LAN_HOST, e.g. LAN_HOST=192.168.1.20 npm run lan:env');
}

const portOf = (url: string | undefined, fallback: number): number => {
  try { const u = new URL(url ?? ''); return Number(u.port) || fallback; } catch { return fallback; }
};

const OPENSSL_CA = join(STATE, 'ca.pem');
const OPENSSL_CA_KEY = join(STATE, 'ca-key.pem');

function mkcert(args: string[]): string {
  return execFileSync('mkcert', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasMkcert(): boolean {
  try { mkcert(['-CAROOT']); return true; } catch { return false; }
}

/** Which root signs the certificate: the OpenSSL CA once it exists (devices already trust it), else mkcert, else a new OpenSSL CA. */
function caKind(): 'openssl' | 'mkcert' {
  if (existsSync(OPENSSL_CA)) return 'openssl';
  return hasMkcert() ? 'mkcert' : 'openssl';
}

function caRootPem(): string {
  if (caKind() === 'mkcert') {
    const file = join(mkcert(['-CAROOT']).trim(), 'rootCA.pem');
    if (!existsSync(file)) throw new Error(`No mkcert root at ${file}. Run: mkcert -install`);
    return readFileSync(file, 'utf8');
  }
  if (!existsSync(OPENSSL_CA)) throw new Error('No certificate authority yet: run npm run lan:certs (or npm run lan:up)');
  return readFileSync(OPENSSL_CA, 'utf8');
}

/** Where the root certificate file is, for the runbook's import steps. */
function caRootPath(): string {
  return caKind() === 'mkcert' ? join(mkcert(['-CAROOT']).trim(), 'rootCA.pem') : OPENSSL_CA;
}

/** Every IPv4 address of this computer (Wi-Fi, Ethernet, hotspot), so one certificate covers them all. */
function localIpv4s(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
}

const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;

// ---------------------------------------------------------------- env

function writeEnv(): Record<string, string> {
  const base = readEnvFile(join(ROOT, '.env'));
  const host = parseLanHost(process.env.LAN_HOST || detectHost());
  const num = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
  const env = lanEnv({
    host,
    webPort: num('LAN_WEB_PORT'), apiPort: num('LAN_API_PORT'), livekitPort: num('LAN_LIVEKIT_PORT'), storagePort: num('LAN_STORAGE_PORT'),
    upstreams: {
      apiPort: Number(base.PORT) || LAN_UPSTREAMS.apiPort,
      livekitPort: portOf(base.LIVEKIT_HTTP_URL, LAN_UPSTREAMS.livekitPort),
      storagePort: portOf(base.S3_ENDPOINT, LAN_UPSTREAMS.storagePort),
    },
  });
  const lines = [
    '# Generated by `npm run lan:env` from LAN_HOST. Do not edit; run it again instead (docs/runbooks/lan-https.md).',
    '# NEXT_PUBLIC_* values are baked into a production web build: after changing LAN_HOST, rebuild the web app.',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`);
  console.log(`Wrote .env.lan for ${host}:`);
  for (const k of ['APP_WEB_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_LIVEKIT_URL', 'LIVEKIT_URL', 'NEXT_PUBLIC_STORAGE_URL', 'S3_PUBLIC_ENDPOINT', 'CORS_ORIGINS', 'TRUST_PROXY', 'HOST']) console.log(`  ${k}=${env[k]}`);
  console.log(`  CSP connect-src (apps/web/src/middleware.ts, per request; for this host): 'self' ${env.NEXT_PUBLIC_API_URL} ${env.NEXT_PUBLIC_API_URL!.replace(/^https/, 'wss')} ${env.NEXT_PUBLIC_LIVEKIT_URL} ${env.NEXT_PUBLIC_LIVEKIT_URL!.replace(/^wss/, 'https')} ${env.NEXT_PUBLIC_STORAGE_URL}`);
  console.log('\nA production web build has these values baked in: rebuild it after every change (npm run lan:up does this with LAN_WEB_MODE=production).');
  return env;
}

// ---------------------------------------------------------------- certificates

function issueCerts(): void {
  const env = readEnvFile(ENV_FILE);
  if (!env.LAN_HOST) throw new Error('No .env.lan yet: run npm run lan:env first');
  mkdirSync(CERTS, { recursive: true, mode: 0o700 });
  const names = [...new Set([env.LAN_HOST, ...localIpv4s(), 'localhost', '127.0.0.1', '::1'])];
  const certFile = join(CERTS, 'cert.pem');
  const keyFile = join(CERTS, 'key.pem');
  const kind = caKind();
  if (kind === 'mkcert') {
    mkcert(['-cert-file', certFile, '-key-file', keyFile, ...names]);
  } else {
    issueWithOpenssl(names, certFile, keyFile);
  }
  const cert = new X509Certificate(readFileSync(certFile));
  console.log(`Issued .lan-https/certs/cert.pem (${kind}) for ${cert.subjectAltName}`);
  console.log(`Valid until ${cert.validTo}. Root: ${caRootPath()}, fingerprint (SHA-256): ${fingerprint(caRootPem())}`);
}

function openssl(args: string[]): void {
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Neither mkcert nor openssl is installed. Install one: Fedora `sudo dnf install mkcert nss-tools` (or openssl); macOS `brew install mkcert nss`; Windows `choco install mkcert`.');
    throw new Error(`openssl ${args[0]} failed: ${String((e as { stderr?: Buffer }).stderr ?? '').trim().split('\n').pop()}`);
  }
}

/**
 * A certificate signed by the local OpenSSL CA (created once, valid 825 days, the most Apple
 * accepts for a private root). The server certificate lasts 397 days and carries the names as
 * Subject Alternative Names (DNS: or IP:), serverAuth key usage and a 2048-bit RSA key, which is
 * what iOS, Android, Chrome and Firefox require.
 */
function issueWithOpenssl(names: string[], certFile: string, keyFile: string): void {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  if (!existsSync(OPENSSL_CA)) {
    console.log('Creating the local certificate authority (once) ...');
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '825', '-keyout', OPENSSL_CA_KEY, '-out', OPENSSL_CA,
      '-subj', '/CN=HRVO local development CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    chmodSync(OPENSSL_CA_KEY, 0o600);
  }
  const csr = join(CERTS, 'server.csr');
  const ext = join(CERTS, 'server.ext');
  const san = names.map((n) => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
  writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', csr, '-subj', `/CN=${names[0]}`]);
  openssl(['x509', '-req', '-in', csr, '-CA', OPENSSL_CA, '-CAkey', OPENSSL_CA_KEY, '-CAcreateserial', '-days', '397', '-out', certFile, '-extfile', ext]);
  chmodSync(keyFile, 0o600);
  rmSync(csr, { force: true });
  rmSync(ext, { force: true });
}

// ---------------------------------------------------------------- check

interface Probe { status: number; headers: http.IncomingHttpHeaders; cert: tls.PeerCertificate | null }

function httpsGet(url: string, ca: string, method = 'GET', headers: Record<string, string> = {}): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, ca, headers, timeout: 15_000 }, (res) => {
      const cert = (res.socket as tls.TLSSocket).getPeerCertificate?.() ?? null;
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, cert }));
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 101, headers: res.headers, cert: null }); });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function browserCheck(env: Record<string, string>, ca: string): Promise<void> {
  // A throwaway browser profile whose NSS store trusts exactly our root, as a phone with the
  // root installed does. Nothing is bypassed: an untrusted certificate fails the page load here.
  let certutil = true;
  try { execFileSync('certutil', ['-H'], { stdio: 'ignore' }); } catch (e) { certutil = (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
  if (!certutil) {
    warn('browser check skipped: certutil is missing (Fedora: sudo dnf install nss-tools; Debian: libnss3-tools). The TLS checks above already verified the certificate against the root.');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'hrvo-lan-check-'));
  try {
    const db = join(home, '.pki', 'nssdb');
    mkdirSync(db, { recursive: true });
    execFileSync('certutil', ['-N', '-d', `sql:${db}`, '--empty-password']);
    writeFileSync(join(home, 'rootCA.pem'), ca);
    execFileSync('certutil', ['-A', '-d', `sql:${db}`, '-n', 'HRVO local root', '-t', 'C,,', '-i', join(home, 'rootCA.pem')]);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ env: { ...process.env, HOME: home } });
    try {
      const page = await browser.newPage();
      const problems: string[] = [];
      page.on('console', (m) => { if (/mixed content|insecure/i.test(m.text())) problems.push(m.text().slice(0, 200)); });
      page.on('requestfailed', (r) => { const f = r.failure()?.errorText ?? ''; if (/CERT|SSL/i.test(f)) problems.push(`${r.url()}: ${f}`); });
      const res = await page.goto(`${env.APP_WEB_URL}/login`, { waitUntil: 'networkidle', timeout: 90_000 });
      const facts = await page.evaluate(() => ({ secure: window.isSecureContext, subtle: !!globalThis.crypto?.subtle, media: !!navigator.mediaDevices }));
      if (res?.ok() && facts.secure && facts.subtle && facts.media) ok(`real browser: ${env.APP_WEB_URL}/login is a secure context (camera, microphone and heartbeat signing available)`);
      else fail(`real browser: status ${res?.status()}, isSecureContext=${facts.secure}, crypto.subtle=${facts.subtle}, mediaDevices=${facts.media}`);
      if (problems.length) fail(`browser reported: ${[...new Set(problems)].join(' | ')}`);
    } finally {
      await browser.close();
    }
  } catch (e) {
    fail(`browser check: ${(e as Error).message.split('\n')[0]}`, `was the certificate issued by this root? Run npm run lan:certs, then npm run lan:up again (${RUNBOOK})`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function check(): Promise<void> {
  const env = { ...readEnvFile(ENV_FILE), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(LAN_|APP_WEB_URL|CORS_ORIGINS|NEXT_PUBLIC_|S3_PUBLIC_ENDPOINT|TRUST_PROXY)/.test(k))) } as Record<string, string>;
  if (!env.LAN_HOST) { console.log('No .env.lan: run npm run lan:up first.'); process.exit(1); }
  console.log('HRVO LAN HTTPS check\n\nURLs in use:');
  for (const k of ['APP_WEB_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_LIVEKIT_URL', 'NEXT_PUBLIC_STORAGE_URL', 'S3_PUBLIC_ENDPOINT', 'CORS_ORIGINS']) console.log(`  ${k.padEnd(24)} ${env[k] ?? '(not set)'}`);
  console.log('');

  const insecure = insecureUrls(env);
  if (insecure.length) fail(`still http:// or ws://: ${insecure.join(', ')}`, 'run npm run lan:env, then restart with npm run lan:up');
  else ok('every browser-facing URL is https:// or wss://');
  if (/^wss:\/\//.test(env.NEXT_PUBLIC_LIVEKIT_URL ?? '')) ok('LiveKit signalling URL is wss://');
  else fail(`LiveKit URL is ${env.NEXT_PUBLIC_LIVEKIT_URL}, not wss://`);

  let ca: string;
  try { ca = caRootPem(); } catch (e) { fail((e as Error).message); summary(); return; }
  console.log(`  ..    root ${caRootPath()} fingerprint (SHA-256) ${fingerprint(ca)}`);

  const endpoints: Array<[string, string, (p: Probe) => boolean]> = [
    ['web app', `${env.APP_WEB_URL}/login`, (p) => p.status < 400],
    ['API', `${env.NEXT_PUBLIC_API_URL}/health`, (p) => p.status === 200],
    ['LiveKit', `${env.NEXT_PUBLIC_LIVEKIT_URL!.replace(/^wss/, 'https')}/`, (p) => p.status === 200],
    // The storage root answers 403 without a signature: what matters here is a trusted TLS answer.
    ['storage', `${env.NEXT_PUBLIC_STORAGE_URL}/`, (p) => p.status > 0 && p.status < 500],
  ];
  for (const [name, url, good] of endpoints) {
    try {
      const p = await httpsGet(url, ca);
      const until = p.cert?.valid_to ? `, certificate valid until ${p.cert.valid_to}` : '';
      if (good(p)) ok(`${name.padEnd(8)} ${url} answers ${p.status} with a trusted certificate${until}`);
      else fail(`${name.padEnd(8)} ${url} answers ${p.status}`, name === 'web app' || name === 'API' ? 'is npm run lan:up still running? see .lan-https/logs' : 'are the containers up? docker compose up -d');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      fail(`${name.padEnd(8)} ${url}: ${code}`, /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(String(code))
        ? 'the proxy does not serve a certificate from this root: npm run lan:certs, then npm run lan:up'
        : 'is the proxy running? npm run lan:up');
    }
  }

  // The heartbeat runs over Socket.IO: a WebSocket upgrade through the proxy must succeed (101).
  try {
    // A WebSocket key is 16 random bytes in base64 (RFC 6455); ws refuses anything else with 400.
    const key = randomBytes(16).toString('base64');
    const p = await httpsGet(`${env.NEXT_PUBLIC_API_URL}/socket.io/?EIO=4&transport=websocket`, ca, 'GET', {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Origin: env.APP_WEB_URL!,
    });
    if (p.status === 101) ok(`heartbeat WebSocket upgrades over wss:// (${env.NEXT_PUBLIC_API_URL!.replace(/^https/, 'wss')})`);
    else fail(`heartbeat WebSocket upgrade answered ${p.status}, not 101`);
  } catch (e) { fail(`heartbeat WebSocket: ${(e as Error).message}`); }

  // The CSP the browser actually receives must allow these origins and nothing on http/ws.
  try {
    const p = await httpsGet(`${env.APP_WEB_URL}/login`, ca);
    const csp = String(p.headers['content-security-policy'] ?? '');
    const connect = (/connect-src ([^;]*)/.exec(csp)?.[1] ?? '').split(/\s+/).filter(Boolean);
    const needed = [env.NEXT_PUBLIC_API_URL, env.NEXT_PUBLIC_LIVEKIT_URL, env.NEXT_PUBLIC_STORAGE_URL].filter(Boolean) as string[];
    const missing = needed.filter((u) => !connect.includes(u));
    if (missing.length) fail(`CSP connect-src lacks ${missing.join(', ')}`, 'the web app was started or built with other NEXT_PUBLIC values: restart with npm run lan:up (production builds: rebuild)');
    else ok('CSP connect-src allows the https/wss API, LiveKit and storage origins');
    const plain = connect.filter((s) => /^(http|ws):/.test(s));
    const devOnly = plain.filter((s) => /^ws:\/\/localhost:/.test(s));
    if (plain.length > devOnly.length) fail(`CSP connect-src still lists ${plain.filter((s) => !devOnly.includes(s)).join(' ')}`);
    if (devOnly.length) warn(`CSP also lists ${devOnly.join(' ')} (Next.js dev hot reload on this computer only; absent in a production build)`);
  } catch (e) { fail(`CSP: ${(e as Error).message}`); }

  if (!process.argv.includes('--no-browser')) await browserCheck(env, ca);
  summary();
}

function summary(): void {
  console.log(failures ? `\n${failures} problem(s). The guide: ${RUNBOOK}` : `\nAll good. Open ${readEnvFile(ENV_FILE).APP_WEB_URL} on a device that trusts the root certificate (${RUNBOOK}).`);
  process.exitCode = failures ? 1 : 0;
}

// ---------------------------------------------------------------- share the root with a phone

function shareCa(): void {
  const ca = caRootPem();
  const env = readEnvFile(ENV_FILE);
  const host = env.LAN_HOST || detectHost();
  const port = Number(process.env.LAN_CA_PORT || 8099);
  const der = new X509Certificate(ca).raw;
  // Only the public root certificate is served (never its private key), and only for 10 minutes.
  const server = http.createServer((req, res) => {
    if (req.url === '/hrvo-root.crt') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="hrvo-root.crt"' });
      res.end(der);
      console.log(`  downloaded by ${req.socket.remoteAddress}`);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`On the phone, open:  http://${host}:${port}/hrvo-root.crt`);
    console.log(`Before trusting it, compare this fingerprint (SHA-256) with the one the phone shows:\n  ${fingerprint(ca)}`);
    console.log(`Steps for iPhone, Android and computers: ${RUNBOOK}. Stops by itself in 10 minutes (or Ctrl+C).`);
  });
  setTimeout(() => { server.close(); console.log('Stopped sharing the root certificate.'); process.exit(0); }, 10 * 60_000).unref();
}

// ---------------------------------------------------------------- main

const command = process.argv[2];
try {
  if (command === 'env') writeEnv();
  else if (command === 'certs') issueCerts();
  else if (command === 'check') await check();
  else if (command === 'share-ca') shareCa();
  else { console.error('usage: node --experimental-strip-types scripts/lan.ts env|certs|check|share-ca'); process.exit(2); }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
