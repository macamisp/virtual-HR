/**
 * Default public holiday calendar (FR-ORG-011): Sri Lanka, from the Government Printing
 * Department's 2026 calendar and the gazette notice of May 2025 under the Holidays Act, as
 * published by Ada Derana (adaderana.lk/news/116465) and the Royal Danish Consulate's 2026 list.
 * One row per date: 1 May is both May Day and Vesak Poya in 2026. HR edits the loaded calendar
 * freely; add a year here when its gazette is out.
 */
export const SRI_LANKA_HOLIDAYS: Readonly<Record<number, ReadonlyArray<{ date: string; name: string }>>> = {
  2026: [
    { date: '2026-01-03', name: 'Duruthu Full Moon Poya Day' },
    { date: '2026-01-15', name: 'Tamil Thai Pongal Day' },
    { date: '2026-02-01', name: 'Navam Full Moon Poya Day' },
    { date: '2026-02-04', name: 'Independence Day' },
    { date: '2026-02-15', name: 'Maha Shivaratri Day' },
    { date: '2026-03-02', name: 'Medin Full Moon Poya Day' },
    { date: '2026-03-21', name: 'Eid-ul-Fitr (Ramazan Festival Day)' },
    { date: '2026-04-01', name: 'Bak Full Moon Poya Day' },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-04-13', name: 'Day prior to Sinhala and Tamil New Year Day' },
    { date: '2026-04-14', name: 'Sinhala and Tamil New Year Day' },
    { date: '2026-05-01', name: 'May Day and Vesak Full Moon Poya Day' },
    { date: '2026-05-02', name: 'Day following Vesak Full Moon Poya Day' },
    { date: '2026-05-28', name: 'Eid-ul-Alha (Hadji Festival Day)' },
    { date: '2026-05-30', name: 'Adhi Poson Full Moon Poya Day' },
    { date: '2026-06-29', name: 'Poson Full Moon Poya Day' },
    { date: '2026-07-29', name: 'Esala Full Moon Poya Day' },
    { date: '2026-08-26', name: "Milad-un-Nabi (Holy Prophet's Birthday)" },
    { date: '2026-08-27', name: 'Nikini Full Moon Poya Day' },
    { date: '2026-09-26', name: 'Binara Full Moon Poya Day' },
    { date: '2026-10-25', name: 'Vap Full Moon Poya Day' },
    { date: '2026-11-08', name: 'Deepavali Festival Day' },
    { date: '2026-11-24', name: 'Il Full Moon Poya Day' },
    { date: '2026-12-23', name: 'Unduvap Full Moon Poya Day' },
    { date: '2026-12-25', name: 'Christmas Day' },
  ],
};

export const defaultHolidaysFor = (year: number): ReadonlyArray<{ date: string; name: string }> | null => SRI_LANKA_HOLIDAYS[year] ?? null;
