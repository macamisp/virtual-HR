'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ProjectListSchema,
  ProjectMembersSchema,
  ProjectSchema,
  TaskActivityListSchema,
  TaskCommentListSchema,
  TaskCommentSchema,
  TaskDetailSchema,
  TaskListSchema,
  UserRefListSchema,
} from '@hrvo/shared';
import type { AttachmentDto, CreateTaskDto, ProjectDto, TaskDetail } from '@hrvo/shared';
import { apiFetch } from './api';
import { useAuthStore } from './auth-store';

export interface TaskFilters {
  scope: 'mine' | 'reported' | 'team' | 'all';
  status?: string;
  projectId?: string;
  priority?: string;
  q?: string;
  includeDone?: boolean;
  dueFrom?: string;
  dueTo?: string;
  assigneeId?: string;
}

export const taskKeys = {
  all: ['tasks'] as const,
  list: (f: TaskFilters) => ['tasks', 'list', f] as const,
  detail: (id: string) => ['tasks', 'detail', id] as const,
  comments: (id: string) => ['tasks', 'comments', id] as const,
  activity: (id: string) => ['tasks', 'activity', id] as const,
  mentionable: (id: string) => ['tasks', 'mentionable', id] as const,
  assignable: (projectId?: string) => ['tasks', 'assignable', projectId ?? null] as const,
  projects: ['projects'] as const,
  projectMembers: (id: string) => ['projects', 'members', id] as const,
  projectCandidates: ['projects', 'candidates'] as const,
};

function qs(f: TaskFilters): string {
  const p = new URLSearchParams({ scope: f.scope });
  if (f.status) p.set('status', f.status);
  if (f.projectId) p.set('projectId', f.projectId);
  if (f.priority) p.set('priority', f.priority);
  if (f.q) p.set('q', f.q);
  if (f.includeDone === false) p.set('includeDone', 'false');
  if (f.dueFrom) p.set('dueFrom', f.dueFrom);
  if (f.dueTo) p.set('dueTo', f.dueTo);
  if (f.assigneeId) p.set('assigneeId', f.assigneeId);
  return p.toString();
}

const useSignedIn = () => useAuthStore((s) => s.status === 'authenticated');

export function useTasks(f: TaskFilters, enabled = true) {
  return useQuery({
    queryKey: taskKeys.list(f),
    queryFn: () => apiFetch(`/tasks?${qs(f)}`, { schema: TaskListSchema }),
    enabled: useSignedIn() && enabled,
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: taskKeys.detail(id),
    queryFn: () => apiFetch(`/tasks/${encodeURIComponent(id)}`, { schema: TaskDetailSchema }),
    enabled: useSignedIn(),
  });
}

export function useTaskComments(id: string) {
  return useQuery({
    queryKey: taskKeys.comments(id),
    queryFn: () => apiFetch(`/tasks/${encodeURIComponent(id)}/comments`, { schema: TaskCommentListSchema }),
    enabled: useSignedIn(),
  });
}

export function useTaskActivity(id: string) {
  return useQuery({
    queryKey: taskKeys.activity(id),
    queryFn: () => apiFetch(`/tasks/${encodeURIComponent(id)}/activity`, { schema: TaskActivityListSchema }),
    enabled: useSignedIn(),
  });
}

export function useMentionable(id: string) {
  return useQuery({
    queryKey: taskKeys.mentionable(id),
    queryFn: () => apiFetch(`/tasks/${encodeURIComponent(id)}/mentionable`, { schema: UserRefListSchema }),
    enabled: useSignedIn(),
    staleTime: 60_000,
  });
}

export function useAssignable(projectId?: string) {
  return useQuery({
    queryKey: taskKeys.assignable(projectId),
    queryFn: () => apiFetch(`/tasks/assignable-users${projectId ? `?projectId=${projectId}` : ''}`, { schema: UserRefListSchema }),
    enabled: useSignedIn(),
    staleTime: 60_000,
  });
}

export function useProjects() {
  return useQuery({ queryKey: taskKeys.projects, queryFn: () => apiFetch('/projects', { schema: ProjectListSchema }), enabled: useSignedIn() });
}

/** Writes a fresh task into the cache and refreshes lists / activity. */
function useTaskWrite() {
  const qc = useQueryClient();
  return (task: TaskDetail) => {
    qc.setQueryData(taskKeys.detail(task.id), task);
    void qc.invalidateQueries({ queryKey: ['tasks', 'list'] });
    void qc.invalidateQueries({ queryKey: taskKeys.activity(task.id) });
    if (task.parentTaskId) void qc.invalidateQueries({ queryKey: taskKeys.detail(task.parentTaskId) });
  };
}

export function useCreateTask() {
  const write = useTaskWrite();
  return useMutation({
    mutationFn: (dto: Partial<CreateTaskDto> & { title: string }) => apiFetch('/tasks', { method: 'POST', body: dto, schema: TaskDetailSchema }),
    onSuccess: write,
  });
}

export function useUpdateTask(id: string) {
  const write = useTaskWrite();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown> & { version: number }) =>
      apiFetch(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, schema: TaskDetailSchema }),
    onSuccess: write,
    // On a 409 (stale version) refetch so the user sees the latest state.
    onError: () => void qc.invalidateQueries({ queryKey: taskKeys.detail(id) }),
  });
}

/** Board moves need the task id per call. */
export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number; status: string }) =>
      apiFetch(`/tasks/${encodeURIComponent(v.id)}`, { method: 'PATCH', body: { version: v.version, status: v.status }, schema: TaskDetailSchema }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['tasks', 'list'] }),
  });
}

export function useTaskAction(id: string) {
  const write = useTaskWrite();
  return useMutation({
    mutationFn: (v: { path: string; method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) =>
      apiFetch(`/tasks/${encodeURIComponent(id)}${v.path}`, { method: v.method ?? 'POST', body: v.body, schema: TaskDetailSchema }),
    onSuccess: write,
  });
}

export function useAddAttachment(id: string) {
  const action = useTaskAction(id);
  return { ...action, add: (dto: AttachmentDto) => action.mutateAsync({ path: '/attachments', body: dto }) };
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: taskKeys.all }),
  });
}

export function useAddComment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => apiFetch(`/tasks/${encodeURIComponent(id)}/comments`, { method: 'POST', body: { body }, schema: TaskCommentSchema }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: taskKeys.comments(id) });
      void qc.invalidateQueries({ queryKey: taskKeys.activity(id) });
    },
  });
}

export function useProjectMembers(id: string | null) {
  return useQuery({
    queryKey: taskKeys.projectMembers(id ?? ''),
    queryFn: () => apiFetch(`/projects/${id}/members`, { schema: ProjectMembersSchema }),
    enabled: useSignedIn() && !!id,
  });
}

export function useProjectCandidates(enabled: boolean) {
  return useQuery({
    queryKey: taskKeys.projectCandidates,
    queryFn: () => apiFetch('/projects/candidates', { schema: UserRefListSchema }),
    enabled: useSignedIn() && enabled,
    staleTime: 60_000,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: Partial<ProjectDto> & { name: string; code: string }) => apiFetch('/projects', { method: 'POST', body: dto, schema: ProjectSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: taskKeys.projects }),
  });
}

export function useProjectMembership(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userId: string; remove?: boolean }) =>
      v.remove
        ? apiFetch(`/projects/${projectId}/members/${v.userId}`, { method: 'DELETE', schema: ProjectMembersSchema })
        : apiFetch(`/projects/${projectId}/members`, { method: 'POST', body: { userId: v.userId }, schema: ProjectMembersSchema }),
    onSuccess: (members) => {
      qc.setQueryData(taskKeys.projectMembers(projectId), members);
      void qc.invalidateQueries({ queryKey: taskKeys.projects });
    },
  });
}
