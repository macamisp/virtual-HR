-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "recording_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retention_recordings_days" INTEGER NOT NULL DEFAULT 90;

-- CreateTable
CREATE TABLE "meeting_recordings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "started_by" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'CONSENT',
    "required_user_ids" UUID[],
    "consent_deadline" TIMESTAMPTZ NOT NULL,
    "egress_id" VARCHAR(64),
    "staging_key" TEXT,
    "storage_key" TEXT,
    "dek_wrapped" BYTEA,
    "key_id" VARCHAR(100),
    "iv" BYTEA,
    "auth_tag" BYTEA,
    "sha256" CHAR(64),
    "size_bytes" BIGINT,
    "duration_seconds" INTEGER,
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "detail" VARCHAR(300),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "recording_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "notice_version" VARCHAR(20) NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),

    CONSTRAINT "recording_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_recordings_egress_id_key" ON "meeting_recordings"("egress_id");

-- CreateIndex
CREATE INDEX "meeting_recordings_org_id_meeting_id_idx" ON "meeting_recordings"("org_id", "meeting_id");

-- CreateIndex
CREATE INDEX "meeting_recordings_status_expires_at_idx" ON "meeting_recordings"("status", "expires_at");

-- CreateIndex
CREATE INDEX "recording_consents_recording_id_user_id_at_idx" ON "recording_consents"("recording_id", "user_id", "at");

-- AddForeignKey
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_consents" ADD CONSTRAINT "recording_consents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_consents" ADD CONSTRAINT "recording_consents_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "meeting_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_consents" ADD CONSTRAINT "recording_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Part 2: hand-written.
ALTER TABLE organizations
  ADD CONSTRAINT organizations_retention_recordings_days_check CHECK (retention_recordings_days BETWEEN 7 AND 3650);

ALTER TABLE meeting_recordings
  ADD CONSTRAINT meeting_recordings_status_check CHECK (status IN ('CONSENT', 'RECORDING', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED', 'DELETED')),
  ADD CONSTRAINT meeting_recordings_required_check CHECK (required_user_ids IS NOT NULL AND cardinality(required_user_ids) >= 1),
  -- A playable recording is encrypted: key, IV, tag, fingerprint and an expiry are all present.
  ADD CONSTRAINT meeting_recordings_ready_check CHECK (status <> 'READY' OR (
    storage_key IS NOT NULL AND dek_wrapped IS NOT NULL AND key_id IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL
    AND sha256 ~ '^[0-9a-f]{64}$' AND expires_at IS NOT NULL)),
  -- Deleted means crypto-shredded: no key and no object left.
  ADD CONSTRAINT meeting_recordings_deleted_check CHECK (status <> 'DELETED' OR (dek_wrapped IS NULL AND storage_key IS NULL AND staging_key IS NULL));
-- At most one recording in progress per meeting.
CREATE UNIQUE INDEX meeting_recordings_one_active ON meeting_recordings (meeting_id) WHERE status IN ('CONSENT', 'RECORDING', 'PROCESSING');

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['meeting_recordings', 'recording_consents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL
         USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)
         WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t || '_org_policy', t);
  END LOOP;
END
$$;
-- Recordings are shredded (status DELETED), never deleted; the consent log is append-only.
GRANT SELECT, INSERT, UPDATE ON meeting_recordings TO hrvo_app;
GRANT SELECT, INSERT ON recording_consents TO hrvo_app;
REVOKE DELETE, TRUNCATE ON meeting_recordings FROM hrvo_app;
REVOKE UPDATE, DELETE, TRUNCATE ON recording_consents FROM hrvo_app;
