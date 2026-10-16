'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentDeviceListSchema, AgentDeviceSchema, PairingCodeSchema } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');
const KEY = ['agent', 'devices'] as const;

/** FR-ATT-011 (ADR 018): your paired desktop agents. */
export function useAgentDevices() {
  return useQuery({ queryKey: KEY, queryFn: () => apiFetch('/agent/devices', { schema: AgentDeviceListSchema }), enabled: useSignedIn(), refetchInterval: 15_000 });
}

export function useCreatePairingCode() {
  return useMutation({ mutationFn: () => apiFetch('/agent/pairing-codes', { method: 'POST', schema: PairingCodeSchema }) });
}

export function useRevokeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/agent/devices/${encodeURIComponent(id)}`, { method: 'DELETE', schema: AgentDeviceSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
