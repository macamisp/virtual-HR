import { replayAttendanceInputs, type AttendanceInput } from './attendance-replay.ts';
/** FR-ATT-021: a session the server closed itself (timeout, lost connection, maximum length). */
/** NFR-ACC-004: one field of one person's day that does not recompute to its stored value. */
export interface ReplayMismatch { userId: string; field: string; stored: string | number | null; recomputed: string | number | null }
export interface AutoClosed { userId: string; sessionId: string; source: string; clockOutAt: Date; workDate: string }

/**
 * HRVO Attendance Engine Service
 * Implements FR-ATT-001 through FR-ATT-010, Section 6.2, 6.3, and 6.6
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { AttendanceStateMachine, InvalidTransitionError } from './attendance-state-machine.ts';
import { HeartbeatValidator } from './heartbeat-validator.ts';
import type { IAttendanceRepository } from './attendance-repository.ts';
import { Permission, userCan } from '../../../../packages/shared/src/auth/types.ts';
import type {
  MyToday,
  MyDay,
  CorrectionQueueItem,
  ConsentStatus,
  TimeTotals,
} from '../../../../packages/shared/src/attendance/api.ts';
import { planOfflineSync } from '../agent/offline-sync.ts';
import type { FlagSink, NewFlag } from './attendance-flags.service.ts';
import type { OfflineInterval, OfflinePlan } from '../agent/offline-sync.ts';
import {
  AttendanceState,
  ClockInSource,
  ClockOutSource,
  SessionStatus,
  DEFAULT_ATTENDANCE_CONFIG,
  SystemClock,
  UserRole,
  CorrectionStatus,
  DayStatus,
  LivePresenceStatus,
} from '../../../../packages/shared/src/attendance/types.ts';
import type {
  AttendanceConfig,
  AttendanceSession,
  Clock,
  HeartbeatPayload,
  HeartbeatSource,
  StateMachineTransitionResult,
  AttendanceCorrection,
  ScheduleComplianceResult,
  AttendanceDaily,
  LiveBoardUser,
  AttendanceExportFilter,
  TransparencyInfo,
  MonitoringConsent,
  IHolidayProvider,
  ILeaveProvider,
} from '../../../../packages/shared/src/attendance/types.ts';
export function sanitizeExportCell<T>(val: T): T | string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return val;
}

function isRepository(value: unknown): value is IAttendanceRepository {
  return !!value && typeof (value as Partial<IAttendanceRepository>).findOpenSessionByUserId === 'function';
}

export class AttendanceService {
  private stateMachine: AttendanceStateMachine;
  private validator: HeartbeatValidator;
  private config: AttendanceConfig;
  private clock: Clock;
  private repository?: IAttendanceRepository;
  private defaultOrgId?: string;
  private holidayProvider?: IHolidayProvider;
  private leaveProvider?: ILeaveProvider;

  // In-memory fallback stores (used when repository is not provided)
  private sessions = new Map<string, AttendanceSession>();
  private closedSessions = new Map<string, AttendanceSession>();
  private sessionSecrets = new Map<string, string>();
  private sessionSecretOrgs = new Map<string, string>();
  private inMemoryConsents = new Map<string, Set<string>>();
  // Per-user mutation queue: every read-modify-write of a user's open session runs in order,
  // so a slow disconnect cannot overwrite a newer heartbeat (lost update). Single-instance only;
  // horizontal scaling needs a shared lock (ADR 006).
  private sessionLocks = new Map<string, Promise<void>>();
  // FR-ADM-001: per-organisation attendance policy (SRS 6.4), cached for 30 s per org.
  private policyProvider?: (orgId: string) => Promise<Partial<AttendanceConfig> | null>;
  private policyCache = new Map<string, { at: number; config: AttendanceConfig; machine: AttendanceStateMachine }>();
  private static readonly POLICY_TTL_MS = 30_000;

  /**
   * Two call shapes are supported (kept for existing callers):
   *  - (config, clock, repository?, defaultOrgId?, holidayProvider?, leaveProvider?)
   *  - (repository, clock?, clock?, holidayProvider?, leaveProvider?)
   */
  constructor(
    configOrRepo?: Partial<AttendanceConfig> | IAttendanceRepository,
    clockOrUndefined?: Clock,
    repoOrClock?: IAttendanceRepository | Clock,
    defaultOrgIdOrHoliday?: string | IHolidayProvider,
    holidayOrLeave?: IHolidayProvider | ILeaveProvider,
    leaveProvider?: ILeaveProvider,
  ) {
    if (isRepository(configOrRepo)) {
      this.repository = configOrRepo;
      this.config = { ...DEFAULT_ATTENDANCE_CONFIG };
      this.clock = (repoOrClock as Clock | undefined) || clockOrUndefined || new SystemClock();
      this.holidayProvider = defaultOrgIdOrHoliday as IHolidayProvider | undefined;
      this.leaveProvider = holidayOrLeave as ILeaveProvider | undefined;
    } else {
      this.config = { ...DEFAULT_ATTENDANCE_CONFIG, ...(configOrRepo ?? {}) };
      this.clock = clockOrUndefined || new SystemClock();
      this.repository = repoOrClock as IAttendanceRepository | undefined;
      this.defaultOrgId = defaultOrgIdOrHoliday as string | undefined;
      this.holidayProvider = holidayOrLeave as IHolidayProvider | undefined;
      this.leaveProvider = leaveProvider;
    }
    this.stateMachine = new AttendanceStateMachine(this.config);
    this.validator = new HeartbeatValidator(300_000, this.clock);
  }

  /** FR-ADM-001: where each organisation's thresholds come from (the org settings table). */
  private flagSink: FlagSink | null = null;
  private lockProvider: { run<T>(name: string, fn: () => Promise<T>): Promise<T> } | null = null;

  /** ADR 020: a lock shared by API tasks (RedisLock); without it, the in-process queue alone. */
  public setLockProvider(lock: { run<T>(name: string, fn: () => Promise<T>): Promise<T> }): void {
    this.lockProvider = lock;
  }

  /** ADR 019: where review flags go (AttendanceFlagsService). Flags never change recorded time. */
  public setFlagSink(sink: FlagSink): void {
    this.flagSink = sink;
  }

  /** The organisation's time zone (work dates of flags). */
  public async timeZoneOf(orgId: string): Promise<string> {
    return (await this.policy(orgId)).config.orgTimezone;
  }

  /** A failing flag store must never break attendance itself. */
  private async raiseFlag(f: NewFlag): Promise<void> {
    try { await this.flagSink?.raise(f); } catch (err) { console.error('raising a review flag failed', err instanceof Error ? err.message : 'unknown error'); }
  }

  public setPolicyProvider(provider: (orgId: string) => Promise<Partial<AttendanceConfig> | null>): void {
    this.policyProvider = provider;
    this.policyCache.clear();
  }

  /** Called after an admin changes the policy, so the next evaluation uses it. */
  public invalidatePolicy(orgId: string): void {
    this.policyCache.delete(orgId);
  }

  /** The organisation's config and a state machine built from it. */
  private async policy(orgId: string | undefined): Promise<{ config: AttendanceConfig; machine: AttendanceStateMachine }> {
    if (!orgId || !this.policyProvider) return { config: this.config, machine: this.stateMachine };
    const now = Date.now();
    const hit = this.policyCache.get(orgId);
    if (hit && now - hit.at < AttendanceService.POLICY_TTL_MS) return hit;
    const overrides = (await this.policyProvider(orgId)) ?? {};
    const config = { ...this.config, ...overrides };
    const entry = { at: now, config, machine: new AttendanceStateMachine(config) };
    this.policyCache.set(orgId, entry);
    return entry;
  }

  private async withSessionLock<T>(orgId: string | undefined, userId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${orgId ?? ''}:${userId}`;
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.sessionLocks.set(key, tail);
    await previous;
    try {
      // ADR 020: across API tasks as well (heartbeats, breaks, corrections and the reconciler).
      return this.lockProvider ? await this.lockProvider.run(`attendance:${key}`, fn) : await fn();
    } finally {
      release();
      if (this.sessionLocks.get(key) === tail) this.sessionLocks.delete(key);
    }
  }

  private async saveWithInput(session: AttendanceSession, at: Date, input: AttendanceInput): Promise<void> {
    if (!this.repository) return;
    const { config } = await this.policy(session.orgId);
    await this.repository.saveSession(session, { sessionId: session.id, orgId: session.orgId, userId: session.userId, at, config, input });
  }

  /**
   * Cryptographically generate a random per-session HMAC secret
   */
  public generateSessionSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Register HMAC secret for a specific login/attendance session
   */
  public async registerSessionSecret(
    sessionId: string,
    secret: string,
    orgId?: string,
  ): Promise<void> {
    const targetOrgId = orgId || this.defaultOrgId;
    this.sessionSecrets.set(sessionId, secret);
    if (targetOrgId) {
      this.sessionSecretOrgs.set(sessionId, targetOrgId);
    }
    if (this.repository && targetOrgId) {
      await this.repository.saveSessionSecret(targetOrgId, sessionId, secret);
    }
  }

  /**
   * Revoke HMAC secret when a session terminates
   */
  public async revokeSessionSecret(sessionId: string, orgId?: string): Promise<void> {
    const targetOrgId = orgId || this.sessionSecretOrgs.get(sessionId) || this.defaultOrgId;
    this.sessionSecrets.delete(sessionId);
    this.sessionSecretOrgs.delete(sessionId);
    if (this.repository && targetOrgId) {
      await this.repository.revokeSessionSecret(targetOrgId, sessionId);
    }
  }

  public async getSessionSecret(sessionId: string, orgId?: string): Promise<string | undefined> {
    const mem = this.sessionSecrets.get(sessionId);
    if (mem) return mem;
    const targetOrgId = orgId || this.sessionSecretOrgs.get(sessionId) || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      const dbSecret = await this.repository.findSessionSecret(targetOrgId, sessionId);
      if (dbSecret) {
        this.sessionSecrets.set(sessionId, dbSecret);
        this.sessionSecretOrgs.set(sessionId, targetOrgId);
        return dbSecret;
      }
    }
    return undefined;
  }

  public getValidator(): HeartbeatValidator {
    return this.validator;
  }

  public getStateMachine(): AttendanceStateMachine {
    return this.stateMachine;
  }

  public getClock(): Clock {
    return this.clock;
  }

  public async getSession(userId: string, orgId?: string): Promise<AttendanceSession | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      return await this.repository.findOpenSessionByUserId(targetOrgId, userId);
    }
    return this.sessions.get(userId) ?? null;
  }

  public async getAllOpenSessions(orgId?: string): Promise<AttendanceSession[]> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository) {
      if (!targetOrgId) {
        throw new Error('Tenant context missing: orgId must be provided to query open sessions');
      }
      return await this.repository.findAllOpenSessions(targetOrgId);
    }
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === SessionStatus.OPEN && (!targetOrgId || s.orgId === targetOrgId),
    );
  }

  public async getClosedSession(
    sessionId: string,
    orgId?: string,
  ): Promise<AttendanceSession | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      return await this.repository.findSessionById(targetOrgId, sessionId);
    }
    return this.closedSessions.get(sessionId) ?? null;
  }

  /**
   * FR-ATT-001 & FR-ATT-004: Ingest client heartbeat
   */
  public async ingestHeartbeat(
    payload: HeartbeatPayload,
    serverTime: Date = this.clock.now(),
    ip: string = '127.0.0.1',
    source: HeartbeatSource = 'WEB',
    /** FR-ATT-018: ISO country from a trusted proxy header (Cloudflare), or null. */
    country: string | null = null,
  ): Promise<StateMachineTransitionResult> {
    // Secret must be strictly bound to payload.sessionId & payload.orgId (per-session secret)
    const secret = await this.getSessionSecret(payload.sessionId, payload.orgId);
    if (!secret) {
      throw new Error(
        `Unauthorized: No active session secret registered for session ${payload.sessionId}`,
      );
    }

    // Cryptographic signature and anti-replay verification
    const validation = await this.validator.validateAsync(
      payload,
      secret,
      serverTime,
      this.repository,
    );
    if (!validation.valid) {
      throw new Error(`Heartbeat rejected: ${validation.reason}`);
    }
    // ADR 025: a valid heartbeat proves this login is live (used when another login logs out).
    if (this.repository) await this.repository.touchSessionSecret(payload.orgId, payload.sessionId, serverTime);

    return await this.withSessionLock(payload.orgId, payload.userId, async () => {
      // Ingest into state machine
      let existingSession: AttendanceSession | null = null;
      if (this.repository) {
        existingSession = await this.repository.findOpenSessionByUserId(
          payload.orgId,
          payload.userId,
        );
      } else {
        existingSession = this.sessions.get(payload.userId) ?? null;
      }

      // FR-AUD-004 / FR-ATT-020 Consent Gate:
      // A user who has not accepted the current monitoring-notice version must not get a session created by heartbeats.
      if (!existingSession) {
        const currentVersion = this.config.currentNoticeVersion ?? 'v1.0.0';
        const hasConsent = await this.hasUserAcceptedNotice(payload.orgId, payload.userId, currentVersion);
        if (!hasConsent) {
          throw new Error(`CONSENT_REQUIRED: User has not accepted current monitoring notice (${currentVersion})`);
        }
      }

      // Section 6.2: DISCONNECTED -> reconnect within grace -> previous state. A valid, signed
      // heartbeat proves the client is connected again (covers socket reconnects and new tabs).
      if (existingSession && existingSession.currentState === AttendanceState.DISCONNECTED) {
        existingSession = (await this.policy(payload.orgId)).machine.handleSocketReconnect(existingSession, serverTime).session;
      }

      // The machine copies the session shallowly (flags are shared), so note this before it runs.
      const hadMultiDevice = !!existingSession?.flags.includes('MULTI_DEVICE');
      const result = (await this.policy(payload.orgId)).machine.handleHeartbeat(
        existingSession,
        payload,
        serverTime,
        ip,
        source,
      );
      if (!existingSession || existingSession.id !== result.session.id) result.session.countryIn = country;
      if (country) result.session.countryOut = country;

      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'heartbeat', deviceId: payload.deviceId,
          activeSeconds: payload.activeSeconds, idleSeconds: payload.idleSeconds, inCall: payload.inCall,
          tabVisible: payload.tabVisible, windowFocused: payload.windowFocused, source });
        // FR-ATT-020: raw event the user can inspect. Counters only, never content.
        await this.repository.recordPresenceEvent({
          orgId: payload.orgId,
          userId: payload.userId,
          sessionId: result.session.id,
          serverTs: serverTime,
          eventType: 'HEARTBEAT',
          state: result.currentState,
          seq: payload.sequenceNumber,
          ip,
          meta: {
            activeSeconds: payload.activeSeconds,
            idleSeconds: payload.idleSeconds,
            tabVisible: payload.tabVisible,
            windowFocused: payload.windowFocused,
            inCall: payload.inCall,
            source,
          },
        });
      }
      this.sessions.set(payload.userId, result.session);

      // FR-ATT-017/018: review flags. Never affect the heartbeat or the recorded time.
      const r = result.session;
      if (r.flags.includes('MULTI_DEVICE') && !hadMultiDevice) {
        await this.raiseFlag({ orgId: r.orgId, userId: r.userId, sessionId: r.id, workDate: r.workDate, kind: 'MULTI_DEVICE', details: { devices: [existingSession?.deviceId, payload.deviceId].filter(Boolean) }, dedupeKey: `dev:${r.id}` });
      }
      try {
        const cfg = (await this.policy(payload.orgId)).config;
        await this.flagSink?.observe({ orgId: r.orgId, userId: r.userId, sessionId: r.id, workDate: r.workDate, ip, country, at: serverTime,
          policy: { allowedCidrs: cfg.allowedCidrs ?? [], allowedCountries: cfg.allowedCountries ?? [] } });
      } catch (err) {
        console.error('network checks failed', err instanceof Error ? err.message : 'unknown error');
      }

      return result;
    });
  }

  /** FR-ATT-023: "Yes, I am still working" within the window (server clock). */
  public async answerChallenge(orgId: string, userId: string, challengeId: string, serverTime: Date = this.clock.now()): Promise<StateMachineTransitionResult> {
    return await this.withSessionLock(orgId, userId, async () => {
      const session = await this.getSession(userId, orgId);
      if (!session || session.status !== SessionStatus.OPEN) throw new InvalidTransitionError(AttendanceState.OFFLINE, 'answer the presence challenge');
      const result = (await this.policy(orgId)).machine.handleChallengeResponse(session, challengeId, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'challenge-confirmed' });
        await this.repository.recordPresenceEvent({ orgId, userId, sessionId: result.session.id, serverTs: serverTime, eventType: 'PRESENCE_CONFIRMED', state: result.currentState, seq: 0 });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * FR-ATT-012 (ADR 018): turn a verified offline buffer into closed sessions flagged
   * OFFLINE_SYNCED. Runs under the user's session lock so it cannot race live heartbeats; only
   * time the server did not already account for is accepted.
   */
  public async applyOfflineSync(p: {
    orgId: string;
    userId: string;
    deviceId: string;
    anchorServerMs: number;
    intervals: OfflineInterval[];
    ip: string;
    maxWindowSeconds?: number;
  }): Promise<{ plan: OfflinePlan; sessionIds: string[] }> {
    const repo = this.repository;
    if (!repo) throw new Error('Repository is required for applyOfflineSync');
    return await this.withSessionLock(p.orgId, p.userId, async () => {
      const now = this.clock.now();
      const { config } = await this.policy(p.orgId);
      const covered = await repo.findCoveredSpans(p.orgId, p.userId, new Date(p.anchorServerMs - 60_000), now);
      const plan = planOfflineSync({
        anchorServerMs: p.anchorServerMs, intervals: p.intervals, nowMs: now.getTime(), covered,
        maxWindowSeconds: p.maxWindowSeconds ?? 12 * 3600, timeZone: config.orgTimezone,
      });
      const sessionIds: string[] = [];
      const dates = new Set<string>();
      for (const planned of plan.sessions) {
        const session: AttendanceSession = {
          id: randomUUID(), orgId: p.orgId, userId: p.userId, deviceId: p.deviceId, workDate: planned.workDate,
          clockInAt: planned.start, clockOutAt: planned.end,
          clockInSource: ClockInSource.OFFLINE_SYNC, clockOutSource: ClockOutSource.OFFLINE_SYNC,
          activeSeconds: planned.activeSeconds, idleSeconds: planned.idleSeconds, breakSeconds: 0, meetingSeconds: 0,
          netSeconds: planned.activeSeconds, lastHeartbeatAt: planned.end, ipIn: p.ip, ipOut: p.ip,
          flags: ['OFFLINE_SYNCED'], status: SessionStatus.CLOSED, currentState: AttendanceState.OFFLINE,
          segments: planned.segments.map((g) => ({
            id: randomUUID(), state: g.state === 'ACTIVE' ? AttendanceState.ACTIVE : AttendanceState.IDLE,
            startedAt: g.start, endedAt: g.end, durationSeconds: Math.round((g.end.getTime() - g.start.getTime()) / 1000), flags: ['OFFLINE_SYNCED'],
          })),
          consecutiveIdleSeconds: 0, agentDeviceId: p.deviceId, agentLastSeenAt: null, webInCallAt: null,
        };
        await this.saveWithInput(session, now, { kind: 'offline', deviceId: p.deviceId, anchorServerMs: p.anchorServerMs,
          intervals: p.intervals, covered: covered.map((c) => ({ from: c.start.toISOString(), to: c.end.toISOString() })),
          maxWindowSeconds: p.maxWindowSeconds ?? 12 * 3600, sessionStart: planned.start.toISOString() });
        // FR-ATT-020: the user sees the synced block among their raw events.
        await repo.recordPresenceEvent({
          orgId: p.orgId, userId: p.userId, sessionId: session.id, serverTs: now, eventType: 'OFFLINE_SYNC', state: AttendanceState.OFFLINE, seq: 0, ip: p.ip,
          meta: { from: planned.start.toISOString(), to: planned.end.toISOString(), activeSeconds: planned.activeSeconds, idleSeconds: planned.idleSeconds },
        });
        sessionIds.push(session.id);
        dates.add(planned.workDate);
        await this.raiseFlag({ orgId: p.orgId, userId: p.userId, sessionId: session.id, workDate: planned.workDate, kind: 'OFFLINE_SYNCED',
          details: { from: planned.start.toISOString(), to: planned.end.toISOString(), activeSeconds: planned.activeSeconds }, dedupeKey: `offline:${session.id}` });
      }
      for (const d of dates) await this.recomputeDailySummaryForUser(p.orgId, p.userId, d);
      return { plan, sessionIds };
    });
  }

  /**
   * Socket disconnect event (Gateway signal) -> Grace timer started
   */
  public async onSocketDisconnect(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const result = (await this.policy(targetOrgId)).machine.handleSocketDisconnect(session, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'disconnect' });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * Socket reconnect event (within grace period) -> Restore state
   */
  public async onSocketReconnect(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const result = (await this.policy(targetOrgId)).machine.handleSocketReconnect(session, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'reconnect' });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * ADR 025: another still-valid login of this person has heartbeated within the organisation's
   * missed-heartbeat window (a second device, or the desktop agent), so a logout elsewhere must
   * not end the session. The excluded family is the login being revoked.
   */
  public async hasOtherLiveLogin(orgId: string, userId: string, excludeFamilyId: string | null, now: Date = this.clock.now()): Promise<boolean> {
    if (!this.repository) return false;
    const windowSeconds = (await this.policy(orgId)).config.missedHeartbeatTimeoutSeconds;
    return await this.repository.hasOtherLiveLogin(orgId, userId, excludeFamilyId, new Date(now.getTime() - windowSeconds * 1000));
  }

  /**
   * Explicit logout (FR-ATT-002, Section 6.2 row 14; ADR 025): the session closes at once, at the
   * last valid heartbeat, like rows 12 and 13. Nothing after that heartbeat is credited, because
   * nothing after it was observed. Called when every login of the person is revoked (logout,
   * password reset, administrative revocation) and no other login is still heartbeating.
   */
  public async onExplicitLogout(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const closeAt = session.lastHeartbeatAt.getTime() < serverTime.getTime() ? session.lastHeartbeatAt : serverTime;
      const result = (await this.policy(targetOrgId)).machine.handleExplicitLogout(session, closeAt);
      if (this.repository) {
        await this.saveWithInput(result.session, closeAt, { kind: 'logout' });
      }
      this.sessions.delete(userId);
      this.closedSessions.set(result.session.id, result.session);
      return result;
    });
  }

  /**
   * User starts break
   */
  public async startBreak(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const result = (await this.policy(targetOrgId)).machine.handleUserStartsBreak(session, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'break-start' });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * User ends break
   */
  public async endBreak(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const result = (await this.policy(targetOrgId)).machine.handleUserEndsBreak(session, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'break-end' });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * User joins call or meeting
   */
  public async joinMeeting(
    userId: string,
    meetingId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const result = (await this.policy(targetOrgId)).machine.handleJoinMeeting(session, meetingId, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'meeting-start', meetingId });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * User leaves call or meeting
   */
  public async leaveMeeting(
    userId: string,
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<StateMachineTransitionResult | null> {
    const targetOrgId = orgId || this.defaultOrgId;
    return await this.withSessionLock(targetOrgId, userId, async () => {
      const session = await this.getSession(userId, targetOrgId);
      if (!session || session.status !== SessionStatus.OPEN) return null;

      const result = (await this.policy(targetOrgId)).machine.handleLeaveMeeting(session, serverTime);
      if (this.repository) {
        await this.saveWithInput(result.session, serverTime, { kind: 'meeting-end' });
      }
      this.sessions.set(userId, result.session);
      return result;
    });
  }

  /**
   * Periodic reconciliation worker (runs every 60 seconds)
   * Section 6.3:
   * 1. Heartbeat nonce cleanup (> 5 minutes old)
   * 2. Midnight boundary split (FR-ATT-008, Row 15)
   * 3. Max session length capping (FR-ATT-009, Row 16)
   * 4. Grace expiration check (Row 12)
   * 5. Missing heartbeat timeout (Row 13)
   *
   * Idempotency guarantee: Running twice produces 0 additional changes
   */
  public async runReconciliation(
    serverTime: Date = this.clock.now(),
    orgId?: string,
  ): Promise<{ closedCount: number; splitCount: number; cleanedNoncesCount: number; closed: AutoClosed[] }> {
    const targetOrgId = orgId || this.defaultOrgId;
    /** FR-ATT-021: sessions the server closed on its own, so the person can be told. */
    const closed: AutoClosed[] = [];
    const noteClosed = (x: AttendanceSession) => {
      if (x.clockOutAt && x.clockOutSource) closed.push({ userId: x.userId, sessionId: x.id, source: x.clockOutSource, clockOutAt: x.clockOutAt, workDate: x.workDate });
    };
    let closedCount = 0;
    let splitCount = 0;
    let cleanedNoncesCount = 0;

    // 1. Cleanup expired nonces (> 5 minutes = 300s)
    if (this.repository && targetOrgId) {
      const fiveMinutesAgo = new Date(serverTime.getTime() - 300_000);
      cleanedNoncesCount = await this.repository.cleanupExpiredNonces(
        targetOrgId,
        fiveMinutesAgo,
      );
    }

    const openSessions = await this.getAllOpenSessions(targetOrgId);

    for (const listed of openSessions) {
      await this.withSessionLock(targetOrgId, listed.userId, async () => {
        // Re-read inside the lock: a heartbeat may have changed the session since the listing.
        const session = this.repository && targetOrgId
          ? await this.repository.findSessionById(targetOrgId, listed.id)
          : (this.sessions.get(listed.userId) ?? listed);
        if (!session || session.id !== listed.id || session.status !== SessionStatus.OPEN) return;

        // 2. Midnight boundary split (must precede timeout so cross-midnight sessions split cleanly)
        const { machine, config } = await this.policy(targetOrgId);
        const midRes = machine.handleMidnightCheck(session, serverTime);
        let currentSession = session;
        if (midRes.splitSession) {
          if (this.repository) {
            await this.repository.saveSession(midRes.splitSession);
            await this.saveWithInput(midRes.session, serverTime, { kind: 'midnight', splitSessionId: midRes.splitSession.id });
          }
          this.closedSessions.set(midRes.session.id, midRes.session);
          this.sessions.set(session.userId, midRes.splitSession);
          splitCount++;
          currentSession = midRes.splitSession;
        }

        // 3. Max session length (>14 hours)
        const maxRes = machine.handleMaxLengthCheck(currentSession, serverTime);
        if (maxRes.session.status === SessionStatus.CLOSED) {
          if (this.repository) {
            await this.saveWithInput(maxRes.session, serverTime, { kind: 'max-length' });
          }
          noteClosed(maxRes.session);
          // FR-ATT-009: closed at the last heartbeat and flagged for review.
          await this.raiseFlag({ orgId: maxRes.session.orgId, userId: maxRes.session.userId, sessionId: maxRes.session.id, workDate: maxRes.session.workDate, kind: 'MAX_LENGTH', dedupeKey: `maxlen:${maxRes.session.id}` });
          this.sessions.delete(session.userId);
          this.closedSessions.set(maxRes.session.id, maxRes.session);
          closedCount++;
          return;
        }

        // 4. Grace expiration check (Row 12: disconnect grace expired)
        if (
          currentSession.currentState === AttendanceState.DISCONNECTED &&
          currentSession.graceTimerExpiresAt &&
          serverTime.getTime() >= currentSession.graceTimerExpiresAt.getTime()
        ) {
          const res = machine.handleGraceExpiration(currentSession, serverTime);
          if (this.repository) {
            await this.saveWithInput(res.session, serverTime, { kind: 'grace-expired' });
          }
          noteClosed(res.session);
          this.sessions.delete(session.userId);
          this.closedSessions.set(res.session.id, res.session);
          closedCount++;
          return;
        }

        // 5. Missing heartbeat timeout (Row 13: >90s silence)
        const silenceSeconds =
          (serverTime.getTime() - currentSession.lastHeartbeatAt.getTime()) / 1000;
        if (
          currentSession.currentState !== AttendanceState.DISCONNECTED &&
          silenceSeconds > config.missedHeartbeatTimeoutSeconds
        ) {
          const res = machine.handleMissingHeartbeatTimeout(currentSession, serverTime);
          if (this.repository) {
            await this.saveWithInput(res.session, serverTime, { kind: 'timeout' });
          }
          noteClosed(res.session);
          this.sessions.delete(session.userId);
          this.closedSessions.set(res.session.id, res.session);
          closedCount++;
          return;
        }

        // 6. FR-ATT-023: an unanswered presence challenge pauses even without heartbeats.
        const challengeRes = machine.handleChallengeExpiry(currentSession, serverTime);
        if (challengeRes) {
          if (this.repository) {
            await this.saveWithInput(challengeRes.session, serverTime, { kind: 'challenge-expired' });
          }
          this.sessions.set(session.userId, challengeRes.session);
        }
          });
    }

    return { closedCount, splitCount, cleanedNoncesCount, closed };
  }

  /**
   * Cleanup job for heartbeat nonces older than maxAgeSeconds (default 300s = 5m)
   */
  public async cleanupExpiredNonces(
    serverTime: Date = this.clock.now(),
    maxAgeSeconds: number = 300,
    orgId?: string,
  ): Promise<number> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      const threshold = new Date(serverTime.getTime() - maxAgeSeconds * 1000);
      return await this.repository.cleanupExpiredNonces(targetOrgId, threshold);
    }
    return 0;
  }

  /**
   * Cleanup job for device sequences inactive older than staleDays (default 30 days)
   */
  public async cleanupStaleDeviceSequences(
    serverTime: Date = this.clock.now(),
    staleDays: number = 30,
    orgId?: string,
  ): Promise<number> {
    const targetOrgId = orgId || this.defaultOrgId;
    if (this.repository && targetOrgId) {
      const threshold = new Date(serverTime.getTime() - staleDays * 86400 * 1000);
      return await this.repository.cleanupStaleDeviceSequences(targetOrgId, threshold);
    }
    return 0;
  }

  // -------------------------------------------------------------
  // FR-ATT-013: Corrections Workflow
  // -------------------------------------------------------------

  public async requestCorrection(params: {
    orgId: string;
    userId: string;
    sessionId?: string | null;
    requestedIn: Date;
    requestedOut: Date;
    reason: string;
    evidenceDocumentId?: string;
  }): Promise<AttendanceCorrection> {
    if (!this.repository) {
      throw new Error('Repository is required for corrections');
    }

    const now = this.clock.now();

    // 1. Reject future times
    if (params.requestedIn.getTime() > now.getTime() || params.requestedOut.getTime() > now.getTime()) {
      throw new Error('Invalid correction request: correction times cannot be in the future');
    }

    // 2. Reject in >= out
    if (params.requestedIn.getTime() >= params.requestedOut.getTime()) {
      throw new Error('Invalid correction request: requestedIn must precede requestedOut');
    }

    // 3. Reject requests older than maxCorrectionAgeDays (default 7 days)
    const maxAgeDays = this.config.maxCorrectionAgeDays ?? 7;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (now.getTime() - params.requestedIn.getTime() > maxAgeMs) {
      throw new Error(`Correction request exceeds maximum allowed age of ${maxAgeDays} days`);
    }

    // 4. Reject duplicate pending request for the same session or interval
    const pending = await this.repository.findPendingCorrections(params.orgId);
    const duplicate = pending.find(
      (c: AttendanceCorrection) =>
        c.userId === params.userId &&
        c.status === CorrectionStatus.PENDING &&
        ((params.sessionId && c.sessionId === params.sessionId) ||
          (!params.sessionId &&
            c.requestedIn.getTime() === params.requestedIn.getTime() &&
            c.requestedOut.getTime() === params.requestedOut.getTime())),
    );
    if (duplicate) {
      throw new Error('A pending correction request already exists for this session');
    }

    // 5. Reject overlap with another active/closed session of the user
    const workDate = formatInTimeZone(params.requestedIn, this.config.orgTimezone, 'yyyy-MM-dd');
    const existingSessions = await this.repository.findSessionsByDate(params.orgId, workDate);
    const userSessions = existingSessions.filter((s: AttendanceSession) => s.userId === params.userId);

    for (const sess of userSessions) {
      if (params.sessionId && sess.id === params.sessionId) continue;
      if (sess.status === SessionStatus.CANCELLED || sess.status === SessionStatus.ADJUSTED) continue;

      const sessStart = sess.clockInAt.getTime();
      const sessEnd = (sess.clockOutAt || sess.lastHeartbeatAt).getTime();
      const reqStart = params.requestedIn.getTime();
      const reqEnd = params.requestedOut.getTime();

      if (Math.max(reqStart, sessStart) < Math.min(reqEnd, sessEnd)) {
        throw new Error(`Correction interval overlaps with existing session ${sess.id}`);
      }
    }

    const correction: AttendanceCorrection = {
      id: randomUUID(),
      orgId: params.orgId,
      userId: params.userId,
      sessionId: params.sessionId || null,
      requestedIn: params.requestedIn,
      requestedOut: params.requestedOut,
      reason: params.reason,
      evidenceDocumentId: params.evidenceDocumentId || null,
      status: CorrectionStatus.PENDING,
      reviewerId: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: now,
    };
    await this.repository.createCorrection(correction);

    await this.repository.recordAuditLog({
      orgId: params.orgId,
      actorId: params.userId,
      action: 'ATTENDANCE_CORRECTION_REQUESTED',
      entityType: 'ATTENDANCE_CORRECTION',
      entityId: correction.id,
      after: {
        requestedIn: params.requestedIn.toISOString(),
        requestedOut: params.requestedOut.toISOString(),
        reason: params.reason,
        sessionId: params.sessionId || null,
      },
      createdAt: now,
    });

    return correction;
  }

  public async getPendingCorrections(orgId: string): Promise<AttendanceCorrection[]> {
    if (!this.repository) return [];
    return await this.repository.findPendingCorrections(orgId);
  }

  public async reviewCorrection(params: {
    orgId: string;
    reviewerId: string;
    reviewerRole: string;
    reviewerPermissions?: readonly string[];
    correctionId: string;
    approved: boolean;
    reviewNote?: string;
  }): Promise<{ correction: AttendanceCorrection; adjustedSession?: AttendanceSession }> {
    if (!this.repository) {
      throw new Error('Repository is required for reviewCorrection');
    }
    const correction = await this.repository.findCorrectionById(params.orgId, params.correctionId);
    if (!correction) {
      throw new Error(`Correction not found: ${params.correctionId}`);
    }

    // FR-ATT-013: A user cannot approve their own correction
    if (correction.userId === params.reviewerId) {
      throw new Error('User cannot approve their own correction');
    }

    // Role check: Only user's manager or HR/Admin may review
    const requester = await this.repository.findUserById(params.orgId, correction.userId);
    const isManager = requester?.managerId === params.reviewerId || params.reviewerRole === UserRole.MANAGER;
    const isHrOrAdmin = userCan({ role: params.reviewerRole, permissions: params.reviewerPermissions }, Permission.ATTENDANCE_READ_ALL) &&
      userCan({ role: params.reviewerRole, permissions: params.reviewerPermissions }, Permission.ATTENDANCE_CORRECTIONS_REVIEW);
    if (!isManager && !isHrOrAdmin) {
      throw new Error('Unauthorized to review correction: Only manager or HR/Admin may review');
    }

    const reviewedAt = this.clock.now();
    let adjustedSession: AttendanceSession | undefined;

    if (params.approved) {
      correction.status = CorrectionStatus.APPROVED;
      correction.reviewerId = params.reviewerId;
      correction.reviewedAt = reviewedAt;
      correction.reviewNote = params.reviewNote || null;
      await this.repository.updateCorrection(correction);

      let origSession: AttendanceSession | null = null;
      if (correction.sessionId) {
        origSession = await this.repository.findSessionById(params.orgId, correction.sessionId);
        if (origSession) {
          origSession.status = SessionStatus.ADJUSTED;
          await this.repository.saveSession(origSession);
        }
      }

      const durationSec = Math.floor((correction.requestedOut.getTime() - correction.requestedIn.getTime()) / 1000);
      const workDate = formatInTimeZone(correction.requestedIn, this.config.orgTimezone, 'yyyy-MM-dd');

      adjustedSession = {
        id: randomUUID(),
        orgId: params.orgId,
        userId: correction.userId,
        deviceId: origSession?.deviceId || 'adjusted-device',
        workDate,
        clockInAt: correction.requestedIn,
        clockOutAt: correction.requestedOut,
        clockInSource: 'CORRECTION',
        clockOutSource: 'CORRECTION',
        activeSeconds: durationSec,
        idleSeconds: 0,
        breakSeconds: 0,
        meetingSeconds: 0,
        netSeconds: durationSec,
        lastHeartbeatAt: correction.requestedOut,
        ipIn: origSession?.ipIn || '127.0.0.1',
        ipOut: origSession?.ipOut || '127.0.0.1',
        flags: ['CORRECTED'],
        status: SessionStatus.CLOSED,
        currentState: AttendanceState.OFFLINE,
        segments: [],
        consecutiveIdleSeconds: 0,
      };
      await this.saveWithInput(adjustedSession, reviewedAt, { kind: 'correction', from: correction.requestedIn.toISOString(), to: correction.requestedOut.toISOString(), deviceId: adjustedSession.deviceId });

      await this.repository.recordAuditLog({
        orgId: params.orgId,
        actorId: params.reviewerId,
        action: 'ATTENDANCE_CORRECTION_APPROVED',
        entityType: 'ATTENDANCE_CORRECTION',
        entityId: correction.id,
        before: { status: CorrectionStatus.PENDING },
        after: {
          status: CorrectionStatus.APPROVED,
          reviewerId: params.reviewerId,
          reviewNote: params.reviewNote || null,
          adjustedSessionId: adjustedSession.id,
        },
        createdAt: reviewedAt,
      });

      // Recompute attendance_daily for the affected date(s)
      const workDateIn = formatInTimeZone(correction.requestedIn, this.config.orgTimezone, 'yyyy-MM-dd');
      const workDateOut = formatInTimeZone(correction.requestedOut, this.config.orgTimezone, 'yyyy-MM-dd');
      const affectedDates = new Set([workDateIn, workDateOut]);
      for (const d of affectedDates) {
        await this.recomputeDailySummaryForUser(params.orgId, correction.userId, d);
      }

      return { correction, adjustedSession };
    } else {
      correction.status = CorrectionStatus.REJECTED;
      correction.reviewerId = params.reviewerId;
      correction.reviewedAt = reviewedAt;
      correction.reviewNote = params.reviewNote || null;
      await this.repository.updateCorrection(correction);

      await this.repository.recordAuditLog({
        orgId: params.orgId,
        actorId: params.reviewerId,
        action: 'ATTENDANCE_CORRECTION_REJECTED',
        entityType: 'ATTENDANCE_CORRECTION',
        entityId: correction.id,
        before: { status: CorrectionStatus.PENDING },
        after: {
          status: CorrectionStatus.REJECTED,
          reviewerId: params.reviewerId,
          reviewNote: params.reviewNote || null,
        },
        createdAt: reviewedAt,
      });

      return { correction };
    }
  }

  // -------------------------------------------------------------
  // FR-ATT-014: Schedule Compliance Engine
  // -------------------------------------------------------------

  /**
   * FR-ATT-021: whether to remind someone who has not clocked in. Due from schedule start + grace
   * for two hours, on working days only (not on holidays, approved leave or flexible schedules).
   */
  public async clockInReminderDue(orgId: string, userId: string, now: Date = this.clock.now()): Promise<{ due: boolean; startAt?: Date; workDate: string }> {
    const tz = (await this.policy(orgId)).config.orgTimezone;
    const workDate = formatInTimeZone(now, tz, 'yyyy-MM-dd');
    const no = { due: false, workDate };
    if (!this.repository) return no;
    if (this.holidayProvider && await this.holidayProvider.isHoliday(orgId, workDate)) return no;
    if (this.leaveProvider && await this.leaveProvider.isUserOnApprovedLeave(orgId, userId, workDate)) return no;
    const schedule = await this.repository.findWorkScheduleForUser(orgId, userId);
    if (!schedule || schedule.flexible) return no;
    const day = schedule.days[formatInTimeZone(now, tz, 'i')];
    if (!day) return no;
    const startAt = fromZonedTime(`${workDate} ${day.start}:00`, tz);
    const dueAt = startAt.getTime() + (schedule.graceMinutes ?? 10) * 60_000;
    if (now.getTime() < dueAt || now.getTime() > dueAt + 2 * 3600_000) return no;
    const sessions = (await this.repository.findSessionsByDate(orgId, workDate)).filter((x) => x.userId === userId && x.status !== SessionStatus.CANCELLED);
    return sessions.length ? no : { due: true, startAt, workDate };
  }

  public async computeScheduleCompliance(params: {
    orgId: string;
    userId: string;
    workDate: string;
    sessions: AttendanceSession[];
  }): Promise<ScheduleComplianceResult> {
    const isHoliday = this.holidayProvider
      ? await this.holidayProvider.isHoliday(params.orgId, params.workDate)
      : false;
    const isOnLeave = this.leaveProvider
      ? await this.leaveProvider.isUserOnApprovedLeave(params.orgId, params.userId, params.workDate)
      : false;

    const actualSeconds = params.sessions.reduce((sum, s) => sum + s.netSeconds, 0);

    // If holiday or approved leave: expected hours = 0, no absence or late flags
    if (isHoliday || isOnLeave) {
      return {
        workDate: params.workDate,
        userId: params.userId,
        isWorkingDay: false,
        isHoliday,
        isOnLeave,
        expectedSeconds: 0,
        actualSeconds,
        lateArrivalMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        isAbsent: false,
        flags: isHoliday ? ['HOLIDAY'] : ['ON_LEAVE'],
      };
    }

    const schedule = this.repository
      ? await this.repository.findWorkScheduleForUser(params.orgId, params.userId)
      : null;

    // Determine day of week in org timezone: 1 = Monday ... 7 = Sunday
    const middayUtc = fromZonedTime(`${params.workDate} 12:00:00`, this.config.orgTimezone);
    const dayOfWeek = formatInTimeZone(middayUtc, this.config.orgTimezone, 'i');

    const dayConfig = schedule?.days ? schedule.days[dayOfWeek] : null;
    const isWorkingDay = dayConfig != null;
    const expectedSeconds = isWorkingDay ? dayConfig.expectedHours * 3600 : 0;
    const graceMinutes = schedule?.graceMinutes ?? 10;

    const flags: string[] = [];
    let lateArrivalMinutes = 0;
    let earlyLeaveMinutes = 0;
    let overtimeMinutes = 0;
    let isAbsent = false;

    if (isWorkingDay && params.sessions.length === 0) {
      isAbsent = true;
      flags.push('ABSENT');
    } else if (isWorkingDay && params.sessions.length > 0 && dayConfig) {
      const sorted = [...params.sessions].sort(
        (a, b) => a.clockInAt.getTime() - b.clockInAt.getTime(),
      );
      const firstIn = sorted[0].clockInAt;
      const lastOut = sorted[sorted.length - 1].clockOutAt;

      const scheduledStartUtc = fromZonedTime(
        `${params.workDate} ${dayConfig.start}:00`,
        this.config.orgTimezone,
      );
      const scheduledEndUtc = fromZonedTime(
        `${params.workDate} ${dayConfig.end}:00`,
        this.config.orgTimezone,
      );

      // Late arrival: clockIn > scheduledStart + graceMinutes
      const lateThreshold = scheduledStartUtc.getTime() + graceMinutes * 60 * 1000;
      if (firstIn.getTime() > lateThreshold) {
        lateArrivalMinutes = Math.floor(
          (firstIn.getTime() - scheduledStartUtc.getTime()) / 60000,
        );
        flags.push('LATE_ARRIVAL');
      }

      // Early leave: lastOut < scheduledEnd - graceMinutes
      if (lastOut) {
        const earlyThreshold = scheduledEndUtc.getTime() - graceMinutes * 60 * 1000;
        if (lastOut.getTime() < earlyThreshold) {
          earlyLeaveMinutes = Math.floor(
            (scheduledEndUtc.getTime() - lastOut.getTime()) / 60000,
          );
          flags.push('EARLY_LEAVE');
        }
      }

      // Overtime: actualSeconds > expectedSeconds
      if (actualSeconds > expectedSeconds) {
        overtimeMinutes = Math.floor((actualSeconds - expectedSeconds) / 60);
        flags.push('OVERTIME');
      }
    }

    return {
      workDate: params.workDate,
      userId: params.userId,
      isWorkingDay,
      isHoliday: false,
      isOnLeave: false,
      expectedSeconds,
      actualSeconds,
      lateArrivalMinutes,
      earlyLeaveMinutes,
      overtimeMinutes,
      isAbsent,
      flags,
    };
  }

  // -------------------------------------------------------------
  // FR-ATT-015 & Section 6.3: Daily Close Job & Draft Timesheets
  // -------------------------------------------------------------

  /**
   * The day's totals for one person from the stored sessions and schedule, without writing
   * anything. The daily close saves this; nightly replay supplies sessions independently
   * rebuilt from accepted raw inputs (NFR-ACC-004). The same inputs give the same row.
   */
  public async computeDailySummary(orgId: string, userId: string, workDate: string, replayedSessions?: AttendanceSession[]): Promise<AttendanceDaily> {
    if (!this.repository) {
      throw new Error('Repository is required for computeDailySummary');
    }
    const allSessions = replayedSessions ?? await this.repository.findSessionsByDate(orgId, workDate);
    const userSessions = allSessions.filter(
      (s: AttendanceSession) => s.userId === userId && s.status !== SessionStatus.CANCELLED && s.status !== SessionStatus.ADJUSTED,
    );

    const compliance = await this.computeScheduleCompliance({
      orgId,
      userId,
      workDate,
      sessions: userSessions,
    });

    const firstIn = userSessions.length > 0 ? userSessions[0].clockInAt : null;
    const lastOut = userSessions.length > 0 ? userSessions[userSessions.length - 1].clockOutAt : null;
    const activeSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.activeSeconds, 0);
    const idleSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.idleSeconds, 0);
    const breakSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.breakSeconds, 0);
    const meetingSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.meetingSeconds, 0);
    const netSeconds = userSessions.reduce((sum: number, s: AttendanceSession) => sum + s.netSeconds, 0);

    let dayStatus: DayStatus = DayStatus.PRESENT;
    if (compliance.isHoliday) {
      dayStatus = DayStatus.HOLIDAY;
    } else if (compliance.isOnLeave) {
      dayStatus = DayStatus.LEAVE;
    } else if (compliance.isAbsent) {
      dayStatus = DayStatus.ABSENT;
    } else if (compliance.expectedSeconds > 0 && netSeconds < compliance.expectedSeconds / 2) {
      dayStatus = DayStatus.HALF_DAY;
    } else if (compliance.lateArrivalMinutes > 0) {
      dayStatus = DayStatus.LATE;
    } else if (compliance.earlyLeaveMinutes > 0) {
      dayStatus = DayStatus.EARLY_LEAVE;
    }

    return {
      orgId,
      userId,
      workDate,
      firstIn,
      lastOut,
      activeSeconds,
      idleSeconds,
      breakSeconds,
      meetingSeconds,
      netSeconds,
      expectedSeconds: compliance.expectedSeconds,
      lateMinutes: compliance.lateArrivalMinutes,
      earlyLeaveMinutes: compliance.earlyLeaveMinutes,
      overtimeMinutes: compliance.overtimeMinutes,
      dayStatus,
    };
  }

  public async recomputeDailySummaryForUser(
    orgId: string,
    userId: string,
    workDate: string,
  ): Promise<AttendanceDaily | null> {
    if (!this.repository) {
      throw new Error('Repository is required for recomputeDailySummaryForUser');
    }
    const daily = await this.computeDailySummary(orgId, userId, workDate);
    await this.repository.saveDailyAttendance(daily);

    // FR-TS-001: the daily timesheet draft (attendance vs logged time, variance).
    await this.repository.refreshTimesheetDay(orgId, userId, workDate);

    return daily;
  }

  /**
   * NFR-ACC-004 (ADR 029): rebuild every person's day from accepted raw attendance inputs and compare with
   * the stored attendance_daily row, field by field. Reports only; never rewrites a row. A person
   * with sessions but no row is a difference too (the daily close has not covered them).
   */
  public async replayDay(orgId: string, workDate: string): Promise<{ users: number; mismatches: ReplayMismatch[] }> {
    if (!this.repository) {
      throw new Error('Repository is required for replayDay');
    }
    const stored = await this.repository.findDailyAttendanceInRange(orgId, { startDate: workDate, endDate: workDate });
    const byUser = new Map(stored.map((d) => [d.userId, d]));
    const storedSessions = await this.repository.findSessionsByDate(orgId, workDate);
    const withSessions = new Set(
      storedSessions
        .filter((s) => s.status !== SessionStatus.CANCELLED && s.status !== SessionStatus.ADJUSTED)
        .map((s) => s.userId),
    );
    const users = new Set([...byUser.keys(), ...withSessions, ...await this.repository.findUsersForReplay(orgId, workDate)]);
    const mismatches: ReplayMismatch[] = [];
    const fields: Array<keyof AttendanceDaily> = ['firstIn', 'lastOut', 'activeSeconds', 'idleSeconds', 'breakSeconds', 'meetingSeconds', 'netSeconds', 'expectedSeconds', 'lateMinutes', 'earlyLeaveMinutes', 'overtimeMinutes', 'dayStatus'];
    const norm = (v: unknown): string | number | null => (v instanceof Date ? v.toISOString() : v === undefined ? null : (v as string | number | null));
    for (const userId of users) {
      const row = byUser.get(userId);
      if (!row) {
        mismatches.push({ userId, field: 'row', stored: 'missing', recomputed: 'present' });
        continue;
      }
      const materialised = storedSessions.filter((s) => s.userId === userId && s.status !== SessionStatus.CANCELLED && s.status !== SessionStatus.ADJUSTED);
      const inputs = await this.repository.findAttendanceInputs(orgId, userId, workDate);
      let replayed: Map<string, AttendanceSession>;
      try { replayed = replayAttendanceInputs(inputs); } catch {
        mismatches.push({ userId, field: 'rawEvents', stored: 'incomplete', recomputed: 'complete input history required' });
        continue;
      }
      const uncovered = materialised.filter((s) => !replayed.has(s.id));
      if (uncovered.length) {
        mismatches.push({ userId, field: 'rawEvents', stored: 'missing', recomputed: `${uncovered.length} session(s) need input history` });
        continue;
      }
      const sessions = materialised.map((s) => replayed.get(s.id)!).sort((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime());
      const again = await this.computeDailySummary(orgId, userId, workDate, sessions);
      for (const f of fields) {
        const a = norm(row[f]);
        const b = norm(again[f]);
        if (a !== b) mismatches.push({ userId, field: f, stored: a, recomputed: b });
      }
    }
    return { users: users.size, mismatches };
  }

  public async runDailyCloseJob(orgId: string, workDate: string): Promise<AttendanceDaily[]> {
    if (!this.repository) {
      throw new Error('Repository is required for runDailyCloseJob');
    }

    const users = await this.repository.findAllUsers(orgId);
    const summaries: AttendanceDaily[] = [];

    for (const user of users) {
      const daily = await this.recomputeDailySummaryForUser(orgId, user.id, workDate);
      if (daily) {
        summaries.push(daily);
      }
    }

    return summaries;
  }

  // -------------------------------------------------------------
  // FR-ATT-016: Live Board with Role Scoping
  // -------------------------------------------------------------

  public async getLiveBoard(params: {
    orgId: string;
    callerUserId: string;
    callerRole: string;
    callerPermissions?: readonly string[];
    callerTeamId?: string | null;
    filterTeamId?: string;
  }): Promise<LiveBoardUser[]> {
    if (!this.repository) {
      throw new Error('Repository is required for getLiveBoard');
    }

    let targetTeamId: string | undefined = undefined;

    // RBAC Scoping
    // RBAC scoping by permission: org-wide readers (HR, admins, managers) may filter by any
    // team; team readers (team leads) are pinned to their own team.
    if (userCan({ role: params.callerRole, permissions: params.callerPermissions }, Permission.ATTENDANCE_READ_ALL) || params.callerRole === UserRole.MANAGER) {
      targetTeamId = params.filterTeamId;
    } else if (userCan({ role: params.callerRole, permissions: params.callerPermissions }, Permission.ATTENDANCE_READ_TEAM)) {
      if (!params.callerTeamId) {
        throw new Error('Team lead has no assigned team');
      }
      targetTeamId = params.callerTeamId;
    } else {
      throw new Error('Insufficient permissions to view live board');
    }

    const users = await this.repository.findAllUsers(params.orgId, targetTeamId);
    const openSessions = await this.repository.findAllOpenSessions(params.orgId);
    const todayStr = formatInTimeZone(this.clock.now(), this.config.orgTimezone, 'yyyy-MM-dd');
    const clockedInToday = new Set(
      (await this.repository.findSessionsByDate(params.orgId, todayStr))
        .filter((s) => s.status !== SessionStatus.ADJUSTED && s.status !== SessionStatus.CANCELLED)
        .map((s) => s.userId),
    );

    const board: LiveBoardUser[] = [];

    for (const u of users) {
      const openSession = openSessions.find((s: AttendanceSession) => s.userId === u.id);
      let status: LivePresenceStatus = LivePresenceStatus.OFFLINE;
      let clockInAt: Date | null = null;
      let lastHeartbeatAt: Date | null = null;
      let todayNetSeconds = 0;
      let currentSessionId: string | null = null;

      if (openSession) {
        currentSessionId = openSession.id;
        clockInAt = openSession.clockInAt;
        lastHeartbeatAt = openSession.lastHeartbeatAt;
        todayNetSeconds = openSession.netSeconds;

        switch (openSession.currentState) {
          case AttendanceState.ACTIVE:
            status = LivePresenceStatus.ACTIVE;
            break;
          case AttendanceState.IDLE:
            status = LivePresenceStatus.IDLE;
            break;
          case AttendanceState.ON_BREAK:
            status = LivePresenceStatus.ON_BREAK;
            break;
          case AttendanceState.IN_MEETING:
            status = LivePresenceStatus.IN_MEETING;
            break;
          default:
            status = LivePresenceStatus.IDLE;
            break;
        }
      } else {
        const isOnLeave = this.leaveProvider
          ? await this.leaveProvider.isUserOnApprovedLeave(params.orgId, u.id, todayStr)
          : false;
        if (isOnLeave) {
          status = LivePresenceStatus.ON_LEAVE;
        } else {
          status = LivePresenceStatus.OFFLINE;
        }
      }

      board.push({
        userId: u.id,
        displayName: u.displayName,
        email: u.email,
        teamId: u.teamId,
        role: u.role,
        status,
        currentSessionId,
        clockInAt,
        lastHeartbeatAt,
        todayNetSeconds,
        hasClockedInToday: clockedInToday.has(u.id) || !!openSession,
      });
    }

    return board;
  }

  // -------------------------------------------------------------
  // FR-ATT-019: Attendance Data Export (CSV & XLSX)
  // -------------------------------------------------------------

  public async exportAttendanceCsv(params: {
    orgId: string;
    callerUserId: string;
    callerRole: string;
    callerPermissions?: readonly string[];
    filter: AttendanceExportFilter;
  }): Promise<string> {
    if (!this.repository) {
      throw new Error('Repository is required for export');
    }
    // Same rule as the route guard (was a hard-coded list that rejected HR_MANAGER/SUPER_ADMIN).
    if (!userCan({ role: params.callerRole, permissions: params.callerPermissions }, Permission.ATTENDANCE_EXPORT)) {
      throw new Error('Export permission denied: caller lacks export permission');
    }

    const records = await this.repository.findDailyAttendanceInRange(params.orgId, params.filter);

    let csv = 'work_date,user_id,display_name,email,first_in,last_out,net_hours,status\n';
    for (const r of records) {
      const netHours = (r.netSeconds / 3600).toFixed(2);
      const firstIn = r.firstIn ? r.firstIn.toISOString() : '';
      const lastOut = r.lastOut ? r.lastOut.toISOString() : '';
      const safeWorkDate = sanitizeExportCell(r.workDate);
      const safeUserId = sanitizeExportCell(r.userId);
      const safeDisplayName = sanitizeExportCell(r.displayName || '');
      const safeEmail = sanitizeExportCell(r.email || '');
      const safeStatus = sanitizeExportCell(r.dayStatus);
      csv += `${safeWorkDate},${safeUserId},"${String(safeDisplayName).replace(/"/g, '""')}","${String(safeEmail).replace(/"/g, '""')}",${firstIn},${lastOut},${netHours},${safeStatus}\n`;
    }

    const exportId = randomUUID();
    await this.repository.recordAuditLog({
      orgId: params.orgId,
      actorId: params.callerUserId,
      action: 'ATTENDANCE_EXPORTED',
      entityType: 'EXPORT',
      entityId: exportId,
      after: { format: 'CSV', filter: params.filter, rowCount: records.length },
      createdAt: this.clock.now(),
    });

    return csv;
  }

  public async exportAttendanceXlsx(params: {
    orgId: string;
    callerUserId: string;
    callerRole: string;
    callerPermissions?: readonly string[];
    filter: AttendanceExportFilter;
  }): Promise<Buffer> {
    if (!this.repository) {
      throw new Error('Repository is required for export');
    }
    // Same rule as the route guard (was a hard-coded list that rejected HR_MANAGER/SUPER_ADMIN).
    if (!userCan({ role: params.callerRole, permissions: params.callerPermissions }, Permission.ATTENDANCE_EXPORT)) {
      throw new Error('Export permission denied: caller lacks export permission');
    }

    const records = await this.repository.findDailyAttendanceInRange(params.orgId, params.filter);

    // exceljs is CommonJS: under NodeNext the classes may sit on `default`.
    type ExcelModule = typeof import('exceljs');
    const ExcelJS = (await import('exceljs')) as ExcelModule & { default?: ExcelModule };
    const WorkbookClass = ExcelJS.default?.Workbook ?? ExcelJS.Workbook;
    const workbook = new WorkbookClass();
    const sheet = workbook.addWorksheet('Attendance');

    sheet.columns = [
      { header: 'work_date', key: 'work_date', width: 15 },
      { header: 'user_id', key: 'user_id', width: 36 },
      { header: 'display_name', key: 'display_name', width: 25 },
      { header: 'email', key: 'email', width: 30 },
      { header: 'first_in', key: 'first_in', width: 25 },
      { header: 'last_out', key: 'last_out', width: 25 },
      { header: 'net_hours', key: 'net_hours', width: 12 },
      { header: 'status', key: 'status', width: 15 },
    ];

    for (const r of records) {
      sheet.addRow({
        work_date: sanitizeExportCell(r.workDate),
        user_id: sanitizeExportCell(r.userId),
        display_name: sanitizeExportCell(r.displayName || ''),
        email: sanitizeExportCell(r.email || ''),
        first_in: r.firstIn ? r.firstIn.toISOString() : '',
        last_out: r.lastOut ? r.lastOut.toISOString() : '',
        net_hours: Number((r.netSeconds / 3600).toFixed(2)),
        status: sanitizeExportCell(r.dayStatus),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();

    const exportId = randomUUID();
    await this.repository.recordAuditLog({
      orgId: params.orgId,
      actorId: params.callerUserId,
      action: 'ATTENDANCE_EXPORTED',
      entityType: 'EXPORT',
      entityId: exportId,
      after: { format: 'XLSX', filter: params.filter, rowCount: records.length },
      createdAt: this.clock.now(),
    });

    return Buffer.from(buffer);
  }

  // -------------------------------------------------------------
  // FR-ATT-020 & FR-AUD-004: Transparency & Monitoring Consent
  // -------------------------------------------------------------

  public async getTransparencyEvents(params: {
    orgId: string;
    userId: string;
  }): Promise<TransparencyInfo> {
    if (!this.repository) {
      throw new Error('Repository is required for transparency');
    }

    const events = await this.repository.findPresenceEventsByUser(params.orgId, params.userId, 100);
    const retentionDays = (await this.policy(params.orgId)).config.presenceRetentionDays ?? 90;

    return {
      plainLanguageNotice:
        'HR Virtual Office Attendance Telemetry Notice: We collect minimal presence and attendance signals: ' +
        'server timestamps of clock in/out, interval counters of active vs idle seconds, in-call/meeting status, ' +
        'IP address, and client device identifier. ' +
        'No screenshots. No keystroke content, no browser history, no URLs, and no webcam feeds are captured or stored. ' +
        `All presence events are retained for ${retentionDays} days in accordance with company privacy policy.`,
      noticeVersion: this.config.currentNoticeVersion ?? 'v1.0.0',
      collectedFields: ['server_ts', 'event_type', 'state', 'seq', 'ip', 'active_seconds', 'idle_seconds', 'in_call'],
      retentionDays,
      events,
    };
  }

  public async hasUserAcceptedNotice(orgId: string, userId: string, version: string): Promise<boolean> {
    if (this.repository) {
      const consents = await this.repository.findMonitoringConsentsByUser(orgId, userId);
      return consents.some((c: MonitoringConsent) => c.noticeVersion === version);
    }
    const userConsents = this.inMemoryConsents.get(userId);
    return userConsents ? userConsents.has(version) : false;
  }

  public async recordMonitoringConsent(params: {
    orgId: string;
    userId: string;
    noticeVersion: string;
    ip?: string;
    userAgent?: string;
  }): Promise<MonitoringConsent> {
    const consent: MonitoringConsent = {
      id: randomUUID(),
      orgId: params.orgId,
      userId: params.userId,
      noticeVersion: params.noticeVersion,
      acceptedAt: this.clock.now(),
      ip: params.ip || null,
      userAgent: params.userAgent || null,
    };

    if (this.repository) {
      await this.repository.saveMonitoringConsent(consent);

      await this.repository.recordAuditLog({
        orgId: params.orgId,
        actorId: params.userId,
        action: 'MONITORING_NOTICE_ACCEPTED',
        entityType: 'MONITORING_CONSENT',
        entityId: consent.id,
        after: {
          noticeVersion: params.noticeVersion,
          acceptedAt: consent.acceptedAt.toISOString(),
        },
        ip: params.ip || null,
        userAgent: params.userAgent || null,
        createdAt: this.clock.now(),
      });
    }

    let userConsents = this.inMemoryConsents.get(params.userId);
    if (!userConsents) {
      userConsents = new Set<string>();
      this.inMemoryConsents.set(params.userId, userConsents);
    }
    userConsents.add(params.noticeVersion);

    return consent;
  }

  // -------------------------------------------------------------
  // Self-service read models for apps/web (SRS 8.3: GET /attendance/me, /attendance/daily)
  // -------------------------------------------------------------

  /** Totals for one session as of `now`, including the elapsed part of an open break or meeting. */
  public totalsAsOf(session: AttendanceSession, now: Date = this.clock.now()): TimeTotals {
    const open = session.segments.length > 0 ? session.segments[session.segments.length - 1] : undefined;
    const openElapsed = open && !open.endedAt
      ? Math.max(0, Math.round((now.getTime() - open.startedAt.getTime()) / 1000))
      : 0;
    const breakSeconds = session.breakSeconds +
      (session.status === SessionStatus.OPEN && open?.state === AttendanceState.ON_BREAK ? openElapsed : 0);
    const meetingSeconds = session.meetingSeconds +
      (session.status === SessionStatus.OPEN && open?.state === AttendanceState.IN_MEETING ? openElapsed : 0);
    // The org's break rule when its policy is loaded (it is, once the org has had a heartbeat).
    const paidBreakMinutes = (this.policyCache.get(session.orgId)?.config ?? this.config).paidBreakMinutesPerDay;
    const paidBreak = Math.min(breakSeconds, paidBreakMinutes * 60);
    const netSeconds = session.flags.includes('MULTI_DEVICE')
      ? Math.max(session.netSeconds, 0)
      : session.activeSeconds + meetingSeconds + paidBreak;
    return {
      activeSeconds: session.activeSeconds,
      idleSeconds: session.idleSeconds,
      breakSeconds,
      meetingSeconds,
      netSeconds,
    };
  }

  private static sumTotals(items: TimeTotals[]): TimeTotals {
    return items.reduce<TimeTotals>(
      (acc, t) => ({
        activeSeconds: acc.activeSeconds + t.activeSeconds,
        idleSeconds: acc.idleSeconds + t.idleSeconds,
        breakSeconds: acc.breakSeconds + t.breakSeconds,
        meetingSeconds: acc.meetingSeconds + t.meetingSeconds,
        netSeconds: acc.netSeconds + t.netSeconds,
      }),
      { activeSeconds: 0, idleSeconds: 0, breakSeconds: 0, meetingSeconds: 0, netSeconds: 0 },
    );
  }

  private static countsTowardDay(s: AttendanceSession): boolean {
    // ADJUSTED originals are replaced by their CORRECTED session (FR-ATT-013).
    return s.status !== SessionStatus.ADJUSTED && s.status !== SessionStatus.CANCELLED;
  }

  /** GET /attendance/me/today: current state, tracking start and today's totals (server clock). */
  public async getMyToday(orgId: string, userId: string): Promise<MyToday> {
    if (!this.repository) throw new Error('Repository is required for getMyToday');
    const now = this.clock.now();
    const workDate = formatInTimeZone(now, this.config.orgTimezone, 'yyyy-MM-dd');
    const open = await this.repository.findOpenSessionByUserId(orgId, userId);
    const today = (await this.repository.findSessionsByUserInRange(orgId, userId, workDate, workDate))
      .filter(AttendanceService.countsTowardDay)
      .filter((s) => !open || s.id !== open.id);
    const all = open ? [...today, open] : today;
    const lastSeg = open && open.segments.length > 0 ? open.segments[open.segments.length - 1] : undefined;

    return {
      workDate,
      state: open ? open.currentState : AttendanceState.OFFLINE,
      sessionId: open?.id ?? null,
      trackingSince: open ? open.clockInAt.toISOString() : null,
      onBreakSince: open?.currentState === AttendanceState.ON_BREAK && lastSeg && !lastSeg.endedAt
        ? lastSeg.startedAt.toISOString()
        : null,
      lastHeartbeatAt: open ? open.lastHeartbeatAt.toISOString() : null,
      totals: AttendanceService.sumTotals(all.map((s) => this.totalsAsOf(s, now))),
      sessionCount: all.length,
      lastClosed: AttendanceService.lastServerClosed(today, open ?? null, now),
      asOf: now.toISOString(),
    };
  }

  /**
   * AC-04: after an outage the person should be offered a correction. The newest session today
   * that the server closed (TIMEOUT or DISCONNECT), unless a later session already covers it.
   */
  private static lastServerClosed(closed: AttendanceSession[], open: AttendanceSession | null, now: Date): MyToday['lastClosed'] {
    const candidates = closed
      .filter((s) => s.clockOutAt && (s.clockOutSource === 'TIMEOUT' || s.clockOutSource === 'DISCONNECT'))
      .sort((a, b) => b.clockOutAt!.getTime() - a.clockOutAt!.getTime());
    const last = candidates[0];
    if (!last) return null;
    const resumedAt = open?.clockInAt ?? closed.filter((s) => s.clockInAt > last.clockOutAt!).sort((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime())[0]?.clockInAt ?? null;
    const until = resumedAt ?? now;
    return { at: last.clockOutAt!.toISOString(), source: last.clockOutSource ?? 'TIMEOUT', minutesUnaccounted: Math.max(0, Math.floor((until.getTime() - last.clockOutAt!.getTime()) / 60_000)) };
  }

  /** GET /attendance/me/days: one row per work date that has sessions (FR-ATT-015). */
  public async getMyDays(orgId: string, userId: string, fromDate: string, toDate: string): Promise<MyDay[]> {
    if (!this.repository) throw new Error('Repository is required for getMyDays');
    const now = this.clock.now();
    const sessions = (await this.repository.findSessionsByUserInRange(orgId, userId, fromDate, toDate))
      .filter(AttendanceService.countsTowardDay);
    const open = await this.repository.findOpenSessionByUserId(orgId, userId);
    const daily = await this.repository.findDailyAttendanceInRange(orgId, { startDate: fromDate, endDate: toDate, userId });
    const dailyByDate = new Map(daily.map((d) => [d.workDate, d]));

    const byDate = new Map<string, AttendanceSession[]>();
    for (const s of sessions) {
      // Use the fully loaded open session (with segments) so live break/meeting time is included.
      const effective = open && s.id === open.id ? open : s;
      const list = byDate.get(s.workDate) ?? [];
      list.push(effective);
      byDate.set(s.workDate, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, list]) => {
        const totals = AttendanceService.sumTotals(list.map((s) => this.totalsAsOf(s, now)));
        const isOpen = list.some((s) => s.status === SessionStatus.OPEN);
        const outs = list.map((s) => s.clockOutAt).filter((d): d is Date => d instanceof Date);
        const d = dailyByDate.get(date);
        return {
          workDate: date,
          ...totals,
          firstIn: new Date(Math.min(...list.map((s) => s.clockInAt.getTime()))).toISOString(),
          lastOut: isOpen || outs.length === 0 ? null : new Date(Math.max(...outs.map((o) => o.getTime()))).toISOString(),
          sessionCount: list.length,
          open: isOpen,
          flags: [...new Set(list.flatMap((s) => s.flags))],
          dayStatus: d?.dayStatus ?? null,
          lateMinutes: d ? d.lateMinutes : null,
        };
      });
  }

  public async getMyCorrections(orgId: string, userId: string): Promise<AttendanceCorrection[]> {
    if (!this.repository) return [];
    return await this.repository.findCorrectionsByUser(orgId, userId);
  }

  /**
   * GET /attendance/corrections: pending requests the caller may review, using the same rule
   * as reviewCorrection (org-wide reviewers, MANAGER role, or the requester's manager).
   */
  public async getCorrectionQueue(params: {
    orgId: string;
    callerId: string;
    callerRole: string;
    callerPermissions?: readonly string[];
  }): Promise<CorrectionQueueItem[]> {
    if (!this.repository) return [];
    const orgWide = (userCan({ role: params.callerRole, permissions: params.callerPermissions }, Permission.ATTENDANCE_READ_ALL) &&
      userCan({ role: params.callerRole, permissions: params.callerPermissions }, Permission.ATTENDANCE_CORRECTIONS_REVIEW)) ||
      params.callerRole === UserRole.MANAGER;
    const pending = await this.repository.findPendingCorrectionsWithRequester(params.orgId);
    return pending
      .filter((c) => c.userId !== params.callerId)
      .filter((c) => orgWide || c.requesterManagerId === params.callerId)
      .map((c) => ({
        id: c.id,
        userId: c.userId,
        sessionId: c.sessionId ?? null,
        requestedIn: c.requestedIn.toISOString(),
        requestedOut: c.requestedOut.toISOString(),
        reason: c.reason,
        status: c.status,
        reviewerId: c.reviewerId ?? null,
        reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
        reviewNote: c.reviewNote ?? null,
        createdAt: c.createdAt.toISOString(),
        requesterName: c.requesterName,
        requesterEmail: c.requesterEmail,
      }));
  }

  /** GET /attendance/consent (FR-AUD-004): has the caller accepted the current notice? */
  public async getConsentStatus(orgId: string, userId: string): Promise<ConsentStatus> {
    const noticeVersion = this.config.currentNoticeVersion ?? 'v1.0.0';
    if (!this.repository) {
      return { accepted: await this.hasUserAcceptedNotice(orgId, userId, noticeVersion), noticeVersion, acceptedAt: null };
    }
    const consents = await this.repository.findMonitoringConsentsByUser(orgId, userId);
    const match = consents.find((c) => c.noticeVersion === noticeVersion);
    return {
      accepted: !!match,
      noticeVersion,
      acceptedAt: match ? new Date(match.acceptedAt).toISOString() : null,
    };
  }
}
