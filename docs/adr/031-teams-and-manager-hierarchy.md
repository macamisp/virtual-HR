# ADR 031: Teams and the manager hierarchy

**Status:** Accepted
**Date:** 19 October 2026
**Requirements:** FR-ORG-006 (teams and a manager hierarchy used for approvals and visibility scopes).

## Problem

`teams.lead_id` and `users.manager_id` existed and already drove approvals (`approversFor`: the manager, else the team's leads and managers, else HR) and the team lead's live-board scope. Nothing let HR or an admin change them: teams and managers could only be set by seed scripts or SQL.

## Decision

- **Who.** Every route needs `users.manage` (HR, HR manager, admin, super admin). No new permission: placing people is user management.
- **Routes.** `GET /org/structure` (teams with lead and member count; people with team, manager, role, status), `POST /org/teams`, `PATCH /org/teams/:id` (name and/or lead), `DELETE /org/teams/:id`, `PUT /org/people/:id/placement` (team and manager together).
- **Rules.** Team names are unique per organisation, ignoring case (unique index `teams_org_name`). A lead or manager must be an active user of the same organisation (another tenant's ids are invisible under RLS and answer 404). A person cannot be their own manager, nor be placed under anyone who already reports to them, directly or through others (recursive query). Only an empty team can be deleted, so nobody's approver or team schedule changes as a side effect.
- **Concurrency.** Every change takes `pg_advisory_xact_lock(hashtext('org-structure:' || org_id))`. Two opposite placements sent at the same moment (A under B, B under A) are serialised; the second one sees the loop and is refused. A test sends exactly that pair.
- **When it applies.** Approvals read `manager_id` and `team_id` from the database on every request, so a new manager decides at once. The team is also a claim in the access token: like a role change, a move reaches the person's own team-scoped views at the next token refresh (15 minutes at most). The screen says so.
- **Audit.** `TEAM_CREATED`, `TEAM_UPDATED`, `TEAM_DELETED` (entity TEAM) and `USER_PLACEMENT_CHANGED` (entity USER), each with before and after values.
- **Screens.** `/admin/teams` (teams, leads, and every person's team and manager; the manager list leaves out the person and everyone below them) and `/admin/org-chart` (a tree from the people without a manager).

## Consequences

- No new table; `teams` already had RLS (docs/security/rls-coverage.md).
- A team schedule (FR-ORG-005) belongs to a team, so an empty-team delete also removes its schedules (existing `ON DELETE CASCADE`).
- Moving people between organisations is not possible, by design.
