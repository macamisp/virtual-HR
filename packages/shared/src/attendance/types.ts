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
  CANCELLED: 'CANCELLED',
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
  paidBreakMinutesPerDay: number;        // default 60 (FR-ATT-007 paid break allowance)
  orgTimezone: string;                   // default Asia/Colombo
  maxCorrectionAgeDays?: number;         // default 7 days
  currentNoticeVersion?: string;         // default 'v1.0.0'
}

export const DEFAULT_ATTENDANCE_CONFIG: AttendanceConfig = {
  heartbeatIntervalSeconds: 30,
  missedHeartbeatTimeoutSeconds: 90,
  disconnectGraceWindowSeconds: 120,
  idleThresholdSeconds: 300,
  pauseThresholdSeconds: 900,
  maxSessionLengthSeconds: 14 * 3600,
  paidBreakMinutesPerDay: 60,
  orgTimezone: 'Asia/Colombo',
  maxCorrectionAgeDays: 7,
  currentNoticeVersion: 'v1.0.0',
};

export interface StateMachineTransitionResult {
  session: AttendanceSession;
  previousState: AttendanceState;
  currentState: AttendanceState;
  actionTaken: string;
  splitSession?: AttendanceSession; // Used on midnight split
}

export const UserRole = {
  EMPLOYEE: 'EMPLOYEE',
  SUBCONTRACTOR: 'SUBCONTRACTOR',
  INTERN: 'INTERN',
  TEAM_LEAD: 'TEAM_LEAD',
  MANAGER: 'MANAGER',
  HR: 'HR',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const CorrectionStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type CorrectionStatus = (typeof CorrectionStatus)[keyof typeof CorrectionStatus];

export interface AttendanceCorrection {
  id: string;
  orgId: string;
  userId: string;
  sessionId?: string | null;
  requestedIn: Date;
  requestedOut: Date;
  reason: string;
  evidenceDocumentId?: string | null;
  status: CorrectionStatus;
  reviewerId?: string | null;
  reviewedAt?: Date | null;
  reviewNote?: string | null;
  createdAt: Date;
}

export interface WorkScheduleDay {
  start: string; // "09:00"
  end: string;   // "17:00"
  expectedHours: number; // 8
}

export interface WorkSchedule {
  id: string;
  orgId: string;
  userId?: string | null;
  teamId?: string | null;
  days: Record<string, WorkScheduleDay>; // "1".."7" (1 = Monday)
  flexible: boolean;
  graceMinutes: number; // default 10
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
}

export interface IHolidayProvider {
  isHoliday(orgId: string, date: string): Promise<boolean>;
}

export interface ILeaveProvider {
  isUserOnApprovedLeave(orgId: string, userId: string, date: string): Promise<boolean>;
}

export class InMemoryHolidayProvider implements IHolidayProvider {
  private holidays = new Set<string>();
  constructor(holidays: string[] = []) {
    for (const h of holidays) this.holidays.add(h);
  }
  addHoliday(orgId: string, date: string): void {
    this.holidays.add(`${orgId}:${date}`);
  }
  async isHoliday(orgId: string, date: string): Promise<boolean> {
    return this.holidays.has(`${orgId}:${date}`) || this.holidays.has(date);
  }
}

export class InMemoryLeaveProvider implements ILeaveProvider {
  private leaves = new Set<string>();
  addLeave(orgId: string, userId: string, date: string): void {
    this.leaves.add(`${orgId}:${userId}:${date}`);
  }
  async isUserOnApprovedLeave(orgId: string, userId: string, date: string): Promise<boolean> {
    return this.leaves.has(`${orgId}:${userId}:${date}`);
  }
}

export interface ScheduleComplianceResult {
  workDate: string;
  userId: string;
  isWorkingDay: boolean;
  isHoliday: boolean;
  isOnLeave: boolean;
  expectedSeconds: number;
  actualSeconds: number;
  lateArrivalMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  isAbsent: boolean;
  flags: string[];
}

export const DayStatus = {
  PRESENT: 'PRESENT',
  LATE: 'LATE',
  EARLY_LEAVE: 'EARLY_LEAVE',
  HALF_DAY: 'HALF_DAY',
  ABSENT: 'ABSENT',
  LEAVE: 'LEAVE',
  HOLIDAY: 'HOLIDAY',
  REST_DAY: 'REST_DAY',
} as const;
export type DayStatus = (typeof DayStatus)[keyof typeof DayStatus];

export interface AttendanceDaily {
  orgId: string;
  userId: string;
  workDate: string; // YYYY-MM-DD
  firstIn: Date | null;
  lastOut: Date | null;
  activeSeconds: number;
  idleSeconds: number;
  breakSeconds: number;
  meetingSeconds: number;
  netSeconds: number;
  expectedSeconds: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  dayStatus: DayStatus;
  displayName?: string;
  email?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface DraftTimesheet {
  id: string;
  orgId: string;
  userId: string;
  workDate: string;
  periodStart: string;
  periodEnd: string;
  status: string; // DRAFT
  attendanceMinutes: number;
  loggedMinutes: number;
  billableMinutes: number;
  varianceMinutes: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export const LivePresenceStatus = {
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',
  ON_BREAK: 'ON_BREAK',
  IN_MEETING: 'IN_MEETING',
  ON_LEAVE: 'ON_LEAVE',
  OFFLINE: 'OFFLINE',
} as const;
export type LivePresenceStatus = (typeof LivePresenceStatus)[keyof typeof LivePresenceStatus];

export interface LiveBoardUser {
  userId: string;
  displayName: string;
  email: string;
  teamId?: string | null;
  role: string;
  status: LivePresenceStatus;
  currentSessionId?: string | null;
  clockInAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  todayNetSeconds: number;
  hasClockedInToday: boolean;   // distinguishes "signed out" from "not yet in"
}

export interface LiveBoardFilter {
  teamId?: string;
}

export interface AttendanceExportFilter {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  teamId?: string;
  userId?: string;
}

export interface AuditLogEntry {
  id?: number;
  orgId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | unknown[] | number | string | boolean | null;
  after?: Record<string, unknown> | unknown[] | number | string | boolean | null;
  ip?: string | null;
  userAgent?: string | null;
  prevHash: string;
  hash: string;
  createdAt: Date;
}

export interface MonitoringConsent {
  id: string;
  orgId: string;
  userId: string;
  noticeVersion: string;
  acceptedAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export interface TransparencyInfo {
  plainLanguageNotice: string;
  noticeVersion: string;
  collectedFields: string[];
  retentionDays: number;
  events: Array<{
    id: number | string;
    serverTs: Date;
    eventType: string;
    state: string;
    seq: number;
    ip?: string | null;
    meta?: Record<string, unknown>;
  }>;
}

