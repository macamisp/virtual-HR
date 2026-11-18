import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';
import { hearsAudio } from './media';

/**
 * Self-hosted LiveKit rehearsal (ADR 067; docs/runbooks/livekit-selfhost.md §5). Opt-in: runs only
 * with LIVEKIT_REHEARSAL=1 and the API's LIVEKIT_URL pointing at the self-hosted server's TLS front
 * (wss://...). Two people in a meeting through that front, then the paths a restrictive network
 * forces: TURN over TLS only, TURN over UDP only, a dropped network that comes back, and a blocked
 * microphone.
 *
 * Rehearsal knobs (local only; leave empty against real DNS and certificates):
 *   LIVEKIT_REHEARSAL_HOSTS=livekit.hrvo.test  resolve these to 127.0.0.1 (signalling; WebRTC's own
 *                                   TURN lookups ignore this, so the TURN name is a *.localhost name)
 *   LIVEKIT_REHEARSAL_LOCAL=1       the server runs on this machine: accept its internal CA and let
 *                                   WebRTC use the loopback interface (TURN on 127.0.0.1)
 *   LIVEKIT_REHEARSAL_TURN_PORT_MAP=443:8453  rewrite the advertised TURN/TLS port
 */
const enabled = process.env.LIVEKIT_REHEARSAL === '1';
const hosts = (process.env.LIVEKIT_REHEARSAL_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const [portFrom, portTo] = (process.env.LIVEKIT_REHEARSAL_TURN_PORT_MAP ?? '').split(':');

test.skip(!enabled, 'LIVEKIT_REHEARSAL=1 runs the self-hosted LiveKit rehearsal');
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...(hosts.length ? [`--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`] : []),
      ...(process.env.LIVEKIT_REHEARSAL_LOCAL === '1' ? ['--ignore-certificate-errors', '--allow-loopback-in-peer-connection'] : []),
    ],
  },
});

type Relay = 'none' | 'tls' | 'udp';

/**
 * Records every RTCPeerConnection (window.__pcs). With relay 'tls' or 'udp' it keeps only the TURN
 * servers LiveKit advertised for that transport and forces relay-only ICE, as a network that blocks
 * direct media would.
 */
function pcHook({ relay, from, to }: { relay: Relay; from: string; to: string }): void {
  const Orig = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  const pick = (url: string) => (relay === 'tls' ? url.startsWith('turns:') : url.startsWith('turn:') && !/transport=tcp/.test(url));
  const port = (url: string) => (from && to ? url.replace(`:${from}`, `:${to}`) : url);
  const force = (config?: RTCConfiguration): RTCConfiguration | undefined => {
    if (relay === 'none' || !config) return config;
    const iceServers = (config.iceServers ?? [])
      .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(pick).map(port) }))
      .filter((s) => s.urls.length > 0);
    return { ...config, iceServers, iceTransportPolicy: 'relay' };
  };
  window.RTCPeerConnection = class extends Orig {
    constructor(config?: RTCConfiguration) {
      super(force(config));
      pcs.push(this);
    }

    // livekit-client may apply the server's ICE servers again later (reconnects, ICE restarts).
    override setConfiguration(config?: RTCConfiguration): void {
      super.setConfiguration(force(config));
    }
  };
}

/** Local candidate type and relay protocol of the selected pair on every connected peer connection. */
async function selectedPaths(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const out: string[] = [];
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s));
      // The pair a transport selected; else the nominated, succeeded pair (older stats shapes).
      const pairs = new Set<string>();
      stats.forEach((s: Record<string, unknown>) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pairs.add(String(s.selectedCandidatePairId));
      });
      if (pairs.size === 0) {
        stats.forEach((s: Record<string, unknown>) => {
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairs.add(String(s.id));
        });
      }
      for (const id of pairs) {
        const local = byId.get(String(byId.get(id)?.localCandidateId));
        if (local) out.push(`${String(local.candidateType)}/${String(local.relayProtocol ?? local.protocol)}`);
      }
    }
    return out;
  });
}

/** What the browser does when the person (or a policy) blocked the camera and microphone for the site. */
function blockedDevices(): void {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
}

async function personIn(browser: Browser, email: string, relay: Relay, blocked = false): Promise<Page> {
  const ctx: BrowserContext = await browser.newContext({ permissions: blocked ? [] : ['camera', 'microphone'] });
  await ctx.addInitScript(pcHook, { relay, from: portFrom ?? '', to: portTo ?? '' });
  if (blocked) await ctx.addInitScript(blockedDevices);
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  return page;
}

async function passPreJoin(page: Page): Promise<void> {
  const pre = page.getByTestId('prejoin');
  await expect(pre).toBeVisible();
  await expect.poll(async () => Number(await pre.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await pre.getByRole('button', { name: 'Join', exact: true }).click();
}

/** Wendy calls Leo; both join with microphones; returns both pages once each sees the other. */
async function call(browser: Browser, relay: Relay): Promise<{ host: Page; guest: Page }> {
  const guest = await personIn(browser, USERS.lead.email, relay);
  await guest.goto('/meetings');
  const host = await personIn(browser, USERS.worker.email, relay);
  await host.goto('/meetings');
  await host.getByRole('button', { name: 'Instant call' }).click();
  await host.getByRole('searchbox', { name: 'Call' }).fill('Leo');
  await host.getByRole('button', { name: new RegExp(USERS.lead.name) }).click();
  await host.getByRole('button', { name: 'Start call' }).click();
  await expect(host).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  await host.getByRole('button', { name: 'Join meeting' }).click();
  await passPreJoin(host);
  await expect(host.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  const ring = guest.getByTestId('ring');
  await expect(ring).toContainText(`${USERS.worker.name} is calling you`);
  await ring.getByRole('button', { name: 'Accept', exact: true }).click();
  await passPreJoin(guest);
  await expect(guest.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  await expect(host.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
  await expect(guest.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id);
  return { host, guest };
}

async function hangUp({ host, guest }: { host: Page; guest: Page }): Promise<void> {
  await guest.getByRole('button', { name: 'Leave' }).click();
  await expect(host.getByTestId('tile-remote')).toHaveCount(0);
  await host.getByRole('button', { name: 'Leave' }).click();
  await guest.context().close();
  await host.context().close();
}

test.describe.serial('Self-hosted LiveKit rehearsal (ADR 067)', () => {
  test.setTimeout(180_000);

  test('a meeting through the TLS front: both hear each other over a direct path', async ({ browser }) => {
    expect(process.env.LIVEKIT_URL ?? '', 'the API must hand out the TLS front').toMatch(/^wss:\/\//);
    const pair = await call(browser, 'none');
    await expect.poll(() => hearsAudio(pair.guest), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hearsAudio(pair.host), { timeout: 20_000 }).toBe(true);
    const paths = await selectedPaths(pair.guest);
    test.info().annotations.push({ type: 'paths', description: paths.join(', ') });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => !p.startsWith('relay')), paths.join(', ')).toBe(true);
    await hangUp(pair);
  });

  test('UDP blocked: media is relayed by TURN over TLS on the TURN name', async ({ browser }) => {
    test.skip(process.env.LIVEKIT_REHEARSAL_LOCAL === '1', 'relayed media needs the browser on another host than the server: the TURN relay cannot loop back into an SFU on the same machine (ADR 067 report)');
    const pair = await call(browser, 'tls');
    await expect.poll(() => hearsAudio(pair.guest), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => hearsAudio(pair.host), { timeout: 30_000 }).toBe(true);
    const paths = await selectedPaths(pair.guest);
    test.info().annotations.push({ type: 'paths', description: paths.join(', ') });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p === 'relay/tls'), paths.join(', ')).toBe(true);
    await hangUp(pair);
  });

  test('only a TURN relay over UDP: media still flows', async ({ browser }) => {
    test.skip(process.env.LIVEKIT_REHEARSAL_LOCAL === '1', 'relayed media needs the browser on another host than the server: the TURN relay cannot loop back into an SFU on the same machine (ADR 067 report)');
    const pair = await call(browser, 'udp');
    await expect.poll(() => hearsAudio(pair.guest), { timeout: 30_000 }).toBe(true);
    const paths = await selectedPaths(pair.guest);
    test.info().annotations.push({ type: 'paths', description: paths.join(', ') });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p === 'relay/udp'), paths.join(', ')).toBe(true);
    await hangUp(pair);
  });

  test('the network drops for a few seconds: the call reconnects and audio flows again', async ({ browser }) => {
    const pair = await call(browser, 'none');
    await expect.poll(() => hearsAudio(pair.guest), { timeout: 20_000 }).toBe(true);
    await pair.guest.context().setOffline(true);
    await pair.guest.waitForTimeout(6_000);
    await pair.guest.context().setOffline(false);
    await expect(pair.guest.getByTestId('call-view')).toHaveAttribute('data-status', 'connected', { timeout: 45_000 });
    await expect(pair.guest.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id, { timeout: 30_000 });
    await expect.poll(() => hearsAudio(pair.guest), { timeout: 30_000 }).toBe(true);
    await hangUp(pair);
  });

  test('a blocked microphone is explained before joining, and nothing is published', async ({ browser }) => {
    const page = await personIn(browser, USERS.worker.email, 'none', true);
    await page.goto('/meetings');
    await page.getByRole('button', { name: 'Instant call' }).click();
    await page.getByRole('button', { name: 'Start call' }).click();
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Join meeting' }).click();
    await expect(page.getByTestId('prejoin-error')).toContainText('The browser blocked the');
    await page.context().close();
  });
});
