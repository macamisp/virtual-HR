'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Headphones } from 'lucide-react';
import type { OfficeSnapshot } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { officeRoute } from '@/lib/media/call-controller';
import { useSetOfficePreferences } from '@/lib/office-queries';
import type { OfficeClient } from '@/lib/office/office-client';
import { CallView } from './call-view';
import { useCallController } from './use-call-controller';
import { PreJoin } from './prejoin';

/**
 * FR-VO-005 / FR-VO-010 (ADR 016, 046): walking into a closed room joins its call; standing near
 * people in the open area joins the proximity group's call, with volume falling off with distance.
 * Media starts only after the user has turned it on and passed the device check. The call itself
 * belongs to the call controller, so it keeps going on other pages (ADR 046).
 */
export function OfficeMedia({ client, snapshot }: { client: OfficeClient; snapshot: OfficeSnapshot }) {
  const c = useCallController();
  const [setup, setSetup] = useState(false);
  const prefs = useSetOfficePreferences();
  const id = useId();

  if (!c.officeMediaEnabled) {
    return setup ? (
      <PreJoin title="Audio and video in the office" joinLabel="Turn on" onCancel={() => setSetup(false)} onJoin={(p) => { c.enableOfficeMedia(p); setSetup(false); }} />
    ) : (
      <div className="space-y-1" data-testid="office-media-off">
        <p className="text-sm text-muted-foreground">Talk to people when you walk into a closed room or stand near them.</p>
        {c.notice ? <p role="status" className="text-sm text-muted-foreground">{c.notice}</p> : null}
        <Button size="sm" variant="outline" onClick={() => setSetup(true)}><Headphones aria-hidden="true" /> Turn on audio and video</Button>
      </div>
    );
  }
  const off = () => c.disableOfficeMedia();
  const route = officeRoute(client);
  const cur = c.current;
  let body: React.ReactNode;
  if (cur?.kind === 'meeting') {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">You are in the meeting “{cur.title}”.</p>
        <Button size="sm" variant="outline" asChild><Link href={`/meetings/${cur.meetingId}`}>Return to meeting</Link></Button>
      </div>
    );
  } else if (c.lock === 'elsewhere') {
    body = (
      <div className="flex flex-wrap items-center gap-2" data-testid="call-elsewhere">
        <p className="text-sm">This call is open in another tab.</p>
        <Button size="sm" onClick={() => void c.takeOver()}>Take over</Button>
        <Button size="sm" variant="ghost" onClick={off}>Turn off</Button>
      </div>
    );
  } else if (c.session.room && cur?.kind === 'office') {
    body = (
      <>
        <p className="text-sm font-medium">{cur.label}</p>
        <CallView session={c.session} compact onLeave={off} />
      </>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">{route ? 'Joining…' : 'Nobody to talk to here. Walk into a room or up to a colleague.'}</p>
        <Button size="sm" variant="ghost" onClick={off}>Turn off</Button>
      </div>
    );
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
