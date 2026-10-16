'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import type { NotificationGroup, NotificationPreferences, QuietHours } from '@hrvo/shared';
import { ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useNotificationPreferences, useSaveNotificationPreferences } from '@/lib/notification-queries';

const GROUPS: NotificationGroup[] = ['Tasks', 'Timesheets', 'Documents', 'Attendance', 'Security'];
type Item = NotificationPreferences['items'][number];

/** FR-NOTIF-004: channels per event type, quiet hours and timezone. Security notices are always on. */
export default function NotificationSettingsPage() {
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const ids = { tz: useId(), quiet: useId(), start: useId(), end: useId() };
  const [items, setItems] = useState<Item[]>([]);
  const [timezone, setTimezone] = useState<string>('');
  const [quiet, setQuiet] = useState<QuietHours | null>(null);
  const [saved, setSaved] = useState(false);
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []), []);
  useEffect(() => {
    if (prefs.data) {
      setItems(prefs.data.items);
      setTimezone(prefs.data.timezone ?? '');
      setQuiet(prefs.data.quietHours);
    }
  }, [prefs.data]);
  const toggle = (type: string, channel: 'inApp' | 'email') => setItems(items.map((i) => (i.type === type ? { ...i, [channel]: !i[channel] } : i)));
  const quietInvalid = quiet !== null && quiet.start === quiet.end;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Notification settings</h1>
      {prefs.isPending ? <LoadingState label="Loading settings" rows={4} /> : null}
      {prefs.isError ? <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} /> : null}
      {prefs.data ? (
        <form aria-label="Notification settings" className="space-y-4" onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          if (quietInvalid) return;
          save.mutate({ timezone: timezone || null, quietHours: quiet, items: items.map((i) => ({ type: i.type, inApp: i.inApp, email: i.email })) }, { onSuccess: () => setSaved(true) });
        }}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quiet hours</CardTitle>
              <CardDescription>Emails that arrive during quiet hours are held until they end. Notifications still appear in the app. Security notices are always sent at once.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-3">
                <Label htmlFor={ids.tz}>Your timezone</Label>
                <NativeSelect id={ids.tz} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  <option value="">Organisation default ({prefs.data.orgTimezone})</option>
                  {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                </NativeSelect>
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <input id={ids.quiet} type="checkbox" checked={quiet !== null} onChange={(e) => setQuiet(e.target.checked ? { start: '22:00', end: '07:00' } : null)} />
                Hold emails during quiet hours
              </label>
              {quiet ? (
                <>
                  <div className="space-y-1.5"><Label htmlFor={ids.start}>From</Label><Input id={ids.start} type="time" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label htmlFor={ids.end}>Until</Label><Input id={ids.end} type="time" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} /></div>
                  {quietInvalid ? <p className="text-sm text-destructive sm:col-span-3" role="alert">Start and end must differ.</p> : null}
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">What to receive</CardTitle>
              <CardDescription>Turning a channel off here also stops the emails you can unsubscribe from in each message.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="notification-preferences">
                <TableHeader><TableRow><TableHead>Event</TableHead><TableHead className="w-24 text-center">In app</TableHead><TableHead className="w-24 text-center">Email</TableHead></TableRow></TableHeader>
                <TableBody>
                  {GROUPS.map((g) => (
                    [
                      <TableRow key={g} className="bg-muted/50"><TableCell colSpan={3} className="font-medium">{g}</TableCell></TableRow>,
                      ...items.filter((i) => i.group === g).map((i) => (
                        <TableRow key={i.type}>
                          <TableCell>{i.label}{i.critical ? <span className="ml-2 text-xs text-muted-foreground">Always on</span> : null}</TableCell>
                          <TableCell className="text-center"><input type="checkbox" aria-label={`${i.label}: in app`} checked={i.inApp} disabled={i.critical} onChange={() => toggle(i.type, 'inApp')} /></TableCell>
                          <TableCell className="text-center"><input type="checkbox" aria-label={`${i.label}: email`} checked={i.email} disabled={i.critical} onChange={() => toggle(i.type, 'email')} /></TableCell>
                        </TableRow>
                      )),
                    ]
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending || quietInvalid}>Save settings</Button>
            {saved ? <p className="text-sm text-muted-foreground" role="status">Settings saved.</p> : null}
          </div>
          {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
        </form>
      ) : null}
    </div>
  );
}
