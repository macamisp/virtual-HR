'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { UserCog } from 'lucide-react';
import { ROLE_LABEL } from '@hrvo/shared';
import type { OrgPerson, UserRole } from '@hrvo/shared';
import { AccessDenied, EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { personName, useOrgStructure } from '@/lib/org-queries';
import { Permission, useCan } from '@/lib/permissions';

function Node({ person, reports, teams }: { person: OrgPerson; reports: Map<string, OrgPerson[]>; teams: Map<string, string> }) {
  const children = reports.get(person.id) ?? [];
  const name = personName(person);
  return (
    <li className="space-y-2">
      <div className="inline-flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm" data-testid={`chart-${person.email}`}>
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">{ROLE_LABEL[person.role as UserRole] ?? person.role}</span>
        {person.teamId ? <Badge variant="secondary">{teams.get(person.teamId) ?? 'Team'}</Badge> : null}
        {person.status !== 'ACTIVE' ? <Badge variant="outline">{person.status.toLowerCase()}</Badge> : null}
        {children.length ? <span className="text-xs text-muted-foreground">{children.length} direct {children.length === 1 ? 'report' : 'reports'}</span> : null}
      </div>
      {children.length ? (
        <ul aria-label={`Reports to ${name}`} className="ml-4 space-y-2 border-l pl-4">
          {children.map((c) => <Node key={c.id} person={c} reports={reports} teams={teams} />)}
        </ul>
      ) : null}
    </li>
  );
}

/** FR-ORG-006 (ADR 031): who reports to whom, as a tree from the people without a manager. */
export default function OrgChartPage() {
  const allowed = useCan(Permission.USERS_MANAGE);
  const structure = useOrgStructure(allowed);
  const view = useMemo(() => {
    const people = structure.data?.people ?? [];
    const ids = new Set(people.map((p) => p.id));
    const reports = new Map<string, OrgPerson[]>();
    for (const p of people) if (p.managerId && ids.has(p.managerId)) reports.set(p.managerId, [...(reports.get(p.managerId) ?? []), p]);
    const roots = people.filter((p) => !p.managerId || !ids.has(p.managerId));
    return { roots, reports, teams: new Map((structure.data?.teams ?? []).map((t) => [t.id, t.name])) };
  }, [structure.data]);
  if (!allowed) return <AccessDenied what="Organisation chart" />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Organisation chart</h1>
        <Button variant="outline" asChild><Link href="/admin/teams"><UserCog aria-hidden="true" /> Teams and managers</Link></Button>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Who reports to whom</CardTitle><CardDescription>People without a manager are at the top. Change a person&apos;s manager on the Teams and managers page.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          {structure.isPending ? <LoadingState label="Loading the organisation chart" /> : null}
          {structure.isError ? <ErrorState error={structure.error} onRetry={() => void structure.refetch()} /> : null}
          {structure.data && !view.roots.length ? <EmptyState title="No people yet" /> : null}
          {view.roots.length ? <ul aria-label="Organisation chart" className="space-y-3" data-testid="org-chart">{view.roots.map((p) => <Node key={p.id} person={p} reports={view.reports} teams={view.teams} />)}</ul> : null}
        </CardContent>
      </Card>
    </div>
  );
}
