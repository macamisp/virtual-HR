/**
 * Hands a finished recording to encryption (ADR 024): a BullMQ job (retried with backoff), or in
 * the background when JOBS_ENABLED=false, so a LiveKit webhook is never held up. Implemented by JobsService.
 */
export const RECORDING_DISPATCHER = Symbol('RECORDING_DISPATCHER');

export interface RecordingDispatcher {
  dispatchRecording(orgId: string, recordingId: string): Promise<void>;
}
