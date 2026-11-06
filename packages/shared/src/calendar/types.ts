/**
 * Calendar sync (SRS 5.4 FR-MEET-006; ADR 023): Google Calendar and Microsoft Outlook (Graph).
 * Our meetings appear in the person's calendar; their responses and busy times come back.
 */
import { z } from 'zod';

export const CALENDAR_PROVIDERS = ['GOOGLE', 'MICROSOFT'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export const CALENDAR_PROVIDER_LABEL: Record<CalendarProvider, string> = { GOOGLE: 'Google Calendar', MICROSOFT: 'Microsoft Outlook' };

export const CalendarConnectionSchema = z.object({
  provider: z.enum(CALENDAR_PROVIDERS),
  /** Configured on this server (OAuth app registered by the organisation). */
  available: z.boolean(),
  connected: z.boolean(),
  accountEmail: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ERROR', 'NONE']),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type CalendarConnection = z.infer<typeof CalendarConnectionSchema>;
export const CalendarConnectionListSchema = z.object({ items: z.array(CalendarConnectionSchema) });

export const CalendarConnectStartSchema = z.object({ authorizeUrl: z.string().url() });

export const BusyQuerySchema = z.object({
  userIds: z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(50)),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});
/** Busy blocks only (never titles or details of other events). */
export const BusyListSchema = z.object({ items: z.array(z.object({ userId: z.string(), start: z.string(), end: z.string() })) });
export type BusyList = z.infer<typeof BusyListSchema>;

/**
 * Upcoming events from the person's own connected calendars (FR-WT-022; ADR 049 §6). Read on
 * demand, never stored; an event never counts as worked time (only joining the call does).
 */
export const UpcomingQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(14).default(7) });
export type UpcomingQuery = z.infer<typeof UpcomingQuerySchema>;
export const UPCOMING_RESPONSES = ['ACCEPTED', 'DECLINED', 'TENTATIVE', 'NEEDS_ACTION'] as const;
export type UpcomingResponse = (typeof UPCOMING_RESPONSES)[number];
export const UpcomingItemSchema = z.object({
  id: z.string(),
  provider: z.enum(CALENDAR_PROVIDERS),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  source: z.string(),
  /** Set when the event is one of our meetings (iCal UID `<uuid>@hrvo`) in this organisation. */
  hrvoMeetingId: z.string().uuid().nullable(),
  /** The person's own answer, where the provider reports it. */
  response: z.enum(UPCOMING_RESPONSES).nullable(),
  /** Our meeting page, else the provider's join or event link; external links are https only. */
  openUrl: z.string().nullable(),
});
export type UpcomingItem = z.infer<typeof UpcomingItemSchema>;
export const UpcomingProviderStatusSchema = z.object({ provider: z.enum(CALENDAR_PROVIDERS), status: z.enum(['ACTIVE', 'ERROR']), lastError: z.string().nullable() });
export const UpcomingListSchema = z.object({
  connected: z.boolean(),
  providers: z.array(UpcomingProviderStatusSchema),
  items: z.array(UpcomingItemSchema),
});
export type UpcomingList = z.infer<typeof UpcomingListSchema>;
