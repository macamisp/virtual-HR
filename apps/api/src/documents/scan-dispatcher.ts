/**
 * Hands a completed upload to the scanner: a BullMQ job (retried with backoff while clamd is
 * down), or inline when JOBS_ENABLED=false. Implemented by JobsService.
 */
export const SCAN_DISPATCHER = Symbol('SCAN_DISPATCHER');

export interface ScanDispatcher {
  dispatchScan(orgId: string, versionId: string): Promise<void>;
}
