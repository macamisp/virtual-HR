'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AttendanceReportSchema,
  ComplianceReportSchema,
  ComplianceRequirementsSchema,
  CostReportSchema,
  DashboardSchema,
  TaskReportSchema,
} from '@hrvo/shared';
import type { ComplianceRequirementsDto, ReportFormat } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export type ReportKind = 'attendance' | 'hours-cost' | 'tasks' | 'compliance';

export interface ReportFilters {
  from: string;
  to: string;
  groupBy?: string;
  teamId?: string;
  userId?: string;
  projectId?: string;
  onlyIssues?: boolean;
}

/** Query string for a report; `compliance` has no date range. */
export function reportQuery(kind: ReportKind, f: ReportFilters, format?: ReportFormat): string {
  const p = new URLSearchParams();
  if (kind !== 'compliance') {
    p.set('from', f.from);
    p.set('to', f.to);
    if (f.groupBy) p.set('groupBy', f.groupBy);
  } else if (f.onlyIssues) p.set('onlyIssues', 'true');
  if (f.teamId) p.set('teamId', f.teamId);
  if (f.userId) p.set('userId', f.userId);
  if (f.projectId) p.set('projectId', f.projectId);
  if (format) p.set('format', format);
  return p.toString();
}

export function useDashboard(enabled: boolean) {
  return useQuery({ queryKey: ['reports', 'dashboard'], queryFn: () => apiFetch('/reports/dashboard', { schema: DashboardSchema }), enabled: useSignedIn() && enabled, refetchInterval: 60_000 });
}

export function useAttendanceReport(f: ReportFilters, enabled: boolean) {
  const q = reportQuery('attendance', f);
  return useQuery({ queryKey: ['reports', 'attendance', q], queryFn: () => apiFetch(`/reports/attendance?${q}`, { schema: AttendanceReportSchema }), enabled: useSignedIn() && enabled && f.from <= f.to });
}

export function useCostReport(f: ReportFilters, enabled: boolean) {
  const q = reportQuery('hours-cost', f);
  return useQuery({ queryKey: ['reports', 'hours-cost', q], queryFn: () => apiFetch(`/reports/hours-cost?${q}`, { schema: CostReportSchema }), enabled: useSignedIn() && enabled && f.from <= f.to });
}

export function useTaskReport(f: ReportFilters, enabled: boolean) {
  const q = reportQuery('tasks', f);
  return useQuery({ queryKey: ['reports', 'tasks', q], queryFn: () => apiFetch(`/reports/tasks?${q}`, { schema: TaskReportSchema }), enabled: useSignedIn() && enabled && f.from <= f.to });
}

export function useComplianceReport(f: ReportFilters, enabled: boolean) {
  const q = reportQuery('compliance', f);
  return useQuery({ queryKey: ['reports', 'compliance', q], queryFn: () => apiFetch(`/reports/compliance?${q}`, { schema: ComplianceReportSchema }), enabled: useSignedIn() && enabled });
}

export function useComplianceRequirements(enabled: boolean) {
  return useQuery({ queryKey: ['reports', 'compliance', 'requirements'], queryFn: () => apiFetch('/reports/compliance/requirements', { schema: ComplianceRequirementsSchema }), enabled: useSignedIn() && enabled });
}

export function useSaveComplianceRequirements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: ComplianceRequirementsDto) => apiFetch('/reports/compliance/requirements', { method: 'PUT', body: dto, schema: ComplianceRequirementsSchema }),
    onSuccess: (r) => {
      qc.setQueryData(['reports', 'compliance', 'requirements'], r);
      void qc.invalidateQueries({ queryKey: ['reports', 'compliance'] });
    },
  });
}
