/**
 * Google Calendar and Microsoft Graph adapters (FR-MEET-006; ADR 023), plain fetch (no SDK).
 * Base URLs can be pointed at local fakes for tests; production refuses overrides. Tokens and
 * event content are never logged.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CalendarProvider } from '../../../../packages/shared/src/calendar/types.ts';

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
  /** Best effort: tell the provider we no longer hold the grant. */
  revoke(token: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ProviderError'; }
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

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    // Only the status reaches logs and the UI; provider bodies can echo tokens or event data.
    throw new ProviderError(res.status, `${what} failed (${res.status})`);
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
    })), 'Google token exchange'));
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    return toTokens(await json<TokenResponse>(await fetch(this.token, form({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    })), 'Google token refresh'), refreshToken);
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

  async revoke(token: string): Promise<void> {
    await fetch(this.revokeUrl, form({ token })).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ Microsoft Graph

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
      .then((r) => json<TokenResponse>(r, 'Microsoft token request'));
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

  async revoke(): Promise<void> {
    // Graph has no per-grant revoke endpoint; the person removes the app in their account settings.
  }
}

export function adaptersFromEnv(env: Env = process.env): Record<CalendarProvider, ProviderAdapter> {
  const redirect = env.CALENDAR_OAUTH_REDIRECT_URL || `${(env.API_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, '')}/calendar/oauth/callback`;
  return { GOOGLE: new GoogleAdapter(env, redirect), MICROSOFT: new MicrosoftAdapter(env, redirect) };
}
