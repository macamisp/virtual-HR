'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CONSENT_NOTICES, RecordingListSchema, RecordingSchema } from '@hrvo/shared';
import { apiDownload, apiFetch } from './api';
import { useAuthStore } from './auth-store';
import { meetingKeys } from './meeting-queries';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const enc = encodeURIComponent;
export const recordingKeys = { list: (meetingId: string) => ['meetings', 'recordings', meetingId] as const };

/** FR-MEET-007 (ADR 024): the recordings of a meeting this viewer may see. */
export function useRecordings(meetingId: string, enabled = true) {
  return useQuery({ queryKey: recordingKeys.list(meetingId), queryFn: () => apiFetch(`/meetings/${enc(meetingId)}/recordings`, { schema: RecordingListSchema }), enabled: useSignedIn() && enabled });
}

function useRefresh(meetingId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: meetingKeys.detail(meetingId) });
    void qc.invalidateQueries({ queryKey: recordingKeys.list(meetingId) });
  };
}

export function useStartRecording(meetingId: string) {
  const refresh = useRefresh(meetingId);
  return useMutation({ mutationFn: () => apiFetch(`/meetings/${enc(meetingId)}/recordings`, { method: 'POST', schema: RecordingSchema }), onSuccess: refresh });
}

/** Answers with the notice version the person was shown. */
export function answerRecording(recordingId: string, granted: boolean) {
  return apiFetch(`/recordings/${enc(recordingId)}/consent`, { method: 'POST', body: { granted, noticeVersion: CONSENT_NOTICES.RECORDING.version }, schema: RecordingSchema });
}

export function useRecordingConsent(meetingId: string) {
  const refresh = useRefresh(meetingId);
  return useMutation({ mutationFn: (v: { recordingId: string; granted: boolean }) => answerRecording(v.recordingId, v.granted), onSuccess: refresh });
}

export function useRecordingAction(meetingId: string, action: 'stop' | 'delete') {
  const refresh = useRefresh(meetingId);
  return useMutation({
    mutationFn: (recordingId: string) => action === 'stop'
      ? apiFetch(`/recordings/${enc(recordingId)}/stop`, { method: 'POST', schema: RecordingSchema })
      : apiFetch(`/recordings/${enc(recordingId)}`, { method: 'DELETE', schema: RecordingSchema }),
    onSuccess: refresh,
  });
}

/** The decrypted MP4 as a blob (the API streams it after checking who may watch). */
export async function fetchRecording(recordingId: string): Promise<{ blob: Blob; filename: string }> {
  return await apiDownload(`/recordings/${enc(recordingId)}/content`);
}
