-- Schema definition for HRVO Attendance Engine with PostgreSQL Row-Level Security (RLS)
-- Ref: docs/SRS.md Section 7.4 & Section 3.4

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(80) UNIQUE NOT NULL,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Colombo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(100) NOT NULL,
  work_date VARCHAR(10) NOT NULL,
  clock_in_at TIMESTAMPTZ NOT NULL,
  clock_out_at TIMESTAMPTZ,
  clock_in_source VARCHAR(40) NOT NULL,
  clock_out_source VARCHAR(40),
  active_seconds INT NOT NULL DEFAULT 0,
  idle_seconds INT NOT NULL DEFAULT 0,
  break_seconds INT NOT NULL DEFAULT 0,
  meeting_seconds INT NOT NULL DEFAULT 0,
  net_seconds INT NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  ip_in VARCHAR(45) NOT NULL,
  ip_out VARCHAR(45),
  flags TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  current_state VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  previous_state VARCHAR(20),
  grace_timer_expires_at TIMESTAMPTZ,
  consecutive_idle_seconds INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  state VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INT NOT NULL DEFAULT 0,
  meeting_id VARCHAR(100),
  flags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS heartbeat_nonces (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id, nonce)
);

CREATE TABLE IF NOT EXISTS device_sequences (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(100) NOT NULL,
  last_sequence INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id, device_id)
);

CREATE TABLE IF NOT EXISTS session_secrets (
  session_id VARCHAR(128) PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  secret VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE session_secrets ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- 1. Create Non-Superuser Application Role (no BYPASSRLS, not table owner)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hrvo_app') THEN
    CREATE ROLE hrvo_app WITH LOGIN PASSWORD 'hrvo_app_pass' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE hrvo_dev TO hrvo_app;
GRANT USAGE ON SCHEMA public TO hrvo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrvo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrvo_app;

-- 2. Enable & FORCE Row-Level Security on every tenant table
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

ALTER TABLE attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE attendance_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_segments FORCE ROW LEVEL SECURITY;

ALTER TABLE heartbeat_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_nonces FORCE ROW LEVEL SECURITY;

ALTER TABLE device_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sequences FORCE ROW LEVEL SECURITY;

ALTER TABLE session_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_secrets FORCE ROW LEVEL SECURITY;

-- 3. Strict RLS Policies (Missing app.org_id returns 0 rows, foreign org_id rejected via WITH CHECK)
DROP POLICY IF EXISTS organizations_org_policy ON organizations;
CREATE POLICY organizations_org_policy ON organizations
  FOR ALL
  USING (id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS users_org_policy ON users;
CREATE POLICY users_org_policy ON users
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS attendance_sessions_org_policy ON attendance_sessions;
CREATE POLICY attendance_sessions_org_policy ON attendance_sessions
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS attendance_segments_org_policy ON attendance_segments;
CREATE POLICY attendance_segments_org_policy ON attendance_segments
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS heartbeat_nonces_org_policy ON heartbeat_nonces;
CREATE POLICY heartbeat_nonces_org_policy ON heartbeat_nonces
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS device_sequences_org_policy ON device_sequences;
CREATE POLICY device_sequences_org_policy ON device_sequences
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS session_secrets_org_policy ON session_secrets;
CREATE POLICY session_secrets_org_policy ON session_secrets
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- 4. Teams and User Extensions (FR-ATT-016 & RBAC)
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  lead_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'EMPLOYEE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- 5. Work Schedules (FR-ATT-014, Section 7.4)
CREATE TABLE IF NOT EXISTS work_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  days JSONB NOT NULL,
  flexible BOOLEAN NOT NULL DEFAULT false,
  grace_minutes INT NOT NULL DEFAULT 10,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Attendance Corrections (FR-ATT-013, Section 7.4)
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  requested_in TIMESTAMPTZ NOT NULL,
  requested_out TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  evidence_document_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Attendance Daily Materialized Summary (FR-ATT-015, Section 7.4)
CREATE TABLE IF NOT EXISTS attendance_daily (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date VARCHAR(10) NOT NULL,
  first_in TIMESTAMPTZ,
  last_out TIMESTAMPTZ,
  active_seconds INT NOT NULL DEFAULT 0,
  idle_seconds INT NOT NULL DEFAULT 0,
  break_seconds INT NOT NULL DEFAULT 0,
  meeting_seconds INT NOT NULL DEFAULT 0,
  net_seconds INT NOT NULL DEFAULT 0,
  expected_seconds INT NOT NULL DEFAULT 0,
  late_minutes INT NOT NULL DEFAULT 0,
  early_leave_minutes INT NOT NULL DEFAULT 0,
  overtime_minutes INT NOT NULL DEFAULT 0,
  day_status VARCHAR(20) NOT NULL DEFAULT 'PRESENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id, work_date)
);

-- 8. Draft Timesheets (FR-TS-001, Section 7.4)
CREATE TABLE IF NOT EXISTS draft_timesheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date VARCHAR(10) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  attendance_minutes INT NOT NULL DEFAULT 0,
  logged_minutes INT NOT NULL DEFAULT 0,
  billable_minutes INT NOT NULL DEFAULT 0,
  variance_minutes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (org_id, user_id, work_date)
);

-- 9. Presence Events Raw Stream (FR-ATT-020, Section 7.4)
CREATE TABLE IF NOT EXISTS presence_events (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  server_ts TIMESTAMPTZ NOT NULL,
  client_ts TIMESTAMPTZ,
  event_type VARCHAR(50) NOT NULL,
  state VARCHAR(20) NOT NULL,
  seq BIGINT NOT NULL DEFAULT 0,
  ip VARCHAR(45),
  meta JSONB DEFAULT '{}'
);

-- 10. Audit Logs with Hash Chain (FR-AUD-001, Section 7.4)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID NOT NULL,
  before JSONB,
  after JSONB,
  ip VARCHAR(45),
  user_agent TEXT,
  prev_hash VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 11. Monitoring Consents (FR-AUD-004, FR-ATT-020)
CREATE TABLE IF NOT EXISTS monitoring_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notice_version VARCHAR(50) NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  ip VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enable & FORCE RLS on all new tables
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;

ALTER TABLE work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedules FORCE ROW LEVEL SECURITY;

ALTER TABLE attendance_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_corrections FORCE ROW LEVEL SECURITY;

ALTER TABLE attendance_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_daily FORCE ROW LEVEL SECURITY;

ALTER TABLE draft_timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_timesheets FORCE ROW LEVEL SECURITY;

ALTER TABLE presence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE presence_events FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE monitoring_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_consents FORCE ROW LEVEL SECURITY;

-- Strict tenant policies
DROP POLICY IF EXISTS teams_org_policy ON teams;
CREATE POLICY teams_org_policy ON teams
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS work_schedules_org_policy ON work_schedules;
CREATE POLICY work_schedules_org_policy ON work_schedules
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS attendance_corrections_org_policy ON attendance_corrections;
CREATE POLICY attendance_corrections_org_policy ON attendance_corrections
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS attendance_daily_org_policy ON attendance_daily;
CREATE POLICY attendance_daily_org_policy ON attendance_daily
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS draft_timesheets_org_policy ON draft_timesheets;
CREATE POLICY draft_timesheets_org_policy ON draft_timesheets
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS presence_events_org_policy ON presence_events;
CREATE POLICY presence_events_org_policy ON presence_events
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS audit_logs_org_policy ON audit_logs;
CREATE POLICY audit_logs_org_policy ON audit_logs
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS monitoring_consents_org_policy ON monitoring_consents;
CREATE POLICY monitoring_consents_org_policy ON monitoring_consents
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Grant permissions to hrvo_app (standard tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrvo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrvo_app;

-- Append-only tables: REVOKE UPDATE, DELETE, TRUNCATE from application role (INSERT + SELECT only)
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM hrvo_app;
REVOKE UPDATE, DELETE, TRUNCATE ON presence_events FROM hrvo_app;
REVOKE UPDATE, DELETE, TRUNCATE ON monitoring_consents FROM hrvo_app;
GRANT SELECT, INSERT ON audit_logs, presence_events, monitoring_consents TO hrvo_app;

-- Dedicated retention role for presence_events retention pruning
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'hrvo_retention') THEN
    CREATE ROLE hrvo_retention WITH LOGIN PASSWORD 'hrvo_retention_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO hrvo_retention;
GRANT SELECT, DELETE ON presence_events TO hrvo_retention;

-- 12. User Authentication & Security Extensions (FR-AUTH-001..004, 007)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';

-- 13. Invitations (FR-AUTH-001)
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'EMPLOYEE',
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  token_hash VARCHAR(128) NOT NULL,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 14. Auth Sessions & Refresh Tokens (FR-AUTH-003)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  refresh_token_hash VARCHAR(128) NOT NULL,
  is_revoked BOOLEAN NOT NULL DEFAULT false,
  ip VARCHAR(45),
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enable & FORCE RLS on invitations and auth_sessions
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invitations_org_policy ON invitations;
CREATE POLICY invitations_org_policy ON invitations
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS auth_sessions_org_policy ON auth_sessions;
CREATE POLICY auth_sessions_org_policy ON auth_sessions
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO hrvo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions TO hrvo_app;

-- 15. Security Definer Auth Lookup Functions (Controlled entry points for unauthenticated requests)
DROP FUNCTION IF EXISTS fn_lookup_user_for_auth(TEXT);
CREATE OR REPLACE FUNCTION fn_lookup_user_for_auth(p_email TEXT)
RETURNS SETOF users
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM users
  WHERE LOWER(email) = LOWER(p_email);
END;
$$;
GRANT EXECUTE ON FUNCTION fn_lookup_user_for_auth(TEXT) TO hrvo_app;

DROP FUNCTION IF EXISTS fn_lookup_invitation_for_signup(VARCHAR);
CREATE OR REPLACE FUNCTION fn_lookup_invitation_for_signup(p_token_hash VARCHAR)
RETURNS SETOF invitations
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM invitations
  WHERE token_hash = p_token_hash;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_lookup_invitation_for_signup(VARCHAR) TO hrvo_app;

DROP FUNCTION IF EXISTS fn_lookup_session_for_refresh(VARCHAR);
CREATE OR REPLACE FUNCTION fn_lookup_session_for_refresh(p_token_hash VARCHAR)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  user_id UUID,
  family_id UUID,
  is_revoked BOOLEAN,
  expires_at TIMESTAMPTZ,
  email VARCHAR,
  display_name VARCHAR,
  role VARCHAR,
  team_id UUID
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.org_id, s.user_id, s.family_id, s.is_revoked, s.expires_at,
         u.email, u.display_name, u.role, u.team_id
  FROM auth_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.refresh_token_hash = p_token_hash;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_lookup_session_for_refresh(VARCHAR) TO hrvo_app;


