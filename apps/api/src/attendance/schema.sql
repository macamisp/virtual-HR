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
