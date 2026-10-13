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
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  nonce VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id, nonce)
);

CREATE TABLE IF NOT EXISTS device_sequences (
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  device_id VARCHAR(100) NOT NULL,
  last_sequence INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, user_id, device_id)
);

CREATE TABLE IF NOT EXISTS session_secrets (
  session_id VARCHAR(128) PRIMARY KEY,
  secret VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Row-Level Security Configuration
ALTER TABLE attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_sessions_org_policy ON attendance_sessions;
CREATE POLICY attendance_sessions_org_policy ON attendance_sessions
  FOR ALL
  USING (
    current_setting('app.org_id', true) IS NULL 
    OR current_setting('app.org_id', true) = '' 
    OR org_id = current_setting('app.org_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.org_id', true) IS NULL 
    OR current_setting('app.org_id', true) = '' 
    OR org_id = current_setting('app.org_id', true)::uuid
  );

DROP POLICY IF EXISTS attendance_segments_org_policy ON attendance_segments;
CREATE POLICY attendance_segments_org_policy ON attendance_segments
  FOR ALL
  USING (
    current_setting('app.org_id', true) IS NULL 
    OR current_setting('app.org_id', true) = '' 
    OR org_id = current_setting('app.org_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.org_id', true) IS NULL 
    OR current_setting('app.org_id', true) = '' 
    OR org_id = current_setting('app.org_id', true)::uuid
  );
