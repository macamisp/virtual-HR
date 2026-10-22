-- Self-service workspaces, owners, Google sign-in, invitation management and job titles
-- (FR-AUTH-001, FR-AUTH-005, FR-AUTH-006, FR-ORG-001, FR-ORG-009; ADR 037).

-- AlterTable: organisation profile and sign-in settings
ALTER TABLE "organizations" ADD COLUMN "work_week" JSONB NOT NULL DEFAULT '[1,2,3,4,5]';
ALTER TABLE "organizations" ADD COLUMN "sso_auto_join_domain" VARCHAR(253);
ALTER TABLE "organizations" ADD COLUMN "mfa_for_sso" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "organizations" ADD COLUMN "onboarded_at" TIMESTAMPTZ;

-- AlterTable: owners, job titles, verified e-mail addresses
ALTER TABLE "users" ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "job_title" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: invitations can be resent and revoked
ALTER TABLE "invitations" ADD COLUMN "revoked_at" TIMESTAMPTZ;
ALTER TABLE "invitations" ADD COLUMN "last_sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable: single-use e-mail verification links for self-service signup
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Google (OIDC) identities linked to users
CREATE TABLE "oauth_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ownership transfers waiting for the new owner's acceptance
CREATE TABLE "ownership_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "keep_ownership" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ownership_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");
CREATE INDEX "email_verification_tokens_org_id_user_id_idx" ON "email_verification_tokens"("org_id", "user_id");
CREATE UNIQUE INDEX "oauth_identities_provider_subject_key" ON "oauth_identities"("provider", "subject");
CREATE UNIQUE INDEX "oauth_identities_org_id_user_id_provider_key" ON "oauth_identities"("org_id", "user_id", "provider");
CREATE INDEX "ownership_transfers_org_id_status_idx" ON "ownership_transfers"("org_id", "status");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: data backfill, integrity, row-level security and grants.

-- Everyone who exists today was invited (FR-AUTH-001) or seeded: their address counts as verified.
-- The column defaults to "verified now" for the same reason (invitations, admin-created and seeded
-- accounts); only self-service signup sets it to NULL until the e-mailed link is used.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
-- Existing super admins are the owners of their organisations (SRS 2.3: "Owner of the organisation account").
UPDATE users SET is_owner = true WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE';

ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED'));
ALTER TABLE organizations ADD CONSTRAINT organizations_sso_auto_join_domain_check
  CHECK (sso_auto_join_domain IS NULL OR sso_auto_join_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
ALTER TABLE oauth_identities ADD CONSTRAINT oauth_identities_provider_check CHECK (provider IN ('GOOGLE'));
ALTER TABLE ownership_transfers ADD CONSTRAINT ownership_transfers_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'));
ALTER TABLE ownership_transfers ADD CONSTRAINT ownership_transfers_not_self_check CHECK (from_user_id <> to_user_id);

-- An owner is always a super admin.
ALTER TABLE users ADD CONSTRAINT users_owner_role_check CHECK (NOT is_owner OR role = 'SUPER_ADMIN');

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_verification_tokens', 'oauth_identities', 'ownership_transfers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
      USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)
      WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)', t || '_org_policy', t);
  END LOOP;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_identities, ownership_transfers TO hrvo_app;
-- Verification links are claimed (UPDATE used_at), never deleted by the application.
GRANT SELECT, INSERT, UPDATE ON email_verification_tokens TO hrvo_app;
REVOKE DELETE, TRUNCATE ON email_verification_tokens FROM hrvo_app;

-- Unauthenticated lookups (verification link, Google identity, workspace choice at sign-in) run
-- before any tenant context exists, through SECURITY DEFINER functions like the other auth lookups.
CREATE FUNCTION fn_lookup_email_verification(p_token_hash VARCHAR)
RETURNS TABLE (id UUID, org_id UUID, user_id UUID, expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT t.id, t.org_id, t.user_id, t.expires_at, t.used_at
  FROM email_verification_tokens t WHERE t.token_hash = p_token_hash;
END;
$$;

CREATE FUNCTION fn_lookup_oauth_identity(p_provider VARCHAR, p_subject VARCHAR)
RETURNS TABLE (org_id UUID, user_id UUID, email VARCHAR)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT i.org_id, i.user_id, i.email FROM oauth_identities i
  WHERE i.provider = p_provider AND i.subject = p_subject;
END;
$$;

-- The workspaces an address belongs to, so a sign-in can ask which one is meant.
CREATE FUNCTION fn_lookup_workspaces_for_email(p_email TEXT)
RETURNS TABLE (org_id UUID, name VARCHAR, slug VARCHAR, user_id UUID, status VARCHAR)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT o.id, o.name, o.slug, u.id, u.status FROM users u JOIN organizations o ON o.id = u.org_id
  WHERE LOWER(u.email) = LOWER(p_email) ORDER BY o.name;
END;
$$;

-- Organisations whose sign-in settings allow a Google account on this domain to join by itself.
CREATE FUNCTION fn_lookup_org_by_sso_domain(p_domain TEXT)
RETURNS TABLE (id UUID, name VARCHAR, slug VARCHAR)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT o.id, o.name, o.slug FROM organizations o WHERE o.sso_auto_join_domain = LOWER(p_domain);
END;
$$;

CREATE FUNCTION fn_lookup_org_by_slug(p_slug TEXT)
RETURNS TABLE (id UUID, name VARCHAR, slug VARCHAR)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT o.id, o.name, o.slug FROM organizations o WHERE o.slug = LOWER(p_slug);
END;
$$;

REVOKE ALL ON FUNCTION fn_lookup_email_verification(VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_lookup_oauth_identity(VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_lookup_workspaces_for_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_lookup_org_by_sso_domain(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_lookup_org_by_slug(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_lookup_email_verification(VARCHAR) TO hrvo_app;
GRANT EXECUTE ON FUNCTION fn_lookup_oauth_identity(VARCHAR, VARCHAR) TO hrvo_app;
GRANT EXECUTE ON FUNCTION fn_lookup_workspaces_for_email(TEXT) TO hrvo_app;
GRANT EXECUTE ON FUNCTION fn_lookup_org_by_sso_domain(TEXT) TO hrvo_app;
GRANT EXECUTE ON FUNCTION fn_lookup_org_by_slug(TEXT) TO hrvo_app;
