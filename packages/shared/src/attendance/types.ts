/**
 * HRVO Attendance Domain Types & Interfaces
 * Ref: docs/SRS.md Section 5.5 (FR-ATT-001..005) & Section 6
 * Compatible with Node.js 22 type stripping (const objects instead of legacy enums)
 */

export const AttendanceState = {
  OFFLINE: 'OFFLINE',
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',
  PAUSED: 'PAUSED',
  IN_MEETING: 'IN_MEETING',
  ON_BREAK: 'ON_BREAK',
  DISCONNECTED: 'DISCONNECTED', // Grace period state
} as const;
export type AttendanceState = (typeof AttendanceState)[keyof typeof AttendanceState];

export const ClockInSource = {
  AUTO_HEARTBEAT: 'AUTO_HEARTBEAT',
  AUTO_LOGIN: 'AUTO_LOGIN',
  AGENT: 'AGENT',
  CORRECTION: 'CORRECTION',
} as const;
export type ClockInSource = (typeof ClockInSource)[keyof typeof ClockInSource];

export const ClockOutSource = {
  LOGOUT: 'LOGOUT',
  DISCONNECT: 'DISCONNECT',
  TIMEOUT: 'TIMEOUT',
  MIDNIGHT: 'MIDNIGHT',
  MAX_LENGTH: 'MAX_LENGTH',
  AGENT: 'AGENT',
  CORRECTION: 'CORRECTION',
} as const;
export type ClockOutSource = (typeof ClockOutSource)[keyof typeof ClockOutSource];

export const SessionStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  ADJUSTED: 'ADJUSTED',
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface HeartbeatPayload {
  orgId: string;
  userId: string;
  deviceId: string;
  sessionId: string;      // Bound to the specific user session (FR-ATT-003, Section 6.3)
  sequenceNumber: number;
  nonce: string;
  activeSeconds: number; // Input activity in interval (0..30)
  idleSeconds: number;   // Inactivity in interval (0..30)
  tabVisible: boolean;
  windowFocused: boolean;
  inCall: boolean;
  meetingId?: string;
  clientTimestamp?: number; // Ignored for server clock
  signature: string;        // HMAC-SHA256 signature
}

export interface AttendanceSegment {
  id: string;
  state: AttendanceState;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  meetingId?: string | null;
  flags: string[];
}

export interface AttendanceSession {
  id: string;
  orgId: string;
  userId: string;
  deviceId: string;
  workDate: string; // YYYY-MM-DD
  clockInAt: Date;  // Server time UTC
  clockOutAt: Date | null;
  clockInSource: ClockInSource;
  clockOutSource: ClockOutSource | null;
  activeSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
  meetingSeconds: number;
  netSeconds: number;
  lastHeartbeatAt: Date;
  ipIn: string;
  ipOut: string | null;
  flags: string[];
  status: SessionStatus;
  currentState: AttendanceState;
  previousState?: AttendanceState;
  segments: AttendanceSegment[];
  graceTimerExpiresAt?: Date | null;
  consecutiveIdleSeconds: number;
}

export interface AttendanceConfig {
  heartbeatIntervalSeconds: number;     // default 30
  missedHeartbeatTimeoutSeconds: number; // default 90
  disconnectGraceWindowSeconds: number;  // default 120
  idleThresholdSeconds: number;          // default 300 (5 min)
  pauseThresholdSeconds: number;         // default 900 (15 min)
  maxSessionLengthSeconds: number;       // default 50400 (14 hours)
  orgTimezone: string;                   // default Asia/Colombo
}

export const DEFAULT_ATTENDANCE_CONFIG: AttendanceConfig = {
  heartbeatIntervalSeconds: 30,
  missedHeartbeatTimeoutSeconds: 90,
  disconnectGraceWindowSeconds: 120,
  idleThresholdSeconds: 300,
  pauseThresholdSeconds: 900,
  maxSessionLengthSeconds: 14 * 3600,
  orgTimezone: 'Asia/Colombo',
};

export interface StateMachineTransitionResult {
  session: AttendanceSession;
  previousState: AttendanceState;
  currentState: AttendanceState;
  actionTaken: string;
  splitSession?: AttendanceSession; // Used on midnight split
}
