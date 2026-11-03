import type { Locator, Page } from '@playwright/test';

/** Counts every RTCPeerConnection the page opens, so a test can read audio RTP stats. */
export const PC_HOOK = () => {
  const Orig = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  window.RTCPeerConnection = class extends Orig { constructor(...a: ConstructorParameters<typeof RTCPeerConnection>) { super(...a); pcs.push(this); } };
};

/** Collects every local camera, microphone and screen track the page ever got, to check they are stopped. */
export const TRACK_HOOK = () => {
  const w = window as unknown as { __tracks: MediaStreamTrack[] };
  w.__tracks = [];
  const md = navigator.mediaDevices;
  for (const k of ['getUserMedia', 'getDisplayMedia'] as const) {
    const orig = md[k].bind(md) as (c?: MediaStreamConstraints) => Promise<MediaStream>;
    (md as unknown as Record<string, unknown>)[k] = async (c?: MediaStreamConstraints) => { const s = await orig(c); w.__tracks.push(...s.getTracks()); return s; };
  }
};

export async function inboundAudio(page: Page): Promise<{ packets: number; energy: number }> {
  return await page.evaluate(async () => {
    let packets = 0;
    let energy = 0;
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((s: { type: string; kind?: string; packetsReceived?: number; totalAudioEnergy?: number }) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') { packets += s.packetsReceived ?? 0; energy += s.totalAudioEnergy ?? 0; }
      });
    }
    return { packets, energy };
  });
}

/** True when audio arrives during the next two seconds (packets and sound, not just a connection). */
export async function hearsAudio(page: Page): Promise<boolean> {
  const a = await inboundAudio(page);
  await page.waitForTimeout(2000);
  const b = await inboundAudio(page);
  return b.packets - a.packets > 20 && b.energy - a.energy > 0;
}

/** Frames painted into the <video> during one second. */
export async function paintedFrames(video: Locator): Promise<number> {
  return await video.evaluate((v: HTMLVideoElement) => new Promise<number>((res) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => { frames += 1; if (performance.now() - t0 < 1000) v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
    setTimeout(() => res(frames), 1100);
  }));
}

/** Every local track the page ever opened is stopped (the camera light is off). */
export async function localTracks(page: Page): Promise<{ total: number; live: number }> {
  return await page.evaluate(() => {
    const t = (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks;
    return { total: t.length, live: t.filter((x) => x.readyState === 'live').length };
  });
}
