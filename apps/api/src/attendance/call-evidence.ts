import type { CallKind } from '../../../../packages/shared/src/attendance/types.ts';

/**
 * ADR 049 §1b (FR-WT-001, FR-WT-002): the server's answer to "is this person really in a call with
 * someone?". Returns the kind of call, or null when the claim is not backed by server state
 * (alone in a room, a group of one, a meeting that is not live, nobody else connected).
 */
export interface CallEvidence {
  verify(q: { orgId: string; userId: string; meetingId: string | null; at: Date }): Promise<CallKind | null>;
}
