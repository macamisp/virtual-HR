import { planOfflineSync, type OfflineInterval } from '../agent/offline-sync.ts';
/** NFR-ACC-004: replay accepted inputs; never read materialised session counters. */
import { AttendanceStateMachine } from './attendance-state-machine.ts';
import { AttendanceState, SessionStatus, type AttendanceConfig, type AttendanceSession, type HeartbeatPayload, type HeartbeatSource } from '../../../../packages/shared/src/index.ts';

export type AttendanceInput =
  | { kind: 'heartbeat'; deviceId: string; activeSeconds: number; idleSeconds: number; inCall: boolean; tabVisible: boolean; windowFocused: boolean; source: HeartbeatSource }
  | { kind: 'disconnect' | 'reconnect' | 'logout' | 'break-start' | 'break-end' | 'meeting-end' | 'grace-expired' | 'timeout' | 'max-length' | 'challenge-expired' | 'challenge-confirmed' }
  | { kind: 'meeting-start'; meetingId: string }
  | { kind: 'midnight'; splitSessionId: string }
  | { kind: 'correction'; from: string; to: string; deviceId: string }
  | { kind: 'offline'; deviceId: string; anchorServerMs: number; intervals: OfflineInterval[]; covered: Array<{ from: string; to: string }>; maxWindowSeconds: number; sessionStart: string };

export interface AttendanceInputRecord {
  sessionId: string;
  orgId: string;
  userId: string;
  at: Date;
  config: AttendanceConfig;
  input: AttendanceInput;
}

/** Events must be in insertion order, including actions backdated to the last heartbeat. */
export function replayAttendanceInputs(events: readonly AttendanceInputRecord[]): Map<string, AttendanceSession> {
  const sessions = new Map<string, AttendanceSession>();
  for (const event of events) {
    const { sessionId, orgId, userId, at, input, config } = event;
    const machine = new AttendanceStateMachine(config);
    let session = sessions.get(sessionId) ?? null;
    if (input.kind === 'heartbeat') {
      if (session?.currentState === AttendanceState.DISCONNECTED) session = machine.handleSocketReconnect(session, at).session;
      const heartbeat: HeartbeatPayload = { ...input, orgId, userId, sessionId: 'replay', sequenceNumber: 0, nonce: '', signature: '' };
      session = machine.handleHeartbeat(session, heartbeat, at, '127.0.0.1', input.source).session;
      session.id = sessionId;
    } else if (input.kind === 'correction' || input.kind === 'offline') {
      const offline = input.kind === 'offline' ? planOfflineSync({ anchorServerMs: input.anchorServerMs, intervals: input.intervals,
        nowMs: at.getTime(), covered: input.covered.map((c) => ({ start: new Date(c.from), end: new Date(c.to) })),
        maxWindowSeconds: input.maxWindowSeconds, timeZone: config.orgTimezone }).sessions.find((s) => s.start.toISOString() === input.sessionStart) : undefined;
      if (input.kind === 'offline' && !offline) throw new Error('Missing accepted offline interval in replay');
      const from = input.kind === 'correction' ? new Date(input.from) : offline!.start;
      const to = input.kind === 'correction' ? new Date(input.to) : offline!.end;
      const seconds = Math.floor((to.getTime() - from.getTime()) / 1000);
      const seed: HeartbeatPayload = { orgId, userId, sessionId: 'replay', deviceId: input.deviceId, activeSeconds: 0, idleSeconds: 0, inCall: false, tabVisible: true, windowFocused: true, sequenceNumber: 0, nonce: '', signature: '' };
      session = machine.handleHeartbeat(null, seed, from, '127.0.0.1').session;
      session.id = sessionId;
      session.clockOutAt = to;
      session.lastHeartbeatAt = to;
      session.status = SessionStatus.CLOSED;
      session.currentState = AttendanceState.OFFLINE;
      if (input.kind === 'correction') {
        session.activeSeconds = seconds;
        session.netSeconds = seconds;
      } else {
        session.segments = offline!.segments.map((s, i) => ({ id: `${sessionId}:${i}`, state: s.state === 'ACTIVE' ? AttendanceState.ACTIVE : AttendanceState.IDLE,
          startedAt: s.start, endedAt: s.end, durationSeconds: Math.round((s.end.getTime() - s.start.getTime()) / 1000), flags: ['OFFLINE_SYNCED'] }));
        session.activeSeconds = offline!.activeSeconds;
        session.idleSeconds = offline!.idleSeconds;
        session.netSeconds = session.activeSeconds;
      }
    } else {
      if (!session) throw new Error(`Missing initial attendance input for ${sessionId}`);
      switch (input.kind) {
        case 'disconnect': session = machine.handleSocketDisconnect(session, at).session; break;
        case 'reconnect': session = machine.handleSocketReconnect(session, at).session; break;
        case 'logout': session = machine.handleExplicitLogout(session, at).session; break;
        case 'break-start': session = machine.handleUserStartsBreak(session, at).session; break;
        case 'break-end': session = machine.handleUserEndsBreak(session, at).session; break;
        case 'meeting-start': session = machine.handleJoinMeeting(session, input.meetingId, at).session; break;
        case 'meeting-end': session = machine.handleLeaveMeeting(session, at).session; break;
        case 'grace-expired': session = machine.handleGraceExpiration(session, at).session; break;
        case 'timeout': session = machine.handleMissingHeartbeatTimeout(session, at).session; break;
        case 'max-length': session = machine.handleMaxLengthCheck(session, at).session; break;
        case 'challenge-expired': session = machine.handleChallengeExpiry(session, at)?.session ?? session; break;
        case 'challenge-confirmed':
          if (!session.challengeId) throw new Error('Missing presence challenge in replay');
          session = machine.handleChallengeResponse(session, session.challengeId, at).session;
          break;
        case 'midnight': {
          const result = machine.handleMidnightCheck(session, at);
          if (!result.splitSession) throw new Error('Missing midnight split in replay');
          result.splitSession.id = input.splitSessionId;
          sessions.set(input.splitSessionId, result.splitSession);
          session = result.session;
          break;
        }
      }
    }
    sessions.set(sessionId, session);
  }
  return sessions;
}
