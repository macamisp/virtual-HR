# Traceability: Organisation and people (SRS 5.2)

| Requirement | Implementation | Tests |
| --- | --- | --- |
| FR-ORG-006 teams, team leads and a manager hierarchy, managed by HR/Admin | `apps/api/src/org/` (`OrgService`, `/org/*` routes, `users.manage`), unique index `teams_org_name`, advisory lock against loops; screens `/admin/teams`, `/admin/org-chart`; ADR 031 | org-structure-e2e (permissions, unique names, loops direct and indirect, concurrent opposite placements, other tenant 404, audit before/after, new manager decides leave at once, empty-team delete), Playwright 26 |
