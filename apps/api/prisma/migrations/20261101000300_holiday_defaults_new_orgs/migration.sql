-- FR-ORG-011: the same default calendar for new organisations as existing ones.
-- SECURITY DEFINER permits provisioning under FORCE RLS before the caller has tenant context.
CREATE FUNCTION seed_new_org_holidays() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public_holidays (org_id, date, name)
  SELECT NEW.id, h.d::date, h.n FROM (VALUES
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
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION seed_new_org_holidays() FROM PUBLIC;
CREATE TRIGGER organization_default_holidays AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION seed_new_org_holidays();
