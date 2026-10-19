-- FR-ORG-002 (ADR 033): subcontractor identity, contact, emergency contact, and tax ID and bank
-- details as AES-256-GCM ciphertext under a per-profile data key wrapped by the KeyProvider.
-- CreateTable
CREATE TABLE "subcontractor_details" (
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "legal_name" VARCHAR(200) NOT NULL DEFAULT '',
    "company_name" VARCHAR(200) NOT NULL DEFAULT '',
    "country" CHAR(2),
    "contact_email" VARCHAR(255),
    "contact_phone" VARCHAR(40),
    "address" VARCHAR(500) NOT NULL DEFAULT '',
    "emergency_contact" JSONB,
    "tax_id_enc" BYTEA,
    "bank_details_enc" BYTEA,
    "dek_wrapped" BYTEA,
    "dek_key_id" VARCHAR(200),
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcontractor_details_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "subcontractor_details_org_id_idx" ON "subcontractor_details"("org_id");

-- AddForeignKey
ALTER TABLE "subcontractor_details" ADD CONSTRAINT "subcontractor_details_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontractor_details" ADD CONSTRAINT "subcontractor_details_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: integrity, row-level security and grants.
ALTER TABLE subcontractor_details
  ADD CONSTRAINT subcontractor_details_country_check CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  -- Ciphertext never exists without the wrapped key that opens it.
  ADD CONSTRAINT subcontractor_details_key_check CHECK ((tax_id_enc IS NULL AND bank_details_enc IS NULL) OR dek_wrapped IS NOT NULL),
  ADD CONSTRAINT subcontractor_details_key_id_check CHECK ((dek_wrapped IS NULL) = (dek_key_id IS NULL)),
  ADD CONSTRAINT subcontractor_details_emergency_check CHECK (emergency_contact IS NULL OR jsonb_typeof(emergency_contact) = 'object');

ALTER TABLE subcontractor_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcontractor_details FORCE ROW LEVEL SECURITY;
CREATE POLICY subcontractor_details_org_policy ON subcontractor_details FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
-- DELETE is granted for privacy erasure (FR-PRIV); profiles are otherwise updated in place.
GRANT SELECT, INSERT, UPDATE, DELETE ON subcontractor_details TO hrvo_app;
