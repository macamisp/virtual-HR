-- FR-ORG-006 (ADR 031): team names are unique per organisation, ignoring case, so HR cannot
-- create two "Support" teams that people and approvers would confuse. teams already has RLS.
CREATE UNIQUE INDEX teams_org_name ON teams (org_id, lower(name));
