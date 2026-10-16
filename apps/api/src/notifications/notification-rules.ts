/**
 * Pure rules for notification preferences (FR-NOTIF-002, 004): quiet hours in the user's
 * timezone, which channels an event reaches, and the signed unsubscribe token. Unit-tested.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { isCriticalNotification } from '../../../../packages/shared/src/notifications/types.ts';
import type { QuietHours } from '../../../../packages/shared/src/notifications/types.ts';

const ZONES = new Set(Intl.supportedValuesOf('timeZone'));
export const isValidTimezone = (tz: string): boolean => ZONES.has(tz) || tz === 'UTC';

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const minutesToClock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * When quiet hours cover `now` in `timezone`, the instant they end (when the email may go);
 * otherwise null. The window may cross midnight (22:00–07:00).
 */
export function quietUntil(now: Date, timezone: string, quiet: QuietHours | null): Date | null {
  if (!quiet) return null;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  const local = formatInTimeZone(now, timezone, 'yyyy-MM-dd HH:mm');
  const minutes = toMinutes(local.slice(11));
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return null;
  // The end falls today, or tomorrow when the window wraps and we are past midnight... or past the start.
  const endsTomorrow = start > end && minutes >= start;
  const day = local.slice(0, 10);
  const endDay = endsTomorrow ? addDay(day) : day;
  return fromZonedTime(`${endDay}T${quiet.end}:00`, timezone);
}

function addDay(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface ChannelPreference {
  inApp: boolean;
  email: boolean;
}

/**
 * Which channels an event uses. `requestedEmail` is what the producing feature asked for;
 * preferences can only turn channels off. Critical types ignore preferences and quiet hours.
 */
export function resolveChannels(
  type: string,
  requestedEmail: boolean,
  pref: ChannelPreference | undefined,
  now: Date,
  timezone: string,
  quiet: QuietHours | null,
): { inApp: boolean; email: boolean; emailAfter: Date | null } {
  if (isCriticalNotification(type)) return { inApp: true, email: requestedEmail, emailAfter: null };
  const inApp = pref?.inApp ?? true;
  const email = requestedEmail && (pref?.email ?? true);
  return { inApp, email, emailAfter: email ? quietUntil(now, timezone, quiet) : null };
}

// ---------------------------------------------------------------- unsubscribe tokens

const b64 = (b: Buffer) => b.toString('base64url');

/** `v1.<payload>.<mac>`; the payload is org, user and type. It can only ever turn email off. */
export function signUnsubscribeToken(secret: string, orgId: string, userId: string, type: string): string {
  const payload = b64(Buffer.from(`${orgId}.${userId}.${type}`, 'utf8'));
  const mac = b64(createHmac('sha256', secret).update(`unsubscribe:${payload}`).digest());
  return `v1.${payload}.${mac}`;
}

export function verifyUnsubscribeToken(secret: string, token: string): { orgId: string; userId: string; type: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, mac] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`unsubscribe:${payload}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [orgId, userId, type] = Buffer.from(payload, 'base64url').toString('utf8').split('.');
  if (!orgId || !userId || !type) return null;
  return { orgId, userId, type };
}
