/**
 * Upcoming calendar events (FR-WT-022; ADR 049 §6) and D6 (only a refused refresh or a 401 after
 * a fresh token means "connect again"), end to end against local fakes of Google Calendar and
 * Microsoft Graph. No real Google or Microsoft account is involved.
 */
import 'reflect-metadata';
import { freshCode } from './support/totp.ts';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import argon2 from 'argon2';
import { AppModule } from '../src/app.module.ts';
import { configureApp } from '../src/common/configure-app.ts';
import { CalendarService } from '../src/calendar/calendar.service.ts';
import { ProviderError, classifyFailure } from '../src/calendar/providers.ts';
import { CalendarConnectionListSchema, MeetingSchema, UpcomingListSchema } from '../../../packages/shared/src/index.ts';
import type { UpcomingList } from '../../../packages/shared/src/index.ts';

const ORG = 'ca1e0000-0000-4000-8000-000000000001';
const ORG_B = 'ca1e0000-0000-4000-8000-000000000002';
const PORT = 3066;
const G_PORT = 3067;
const M_PORT = 3068;
const PASSWORD = 'ComplexPassword123!';
const SECRET = 'KVKFKRCPNZQUYMLXOVYDSQKJKZDTSRLD';
const U = {
  host: { id: 'ca1e0000-0000-4000-8000-000000000011', org: ORG, email: 'host@upcoming.test', name: 'Hana Host', role: 'HR', mfa: true },
  att: { id: 'ca1e0000-0000-4000-8000-000000000012', org: ORG, email: 'ann@upcoming.test', name: 'Ann Attendee', role: 'EMPLOYEE', mfa: false },
  other: { id: 'ca1e0000-0000-4000-8000-000000000021', org: ORG_B, email: 'otto@upcoming-b.test', name: 'Otto Other', role: 'EMPLOYEE', mfa: false },
} as const;
type Who = keyof typeof U;

// ------------------------------------------------------------------ fakes

function body(req: IncomingMessage): Promise<string> {
  return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });
}
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

class FakeProvider {
  server!: Server;
  pendingCodes = new Map<string, { challenge: string; email: string }>();
  issued = new Set<string>();
  calls: string[] = [];
  lastQuery: URLSearchParams | null = null;
  events: unknown[] = [];
  failRefresh = false;
  /** Every calendar API call answers this (token endpoint unaffected); `once` clears it after one use. */
  fail: { status: number; body: unknown; once?: boolean } | null = null;
  private n = 0;

  constructor(private readonly kind: 'google' | 'microsoft', private readonly port: number) {}

  start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req).then(([status, out]) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 204 ? undefined : JSON.stringify(out));
    }));
    return new Promise((r) => this.server.listen(this.port, () => r()));
  }

  count(path: string): number { return this.calls.filter((c) => c === path).length; }

  private token(refresh: boolean, email: string): Record<string, unknown> {
    this.n += 1;
    const access = `${this.kind}-access-${this.n}`;
    this.issued.add(access);
    return { access_token: access, ...(refresh ? { refresh_token: `${this.kind}-refresh-1` } : {}), expires_in: 3600, id_token: idToken(email) };
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const raw = await body(req);
    this.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname.endsWith('/token')) {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'authorization_code') {
        const p = this.pendingCodes.get(f.get('code') ?? '');
        const ok = p && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === p.challenge;
        if (!ok) return [400, { error: 'invalid_grant' }];
        this.pendingCodes.delete(f.get('code')!);
        return [200, this.token(true, p.email)];
      }
      if (this.failRefresh || f.get('refresh_token') !== `${this.kind}-refresh-1`) return [400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }];
      return [200, this.token(false, '')];
    }
    if (url.pathname.endsWith('/revoke')) return [200, {}];
    if (this.fail) {
      const f = this.fail;
      if (f.once) this.fail = null;
      return [f.status, f.body];
    }
    if (!this.issued.has((req.headers.authorization ?? '').replace('Bearer ', ''))) return [401, { error: 'unauthorized' }];
    if (this.kind === 'google' && url.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'GET') {
      this.lastQuery = url.searchParams;
      return [200, { items: this.events }];
    }
    if (this.kind === 'microsoft' && url.pathname === '/v1.0/me/calendarView') {
      this.lastQuery = url.searchParams;
      return [200, { value: this.events }];
    }
    if (url.pathname === '/calendar/v3/freeBusy') return [200, { calendars: { primary: { busy: [] } } }];
    return [404, {}];
  }
}

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const graphTime = (d: Date) => d.toISOString().replace('Z', '0000');

describe('Upcoming calendar events (FR-WT-022)', { concurrency: false }, () => {
  let app: INestApplication;
  let adminPool: pg.Pool;
  let service: CalendarService;
  const google = new FakeProvider('google', G_PORT);
  const microsoft = new FakeProvider('microsoft', M_PORT);
  const base = `http://localhost:${PORT}`;
  const tokens = {} as Record<Who, string>;
  let meetingId = '';
  const strangerUid = `${randomUUID()}@hrvo`;

  const api = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  async function ok<T>(res: Response, status: number, schema?: { parse: (v: unknown) => T }): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, `${res.url}: ${text}`);
    return schema ? schema.parse(JSON.parse(text)) : (JSON.parse(text || 'null') as T);
  }
  const upcoming = async (who: Who, q = ''): Promise<UpcomingList> => ok(await api(who, `/calendar/upcoming${q}`), 200, UpcomingListSchema);
  async function connect(who: Who, provider: 'GOOGLE' | 'MICROSOFT', fake: FakeProvider): Promise<void> {
    const { authorizeUrl } = await ok<{ authorizeUrl: string }>(await api(who, `/calendar/${provider.toLowerCase()}/connect`, { method: 'POST' }), 200);
    const q = new URL(authorizeUrl).searchParams;
    const code = `code-${who}-${provider}`;
    fake.pendingCodes.set(code, { challenge: q.get('code_challenge')!, email: U[who].email });
    const res = await fetch(`${base}/calendar/oauth/callback?code=${code}&state=${q.get('state')}`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), `http://web.test/account/calendar?connected=${provider}`);
  }
  const conn = async (provider: 'GOOGLE' | 'MICROSOFT') => (await adminPool.query<{ status: string; last_error: string | null }>(
    `SELECT status, last_error FROM calendar_connections WHERE user_id = $1 AND provider = $2`, [U.att.id, provider])).rows[0]!;
  const attendanceRows = async () => (await adminPool.query<{ s: number; g: number }>(
    `SELECT (SELECT count(*)::int FROM attendance_sessions WHERE user_id = $1) AS s,
            (SELECT count(*)::int FROM attendance_segments g JOIN attendance_sessions x ON x.id = g.session_id WHERE x.user_id = $1) AS g`, [U.att.id])).rows[0]!;

  before(async () => {
    Object.assign(process.env, {
      BREACHED_PASSWORD_CHECK: 'local', MAIL_TRANSPORT: 'memory', RATE_LIMIT_LOGIN: '1000', JOBS_ENABLED: 'false', APP_WEB_URL: 'http://web.test',
      GOOGLE_OAUTH_CLIENT_ID: 'g-client', GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret', MICROSOFT_OAUTH_CLIENT_ID: 'm-client', MICROSOFT_OAUTH_CLIENT_SECRET: 'm-secret',
      GOOGLE_OAUTH_AUTH_URL: `http://localhost:${G_PORT}/auth`, GOOGLE_OAUTH_TOKEN_URL: `http://localhost:${G_PORT}/token`, GOOGLE_OAUTH_REVOKE_URL: `http://localhost:${G_PORT}/revoke`,
      GOOGLE_CALENDAR_API: `http://localhost:${G_PORT}/calendar/v3`, MICROSOFT_LOGIN_URL: `http://localhost:${M_PORT}/oauth2/v2.0`, MICROSOFT_GRAPH_API: `http://localhost:${M_PORT}/v1.0`,
      CALENDAR_OAUTH_REDIRECT_URL: `${base}/calendar/oauth/callback`,
    });
    await Promise.all([google.start(), microsoft.start()]);
    adminPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGADMIN_USER || 'postgres', password: process.env.PGADMIN_PASSWORD || 'postgres' });
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_B]]);
    await adminPool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Upcoming Ltd', 'cal-upcoming-a'), ($2, 'Other Ltd', 'cal-upcoming-b')`, [ORG, ORG_B]);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    for (const u of Object.values(U)) {
      await adminPool.query(`INSERT INTO users (id, org_id, email, display_name, role, password_hash, status, mfa_enabled, mfa_secret) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
        [u.id, u.org, u.email, u.name, u.role, hash, u.mfa, u.mfa ? SECRET : null]);
    }
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.listen(PORT);
    service = app.get(CalendarService, { strict: false });
    for (const who of Object.keys(U) as Who[]) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: U[who].email, password: PASSWORD, ...(U[who].mfa ? { totpCode: await freshCode(SECRET) } : {}) }) });
      tokens[who] = ((await res.json()) as { accessToken: string }).accessToken;
    }
  });

  after(async () => {
    await app?.close();
    google.server?.close();
    microsoft.server?.close();
    await adminPool.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_B]]);
    await adminPool.end();
  });

  beforeEach(async () => {
    service?.clearUpcomingCache();
    google.fail = null; microsoft.fail = null; google.failRefresh = false; microsoft.failRefresh = false;
    if (adminPool) await adminPool.query(`UPDATE calendar_connections SET status = 'ACTIVE', last_error = NULL, expires_at = now() + interval '1 hour' WHERE user_id = $1`, [U.att.id]);
  });

  it('needs a session, validates days, and says "not connected" with no items', async () => {
    assert.equal((await fetch(`${base}/calendar/upcoming`)).status, 401);
    assert.equal((await api('att', '/calendar/upcoming?days=0')).status, 400);
    assert.equal((await api('att', '/calendar/upcoming?days=15')).status, 400);
    assert.deepEqual(await upcoming('att'), { connected: false, providers: [], items: [] });
  });

  it('lists Google and Outlook events with title, times, source, response and a safe open link', async () => {
    await connect('att', 'GOOGLE', google);
    await connect('att', 'MICROSOFT', microsoft);
    const start = at(24 * 60);
    meetingId = (await ok(await api('host', '/meetings', { method: 'POST', body: { type: 'SCHEDULED', title: 'Quarterly review', start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString(), attendeeIds: [U.att.id], sendInvites: false } }), 201, MeetingSchema)).id;
    const tomorrow = at(48 * 60).toISOString().slice(0, 10);
    const dayAfter = at(72 * 60).toISOString().slice(0, 10);
    google.events = [
      { id: 'g1', status: 'confirmed', summary: 'Design review', iCalUID: 'g1@google.com', start: { dateTime: at(60).toISOString() }, end: { dateTime: at(120).toISOString() },
        attendees: [{ email: 'boss@example.com', responseStatus: 'accepted' }, { email: U.att.email, self: true, responseStatus: 'accepted' }],
        hangoutLink: 'https://meet.google.com/abc-defg-hij', htmlLink: 'https://www.google.com/calendar/event?eid=g1' },
      { id: 'g2', status: 'confirmed', summary: 'Quarterly review', iCalUID: `${meetingId}@hrvo`, start: { dateTime: start.toISOString() }, end: { dateTime: new Date(start.getTime() + 3600_000).toISOString() },
        attendees: [{ email: U.att.email, self: true, responseStatus: 'needsAction' }], htmlLink: 'https://www.google.com/calendar/event?eid=g2' },
      { id: 'g3', status: 'confirmed', iCalUID: 'g3@google.com', start: { date: tomorrow }, end: { date: dayAfter }, hangoutLink: 'javascript:alert(1)', htmlLink: 'http://insecure.example/g3' },
      { id: 'g4', status: 'confirmed', summary: 'Vendor call', iCalUID: strangerUid, start: { dateTime: at(30).toISOString() }, end: { dateTime: at(45).toISOString() },
        attendees: [{ email: U.att.email, self: true, responseStatus: 'tentative' }],
        conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1-555-0100' }, { entryPointType: 'video', uri: 'https://zoom.example/j/1' }] }, htmlLink: 'https://www.google.com/calendar/event?eid=g4' },
      { id: 'g5', status: 'cancelled', summary: 'Gone', start: { dateTime: at(90).toISOString() }, end: { dateTime: at(100).toISOString() } },
    ];
    microsoft.events = [
      { id: 'm1', subject: 'Budget sync', start: { dateTime: graphTime(at(180)) }, end: { dateTime: graphTime(at(210)) }, isAllDay: false, isCancelled: false,
        iCalUId: 'abc', responseStatus: { response: 'declined' }, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' }, webLink: 'https://outlook.office365.com/owa/?itemid=m1' },
      { id: 'm2', subject: 'Quarterly review', start: { dateTime: graphTime(start) }, end: { dateTime: graphTime(new Date(start.getTime() + 3600_000)) }, isAllDay: false,
        iCalUId: 'exchange-generated', transactionId: `${meetingId}@hrvo`, responseStatus: { response: 'organizer' }, onlineMeeting: null, webLink: 'https://outlook.office365.com/owa/?itemid=m2' },
      { id: 'm3', subject: 'Cancelled', start: { dateTime: graphTime(at(200)) }, end: { dateTime: graphTime(at(230)) }, isCancelled: true },
      { id: 'm4', subject: '  ', start: { dateTime: graphTime(at(300)) }, end: { dateTime: graphTime(at(330)) }, responseStatus: { response: 'organizer' }, onlineMeeting: null, webLink: 'javascript:void(0)' },
    ];
    const before = await attendanceRows();
    const l = await upcoming('att', '?days=7');
    const gq = google.lastQuery!;
    assert.equal(gq.get('singleEvents'), 'true');
    assert.equal(gq.get('orderBy'), 'startTime');
    assert.equal(gq.get('maxResults'), '50');
    assert.equal(gq.get('showDeleted'), 'false');
    const span = new Date(gq.get('timeMax')!).getTime() - new Date(gq.get('timeMin')!).getTime();
    assert.equal(span, 7 * 86_400_000);
    assert.equal(microsoft.lastQuery!.get('$top'), '50');

    assert.equal(l.connected, true);
    assert.deepEqual(l.providers, [{ provider: 'GOOGLE', status: 'ACTIVE', lastError: null }, { provider: 'MICROSOFT', status: 'ACTIVE', lastError: null }]);
    assert.deepEqual(l.items.map((i) => [i.id, i.title]), [['g4', 'Vendor call'], ['g1', 'Design review'], ['m1', 'Budget sync'], ['m4', '(No title)'], ['g2', 'Quarterly review'], ['g3', '(No title)']]);
    const by = Object.fromEntries(l.items.map((i) => [i.id, i]));
    assert.deepEqual(by.g1, { id: 'g1', provider: 'GOOGLE', title: 'Design review', start: (google.events[0] as { start: { dateTime: string } }).start.dateTime, end: (google.events[0] as { end: { dateTime: string } }).end.dateTime,
      allDay: false, source: 'Google Calendar (primary)', hrvoMeetingId: null, response: 'ACCEPTED', openUrl: 'https://meet.google.com/abc-defg-hij' });
    assert.equal(by.g2!.hrvoMeetingId, meetingId, 'our meeting is recognised by its iCal UID');
    assert.equal(by.g2!.openUrl, `http://web.test/meetings/${meetingId}`);
    assert.equal(by.g2!.response, 'NEEDS_ACTION');
    assert.equal(by.g3!.allDay, true);
    assert.equal(by.g3!.start, `${tomorrow}T00:00:00.000Z`);
    assert.equal(by.g3!.openUrl, null, 'javascript: and http: links are dropped');
    assert.equal(by.g4!.hrvoMeetingId, null, 'a @hrvo UID of a meeting that is not in this organisation is not ours');
    assert.equal(by.g4!.openUrl, 'https://zoom.example/j/1');
    assert.equal(by.g4!.response, 'TENTATIVE');
    assert.equal(by.m1!.source, 'Outlook calendar');
    assert.equal(by.m1!.response, 'DECLINED');
    assert.equal(by.m1!.openUrl, 'https://teams.microsoft.com/l/meetup-join/1');
    assert.equal(by.m4!.openUrl, null);
    assert.equal(by.m4!.response, null);
    assert.equal(l.items.filter((i) => i.hrvoMeetingId === meetingId).length, 1, 'the same meeting in both calendars shows once');

    // A calendar event never creates attendance or meeting time (ADR 049 §6), and nothing is stored.
    assert.deepEqual(await attendanceRows(), before);
    assert.deepEqual(before, { s: 0, g: 0 });
    for (const t of ['calendar_event_links', 'calendar_busy']) {
      assert.equal((await adminPool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [U.att.id])).rows[0].n, 0, t);
    }
  });

  it('caches the answer for 60 s per person: two requests, one provider call', async () => {
    const g = google.count('GET /calendar/v3/calendars/primary/events');
    const m = microsoft.count('GET /v1.0/me/calendarView');
    const a = await upcoming('att');
    const b = await upcoming('att');
    assert.deepEqual(a, b);
    assert.equal(google.count('GET /calendar/v3/calendars/primary/events'), g + 1);
    assert.equal(microsoft.count('GET /v1.0/me/calendarView'), m + 1);
  });

  it('a provider outage returns the other provider\'s events and that provider\'s status (never a 500)', async () => {
    google.fail = { status: 500, body: { error: { code: 500, message: 'backend error' } } };
    const l = await upcoming('att');
    assert.deepEqual(l.items.map((i) => i.provider).filter((p, i, a) => a.indexOf(p) === i), ['MICROSOFT']);
    const g = l.providers.find((p) => p.provider === 'GOOGLE')!;
    assert.equal(g.status, 'ACTIVE');
    assert.match(g.lastError ?? '', /will retry/);
    assert.equal(l.providers.find((p) => p.provider === 'MICROSOFT')!.lastError, null);
    assert.equal((await conn('GOOGLE')).status, 'ACTIVE');
  });

  it('D6: 403 rateLimitExceeded (sync) and 429 (upcoming) are temporary: still connected, with a note', async () => {
    google.fail = { status: 403, body: { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded' }] } } };
    const s = await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200, CalendarConnectionListSchema);
    const g = s.items.find((c) => c.provider === 'GOOGLE')!;
    assert.equal(g.status, 'ACTIVE');
    assert.match(g.lastError ?? '', /rate limiting/);
    google.fail = null;
    microsoft.fail = { status: 429, body: { error: { code: 'TooManyRequests', message: 'slow down' } } };
    const l = await upcoming('att');
    const m = l.providers.find((p) => p.provider === 'MICROSOFT')!;
    assert.deepEqual([m.status, m.lastError], ['ACTIVE', 'Calendar provider is rate limiting; will retry.']);
    assert.deepEqual(await conn('MICROSOFT'), { status: 'ACTIVE', last_error: 'Calendar provider is rate limiting; will retry.' });
    assert.ok(l.items.some((i) => i.provider === 'GOOGLE'));
    google.fail = { status: 403, body: { error: { code: 403, message: 'Quota', errors: [{ reason: 'quotaExceeded' }] } } };
    await ok(await api('att', '/calendar/sync', { method: 'POST' }), 200);
    assert.equal((await conn('GOOGLE')).status, 'ACTIVE');
  });

  it('D6: a refused refresh (invalid_grant) marks the connection "connect again"', async () => {
    await adminPool.query(`UPDATE calendar_connections SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND provider = 'GOOGLE'`, [U.att.id]);
    google.failRefresh = true;
    const l = await upcoming('att');
    const g = l.providers.find((p) => p.provider === 'GOOGLE')!;
    assert.equal(g.status, 'ERROR');
    assert.match(g.lastError ?? '', /Connect the calendar again/);
    assert.ok(l.items.length > 0 && l.items.every((i) => i.provider === 'MICROSOFT'));
    assert.equal((await conn('GOOGLE')).status, 'ERROR');
    // An ERROR connection is not called again until the person reconnects.
    service.clearUpcomingCache();
    const calls = google.calls.length;
    assert.equal((await upcoming('att')).providers.find((p) => p.provider === 'GOOGLE')!.status, 'ERROR');
    assert.equal(google.calls.length, calls);
  });

  it('D6: a 401 earns one refresh and retry; a 401 after a fresh token means "connect again"', async () => {
    const refreshes = google.count('POST /token');
    google.fail = { status: 401, body: { error: { code: 401 } }, once: true };
    const l = await upcoming('att');
    assert.equal(l.providers.find((p) => p.provider === 'GOOGLE')!.status, 'ACTIVE');
    assert.ok(l.items.some((i) => i.provider === 'GOOGLE'));
    assert.equal(google.count('POST /token'), refreshes + 1);
    service.clearUpcomingCache();
    google.fail = { status: 401, body: { error: { code: 401 } } };
    assert.equal((await upcoming('att')).providers.find((p) => p.provider === 'GOOGLE')!.status, 'ERROR');
    assert.equal((await conn('GOOGLE')).status, 'ERROR');
  });

  it('D6 classification: other 403s and 400s from the API do not ask to reconnect', () => {
    assert.equal(classifyFailure(new ProviderError(403, 'x', 'api', 'forbidden')), 'TEMPORARY');
    assert.equal(classifyFailure(new ProviderError(403, 'x', 'api', 'userRateLimitExceeded')), 'RATE_LIMITED');
    assert.equal(classifyFailure(new ProviderError(400, 'x', 'api', 'invalid_grant')), 'TEMPORARY');
    assert.equal(classifyFailure(new ProviderError(400, 'x', 'token', 'invalid_grant')), 'RECONNECT');
    assert.equal(classifyFailure(new ProviderError(401, 'x', 'token', 'invalid_client')), 'TEMPORARY');
    assert.equal(classifyFailure(new Error('network')), 'TEMPORARY');
  });

  it('only the person\'s own connections: a colleague and another organisation see nothing', async () => {
    assert.deepEqual(await upcoming('host'), { connected: false, providers: [], items: [] });
    assert.deepEqual(await upcoming('other'), { connected: false, providers: [], items: [] });
    // RLS: without a tenant context the connections are invisible to the app role.
    const appPool = new pg.Pool({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433), database: process.env.PGDATABASE || 'hrvo_dev', user: process.env.PGUSER || 'hrvo_app', password: process.env.PGPASSWORD || 'hrvo_app' });
    try {
      assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM calendar_connections`)).rows[0].n, 0);
    } finally {
      await appPool.end();
    }
    assert.deepEqual(await attendanceRows(), { s: 0, g: 0 });
  });
});
