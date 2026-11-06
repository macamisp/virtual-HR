/**
 * Google Calendar and Microsoft Graph adapters (FR-MEET-006; ADR 023), plain fetch (no SDK).
 * Base URLs can be pointed at local fakes for tests; production refuses overrides. Tokens and
 * event content are never logged.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CalendarProvider, UpcomingResponse } from '../../../../packages/shared/src/calendar/types.ts';

export interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: Date; accountEmail: string | null }
export interface CalendarEvent {
  uid: string; // `${meetingId}@hrvo`, stable across updates
  sequence: number;
  title: string;
  description: string;
  start: Date;
  end: Date;
  organizerEmail: string;
  selfEmail: string;
  joinUrl: string;
}
export type ExternalResponse = 'ACCEPTED' | 'DECLINED' | 'NEEDS_ACTION';
export interface Busy { start: Date; end: Date }
/** One event of the person's own calendar, read on demand for FR-WT-022 (never stored or logged). */
export interface UpcomingEvent {
  id: string;
  title: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  /** iCal UID (Google iCalUID; Graph iCalUId or our transactionId), to recognise our meetings. */
  uids: string[];
  response: UpcomingResponse | null;
  /** Candidate links in order of preference; the service keeps the first https one. */
  links: Array<string | null | undefined>;
}

export interface ProviderAdapter {
  readonly provider: CalendarProvider;
  readonly configured: boolean;
  authorizeUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, verifier: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  /** Create or update our meeting in the person's calendar; returns the external id. */
  upsert(accessToken: string, externalId: string | null, e: CalendarEvent): Promise<string>;
  remove(accessToken: string, externalId: string): Promise<void>;
  /** The person's response as seen in their calendar; null = the event is gone. */
  response(accessToken: string, externalId: string, selfEmail: string): Promise<ExternalResponse | null>;
  busy(accessToken: string, from: Date, to: Date): Promise<Busy[]>;
  /** The person's events between from and to (at most 50, ordered by start, no deleted ones). */
  upcoming(accessToken: string, from: Date, to: Date): Promise<UpcomingEvent[]>;
  /** Best effort: tell the provider we no longer hold the grant. */
  revoke(token: string): Promise<void>;
}

/**
 * `stage` says whether the token endpoint or the calendar API refused; `reason` is the provider's
 * machine-readable error code only (e.g. `invalid_grant`, `rateLimitExceeded`), never its body.
 */
export class ProviderError extends Error {
  constructor(readonly status: number, message: string, readonly stage: 'token' | 'api' = 'api', readonly reason: string | null = null) {
    super(message);
    this.name = 'ProviderError';
  }
}

const RATE_LIMIT_REASONS = new Set(['ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded', 'rate_limit_exceeded']);

/**
 * D6 (ADR 049 §6): only a refused refresh (`invalid_grant`) or a 401 from the API after a fresh
 * token means the person must connect again. 429 and 403 rate-limit reasons are temporary.
 */
export type ProviderFailure = 'RECONNECT' | 'RATE_LIMITED' | 'TEMPORARY';
export function classifyFailure(err: unknown): ProviderFailure {
  if (!(err instanceof ProviderError)) return 'TEMPORARY';
  if (err.stage === 'token') return err.reason === 'invalid_grant' ? 'RECONNECT' : 'TEMPORARY';
  if (err.status === 401) return 'RECONNECT';
  if (err.status === 429) return 'RATE_LIMITED';
  if (err.status === 403 && err.reason && RATE_LIMIT_REASONS.has(err.reason.toLowerCase())) return 'RATE_LIMITED';
  return 'TEMPORARY';
}
export const FAILURE_MESSAGE: Record<ProviderFailure, string> = {
  RECONNECT: 'Access was revoked or expired. Connect the calendar again.',
  RATE_LIMITED: 'Calendar provider is rate limiting; will retry.',
  TEMPORARY: 'Sync failed; it will be retried.',
};

/** Keeps only an error code from a provider error body (Google, Graph or OAuth shape). */
function errorReason(body: unknown): string | null {
  const code = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_]{1,64}$/.test(v) ? v : null);
  if (!body || typeof body !== 'object') return null;
  const e = (body as { error?: unknown }).error;
  if (typeof e === 'string') return code(e);
  if (!e || typeof e !== 'object') return null;
  const o = e as { errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }>; code?: unknown };
  for (const x of [...(Array.isArray(o.errors) ? o.errors : []), ...(Array.isArray(o.details) ? o.details : [])]) {
    const r = code(x?.reason);
    if (r) return r;
  }
  return code(o.code);
}

/** Only https links leave the API (no javascript:, data: or plain http). */
export function httpsOnly(u: string | null | undefined): string | null {
  if (typeof u !== 'string' || u.length > 2048) return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

type Env = Record<string, string | undefined>;

/** Overrides of provider URLs exist for tests only. */
function base(env: Env, name: string, fallback: string): string {
  const v = env[name];
  if (v && env.NODE_ENV === 'production') throw new Error(`${name} must not be overridden in production`);
  return (v || fallback).replace(/\/$/, '');
}

async function json<T>(res: Response, what: string, stage: 'token' | 'api' = 'api'): Promise<T> {
  if (!res.ok) {
    // Only the status reaches logs and the UI; provider bodies can echo tokens or event data, so
    // nothing but an error code is kept from them.
    const reason = [400, 401, 403, 429].includes(res.status) ? errorReason(await res.json().catch(() => null)) : null;
    throw new ProviderError(res.status, `${what} failed (${res.status})`, stage, reason);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15_000) });
const authed = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(15_000) });

/** The email claim of an ID token received directly from the provider's token endpoint over TLS. */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown; preferred_username?: unknown };
    const e = typeof payload.email === 'string' ? payload.email : typeof payload.preferred_username === 'string' ? payload.preferred_username : null;
    return e && e.includes('@') ? e.slice(0, 320) : null;
  } catch {
    return null;
  }
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string }
const toTokens = (t: TokenResponse, previousRefresh: string | null = null): Tokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token ?? previousRefresh,
  expiresAt: new Date(Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000),
  accountEmail: emailFromIdToken(t.id_token),
});

// ------------------------------------------------------------------ Google

interface GoogleEvent {
  id?: unknown; status?: string; eventType?: string; summary?: unknown; iCalUID?: unknown; htmlLink?: string; hangoutLink?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly provider = 'GOOGLE' as const;
  private readonly auth: string;
  private readonly token: string;
  private readonly api: string;
  private readonly revokeUrl: string;
  constructor(private readonly env: Env, private readonly redirectUri: string) {
    this.auth = base(env, 'GOOGLE_OAUTH_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');
    this.token = base(env, 'GOOGLE_OAUTH_TOKEN_URL', 'https://oauth2.googleapis.com/token');
    this.api = base(env, 'GOOGLE_CALENDAR_API', 'https://www.googleapis.com/calendar/v3');
    this.revokeUrl = base(env, 'GOOGLE_OAUTH_REVOKE_URL', 'https://oauth2.googleapis.com/revoke');
  }
  get configured(): boolean { return !!(this.env.GOOGLE_OAUTH_CLIENT_ID && this.env.GOOGLE_OAUTH_CLIENT_SECRET); }

  authorizeUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.env.GOOGLE_OAUTH_CLIENT_ID!, redirect_uri: this.redirectUri, response_type: 'code', state,
      // Events on the person's calendars, their free/busy, and who they are.
      scope: 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy',
      access_type: 'offline', prompt: 'consent', code_challenge: codeChallenge, code_challenge_method: 'S256',
    });
    return `${this.auth}?${q.toString()}`;
  }

  async exchangeCode(code: string, verifier: string): Promise<Tokens> {
    return toTokens(await json<TokenResponse>(await fetch(this.token, form({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.redirectUri,
      client_id: this.env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    })), 'Google token exchange', 'token'));
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    return toTokens(await json<TokenResponse>(await fetch(this.token, form({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    })), 'Google token refresh', 'token'), refreshToken);
  }

  /** events.import keeps our iCalUID, with the host as organizer: the person can RSVP in Google, and no e-mails are sent. */
  async upsert(token: string, externalId: string | null, e: CalendarEvent): Promise<string> {
    const body = {
      iCalUID: e.uid, sequence: e.sequence, summary: e.title, description: `${e.description}\n\nJoin: ${e.joinUrl}`.trim(),
      start: { dateTime: e.start.toISOString() }, end: { dateTime: e.end.toISOString() },
      organizer: { email: e.organizerEmail }, attendees: [{ email: e.selfEmail, self: true, responseStatus: 'needsAction' }],
      source: { title: 'HR Virtual Office', url: e.joinUrl }, guestsCanModify: false,
    };
    if (externalId) {
      // Keep the person's own response when updating.
      const { attendees: _a, ...rest } = body;
      await json(await fetch(`${this.api}/calendars/primary/events/${encodeURIComponent(externalId)}?sendUpdates=none`, authed(token, { method: 'PATCH', body: JSON.stringify(rest) })), 'Google event update');
      return externalId;
    }
    const r = await json<{ id: string }>(await fetch(`${this.api}/calendars/primary/events/import`, authed(token, { method: 'POST', body: JSON.stringify(body) })), 'Google event import');
    return r.id;
  }

  async remove(token: string, externalId: string): Promise<void> {
    const res = await fetch(`${this.api}/calendars/primary/events/${encodeURIComponent(externalId)}?sendUpdates=none`, authed(token, { method: 'DELETE' }));
    if (res.status === 404 || res.status === 410) return;
    await json(res, 'Google event delete');
  }

  async response(token: string, externalId: string, selfEmail: string): Promise<ExternalResponse | null> {
    const res = await fetch(`${this.api}/calendars/primary/events/${encodeURIComponent(externalId)}`, authed(token));
    if (res.status === 404 || res.status === 410) return null;
    const ev = await json<{ status?: string; attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }> }>(res, 'Google event read');
    if (ev.status === 'cancelled') return null;
    const me = ev.attendees?.find((a) => a.self || a.email?.toLowerCase() === selfEmail.toLowerCase());
    return me?.responseStatus === 'accepted' ? 'ACCEPTED' : me?.responseStatus === 'declined' ? 'DECLINED' : 'NEEDS_ACTION';
  }

  async busy(token: string, from: Date, to: Date): Promise<Busy[]> {
    const r = await json<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> }>(await fetch(`${this.api}/freeBusy`, authed(token, {
      method: 'POST', body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] }),
    })), 'Google free/busy');
    return (r.calendars?.primary?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async upcoming(token: string, from: Date, to: Date): Promise<UpcomingEvent[]> {
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50', showDeleted: 'false' });
    const r = await json<{ items?: GoogleEvent[] }>(await fetch(`${this.api}/calendars/primary/events?${q.toString()}`, authed(token)), 'Google events list');
    const out: UpcomingEvent[] = [];
    for (const e of r.items ?? []) {
      if (typeof e.id !== 'string' || e.status === 'cancelled' || e.eventType === 'workingLocation') continue;
      const allDay = !e.start?.dateTime && !!e.start?.date;
      const start = new Date(allDay ? `${e.start?.date}T00:00:00Z` : e.start?.dateTime ?? '');
      const end = new Date(allDay ? `${e.end?.date ?? e.start?.date}T00:00:00Z` : e.end?.dateTime ?? '');
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const self = e.attendees?.find((a) => a.self)?.responseStatus;
      const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
      out.push({
        id: e.id, title: typeof e.summary === 'string' ? e.summary : null, start, end, allDay,
        uids: typeof e.iCalUID === 'string' ? [e.iCalUID] : [],
        response: self === 'accepted' ? 'ACCEPTED' : self === 'declined' ? 'DECLINED' : self === 'tentative' ? 'TENTATIVE' : self === 'needsAction' ? 'NEEDS_ACTION' : null,
        links: [e.hangoutLink, video, ...(e.conferenceData?.entryPoints ?? []).map((p) => p.uri), e.htmlLink],
      });
    }
    return out;
  }

  async revoke(token: string): Promise<void> {
    await fetch(this.revokeUrl, form({ token })).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ Microsoft Graph

interface GraphEvent {
  id?: unknown; subject?: unknown; isAllDay?: boolean; isCancelled?: boolean; iCalUId?: unknown; transactionId?: unknown; webLink?: string;
  start?: { dateTime?: string }; end?: { dateTime?: string };
  responseStatus?: { response?: string }; onlineMeeting?: { joinUrl?: string } | null;
}

export class MicrosoftAdapter implements ProviderAdapter {
  readonly provider = 'MICROSOFT' as const;
  private readonly login: string;
  private readonly graph: string;
  constructor(private readonly env: Env, private readonly redirectUri: string) {
    const tenant = env.MICROSOFT_OAUTH_TENANT || 'common';
    this.login = base(env, 'MICROSOFT_LOGIN_URL', `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`);
    this.graph = base(env, 'MICROSOFT_GRAPH_API', 'https://graph.microsoft.com/v1.0');
  }
  get configured(): boolean { return !!(this.env.MICROSOFT_OAUTH_CLIENT_ID && this.env.MICROSOFT_OAUTH_CLIENT_SECRET); }

  authorizeUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.env.MICROSOFT_OAUTH_CLIENT_ID!, redirect_uri: this.redirectUri, response_type: 'code', response_mode: 'query', state,
      scope: 'openid email offline_access Calendars.ReadWrite', code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return `${this.login}/authorize?${q.toString()}`;
  }

  private tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    return fetch(`${this.login}/token`, form({ ...body, client_id: this.env.MICROSOFT_OAUTH_CLIENT_ID!, client_secret: this.env.MICROSOFT_OAUTH_CLIENT_SECRET!, scope: 'openid email offline_access Calendars.ReadWrite' }))
      .then((r) => json<TokenResponse>(r, 'Microsoft token request', 'token'));
  }

  async exchangeCode(code: string, verifier: string): Promise<Tokens> {
    return toTokens(await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.redirectUri }));
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    return toTokens(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }), refreshToken);
  }

  /**
   * An event in the person's calendar without attendees (Graph would e-mail invitations otherwise);
   * transactionId makes a retried create idempotent.
   */
  async upsert(token: string, externalId: string | null, e: CalendarEvent): Promise<string> {
    const body = {
      subject: e.title, body: { contentType: 'text', content: `${e.description}\n\nJoin: ${e.joinUrl}\nOrganised by ${e.organizerEmail} in HR Virtual Office.`.trim() },
      start: { dateTime: e.start.toISOString().replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: e.end.toISOString().replace('Z', ''), timeZone: 'UTC' },
      location: { displayName: 'HR Virtual Office' }, showAs: 'busy', isReminderOn: true,
    };
    if (externalId) {
      await json(await fetch(`${this.graph}/me/events/${encodeURIComponent(externalId)}`, authed(token, { method: 'PATCH', body: JSON.stringify(body) })), 'Microsoft event update');
      return externalId;
    }
    const r = await json<{ id: string }>(await fetch(`${this.graph}/me/events`, authed(token, { method: 'POST', body: JSON.stringify({ ...body, transactionId: e.uid }) })), 'Microsoft event create');
    return r.id;
  }

  async remove(token: string, externalId: string): Promise<void> {
    const res = await fetch(`${this.graph}/me/events/${encodeURIComponent(externalId)}`, authed(token, { method: 'DELETE' }));
    if (res.status === 404) return;
    await json(res, 'Microsoft event delete');
  }

  /** Graph shows no response on the person's own copy: removing or cancelling it counts as declining. */
  async response(token: string, externalId: string): Promise<ExternalResponse | null> {
    const res = await fetch(`${this.graph}/me/events/${encodeURIComponent(externalId)}?$select=isCancelled,showAs`, authed(token));
    if (res.status === 404) return null;
    const ev = await json<{ isCancelled?: boolean; showAs?: string }>(res, 'Microsoft event read');
    return ev.isCancelled ? null : ev.showAs === 'free' ? 'DECLINED' : 'NEEDS_ACTION';
  }

  async busy(token: string, from: Date, to: Date): Promise<Busy[]> {
    const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $select: 'start,end,showAs,isCancelled', $top: '200' });
    const r = await json<{ value?: Array<{ start: { dateTime: string }; end: { dateTime: string }; showAs?: string; isCancelled?: boolean }> }>(
      await fetch(`${this.graph}/me/calendarView?${q.toString()}`, authed(token, { headers: { Prefer: 'outlook.timezone="UTC"' } })), 'Microsoft calendar view');
    return (r.value ?? []).filter((v) => !v.isCancelled && v.showAs !== 'free')
      .map((v) => ({ start: new Date(`${v.start.dateTime.replace(/Z$/, '')}Z`), end: new Date(`${v.end.dateTime.replace(/Z$/, '')}Z`) }));
  }

  async upcoming(token: string, from: Date, to: Date): Promise<UpcomingEvent[]> {
    const q = new URLSearchParams({
      startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '50', $orderby: 'start/dateTime',
      $select: 'id,subject,start,end,isAllDay,isCancelled,iCalUId,transactionId,responseStatus,onlineMeeting,webLink',
    });
    const r = await json<{ value?: GraphEvent[] }>(
      await fetch(`${this.graph}/me/calendarView?${q.toString()}`, authed(token, { headers: { Prefer: 'outlook.timezone="UTC"' } })), 'Microsoft calendar view');
    const utc = (d: string | undefined) => new Date(`${(d ?? '').replace(/Z$/, '')}Z`);
    const out: UpcomingEvent[] = [];
    for (const e of r.value ?? []) {
      if (typeof e.id !== 'string' || e.isCancelled) continue;
      const start = utc(e.start?.dateTime);
      const end = utc(e.end?.dateTime);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const a = e.responseStatus?.response;
      out.push({
        id: e.id, title: typeof e.subject === 'string' ? e.subject : null, start, end, allDay: e.isAllDay === true,
        uids: [e.iCalUId, e.transactionId].filter((u): u is string => typeof u === 'string'),
        response: a === 'accepted' ? 'ACCEPTED' : a === 'declined' ? 'DECLINED' : a === 'tentativelyAccepted' ? 'TENTATIVE' : a === 'notResponded' ? 'NEEDS_ACTION' : null,
        links: [e.onlineMeeting?.joinUrl, e.webLink],
      });
    }
    return out;
  }

  async revoke(): Promise<void> {
    // Graph has no per-grant revoke endpoint; the person removes the app in their account settings.
  }
}

export function adaptersFromEnv(env: Env = process.env): Record<CalendarProvider, ProviderAdapter> {
  const redirect = env.CALENDAR_OAUTH_REDIRECT_URL || `${(env.API_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '')}/calendar/oauth/callback`;
  return { GOOGLE: new GoogleAdapter(env, redirect), MICROSOFT: new MicrosoftAdapter(env, redirect) };
}
