/**
 * RFC 5545 calendar invites (FR-MEET-003, ADR 016), hand-written: VEVENT with organizer,
 * attendees, recurrence, a join link, and METHOD REQUEST / CANCEL with an increasing SEQUENCE.
 * Text is escaped and lines are folded at 75 octets. Pure and unit-tested.
 */
import type { Recurrence } from '../../../../packages/shared/src/meetings/types.ts';

export interface IcsEvent {
  uid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  title: string;
  description: string;
  start: Date;
  end: Date;
  organizer: { name: string; email: string };
  attendees: Array<{ name: string; email: string }>;
  url: string;
  rrule: string | null;
  now?: Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds a content line at 75 octets (not characters), continuation lines start with a space. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a UTF-8 sequence: back up to a lead byte.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // the leading space counts
  }
  return parts.join('\r\n ');
}

const mailto = (p: { name: string; email: string }) => `CN=${quoteParam(p.name)}:mailto:${p.email}`;
const quoteParam = (s: string) => `"${s.replace(/["\r\n]/g, '')}"`;

export function rruleOf(r: (Omit<Recurrence, 'interval'> & { interval?: number }) | null): string | null {
  if (!r) return null;
  const parts = [`FREQ=${r.freq}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'WEEKLY' && r.byDay?.length) parts.push(`BYDAY=${r.byDay.join(',')}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, '')}T235959Z`);
  return parts.join(';');
}

export function buildIcs(e: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HR Virtual Office//Meetings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.method}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${stamp(e.now ?? new Date())}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(e.end)}`,
    `SUMMARY:${escapeText(e.title)}`,
    `DESCRIPTION:${escapeText(`${e.description ? `${e.description}\n\n` : ''}Join: ${e.url}`)}`,
    `URL:${e.url}`,
    `LOCATION:${escapeText('HR Virtual Office')}`,
    `ORGANIZER;${mailto(e.organizer)}`,
    ...e.attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;${mailto(a)}`),
    ...(e.rrule ? [`RRULE:${e.rrule}`] : []),
    `STATUS:${e.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * The next occurrence that has not ended (for listing recurring meetings), within 2 years.
 * Supports the RRULE subset produced by rruleOf.
 */
export function nextOccurrence(start: Date, end: Date, rrule: string | null, now: Date): { start: Date; end: Date } | null {
  const dur = end.getTime() - start.getTime();
  if (!rrule) return end > now ? { start, end } : null;
  const p = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=') as [string, string]));
  const interval = Number(p.INTERVAL ?? 1);
  const count = p.COUNT ? Number(p.COUNT) : Infinity;
  const until = p.UNTIL ? new Date(`${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}T23:59:59Z`) : null;
  const days = p.BYDAY ? p.BYDAY.split(',') : null;
  const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  let n = 0;
  for (let i = 0; i < 1500; i += 1) {
    let s: Date;
    if (p.FREQ === 'DAILY') s = new Date(start.getTime() + i * interval * 86_400_000);
    else if (p.FREQ === 'MONTHLY') { s = new Date(start); s.setUTCMonth(start.getUTCMonth() + i * interval); }
    else {
      // WEEKLY: walk day by day inside the active weeks.
      s = new Date(start.getTime() + i * 86_400_000);
      const week = Math.floor(i / 7);
      if (week % interval !== 0) continue;
      if (days ? !days.includes(DOW[s.getUTCDay()]!) : s.getUTCDay() !== start.getUTCDay()) continue;
    }
    if (until && s > until) return null;
    if (s.getTime() - start.getTime() > 2 * 365 * 86_400_000) return null;
    n += 1;
    if (n > count) return null;
    const e = new Date(s.getTime() + dur);
    if (e > now) return { start: s, end: e };
  }
  return null;
}
