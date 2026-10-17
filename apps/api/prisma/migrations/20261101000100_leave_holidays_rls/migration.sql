-- Leave requests and the public holiday calendar, part 2 (FR-ORG-010, FR-ORG-011, FR-ATT-022; ADR 027):
-- constraints, row-level security, grants and the default Sri Lanka 2026 calendar. Hand-written.
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_type_check CHECK (type IN ('ANNUAL', 'SICK', 'UNPAID', 'OTHER')),
  ADD CONSTRAINT leave_requests_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  ADD CONSTRAINT leave_requests_dates_check CHECK (end_date >= start_date AND end_date - start_date < 90),
  -- A decision always carries its time (the decider may later be anonymised).
  ADD CONSTRAINT leave_requests_decided_check CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_at IS NOT NULL);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_requests', 'public_holidays'] LOOP
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
-- Requests are cancelled, never deleted; the calendar is editable.
GRANT SELECT, INSERT, UPDATE ON leave_requests TO hrvo_app;
REVOKE DELETE, TRUNCATE ON leave_requests FROM hrvo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public_holidays TO hrvo_app;

-- FR-ORG-011: the Sri Lanka 2026 calendar (gazette under the Holidays Act) for every existing
-- organisation; HR edits it from Admin > Public holidays. New organisations load it from there.
INSERT INTO public_holidays (org_id, date, name)
SELECT o.id, h.d::date, h.n
FROM organizations o
CROSS JOIN (VALUES
    ('2026-01-03', 'Duruthu Full Moon Poya Day'),
    ('2026-01-15', 'Tamil Thai Pongal Day'),
    ('2026-02-01', 'Navam Full Moon Poya Day'),
    ('2026-02-04', 'Independence Day'),
    ('2026-02-15', 'Maha Shivaratri Day'),
    ('2026-03-02', 'Medin Full Moon Poya Day'),
    ('2026-03-21', 'Eid-ul-Fitr (Ramazan Festival Day)'),
    ('2026-04-01', 'Bak Full Moon Poya Day'),
    ('2026-04-03', 'Good Friday'),
    ('2026-04-13', 'Day prior to Sinhala and Tamil New Year Day'),
    ('2026-04-14', 'Sinhala and Tamil New Year Day'),
    ('2026-05-01', 'May Day and Vesak Full Moon Poya Day'),
    ('2026-05-02', 'Day following Vesak Full Moon Poya Day'),
    ('2026-05-28', 'Eid-ul-Alha (Hadji Festival Day)'),
    ('2026-05-30', 'Adhi Poson Full Moon Poya Day'),
    ('2026-06-29', 'Poson Full Moon Poya Day'),
    ('2026-07-29', 'Esala Full Moon Poya Day'),
    ('2026-08-26', 'Milad-un-Nabi (Holy Prophet''s Birthday)'),
    ('2026-08-27', 'Nikini Full Moon Poya Day'),
    ('2026-09-26', 'Binara Full Moon Poya Day'),
    ('2026-10-25', 'Vap Full Moon Poya Day'),
    ('2026-11-08', 'Deepavali Festival Day'),
    ('2026-11-24', 'Il Full Moon Poya Day'),
    ('2026-12-23', 'Unduvap Full Moon Poya Day'),
    ('2026-12-25', 'Christmas Day')) AS h(d, n)
ON CONFLICT (org_id, date) DO NOTHING;
