'use client';

import { useState } from 'react';
import type { Project } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { FormField } from '@/components/form-field';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Permission, useCan } from '@/lib/permissions';
import { useAuthStore } from '@/lib/auth-store';
import { useCreateProject, useProjectCandidates, useProjectMembers, useProjectMembership, useProjects } from '@/lib/task-queries';

/** Minimal project administration (SRS 7.4 projects / project_members). */
export default function ProjectsPage() {
  const canManage = useCan(Permission.PROJECTS_MANAGE);
  const projects = useProjects();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Projects</h1>
      {canManage ? <CreateProject /> : null}
      {projects.isPending ? <LoadingState label="Loading projects" /> : null}
      {projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : null}
      {projects.data && projects.data.length === 0 ? (
        <EmptyState title="No projects" description={canManage ? 'Create the first project above.' : 'You are not a member of any project yet.'} />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(projects.data ?? []).map((p) => (
          <ProjectCard key={p.id} project={p} expanded={selected === p.id} onToggle={() => setSelected((s) => (s === p.id ? null : p.id))} />
        ))}
      </div>
    </div>
  );
}

function CreateProject() {
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [client, setClient] = useState('');
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">New project</CardTitle></CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name: name.trim(), code: code.trim().toUpperCase(), clientName: client.trim() || null }, {
              onSuccess: () => { setName(''); setCode(''); setClient(''); },
            });
          }}
        >
          <FormField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <FormField label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={30} required />
          <FormField label="Client (optional)" value={client} onChange={(e) => setClient(e.target.value)} />
          <Button type="submit" disabled={create.isPending || name.trim().length < 2 || code.trim().length < 2}>Create</Button>
        </form>
        {create.isError ? <Alert variant="destructive" className="mt-3"><AlertDescription>{create.error.message}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  );
}

function ProjectCard({ project, expanded, onToggle }: { project: Project; expanded: boolean; onToggle: () => void }) {
  const me = useAuthStore((s) => s.user?.id);
  const canManage = useCan(Permission.PROJECTS_MANAGE) || project.manager?.id === me;
  return (
    <Card data-testid={`project-${project.code}`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{project.code} · {project.name}</span>
          <Badge variant={project.status === 'ACTIVE' ? 'success' : 'secondary'}>{project.status.replace('_', ' ').toLowerCase()}</Badge>
        </CardTitle>
        <CardDescription>
          {project.clientName ? `${project.clientName} · ` : ''}
          {project.manager ? `Managed by ${project.manager.displayName ?? project.manager.email} · ` : ''}
          {project.memberCount} member{project.memberCount === 1 ? '' : 's'}
          {project.isMember ? ' · you are a member' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="sm" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Hide members' : 'Members'}</Button>
        {expanded ? <Members projectId={project.id} canManage={canManage} /> : null}
      </CardContent>
    </Card>
  );
}

function Members({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const members = useProjectMembers(projectId);
  const candidates = useProjectCandidates(canManage);
  const change = useProjectMembership(projectId);
  const [pick, setPick] = useState('');
  const memberIds = new Set((members.data ?? []).map((m) => m.id));
  return (
    <div className="mt-3 space-y-3">
      {members.isPending ? <LoadingState label="Loading members" rows={2} /> : null}
      {members.isError ? <ErrorState error={members.error} /> : null}
      <ul className="divide-y text-sm">
        {(members.data ?? []).map((m) => (
          <li key={m.id} className="flex items-center justify-between py-1.5">
            <span>{m.displayName ?? m.email} <span className="text-xs text-muted-foreground">{m.role.toLowerCase()}</span></span>
            {canManage ? <Button size="sm" variant="ghost" onClick={() => change.mutate({ userId: m.id, remove: true })}>Remove</Button> : null}
          </li>
        ))}
      </ul>
      {members.data && members.data.length === 0 ? <p className="text-sm text-muted-foreground">No members yet.</p> : null}
      {canManage && candidates.data ? (
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (pick) change.mutate({ userId: pick }, { onSuccess: () => setPick('') }); }}>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`add-${projectId}`}>Add member</Label>
            <NativeSelect id={`add-${projectId}`} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a person</option>
              {candidates.data.filter((c) => !memberIds.has(c.id)).map((c) => (
                <option key={c.id} value={c.id}>{c.displayName ?? c.email} ({c.role.toLowerCase()})</option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="secondary" disabled={!pick || change.isPending}>Add</Button>
        </form>
      ) : null}
      {change.isError ? <p className="text-sm font-medium text-destructive">{change.error.message}</p> : null}
    </div>
  );
}
