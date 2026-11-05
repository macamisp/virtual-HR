'use client';

import Link from 'next/link';
import { AudioLines, Hand, Headphones, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { officeRoute } from '@/lib/media/call-controller';
import type { OfficeClient } from '@/lib/office/office-client';
import { cn } from '@/lib/utils';
import { useSession } from './call-view';
import { PreJoin } from './prejoin';
import { useCallController } from './use-call-controller';

/**
 * ADR 048 §3b: the office's call controls in one toolbar above the map. It drives the tab's single
 * call controller and media session (the same ones as the floating dock), so nothing is joined
 * twice. Before media is on it offers the device check (PreJoin) as the main action. Labels show
 * from md up; below that the buttons are icons with the same accessible names and tooltips.
 */
export function OfficeToolbar({ client, setup, onSetup }: { client: OfficeClient; setup: boolean; onSetup: (v: boolean) => void }) {
  const c = useCallController();
  const s = c.session;
  useSession(s);
  const cur = c.current;
  const inCall = !!s.room && !!cur;
  const handUp = s.tiles().find((t) => t.isLocal)?.hand ?? false;
  const count = s.tiles().length;
  const route = officeRoute(client);

  let status: string;
  if (!c.officeMediaEnabled && cur?.kind !== 'meeting') status = 'Audio and video off';
  else if (c.lock === 'elsewhere') status = 'Open in another tab';
  else if (inCall && s.status === 'reconnecting') status = 'Reconnecting…';
  else if (inCall && s.status === 'connecting') status = 'Connecting…';
  else if (inCall && s.status === 'connected') status = `Connected · ${cur.kind === 'office' ? cur.label : cur.title} · ${count} in call`;
  else if (route) status = 'Joining…';
  else status = 'Nobody to talk to here. Walk into a room or up to a colleague.';
  const tone = s.status === 'reconnecting' || s.status === 'connecting' ? 'bg-amber-500' : inCall && s.status === 'connected' ? 'bg-green-600' : 'bg-slate-400';

  const ctl = (props: { label: string; on?: boolean; pressed?: boolean; onClick: () => void; icon: React.ReactNode; text: string; disabled?: boolean; danger?: boolean }) => (
    <Button size="sm" variant={props.danger ? 'destructive' : props.on ? 'default' : 'outline'} aria-label={props.label} title={props.label}
      aria-pressed={props.pressed} disabled={props.disabled} onClick={props.onClick} className="px-2 md:px-3">
      {props.icon}<span className="hidden md:inline">{props.text}</span>
    </Button>
  );

  return (
    <>
      <div role="region" aria-label="Office call" data-testid="office-toolbar" data-status={inCall ? s.status : 'none'}
        data-mic={s.micOn ? 'on' : 'off'} data-cam={s.camOn ? 'on' : 'off'} data-speaker={s.speakerMuted ? 'off' : 'on'}
        className="z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur md:sticky md:top-16">
        <p role="status" aria-live="polite" className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-sm" data-testid="office-call-status">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', tone)} aria-hidden="true" />
          <span className="truncate">{status}</span>
        </p>
        {!c.officeMediaEnabled && cur?.kind !== 'meeting' ? (
          <Button size="sm" onClick={() => onSetup(true)} disabled={setup}><Headphones aria-hidden="true" /> Turn on audio and video</Button>
        ) : c.lock === 'elsewhere' ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="call-elsewhere">
            <span className="text-sm">This call is open in another tab.</span>
            <Button size="sm" onClick={() => void c.takeOver()}>Take over</Button>
            <Button size="sm" variant="ghost" onClick={() => c.disableOfficeMedia()}>Turn off</Button>
          </div>
        ) : (
          <div role="toolbar" aria-label="Call controls" className="flex flex-wrap items-center gap-1">
            {ctl({ label: s.micOn ? 'Mute' : 'Unmute', on: s.micOn, pressed: s.micOn, disabled: !inCall, onClick: () => void s.toggleMic(), icon: s.micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />, text: s.micOn ? 'Mic on' : 'Mic off' })}
            {ctl({ label: 'Camera', on: s.camOn, pressed: s.camOn, disabled: !inCall, onClick: () => void s.toggleCam(), icon: s.camOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />, text: s.camOn ? 'Camera on' : 'Camera off' })}
            {ctl({ label: s.speakerMuted ? 'Unmute speakers' : 'Mute speakers', on: !s.speakerMuted, pressed: !s.speakerMuted, onClick: () => void s.setSpeakerMuted(!s.speakerMuted), icon: s.speakerMuted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />, text: s.speakerMuted ? 'Sound off' : 'Sound on' })}
            {ctl({ label: s.sharing ? 'Stop sharing' : 'Share screen', on: s.sharing, pressed: s.sharing, disabled: !inCall, onClick: () => void s.toggleShare(), icon: <MonitorUp aria-hidden="true" />, text: s.sharing ? 'Stop sharing' : 'Share' })}
            {ctl({ label: handUp ? 'Lower hand' : 'Raise hand', on: handUp, pressed: handUp, disabled: !inCall, onClick: () => void s.raiseHand(!handUp), icon: <Hand aria-hidden="true" />, text: handUp ? 'Lower hand' : 'Raise hand' })}
            {ctl({ label: 'Audio only', on: s.audioOnly, pressed: s.audioOnly, disabled: !inCall, onClick: () => void s.setAudioOnly(!s.audioOnly), icon: <AudioLines aria-hidden="true" />, text: 'Audio only' })}
            {cur?.kind === 'meeting' ? <Button size="sm" variant="outline" asChild><Link href={`/meetings/${cur.meetingId}`}>Return to meeting</Link></Button> : null}
            {ctl({ label: inCall ? 'Leave call' : 'Turn off audio and video', danger: true, onClick: () => void c.leave(), icon: <PhoneOff aria-hidden="true" />, text: inCall ? 'Leave' : 'Turn off' })}
          </div>
        )}
        {inCall && s.audioBlocked && !s.speakerMuted ? <Button size="sm" variant="secondary" onClick={() => void s.allowAudio()}><Volume2 aria-hidden="true" /> Allow sound</Button> : null}
      </div>
      {setup && !c.officeMediaEnabled ? (
        <PreJoin title="Audio and video in the office" joinLabel="Turn on" onCancel={() => onSetup(false)} onJoin={(p) => { c.enableOfficeMedia(p); onSetup(false); }} />
      ) : null}
    </>
  );
}
