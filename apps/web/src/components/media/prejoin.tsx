'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, Volume2 } from 'lucide-react';
import { Room, createLocalAudioTrack, createLocalVideoTrack, type LocalAudioTrack, type LocalVideoTrack } from 'livekit-client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { loadPrefs, savePrefs } from '@/lib/media/devices';
import { mediaErrorMessage } from '@hrvo/shared';
import type { MediaDevice } from '@hrvo/shared';
import type { DevicePrefs } from '@/lib/media/devices';

/**
 * FR-MEET-011: camera preview, microphone level and a speaker test, with device selection.
 * Choices are remembered in this browser.
 */
/** Why a device failed, naming the HTTPS requirement when the page is not a secure context. */
const explain = (err: unknown, device: MediaDevice) =>
  mediaErrorMessage(err, device, { secure: window.isSecureContext, hasMediaDevices: !!navigator.mediaDevices, origin: window.location.origin });

export function PreJoin({ title, onJoin, onCancel, joinLabel = 'Join' }: { title: string; onJoin: (p: DevicePrefs) => void; onCancel?: () => void; joinLabel?: string }) {
  const [prefs, setPrefs] = useState<DevicePrefs>(() => loadPrefs());
  const [devices, setDevices] = useState<{ audioinput: MediaDeviceInfo[]; videoinput: MediaDeviceInfo[]; audiooutput: MediaDeviceInfo[] }>({ audioinput: [], videoinput: [], audiooutput: [] });
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const ids = { mic: useId(), cam: useId(), spk: useId() };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([Room.getLocalDevices('audioinput', true), Room.getLocalDevices('videoinput', true), Room.getLocalDevices('audiooutput', false)])
      .then(([a, v, o]) => { if (!cancelled) setDevices({ audioinput: a, videoinput: v, audiooutput: o }); })
      .catch((err: unknown) => setError(explain(err, 'camera or microphone')));
    return () => { cancelled = true; };
  }, []);

  // Camera preview.
  useEffect(() => {
    if (!prefs.camOn) return;
    let track: LocalVideoTrack | null = null;
    let cancelled = false;
    void createLocalVideoTrack({ deviceId: prefs.videoInput === 'default' ? undefined : prefs.videoInput, resolution: { width: 640, height: 360 } })
      .then((t) => { if (cancelled) { t.stop(); return; } track = t; if (video.current) t.attach(video.current); })
      .catch((err: unknown) => setError(explain(err, 'camera')));
    return () => { cancelled = true; track?.stop(); };
  }, [prefs.camOn, prefs.videoInput]);

  // Microphone level meter.
  useEffect(() => {
    if (!prefs.micOn) { setLevel(0); return; }
    let track: LocalAudioTrack | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    void createLocalAudioTrack({ deviceId: prefs.audioInput === 'default' ? undefined : prefs.audioInput, echoCancellation: true, noiseSuppression: true })
      .then((t) => {
        if (cancelled) { t.stop(); return; }
        track = t;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(new MediaStream([t.mediaStreamTrack])).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => { analyser.getByteTimeDomainData(data); let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128)); setLevel(Math.min(1, peak / 64)); raf = requestAnimationFrame(tick); };
        tick();
      })
      .catch((err: unknown) => setError(explain(err, 'microphone')));
    return () => { cancelled = true; cancelAnimationFrame(raf); track?.stop(); void ctx?.close(); };
  }, [prefs.micOn, prefs.audioInput]);

  const testSpeaker = async () => {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(dest);
    const el = new Audio();
    el.srcObject = dest.stream;
    if (prefs.audioOutput !== 'default' && 'setSinkId' in el) await (el as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(prefs.audioOutput).catch(() => undefined);
    osc.start();
    await el.play().catch(() => undefined);
    setTimeout(() => { osc.stop(); void ctx.close(); }, 700);
  };

  const set = (p: Partial<DevicePrefs>) => setPrefs({ ...prefs, ...p });
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;
  return (
    <Card data-testid="prejoin">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="relative aspect-video w-full max-w-md overflow-hidden rounded bg-slate-900">
          {prefs.camOn ? <video ref={video} muted playsInline autoPlay className="h-full w-full object-cover" data-testid="prejoin-video" /> : <p className="absolute inset-0 grid place-items-center text-sm text-slate-300">Camera off</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={prefs.micOn ? 'default' : 'outline'} aria-pressed={prefs.micOn} onClick={() => set({ micOn: !prefs.micOn })}>{prefs.micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />} Microphone {prefs.micOn ? 'on' : 'off'}</Button>
          <Button type="button" variant={prefs.camOn ? 'default' : 'outline'} aria-pressed={prefs.camOn} onClick={() => set({ camOn: !prefs.camOn })}>{prefs.camOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />} Camera {prefs.camOn ? 'on' : 'off'}</Button>
          <Button type="button" variant="outline" onClick={() => void testSpeaker()}><Volume2 aria-hidden="true" /> Test speaker</Button>
        </div>
        <div className="space-y-1" aria-label="Microphone level" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} data-testid="mic-level">
          <div className="h-2 w-full max-w-md rounded bg-muted"><div className="h-2 rounded bg-green-600 transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} /></div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1"><Label htmlFor={ids.mic}>Microphone</Label>
            <NativeSelect id={ids.mic} value={prefs.audioInput} onChange={(e) => set({ audioInput: e.target.value })}><option value="default">Default</option>{devices.audioinput.filter((d) => d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Microphone')}</option>)}</NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.cam}>Camera</Label>
            <NativeSelect id={ids.cam} value={prefs.videoInput} onChange={(e) => set({ videoInput: e.target.value })}><option value="default">Default</option>{devices.videoinput.filter((d) => d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Camera')}</option>)}</NativeSelect></div>
          <div className="space-y-1"><Label htmlFor={ids.spk}>Speaker</Label>
            <NativeSelect id={ids.spk} value={prefs.audioOutput} onChange={(e) => set({ audioOutput: e.target.value })}><option value="default">Default</option>{devices.audiooutput.filter((d) => d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Speaker')}</option>)}</NativeSelect></div>
        </div>
        {error ? <Alert variant="destructive" data-testid="prejoin-error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex gap-2">
          <Button onClick={() => { savePrefs(prefs); onJoin(prefs); }}>{joinLabel}</Button>
          {onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        </div>
      </CardContent>
    </Card>
  );
}
