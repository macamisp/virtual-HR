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
