-- Auth hardening: password reset (FR-AUTH-008), revocation reasons, socket lifecycle
-- notifications (FR-AUTH-003), status-aware refresh lookup.

-- ============ Part 1: tables (generated) ============
-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "revoked_reason" VARCHAR(40);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "requested_ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_org_id_user_id_idx" ON "password_reset_tokens"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_refresh_token_hash_idx" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_org_id_family_id_idx" ON "auth_sessions"("org_id", "family_id");

-- CreateIndex
CREATE INDEX "auth_sessions_org_id_user_id_idx" ON "auth_sessions"("org_id", "user_id");

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============ Part 2: security (hand-written) ============

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_org_policy ON password_reset_tokens
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON password_reset_tokens TO hrvo_app;
REVOKE DELETE, TRUNCATE ON password_reset_tokens FROM hrvo_app;

-- Refresh lookup now also returns the user status and revoke reason so refresh can
-- refuse suspended/offboarded users and tell rotation apart from revocation.
DROP FUNCTION fn_lookup_session_for_refresh(VARCHAR);
CREATE FUNCTION fn_lookup_session_for_refresh(p_token_hash VARCHAR)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  user_id UUID,
  family_id UUID,
  is_revoked BOOLEAN,
  revoked_reason VARCHAR,
  expires_at TIMESTAMPTZ,
  email VARCHAR,
  display_name VARCHAR,
  role VARCHAR,
  team_id UUID,
  user_status VARCHAR
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.org_id, s.user_id, s.family_id, s.is_revoked, s.revoked_reason, s.expires_at,
         u.email, u.display_name, u.role, u.team_id, u.status
  FROM auth_sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.refresh_token_hash = p_token_hash;
END;
$$;
REVOKE ALL ON FUNCTION fn_lookup_session_for_refresh(VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_lookup_session_for_refresh(VARCHAR) TO hrvo_app;

-- Password reset token lookup for the unauthenticated reset endpoint (FR-AUTH-008).
CREATE FUNCTION fn_lookup_password_reset(p_token_hash VARCHAR)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  user_id UUID,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  user_status VARCHAR
)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.org_id, t.user_id, t.expires_at, t.used_at, u.status
  FROM password_reset_tokens t
  JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = p_token_hash;
END;
$$;
REVOKE ALL ON FUNCTION fn_lookup_password_reset(VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_lookup_password_reset(VARCHAR) TO hrvo_app;

-- Socket lifecycle (ADR 004): publish revocations and deactivations on channel
-- 'hrvo_auth_events' so every API instance can disconnect affected sockets on commit.
-- Payloads carry identifiers only, never tokens or secrets.
CREATE FUNCTION fn_notify_auth_session_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r auth_sessions;
BEGIN
  IF TG_OP = 'DELETE' THEN
    r := OLD;
  ELSE
    r := NEW;
    IF NOT NEW.is_revoked
       OR NEW.revoked_reason IS NOT DISTINCT FROM 'ROTATED'
       OR (OLD.is_revoked AND NEW.revoked_reason IS NOT DISTINCT FROM OLD.revoked_reason) THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM pg_notify('hrvo_auth_events', json_build_object(
    'type', 'session_revoked',
    'orgId', r.org_id,
    'userId', r.user_id,
    'sessionId', r.id,
    'familyId', r.family_id,
    'reason', COALESCE(r.revoked_reason, CASE WHEN TG_OP = 'DELETE' THEN 'DELETED' ELSE 'REVOKED' END)
  )::text);
  RETURN r;
END;
$$;

CREATE TRIGGER trg_auth_sessions_notify
  AFTER UPDATE OF is_revoked, revoked_reason OR DELETE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION fn_notify_auth_session_change();

CREATE FUNCTION fn_notify_user_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'ACTIVE' THEN
    PERFORM pg_notify('hrvo_auth_events', json_build_object(
      'type', 'user_deactivated',
      'orgId', NEW.org_id,
      'userId', NEW.id,
      'status', NEW.status
    )::text);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_status_notify
  AFTER UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION fn_notify_user_status_change();
