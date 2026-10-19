-- FR-VO-008; FR-MEET-001, 005, 012, 013 (ADR 031).
CREATE TABLE meeting_calls (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  caller_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state varchar(10) NOT NULL DEFAULT 'RINGING' CHECK (state IN ('RINGING','ACCEPTED','DECLINED','MISSED','BUSY','CANCELLED')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '45 seconds'),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, callee_id),
  CHECK (caller_id <> callee_id)
);
CREATE INDEX meeting_calls_pending ON meeting_calls (org_id, expires_at) WHERE state = 'RINGING';
ALTER TABLE meeting_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_calls_org_policy ON meeting_calls FOR ALL
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON meeting_calls TO hrvo_app;

ALTER TABLE channels ADD COLUMN meeting_id uuid UNIQUE REFERENCES meetings(id) ON DELETE CASCADE;
ALTER TABLE channels ADD CONSTRAINT channels_meeting_kind CHECK (meeting_id IS NULL OR kind = 'GROUP');
CREATE FUNCTION fn_meeting_calls_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = NEW.meeting_id AND org_id = NEW.org_id)
     OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.caller_id AND org_id = NEW.org_id)
     OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.callee_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'call crosses organisations';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_calls_same_org BEFORE INSERT OR UPDATE ON meeting_calls
  FOR EACH ROW EXECUTE FUNCTION fn_meeting_calls_same_org();
CREATE FUNCTION fn_meeting_channel_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meeting_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM meetings WHERE id = NEW.meeting_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'meeting chat crosses organisations';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meeting_channel_same_org BEFORE INSERT OR UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION fn_meeting_channel_same_org();
