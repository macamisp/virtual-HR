'use client';

import { useId } from 'react';
import type { OfficeSnapshot } from '@hrvo/shared';
import { officeRoute } from '@/lib/media/call-controller';
import { useSetOfficePreferences } from '@/lib/office-queries';
import type { OfficeClient } from '@/lib/office/office-client';
import { CallView } from './call-view';
import { useCallController } from './use-call-controller';

/**
 * FR-VO-005 / FR-VO-010 (ADR 016, 046): walking into a closed room joins its call; standing near
 * people in the open area joins the proximity group's call, with volume falling off with distance.
 * Media starts only after the user has turned it on and passed the device check. The call itself
 * belongs to the call controller, so it keeps going on other pages (ADR 048); its controls and the
 * device check are in the toolbar above the map (OfficeToolbar).
 */
export function OfficeMedia({ client, snapshot }: { client: OfficeClient; snapshot: OfficeSnapshot }) {
  const c = useCallController();
  const prefs = useSetOfficePreferences();
  const id = useId();

  if (!c.officeMediaEnabled && c.current?.kind !== 'meeting') {
    return (
      <div className="space-y-1" data-testid="office-media-off">
        <p className="text-sm text-muted-foreground">Talk to people when you walk into a closed room or stand near them. Use “Turn on audio and video” above the map.</p>
        {c.notice ? <p role="status" className="text-sm text-muted-foreground">{c.notice}</p> : null}
      </div>
    );
  }
  const route = officeRoute(client);
  const cur = c.current;
  let body: React.ReactNode;
  if (cur?.kind === 'meeting') {
    body = <p className="text-sm text-muted-foreground">You are in the meeting “{cur.title}”.</p>;
  } else if (c.lock === 'elsewhere') {
    body = <p className="text-sm text-muted-foreground">This call is open in another tab.</p>;
  } else if (c.session.room && cur?.kind === 'office') {
    // The controls are in the toolbar above the map (ADR 048 §3b); here the people and a shared screen.
    body = (
      <>
        <p className="text-sm font-medium">{cur.label}</p>
        <CallView session={c.session} compact controls={false} onLeave={() => c.disableOfficeMedia()} />
      </>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">{route ? 'Joining…' : 'Nobody to talk to here. Walk into a room or up to a colleague.'}</p>;
  }
  return (
    <div className="space-y-2" data-testid="office-media">
      {c.notice ? <p role="status" className="text-sm text-muted-foreground">{c.notice}</p> : null}
      {body}
      <label htmlFor={id} className="flex items-center gap-2 text-xs text-muted-foreground">
        <input id={id} type="checkbox" checked={snapshot.me.muteOnLeave} disabled={prefs.isPending}
          onChange={(e) => { c.setMuteOnLeave(e.target.checked); prefs.mutate({ muteOnLeave: e.target.checked }); }} />
        Mute my microphone when I leave the office page
      </label>
      {prefs.isError ? <p role="alert" className="text-xs text-destructive">{prefs.error.message}</p> : null}
    </div>
  );
}
