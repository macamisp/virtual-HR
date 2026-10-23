/**
 * `npm run google:check` (ADR 037): is sign in with Google configured? Prints whether each setting
 * is present (never its value), fetches Google's OpenID discovery document, and prints the exact
 * redirect URI and JavaScript origin to register in Google Cloud Console.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env: Record<string, string | undefined> = { ...readEnvFile(join(ROOT, '.env')), ...process.env };
const present = (names: string[]) => names.find((n) => (env[n] ?? '').trim() !== '');
let failures = 0;
const line = (ok: boolean, msg: string) => { if (!ok) failures += 1; console.log(`  ${ok ? 'OK     ' : 'MISSING'}  ${msg}`); };

console.log('Sign in with Google: configuration check\n');
const idName = present(['GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID']);
const secretName = present(['GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET']);
const redirect = (env.GOOGLE_REDIRECT_URI || env.GOOGLE_SIGNIN_REDIRECT_URL || '').trim();
line(!!idName, `client id ${idName ? `(${idName} is set)` : '(set GOOGLE_CLIENT_ID)'}`);
line(!!secretName, `client secret ${secretName ? `(${secretName} is set)` : '(set GOOGLE_CLIENT_SECRET)'}`);
line(!!redirect, `redirect URI ${redirect ? '(GOOGLE_REDIRECT_URI is set)' : '(set GOOGLE_REDIRECT_URI, e.g. http://localhost:3001/auth/google/callback)'}`);
const web = (env.APP_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const effectiveRedirect = redirect || 'http://localhost:3001/auth/google/callback';
try {
  const u = new URL(effectiveRedirect);
  line(u.pathname === '/auth/google/callback', `redirect URI path is /auth/google/callback (${u.pathname})`);
  line(u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1', `redirect URI is https:// or localhost (Google refuses plain http elsewhere): ${u.protocol}//${u.host}`);
} catch {
  line(false, `redirect URI is a valid URL: ${effectiveRedirect}`);
}

const discovery = env.GOOGLE_OIDC_DISCOVERY_URL || 'https://accounts.google.com/.well-known/openid-configuration';
try {
  const res = await fetch(discovery, { signal: AbortSignal.timeout(10_000) });
  const doc = (await res.json()) as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string; code_challenge_methods_supported?: string[] };
  line(res.ok && !!doc.authorization_endpoint && !!doc.token_endpoint && !!doc.jwks_uri, `discovery document reachable (${discovery}): issuer ${doc.issuer ?? '?'}`);
  line((doc.code_challenge_methods_supported ?? []).includes('S256'), 'provider supports PKCE S256');
} catch (e) {
  line(false, `discovery document (${discovery}): ${(e as Error).message}`);
}

console.log(`
Register in Google Cloud Console → APIs & Services → Credentials → your OAuth client (Web application):
  Authorised redirect URI:        ${effectiveRedirect}
  Authorised JavaScript origin:   ${web}
Production pattern:
  redirect URI                    https://<api-host>/auth/google/callback
  JavaScript origin               https://<web-host>
Calendar sync (ADR 023) also needs: ${effectiveRedirect.replace('/auth/google/callback', '/calendar/oauth/callback')}

Guide: docs/runbooks/google-signin.md`);
process.exit(failures ? 1 : 0);
