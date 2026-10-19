/**
 * Safety checks for demo seeds (docs/runbooks/demo-internet.md). The local demo uses one fixed,
 * published password, so it must never run while any configured address is reachable from the
 * internet. The internet demo generates passwords per run and refuses settings that are only
 * acceptable on a developer machine.
 */
import { randomInt } from 'node:crypto';

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** True for http(s)://localhost, 127.0.0.1, ::1 and *.localhost; anything else (or unparsable) counts as public. */
export function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Every configured address that is not local: the web app, the API, storage, CORS origins and the tunnel. */
export function publicUrls(env: Env): string[] {
  const values = [env.APP_WEB_URL, env.NEXT_PUBLIC_API_URL, env.NEXT_PUBLIC_STORAGE_URL, env.S3_PUBLIC_ENDPOINT, env.DEMO_PUBLIC_URL, ...(env.CORS_ORIGINS ?? '').split(',')]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length > 0);
  return [...new Set(values.filter((v) => !isLocalUrl(v)))];
}

/** The local seed (one published password) refuses whenever anything points at the internet. */
export function assertDefaultPasswordsStayLocal(env: Env): void {
  const exposed = publicUrls(env);
  if (exposed.length > 0) {
    throw new Error(
      `Refusing to seed the default demo passwords while these addresses are public: ${exposed.join(', ')}. ` +
      'For an internet demo run "npm run seed:demo:internet", which generates passwords per run.',
    );
  }
}

/** The internet demo refuses development-only settings. */
export function assertInternetDemoSafe(env: Env): void {
  const problems: string[] = [];
  if (env.AUTH_MFA_ENFORCEMENT === 'off') problems.push('AUTH_MFA_ENFORCEMENT=off (HR and admins must use 2FA in a public demo; leave it empty)');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || /change-in-production/i.test(env.JWT_SECRET)) problems.push('JWT_SECRET is missing, short or the development value (use: openssl rand -hex 32)');
  if (!env.LIVEKIT_API_SECRET || env.LIVEKIT_API_SECRET.startsWith('hrvo-dev')) problems.push('LIVEKIT_API_SECRET is the development key (use your LiveKit Cloud key and secret)');
  if (env.BREACHED_PASSWORD_CHECK === 'local') problems.push('BREACHED_PASSWORD_CHECK=local (leave it empty so new passwords are checked against Have I Been Pwned)');
  // The storage tunnel exposes the S3 endpoint itself: its keys are the only lock.
  if (env.S3_PUBLIC_ENDPOINT && !isLocalUrl(env.S3_PUBLIC_ENDPOINT) && (env.S3_SECRET_KEY ?? '').length < 24) problems.push('S3_SECRET_KEY is shorter than 24 characters while storage is public (use: openssl rand -hex 24, in .env and the storage identity)');
  if (publicUrls(env).some((u) => u.startsWith('http://'))) problems.push('a public address uses http://; the tunnel addresses must be https:// (camera, microphone and cookies need it)');
  if (problems.length > 0) throw new Error(`Refusing to seed the internet demo:\n  - ${problems.join('\n  - ')}`);
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#%+-=?@^_~';

/** A random password from the OS CSPRNG: `length` characters, at least one of each class, no look-alike characters. */
export function strongPassword(length = 20): string {
  if (length < 12) throw new Error('Demo passwords are at least 12 characters');
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const pick = (set: string) => set[randomInt(set.length)]!;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
