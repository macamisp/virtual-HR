/**
 * Refresh tokens are delivered only as the httpOnly cookie (FR-AUTH-003). Test helpers that
 * behave like a browser: read the cookie from Set-Cookie and send it back with the CSRF header.
 */
import assert from 'node:assert/strict';

/** `refreshToken=<value>` from a response, ready for a Cookie header. */
export function refreshCookie(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('refreshToken='));
  assert.ok(raw, 'response sets the refresh cookie');
  return raw.split(';')[0]!;
}

/** The raw token value inside a `refreshToken=<value>` cookie pair. */
export function cookieValue(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
}

export function refreshWithCookie(baseUrl: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-HRVO-CSRF': '1' },
  });
}

/** Paths of any key that looks like a refresh token, anywhere in a JSON value. */
export function refreshTokenFields(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => refreshTokenFields(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(/refresh.?token/i.test(k) ? [`${path}.${k}`] : []),
      ...refreshTokenFields(v, `${path}.${k}`),
    ]);
  }
  return [];
}
