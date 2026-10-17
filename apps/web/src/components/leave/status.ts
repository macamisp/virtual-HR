import type { LeaveRequest } from '@hrvo/shared';

/** FR-ORG-010: how each leave status is shown (shared by the request and review pages). */
export const LEAVE_STATUS: Record<LeaveRequest['status'], { label: string; variant: 'secondary' | 'success' | 'destructive' | 'outline' }> = {
  PENDING: { label: 'Waiting for a decision', variant: 'secondary' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Rejected', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};
