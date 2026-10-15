/**
 * FR-ADM-001 policy ranges (SRS 6.4). The heartbeat interval stays global (it is a client
 * protocol constant); everything else is per organisation.
 */
import type { AttendanceConfig } from '../../../../packages/shared/src/attendance/types.ts';

export type AttendancePolicy = Pick<
  AttendanceConfig,
  'missedHeartbeatTimeoutSeconds' | 'disconnectGraceWindowSeconds' | 'idleThresholdSeconds' | 'pauseThresholdSeconds' | 'maxSessionLengthSeconds' | 'paidBreakMinutesPerDay'
>;

export const POLICY_RANGES: Record<keyof AttendancePolicy, { min: number; max: number; label: string }> = {
  missedHeartbeatTimeoutSeconds: { min: 60, max: 180, label: 'Missed-heartbeat timeout' },
  disconnectGraceWindowSeconds: { min: 30, max: 300, label: 'Disconnect grace window' },
  idleThresholdSeconds: { min: 120, max: 1800, label: 'Idle threshold' },
  pauseThresholdSeconds: { min: 300, max: 3600, label: 'Pause threshold' },
  maxSessionLengthSeconds: { min: 8 * 3600, max: 18 * 3600, label: 'Maximum session length' },
  paidBreakMinutesPerDay: { min: 0, max: 240, label: 'Paid break per day' },
};

/** Problems with a (partial) policy; empty when valid. */
export function validateAttendancePolicy(p: Partial<AttendancePolicy>): string[] {
  const errors: string[] = [];
  for (const [key, range] of Object.entries(POLICY_RANGES) as Array<[keyof AttendancePolicy, (typeof POLICY_RANGES)[keyof AttendancePolicy]]>) {
    const v = p[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < range.min || v > range.max) errors.push(`${range.label} must be between ${range.min} and ${range.max}`);
  }
  const idle = p.idleThresholdSeconds ?? 300;
  const pause = p.pauseThresholdSeconds ?? 900;
  if (pause <= idle) errors.push('The pause threshold must be longer than the idle threshold');
  return errors;
}
