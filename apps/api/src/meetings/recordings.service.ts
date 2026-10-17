/**
 * Meeting recording with consent (SRS 5.4 FR-MEET-007, FR-AUD-004; ADR 024).
 *
 * Off unless the organisation enables it. A host or co-host asks; everyone in the call (and anyone
 * who joins meanwhile) must answer yes within two minutes, otherwise nothing is recorded. Only then
 * does LiveKit Egress start a composite recording into a staging key. When it ends, the API encrypts
 * the MP4 with a fresh data key (KeyProvider purpose "recording", KMS in AWS), deletes the staging
 * copy and keeps it for the organisation's retention period, after which it is crypto-shredded.
 * People who were not asked cannot join while it records. Only host, co-hosts and the people who
 * were recorded can watch. Times are the server's.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import type pg from 'pg';
import { PrismaService } from '../common/prisma.service.ts';
import { appendAuditEntry } from '../common/audit-chain.ts';
import { isProduction } from '../common/config.ts';
import type { RequestContext } from '../common/decorators/request-context.decorator.ts';
import { AttendanceGateway } from '../attendance/attendance.gateway.ts';
import { KEY_PROVIDER, createDecryptStream, createEncryptStream, generateDek } from '../documents/crypto.ts';
import type { KeyProvider } from '../documents/crypto.ts';
import { OBJECT_STORE } from '../documents/object-store.ts';
import type { ObjectStore } from '../documents/object-store.ts';
import { liveKitConfig, roomService, startRoomRecording, stopRecording } from '../media/livekit.ts';
import type { EgressS3, LkEgressInfo } from '../media/livekit.ts';
import { CONSENT_NOTICES } from '../../../../packages/shared/src/admin/types.ts';
import type { AuthenticatedUser, Recording, RecordingConsentDto, RecordingStatus } from '../../../../packages/shared/src/index.ts';
import { RECORDING_DISPATCHER } from './recording-dispatcher.ts';
import type { RecordingDispatcher } from './recording-dispatcher.ts';
import { CONSENT_WINDOW_SECONDS, canWatchRecording, consentOutcome, recordingExpiry } from './recording-rules.ts';

type Role = 'HOST' | 'COHOST' | 'ATTENDEE' | 'NONE';
interface RecRow {
  id: string; org_id: string; meeting_id: string; started_by: string; status: RecordingStatus; required_user_ids: string[]; consent_deadline: Date;
  egress_id: string | null; staging_key: string | null; storage_key: string | null; dek_wrapped: Buffer | null; key_id: string | null; iv: Buffer | null; auth_tag: Buffer | null;
  sha256: string | null; size_bytes: string | null; duration_seconds: number | null; started_at: Date | null; ended_at: Date | null; expires_at: Date | null; detail: string | null; created_at: Date;
}
interface MeetingBits { id: string; type: string; status: string; host_id: string; livekit_room_name: string; title: string }
interface Person { id: string; displayName: string | null; email: string }

const ACTIVE: RecordingStatus[] = ['CONSENT', 'RECORDING', 'PROCESSING'];
const NOTICE = () => CONSENT_NOTICES.RECORDING.version;
export const recordingKeys = {
  // Top-level prefix: the upload-only IAM policy and a lifecycle safety rule target it (ADR 024).
  staging: (org: string, id: string) => `_recordings_staging/${org}/${id}.mp4`,
  stored: (org: string, id: string) => `${org}/_recordings/${id}`,
};

/** Where Egress uploads. A dedicated upload-only key in production (ADR 024); the dev store otherwise. */
export function egressS3FromEnv(env: Record<string, string | undefined> = process.env): EgressS3 {
  const accessKey = env.RECORDING_S3_ACCESS_KEY || (isProduction() ? '' : env.S3_ACCESS_KEY || '');
  const secret = env.RECORDING_S3_SECRET_KEY || (isProduction() ? '' : env.S3_SECRET_KEY || '');
  if (!accessKey || !secret) throw new ServiceUnavailableException('Recording storage is not configured');
  return {
    accessKey, secret, region: env.RECORDING_S3_REGION || env.S3_REGION || 'us-east-1', endpoint: env.RECORDING_S3_ENDPOINT || env.S3_ENDPOINT || undefined,
    bucket: env.RECORDING_S3_BUCKET || env.S3_BUCKET || 'hrvo-documents', forcePathStyle: (env.RECORDING_S3_FORCE_PATH_STYLE ?? env.S3_FORCE_PATH_STYLE) !== 'false',
  };
}

export interface RecordingFile { stream: Readable; sizeBytes: number; fileName: string }

@Injectable()
export class RecordingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AttendanceGateway,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(RECORDING_DISPATCHER) private readonly jobs: RecordingDispatcher,
  ) {}

  // ------------------------------------------------------------------ helpers

  private async meeting(db: pg.PoolClient, id: string, lock = false): Promise<MeetingBits> {
    const m = (await db.query<MeetingBits>(`SELECT id, type, status, host_id, livekit_room_name, title FROM meetings WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!m) throw new NotFoundException('Meeting not found');
    return m;
  }

  private async rec(db: pg.PoolClient, id: string, lock = false): Promise<RecRow> {
    const r = (await db.query<RecRow>(`SELECT * FROM meeting_recordings WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r) throw new NotFoundException('Recording not found');
    return r;
  }

  private async roleOf(db: pg.PoolClient, m: MeetingBits, userId: string): Promise<Role> {
    if (m.host_id === userId) return 'HOST';
    return (await db.query<{ role: Role }>(`SELECT role FROM meeting_attendees WHERE meeting_id = $1 AND user_id = $2`, [m.id, userId])).rows[0]?.role ?? 'NONE';
  }

  /** People in the call right now (from the LiveKit webhooks). */
  private async present(db: pg.PoolClient, meetingId: string): Promise<string[]> {
    return (await db.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM meeting_participants WHERE meeting_id = $1 AND left_at IS NULL`, [meetingId])).rows.map((r) => r.user_id);
  }

  private async answers(db: pg.PoolClient, recId: string): Promise<Array<{ userId: string; granted: boolean }>> {
    return (await db.query<{ user_id: string; granted: boolean }>(`SELECT user_id, granted FROM recording_consents WHERE recording_id = $1 ORDER BY at, id`, [recId])).rows.map((r) => ({ userId: r.user_id, granted: r.granted }));
  }

  private async hasConsented(db: pg.PoolClient, recId: string, userId: string): Promise<boolean> {
    const r = (await db.query<{ granted: boolean }>(`SELECT granted FROM recording_consents WHERE recording_id = $1 AND user_id = $2 ORDER BY at DESC, id DESC LIMIT 1`, [recId, userId])).rows[0];
    return r?.granted === true;
  }

  private async people(db: pg.PoolClient, ids: string[]): Promise<Person[]> {
    if (!ids.length) return [];
    return (await db.query<{ id: string; display_name: string | null; email: string }>(`SELECT id, display_name, email FROM users WHERE id = ANY($1::uuid[]) ORDER BY COALESCE(display_name, email)`, [ids]))
      .rows.map((p) => ({ id: p.id, displayName: p.display_name, email: p.email }));
  }

  private async toDto(db: pg.PoolClient, user: AuthenticatedUser, r: RecRow, role: Role): Promise<Recording> {
    const answers = await this.answers(db, r.id);
    const latest = new Map(answers.map((a) => [a.userId, a.granted]));
    const waiting = r.status === 'CONSENT' ? r.required_user_ids.filter((u) => latest.get(u) !== true) : [];
    const moderator = role === 'HOST' || role === 'COHOST';
    const mine = latest.get(user.id);
    return {
      id: r.id, meetingId: r.meeting_id, status: r.status, startedBy: (await this.people(db, [r.started_by]))[0]!, createdAt: r.created_at.toISOString(),
      consentDeadline: r.consent_deadline.toISOString(), startedAt: r.started_at?.toISOString() ?? null, endedAt: r.ended_at?.toISOString() ?? null,
      durationSeconds: r.duration_seconds, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), expiresAt: r.expires_at?.toISOString() ?? null, detail: r.detail,
      waitingFor: await this.people(db, waiting), myConsent: mine === undefined ? null : mine,
      canStop: r.status === 'RECORDING' && (moderator || r.started_by === user.id) || (r.status === 'CONSENT' && (moderator || r.started_by === user.id)),
      canWatch: r.status === 'READY' && canWatchRecording({ role, consented: mine === true }),
      canDelete: moderator && ['READY', 'FAILED', 'CANCELLED'].includes(r.status),
    };
  }

  private broadcast(userIds: string[], payload: { meetingId: string; recordingId: string; status: RecordingStatus }): void {
    for (const u of new Set(userIds)) this.gateway.notifyUser(u, 'meeting:recording', payload);
  }

  // ------------------------------------------------------------------ for MeetingsService

  /** The banner: the recording being asked for, running or processing, as this viewer sees it. */
  async active(db: pg.PoolClient, user: AuthenticatedUser, meetingId: string, role: Role): Promise<Recording | null> {
    const r = (await db.query<RecRow>(`SELECT * FROM meeting_recordings WHERE meeting_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`, [meetingId, ACTIVE])).rows[0];
    return r ? await this.toDto(db, user, r, role) : null;
  }

  async enabled(db: pg.PoolClient, orgId: string): Promise<boolean> {
    return (await db.query<{ recording_enabled: boolean }>(`SELECT recording_enabled FROM organizations WHERE id = $1`, [orgId])).rows[0]?.recording_enabled === true;
  }

  /** Join gate: someone who has not agreed cannot enter while a recording is asked for or running. */
  async joinBlocker(db: pg.PoolClient, meetingId: string, userId: string): Promise<string | null> {
    const r = (await db.query<{ id: string }>(`SELECT id FROM meeting_recordings WHERE meeting_id = $1 AND status IN ('CONSENT', 'RECORDING') LIMIT 1`, [meetingId])).rows[0];
    if (!r) return null;
    return (await this.hasConsented(db, r.id, userId)) ? null : r.id;
  }

  // ------------------------------------------------------------------ request, consent, start

  async request(user: AuthenticatedUser, meetingId: string, ctx: RequestContext): Promise<Recording> {
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.meeting(db, meetingId, true);
      if (!(await this.enabled(db, user.orgId))) throw new ForbiddenException('Recording is turned off for this organisation');
      if (m.type === 'ROOM') throw new BadRequestException('Office room meetings cannot be recorded');
      const role = await this.roleOf(db, m, user.id);
      if (role !== 'HOST' && role !== 'COHOST') throw new ForbiddenException('Only the host or a co-host can record');
      if (m.status !== 'LIVE') throw new ConflictException('The meeting is not live');
      const present = await this.present(db, meetingId);
      if (!present.includes(user.id)) throw new ConflictException('Join the call before you start recording');
      const busy = await db.query(`SELECT 1 FROM meeting_recordings WHERE meeting_id = $1 AND status = ANY($2)`, [meetingId, ACTIVE]);
      if (busy.rowCount) throw new ConflictException('A recording is already in progress');
      const id = randomUUID();
      await db.query(
        `INSERT INTO meeting_recordings (id, org_id, meeting_id, started_by, required_user_ids, consent_deadline, staging_key) VALUES ($1, $2, $3, $4, $5::uuid[], now() + make_interval(secs => $6), $7)`,
        [id, user.orgId, meetingId, user.id, present, CONSENT_WINDOW_SECONDS, recordingKeys.staging(user.orgId, id)]);
      // Asking is the requester's own yes.
      await db.query(`INSERT INTO recording_consents (org_id, recording_id, user_id, granted, notice_version, ip, user_agent) VALUES ($1, $2, $3, true, $4, $5, $6)`,
        [user.orgId, id, user.id, NOTICE(), ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RECORDING_REQUESTED', entityType: 'MEETING_RECORDING', entityId: id, after: { meetingId, participants: present.length }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return { id, present };
    });
    for (const u of out.present) if (u !== user.id) this.gateway.notifyUser(u, 'meeting:recording-consent', { meetingId, recordingId: out.id });
    this.broadcast(out.present, { meetingId, recordingId: out.id, status: 'CONSENT' });
    await this.evaluate(user.orgId, out.id);
    return await this.get(user, out.id);
  }

  async consent(user: AuthenticatedUser, id: string, dto: RecordingConsentDto, ctx: RequestContext): Promise<Recording> {
    if (dto.noticeVersion !== NOTICE()) throw new ConflictException('The recording notice has changed. Reload and read it again.');
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.rec(db, id, true);
      const m = await this.meeting(db, r.meeting_id);
      const role = await this.roleOf(db, m, user.id);
      const admitted = (await db.query(`SELECT 1 FROM meeting_lobby WHERE meeting_id = $1 AND user_id = $2 AND state = 'ADMITTED'`, [m.id, user.id])).rowCount;
      const took = (await db.query(`SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`, [m.id, user.id])).rowCount;
      if (role === 'NONE' && !admitted && !took && !r.required_user_ids.includes(user.id)) throw new NotFoundException('Recording not found');
      if (r.status !== 'CONSENT' && r.status !== 'RECORDING') throw new ConflictException('This recording is no longer asking for consent');
      await db.query(`INSERT INTO recording_consents (org_id, recording_id, user_id, granted, notice_version, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.orgId, id, user.id, dto.granted, dto.noticeVersion, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
      // A late joiner who agrees becomes one of the people whose yes is needed.
      if (dto.granted && !r.required_user_ids.includes(user.id)) await db.query(`UPDATE meeting_recordings SET required_user_ids = array_append(required_user_ids, $2::uuid), updated_at = now() WHERE id = $1`, [id, user.id]);
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: dto.granted ? 'RECORDING_CONSENT_GIVEN' : 'RECORDING_CONSENT_REFUSED', entityType: 'MEETING_RECORDING', entityId: id,
        after: { meetingId: m.id, noticeVersion: dto.noticeVersion }, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      // Withdrawing while it records stops the recording (what was recorded with consent is kept).
      const stopNow = !dto.granted && r.status === 'RECORDING' && r.required_user_ids.includes(user.id);
      return { stopNow, room: m.livekit_room_name, egressId: r.egress_id };
    });
    if (out.stopNow) await this.endEgress(user.orgId, id, out.room, out.egressId, 'Stopped: a participant withdrew consent');
    else await this.evaluate(user.orgId, id);
    return await this.get(user, id);
  }

  /** Decide a CONSENT recording: start, refuse, expire, or ask newcomers who are already in the call. */
  async evaluate(orgId: string, id: string): Promise<void> {
    const out = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const r = await this.rec(db, id, true);
      if (r.status !== 'CONSENT') return null;
      const m = await this.meeting(db, r.meeting_id);
      const answers = await this.answers(db, id);
      // Anyone in the call is required, even if they slipped in with a token issued before the request.
      const present = await this.present(db, r.meeting_id);
      const newcomers = present.filter((u) => !r.required_user_ids.includes(u));
      const required = [...r.required_user_ids, ...newcomers];
      if (newcomers.length) await db.query(`UPDATE meeting_recordings SET required_user_ids = $2::uuid[], updated_at = now() WHERE id = $1`, [id, required]);
      const outcome = m.status !== 'LIVE' ? 'EXPIRED' : consentOutcome(required, answers, r.consent_deadline, new Date());
      if (outcome === 'PENDING') return { kind: 'ask' as const, newcomers, meetingId: m.id, everyone: present };
      if (outcome === 'START') {
        await db.query(`UPDATE meeting_recordings SET status = 'RECORDING', updated_at = now() WHERE id = $1`, [id]);
        return { kind: 'start' as const, room: m.livekit_room_name, staging: r.staging_key!, meetingId: m.id, everyone: present, starter: r.started_by };
      }
      const declined = outcome === 'REFUSED' ? (await this.people(db, required.filter((u) => answers.filter((a) => a.userId === u).at(-1)?.granted === false)))[0] : null;
      const detail = declined ? `Not recorded: ${declined.displayName ?? declined.email} declined` : 'Not recorded: not everyone answered in time';
      await db.query(`UPDATE meeting_recordings SET status = 'CANCELLED', staging_key = NULL, detail = $2, updated_at = now() WHERE id = $1`, [id, detail]);
      await appendAuditEntry(db, { orgId, actorId: r.started_by, action: 'RECORDING_CANCELLED', entityType: 'MEETING_RECORDING', entityId: id, after: { reason: outcome, system: true } });
      return { kind: 'cancelled' as const, meetingId: m.id, everyone: [...present, r.started_by] };
    });
    if (!out) return;
    if (out.kind === 'ask') {
      for (const u of out.newcomers) this.gateway.notifyUser(u, 'meeting:recording-consent', { meetingId: out.meetingId, recordingId: id });
      this.broadcast(out.everyone, { meetingId: out.meetingId, recordingId: id, status: 'CONSENT' });
      return;
    }
    if (out.kind === 'cancelled') { this.broadcast(out.everyone, { meetingId: out.meetingId, recordingId: id, status: 'CANCELLED' }); return; }
    // Everyone agreed: start Egress. On failure nothing was recorded.
    try {
      const info = await startRoomRecording(liveKitConfig(), out.room, out.staging, egressS3FromEnv());
      await this.prisma.runWithTenantContext(orgId, async (db) => {
        await db.query(`UPDATE meeting_recordings SET egress_id = $2, started_at = now(), updated_at = now() WHERE id = $1`, [id, info.egressId]);
        await appendAuditEntry(db, { orgId, actorId: out.starter, action: 'RECORDING_STARTED', entityType: 'MEETING_RECORDING', entityId: id, after: { system: true } });
      });
      this.broadcast(out.everyone, { meetingId: out.meetingId, recordingId: id, status: 'RECORDING' });
    } catch (err) {
      console.error('Recording start failed:', err instanceof Error ? err.message : 'unknown error');
      await this.prisma.runWithTenantContext(orgId, (db) => db.query(`UPDATE meeting_recordings SET status = 'FAILED', staging_key = NULL, detail = 'The recording service could not start', updated_at = now() WHERE id = $1`, [id]));
      this.broadcast(out.everyone, { meetingId: out.meetingId, recordingId: id, status: 'FAILED' });
    }
  }

  // ------------------------------------------------------------------ stop and Egress events

  async stop(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<Recording> {
    const out = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.rec(db, id, true);
      const m = await this.meeting(db, r.meeting_id);
      const role = await this.roleOf(db, m, user.id);
      if (role !== 'HOST' && role !== 'COHOST' && r.started_by !== user.id) throw new ForbiddenException('Only the host, a co-host or whoever started it can stop the recording');
      if (r.status === 'CONSENT') {
        await db.query(`UPDATE meeting_recordings SET status = 'CANCELLED', staging_key = NULL, detail = 'Cancelled before it started', updated_at = now() WHERE id = $1`, [id]);
        await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RECORDING_CANCELLED', entityType: 'MEETING_RECORDING', entityId: id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
        return { cancelled: true as const, meetingId: m.id, everyone: await this.present(db, m.id) };
      }
      if (r.status !== 'RECORDING') throw new ConflictException('The recording is not running');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RECORDING_STOPPED', entityType: 'MEETING_RECORDING', entityId: id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return { cancelled: false as const, room: m.livekit_room_name, egressId: r.egress_id };
    });
    if (out.cancelled) this.broadcast(out.everyone, { meetingId: out.meetingId, recordingId: id, status: 'CANCELLED' });
    else await this.endEgress(user.orgId, id, out.room, out.egressId, null);
    return await this.get(user, id);
  }

  /** Ask Egress to finish; the file is processed when its "egress_ended" webhook arrives. */
  private async endEgress(orgId: string, id: string, room: string, egressId: string | null, detail: string | null): Promise<void> {
    if (egressId) {
      try { await stopRecording(liveKitConfig(), room, egressId); } catch (err) { console.error('Recording stop failed:', err instanceof Error ? err.message : 'unknown error'); }
    }
    const meetingId = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const r = await db.query<{ meeting_id: string }>(`UPDATE meeting_recordings SET status = 'PROCESSING', ended_at = COALESCE(ended_at, now()), detail = COALESCE($2, detail), updated_at = now() WHERE id = $1 AND status = 'RECORDING' RETURNING meeting_id`, [id, detail]);
      return r.rows[0]?.meeting_id ?? null;
    });
    if (meetingId) this.broadcast(await this.everyone(orgId, meetingId, id), { meetingId, recordingId: id, status: 'PROCESSING' });
  }

  private async everyone(orgId: string, meetingId: string, recId: string): Promise<string[]> {
    return await this.prisma.runWithTenantContext(orgId, async (db) => {
      const r = await this.rec(db, recId);
      return [...(await this.present(db, meetingId)), ...r.required_user_ids];
    });
  }

  /** LiveKit egress webhooks. Returns the recording to process once the file is complete. */
  async onEgress(db: pg.PoolClient, orgId: string, info: LkEgressInfo): Promise<{ process: string | null; meetingId: string; recordingId: string; status: RecordingStatus } | null> {
    const r = (await db.query<RecRow>(`SELECT * FROM meeting_recordings WHERE egress_id = $1 FOR UPDATE`, [info.egressId])).rows[0];
    if (!r || r.org_id !== orgId) return null;
    const ended = ['EGRESS_COMPLETE', 'EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED'].includes(info.status);
    if (!ended || !['RECORDING', 'PROCESSING'].includes(r.status)) return null;
    const hasFile = !!info.file && info.file.size > 0;
    if (info.status === 'EGRESS_COMPLETE' || (info.status === 'EGRESS_LIMIT_REACHED' && hasFile)) {
      await db.query(`UPDATE meeting_recordings SET status = 'PROCESSING', ended_at = COALESCE(ended_at, now()), duration_seconds = $2, updated_at = now() WHERE id = $1`, [r.id, info.file?.durationSeconds ?? null]);
      return { process: r.id, meetingId: r.meeting_id, recordingId: r.id, status: 'PROCESSING' };
    }
    // The error text is LiveKit's and may name storage settings: it is not stored.
    await db.query(`UPDATE meeting_recordings SET status = 'FAILED', ended_at = COALESCE(ended_at, now()), detail = 'The recording service stopped with an error', updated_at = now() WHERE id = $1`, [r.id]);
    await appendAuditEntry(db, { orgId, actorId: r.started_by, action: 'RECORDING_FAILED', entityType: 'MEETING_RECORDING', entityId: r.id, after: { egressStatus: info.status, system: true } });
    return { process: null, meetingId: r.meeting_id, recordingId: r.id, status: 'FAILED' };
  }

  /** After a webhook transaction: tell the room, and encrypt a finished file. */
  async afterEgress(orgId: string, e: { process: string | null; meetingId: string; recordingId: string; status: RecordingStatus }): Promise<void> {
    this.broadcast(await this.everyone(orgId, e.meetingId, e.recordingId), { meetingId: e.meetingId, recordingId: e.recordingId, status: e.status });
    if (e.process) await this.jobs.dispatchRecording(orgId, e.process);
  }

  /** Participant joined while recording without having agreed (an old token): remove them at once. */
  async enforceOnJoin(orgId: string, meetingId: string, userId: string, room: string): Promise<void> {
    const blocker = await this.prisma.runWithTenantContext(orgId, async (db) => {
      const r = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM meeting_recordings WHERE meeting_id = $1 AND status IN ('CONSENT', 'RECORDING') LIMIT 1`, [meetingId])).rows[0];
      if (!r) return null;
      return (await this.hasConsented(db, r.id, userId)) ? null : r;
    });
    if (!blocker) return;
    if (blocker.status === 'CONSENT') { await this.evaluate(orgId, blocker.id); return; }
    try { await roomService(liveKitConfig(), 'RemoveParticipant', room, { identity: userId }); } catch { /* already gone */ }
    this.gateway.notifyUser(userId, 'meeting:removed', { meetingId, reason: 'RECORDING_CONSENT', recordingId: blocker.id });
  }

  // ------------------------------------------------------------------ processing (encrypt) and access

  /** Staging MP4 -> encrypted object; the staging copy is deleted. Idempotent. */
  async process(orgId: string, id: string): Promise<void> {
    const r = await this.prisma.runWithTenantContext(orgId, (db) => this.rec(db, id));
    if (r.status !== 'PROCESSING' || !r.staging_key) return;
    let size: number;
    try { size = await this.store.size(r.staging_key); } catch {
      await this.prisma.runWithTenantContext(orgId, (db) => db.query(`UPDATE meeting_recordings SET status = 'FAILED', staging_key = NULL, detail = 'The recorded file did not arrive', updated_at = now() WHERE id = $1 AND status = 'PROCESSING'`, [id]));
      return;
    }
    const dek = generateDek();
    try {
      const wrapped = await this.keys.wrap(dek, { orgId, documentId: id, purpose: 'recording' });
      const hash = createHash('sha256');
      const tap = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); cb(null, chunk); } });
      const enc = createEncryptStream(dek);
      const source = await this.store.stream(r.staging_key);
      source.on('error', (err) => enc.stream.destroy(err));
      tap.on('error', (err) => enc.stream.destroy(err));
      const storedKey = recordingKeys.stored(orgId, id);
      await this.store.put(storedKey, source.pipe(tap).pipe(enc.stream), size);
      const { iv, authTag } = enc.result();
      await this.prisma.runWithTenantContext(orgId, async (db) => {
        const days = (await db.query<{ d: number }>(`SELECT retention_recordings_days AS d FROM organizations WHERE id = $1`, [orgId])).rows[0]!.d;
        const upd = await db.query(
          `UPDATE meeting_recordings SET status = 'READY', storage_key = $2, dek_wrapped = $3, key_id = $4, iv = $5, auth_tag = $6, sha256 = $7, size_bytes = $8,
             expires_at = $9, staging_key = NULL, updated_at = now() WHERE id = $1 AND status = 'PROCESSING'`,
          [id, storedKey, wrapped.wrapped, wrapped.keyId, iv, authTag, hash.digest('hex'), size, recordingExpiry(r.ended_at ?? new Date(), days)]);
        if (upd.rowCount) await appendAuditEntry(db, { orgId, actorId: r.started_by, action: 'RECORDING_READY', entityType: 'MEETING_RECORDING', entityId: id, after: { sizeBytes: size, retentionDays: days, system: true } });
      });
      await this.store.remove(r.staging_key).catch(() => undefined);
    } finally { dek.fill(0); }
    this.broadcast(await this.everyone(orgId, r.meeting_id, id), { meetingId: r.meeting_id, recordingId: id, status: 'READY' });
  }

  async get(user: AuthenticatedUser, id: string): Promise<Recording> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.rec(db, id);
      const m = await this.meeting(db, r.meeting_id);
      const role = await this.roleOf(db, m, user.id);
      if (role === 'NONE' && !r.required_user_ids.includes(user.id) && !(await this.hasConsented(db, id, user.id))) {
        // Someone at the join gate may read the request they are asked about.
        const blocker = await this.joinBlocker(db, m.id, user.id);
        if (blocker !== id) throw new NotFoundException('Recording not found');
      }
      return await this.toDto(db, user, r, role);
    });
  }

  async list(user: AuthenticatedUser, meetingId: string): Promise<{ items: Recording[]; enabled: boolean }> {
    return await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const m = await this.meeting(db, meetingId);
      const role = await this.roleOf(db, m, user.id);
      const rows = (await db.query<RecRow>(`SELECT * FROM meeting_recordings WHERE meeting_id = $1 AND status <> 'DELETED' ORDER BY created_at DESC LIMIT 100`, [meetingId])).rows;
      const items: Recording[] = [];
      for (const r of rows) {
        // Listed for moderators and for the people who were asked; other invitees do not see it.
        if (role !== 'HOST' && role !== 'COHOST' && !r.required_user_ids.includes(user.id)) continue;
        items.push(await this.toDto(db, user, r, role));
      }
      if (role === 'NONE' && !items.length) {
        const took = await db.query(`SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2 LIMIT 1`, [meetingId, user.id]);
        if (!took.rowCount) throw new NotFoundException('Meeting not found');
      }
      return { items, enabled: await this.enabled(db, user.orgId) };
    });
  }

  /** Decrypting stream of a READY recording for someone allowed to watch; every opening is audited. */
  async content(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<RecordingFile> {
    const r = await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const rec = await this.rec(db, id);
      const m = await this.meeting(db, rec.meeting_id);
      const role = await this.roleOf(db, m, user.id);
      if (!canWatchRecording({ role, consented: await this.hasConsented(db, id, user.id) })) throw new NotFoundException('Recording not found');
      if (rec.status !== 'READY') throw new ConflictException('The recording is not ready');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RECORDING_VIEWED', entityType: 'MEETING_RECORDING', entityId: id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
      return { rec, title: m.title };
    });
    const dek = await this.keys.unwrap(r.rec.dek_wrapped!, r.rec.key_id!, { orgId: user.orgId, documentId: id, purpose: 'recording' });
    try {
      const dec = createDecryptStream(dek, r.rec.iv!, r.rec.auth_tag!);
      const source = await this.store.stream(r.rec.storage_key!);
      source.on('error', (err) => dec.destroy(err));
      const day = (r.rec.started_at ?? r.rec.created_at).toISOString().slice(0, 10);
      return { stream: source.pipe(dec), sizeBytes: Number(r.rec.size_bytes), fileName: `${r.title.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80) || 'meeting'} ${day}.mp4` };
    } finally { dek.fill(0); }
  }

  /** Crypto-shred: object and key are destroyed; the row and the consent log stay as history. */
  async remove(user: AuthenticatedUser, id: string, ctx: RequestContext): Promise<Recording> {
    await this.prisma.runWithTenantContext(user.orgId, async (db) => {
      const r = await this.rec(db, id, true);
      const role = await this.roleOf(db, await this.meeting(db, r.meeting_id), user.id);
      if (role !== 'HOST' && role !== 'COHOST') throw new ForbiddenException('Only the host or a co-host can delete a recording');
      if (!['READY', 'FAILED', 'CANCELLED'].includes(r.status)) throw new ConflictException('Stop the recording first');
      await this.shred(db, r, 'Deleted by the host');
      await appendAuditEntry(db, { orgId: user.orgId, actorId: user.id, action: 'RECORDING_DELETED', entityType: 'MEETING_RECORDING', entityId: id, ip: ctx.ip ?? undefined, userAgent: ctx.userAgent ?? undefined });
    });
    return await this.get(user, id);
  }

  private async shred(db: pg.PoolClient, r: RecRow, detail: string): Promise<void> {
    for (const k of [r.storage_key, r.staging_key]) if (k) await this.store.remove(k).catch(() => undefined);
    await db.query(`UPDATE meeting_recordings SET status = 'DELETED', storage_key = NULL, staging_key = NULL, dek_wrapped = NULL, key_id = NULL, detail = $2, updated_at = now() WHERE id = $1`, [r.id, detail]);
  }

  /** Every 5 minutes: expire unanswered requests, retry stuck processing, shred expired recordings. */
  async maintenance(now = new Date()): Promise<{ expired: number; shredded: number; retried: number }> {
    const orgs = (await this.prisma.getPool().query<{ id: string }>(`SELECT id FROM fn_list_orgs_for_jobs()`)).rows.map((o) => o.id);
    let expired = 0; let shredded = 0; let retried = 0;
    for (const orgId of orgs) {
      const work = await this.prisma.runWithTenantContext(orgId, async (db) => ({
        consent: (await db.query<{ id: string }>(`SELECT id FROM meeting_recordings WHERE status = 'CONSENT' AND consent_deadline <= $1`, [now])).rows.map((r) => r.id),
        stuck: (await db.query<{ id: string }>(`SELECT id FROM meeting_recordings WHERE status = 'PROCESSING' AND updated_at < $1::timestamptz - interval '10 minutes'`, [now])).rows.map((r) => r.id),
        due: (await db.query<RecRow>(`SELECT * FROM meeting_recordings WHERE status = 'READY' AND expires_at <= $1`, [now])).rows,
      }));
      for (const id of work.consent) { await this.evaluate(orgId, id); expired += 1; }
      for (const id of work.stuck) { await this.process(orgId, id).catch((err: unknown) => console.error('Recording processing failed:', err instanceof Error ? err.message : 'unknown error')); retried += 1; }
      for (const r of work.due) {
        await this.prisma.runWithTenantContext(orgId, async (db) => {
          await this.shred(db, r, 'Deleted at the end of the retention period');
          await appendAuditEntry(db, { orgId, actorId: r.started_by, action: 'RECORDING_EXPIRED', entityType: 'MEETING_RECORDING', entityId: r.id, after: { system: true } });
        });
        shredded += 1;
      }
    }
    return { expired, shredded, retried };
  }
}
