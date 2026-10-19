'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { Check, Network, Pencil, Plus, Trash2, X } from 'lucide-react';
import { ROLE_LABEL } from '@hrvo/shared';
import type { OrgPerson, OrgStructure, OrgTeam, UserRole } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { personName, usePlacement, useOrgStructure, useTeamMutations } from '@/lib/org-queries';
import { Permission, useCan } from '@/lib/permissions';

const roleLabel = (role: string) => ROLE_LABEL[role as UserRole] ?? role;

/** Everyone who reports to `id`, directly or through others: they cannot become its manager. */
function below(people: OrgPerson[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const next = queue.shift()!;
    for (const p of people) if (p.managerId === next && !out.has(p.id)) { out.add(p.id); queue.push(p.id); }
  }
  return out;
}

function TeamRow({ team, active }: { team: OrgTeam; active: OrgPerson[] }) {
  const { update, remove } = useTeamMutations();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const leadId = useId();
  const error = update.error ?? remove.error;
  return (
    <TableRow data-testid={`team-${team.name}`}>
      <TableCell>
        {editing ? (
          <form className="flex items-center gap-1" aria-label={`Rename ${team.name}`} onSubmit={(e) => { e.preventDefault(); update.mutate({ id: team.id, dto: { name } }, { onSuccess: () => setEditing(false) }); }}>
            <Input aria-label="Team name" value={name} maxLength={100} required onChange={(e) => setName(e.target.value)} className="h-8" />
            <Button size="sm" type="submit" aria-label="Save name" disabled={update.isPending || !name.trim()}><Check aria-hidden="true" /></Button>
            <Button size="sm" type="button" variant="ghost" aria-label="Cancel" onClick={() => { setEditing(false); setName(team.name); }}><X aria-hidden="true" /></Button>
          </form>
        ) : (
          <span className="flex items-center gap-1 font-medium">{team.name}<Button size="sm" variant="ghost" aria-label={`Rename ${team.name}`} onClick={() => setEditing(true)}><Pencil aria-hidden="true" /></Button></span>
        )}
        {error ? <p role="alert" className="text-xs font-medium text-destructive">{error.message}</p> : null}
      </TableCell>
      <TableCell>
        <Label htmlFor={leadId} className="sr-only">Lead of {team.name}</Label>
        <NativeSelect id={leadId} value={team.lead?.id ?? ''} disabled={update.isPending} onChange={(e) => update.mutate({ id: team.id, dto: { leadId: e.target.value || null } })}>
          <option value="">No lead</option>
          {active.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
        </NativeSelect>
      </TableCell>
      <TableCell>{team.memberCount}</TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="ghost" aria-label={`Delete ${team.name}`} title={team.memberCount ? 'Move its members to another team first' : undefined} disabled={remove.isPending || team.memberCount > 0} onClick={() => remove.mutate(team.id)}><Trash2 aria-hidden="true" /></Button>
      </TableCell>
    </TableRow>
  );
}

function PersonRow({ person, data, onSaved }: { person: OrgPerson; data: OrgStructure; onSaved: (msg: string) => void }) {
  const placement = usePlacement();
  const [teamId, setTeamId] = useState(person.teamId ?? '');
  const [managerId, setManagerId] = useState(person.managerId ?? '');
  const ids = { t: useId(), m: useId() };
  const blocked = useMemo(() => below(data.people, person.id), [data.people, person.id]);
  const managers = data.people.filter((p) => p.status === 'ACTIVE' && p.id !== person.id && !blocked.has(p.id));
  const dirty = teamId !== (person.teamId ?? '') || managerId !== (person.managerId ?? '');
  const name = personName(person);
  return (
    <TableRow data-testid={`person-${person.email}`}>
      <TableCell>
        <div className="font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{person.email} · {roleLabel(person.role)}{person.status !== 'ACTIVE' ? <Badge variant="outline" className="ml-1">{person.status.toLowerCase()}</Badge> : null}</div>
        {placement.isError ? <p role="alert" className="text-xs font-medium text-destructive">{placement.error.message}</p> : null}
      </TableCell>
      <TableCell>
        <Label htmlFor={ids.t} className="sr-only">Team of {name}</Label>
        <NativeSelect id={ids.t} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">No team</option>
          {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </NativeSelect>
      </TableCell>
      <TableCell>
        <Label htmlFor={ids.m} className="sr-only">Manager of {name}</Label>
        <NativeSelect id={ids.m} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">No manager</option>
          {managers.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
        </NativeSelect>
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={!dirty || placement.isPending} onClick={() => placement.mutate({ id: person.id, dto: { teamId: teamId || null, managerId: managerId || null } }, { onSuccess: () => onSaved(`Saved ${name}'s team and manager.`) })}>
          {placement.isPending ? 'Saving…' : 'Save'}
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** FR-ORG-006 (ADR 031): HR and admins manage teams, team leads, and who reports to whom. */
export default function TeamsPage() {
  const allowed = useCan(Permission.USERS_MANAGE);
  const structure = useOrgStructure(allowed);
  const { create } = useTeamMutations();
  const [name, setName] = useState('');
  const [lead, setLead] = useState('');
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const ids = { n: useId(), l: useId(), f: useId() };
  if (!allowed) return <AccessDenied what="Teams and managers" />;
  const data = structure.data;
  const active = data?.people.filter((p) => p.status === 'ACTIVE') ?? [];
  const q = filter.trim().toLowerCase();
  const shown = data?.people.filter((p) => !q || personName(p).toLowerCase().includes(q) || p.email.toLowerCase().includes(q)) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Teams and managers</h1>
        <Button variant="outline" asChild><Link href="/admin/org-chart"><Network aria-hidden="true" /> Organisation chart</Link></Button>
      </div>
      {message ? <Alert><AlertDescription role="status">{message}</AlertDescription></Alert> : null}
      {structure.isPending ? <LoadingState label="Loading teams and people" /> : null}
      {structure.isError ? <ErrorState error={structure.error} onRetry={() => void structure.refetch()} /> : null}
      {data ? (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Teams</CardTitle><CardDescription>A team lead sees their team&apos;s live board and approves for people without a manager. A team can be deleted once it is empty.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {!data.teams.length ? <EmptyState title="No teams yet" description="Create the first team below." /> : (
                <div className="overflow-x-auto">
                  <Table data-testid="teams">
                    <TableHeader><TableRow><TableHead>Team</TableHead><TableHead>Lead</TableHead><TableHead>Members</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>{data.teams.map((t) => <TeamRow key={`${t.id}:${t.name}`} team={t} active={active} />)}</TableBody>
                  </Table>
                </div>
              )}
              <form className="flex flex-wrap items-end gap-3" aria-label="Create a team" onSubmit={(e) => { e.preventDefault(); create.mutate({ name, leadId: lead || null }, { onSuccess: (t) => { setName(''); setLead(''); setMessage(`Created ${t.name}.`); } }); }}>
                <div className="min-w-56 flex-1 space-y-1"><Label htmlFor={ids.n}>New team</Label><Input id={ids.n} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor={ids.l}>Lead (optional)</Label>
                  <NativeSelect id={ids.l} value={lead} onChange={(e) => setLead(e.target.value)}><option value="">No lead</option>{active.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}</NativeSelect></div>
                <Button type="submit" disabled={create.isPending || !name.trim()}><Plus aria-hidden="true" /> {create.isPending ? 'Creating…' : 'Create team'}</Button>
              </form>
              {create.isError ? <Alert variant="destructive"><AlertDescription>{create.error.message}</AlertDescription></Alert> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">People</CardTitle><CardDescription>The manager approves leave, timesheets and corrections. Someone who already reports to a person cannot become their manager. A change of team applies at the person&apos;s next sign-in refresh (within 15 minutes).</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div className="max-w-sm space-y-1"><Label htmlFor={ids.f}>Find a person</Label><Input id={ids.f} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
              {!shown.length ? <EmptyState title={q ? 'Nobody matches' : 'No people yet'} /> : (
                <div className="overflow-x-auto">
                  <Table data-testid="people">
                    <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Team</TableHead><TableHead>Manager</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>{shown.map((p) => <PersonRow key={`${p.id}:${p.teamId}:${p.managerId}`} person={p} data={data} onSaved={setMessage} />)}</TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
