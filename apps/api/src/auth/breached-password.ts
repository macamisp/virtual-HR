/**
 * Breached-password check (FR-AUTH-002).
 *
 * BREACHED_PASSWORD_CHECK selects the implementation:
 *  - "hibp" (default): Have I Been Pwned range API with k-anonymity. Only the first
 *    5 hex chars of the SHA-1 hash leave the server; the full hash and the password
 *    never do. Responses are padded (Add-Padding) so response size leaks nothing.
 *  - "local": offline stub with a small built-in blocklist, for tests and air-gapped
 *    dev only. Refused in production.
 */
import { createHash } from 'node:crypto';
import { isProduction } from '../common/config.ts';

export const BREACHED_PASSWORD_CHECKER = Symbol('BREACHED_PASSWORD_CHECKER');

export interface BreachedPasswordChecker {
  /** Resolves true if the password appears in a breach corpus. Throws BreachCheckUnavailableError if it cannot tell. */
  isBreached(password: string): Promise<boolean>;
}

export class BreachCheckUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreachCheckUnavailableError';
  }
}

type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class HibpRangeChecker implements BreachedPasswordChecker {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(fetchFn: FetchFn = fetch, baseUrl = 'https://api.pwnedpasswords.com', timeoutMs = 3000) {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    let body: string;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'HRVO-API' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new BreachCheckUnavailableError(`Breach API responded with HTTP ${res.status}`);
      }
      body = await res.text();
    } catch (err) {
      if (err instanceof BreachCheckUnavailableError) throw err;
      throw new BreachCheckUnavailableError('Breach API unreachable');
    }

    for (const line of body.split('\n')) {
      const [candidate, countRaw] = line.trim().split(':');
      // Padding entries have a count of 0 and must be ignored.
      if (candidate === suffix && Number.parseInt(countRaw ?? '0', 10) > 0) {
        return true;
      }
    }
    return false;
  }
}

const LOCAL_BLOCKLIST = new Set([
  'password123456',
  '123456789012',
  'qwertyuiopas',
  'administrator1',
  'letmein123456',
  'welcome123456',
  'companypassword1',
]);

export class LocalBlocklistChecker implements BreachedPasswordChecker {
  async isBreached(password: string): Promise<boolean> {
    return LOCAL_BLOCKLIST.has(password.toLowerCase());
  }
}

export function createBreachedPasswordChecker(): BreachedPasswordChecker {
  // Unset or empty (the runbooks say "leave it empty") means the default, HIBP.
  const mode = (process.env.BREACHED_PASSWORD_CHECK ?? '').trim() || 'hibp';
  if (mode === 'local') {
    if (isProduction()) {
      throw new Error('BREACHED_PASSWORD_CHECK=local is a test stub and is not allowed in production');
    }
    return new LocalBlocklistChecker();
  }
  if (mode !== 'hibp') {
    throw new Error(`Unknown BREACHED_PASSWORD_CHECK mode: ${mode}`);
  }
  return new HibpRangeChecker(fetch, process.env.HIBP_API_URL || 'https://api.pwnedpasswords.com');
}
