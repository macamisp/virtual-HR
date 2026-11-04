import { expect, test, type Browser, type Page } from '@playwright/test';
import { USERS } from './fixtures';
import { passNoticeGate, signIn } from './helpers';

/**
 * FR-MEET-002 / FR-VO-005 regression (2026-10-29): people inside a meeting room could not hear
 * each other. The client asked for a proximity call in open-access meeting rooms (it looked at the
 * access mode, the server at the room type), and it never learnt that walking through a door had
 * changed its room. Audio is checked on the wire: inbound RTP packets with non-zero energy from
 * Chromium's synthetic microphone tone.
 */

/** Counts every RTCPeerConnection the page opens, so the test can read audio RTP stats. */
const PC_HOOK = () => {
  const Orig = window.RTCPeerConnection;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  window.RTCPeerConnection = class extends Orig { constructor(...a: ConstructorParameters<typeof RTCPeerConnection>) { super(...a); pcs.push(this); } };
};

async function inboundAudio(page: Page): Promise<{ packets: number; energy: number }> {
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
async function hearsAudio(page: Page): Promise<boolean> {
  const a = await inboundAudio(page);
  await page.waitForTimeout(2000);
  const b = await inboundAudio(page);
  return b.packets - a.packets > 20 && b.energy - a.energy > 0;
}

async function inOffice(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(PC_HOOK);
  const page = await ctx.newPage();
  await signIn(page, email);
  await passNoticeGate(page);
  await page.goto('/office');
  await expect(page.getByTestId('office-canvas').locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Turn on audio and video' }).click();
  await page.getByTestId('prejoin').getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(page.getByTestId('office-media')).toBeVisible();
  return page;
}

const goTo = (page: Page, room: string) => page.getByRole('list', { name: 'Rooms' }).getByTestId(`room-${room}`).getByRole('button', { name: `Go to ${room}` }).click();

test('office: people in the same meeting room hear each other; other rooms and the open area do not', async ({ browser }) => {
  test.setTimeout(180_000); // two sign-ins and four LiveKit (re)connections
  const lead = await inOffice(browser, USERS.lead.email);
  const worker = await inOffice(browser, USERS.worker.email);
  try {
    // Meeting room A is a MEETING room with OPEN access: walking in is free, and it is a room call.
    await goTo(lead, 'Meeting room A');
    await goTo(worker, 'Meeting room A');
    const leadMedia = lead.getByTestId('office-media');
    const workerMedia = worker.getByTestId('office-media');
    await expect(leadMedia).toContainText('Meeting room A');
    await expect(leadMedia.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.worker.id);
    await expect(workerMedia.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
    await expect.poll(() => hearsAudio(lead), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hearsAudio(worker), { timeout: 20_000 }).toBe(true);

    // Walk out through the door (the teleport puts the avatar just below the table, in the door
    // column): the client learns it left the room from the server and leaves the room call.
    await worker.getByTestId('office-canvas').focus();
    await worker.keyboard.down('KeyS');
    await worker.waitForTimeout(1500);
    await worker.keyboard.up('KeyS');
    await expect(worker.getByTestId('my-status')).not.toContainText('Meeting room A');
    await expect(lead.getByTestId('people-list').getByRole('listitem').filter({ hasText: USERS.worker.name })).toContainText('in the open area');
    await expect(leadMedia.getByTestId('tile-remote')).toHaveCount(0);
    await expect.poll(() => hearsAudio(lead), { timeout: 20_000 }).toBe(false);

    // Another meeting room is another conversation.
    await goTo(worker, 'Meeting room B');
    await expect(workerMedia).toContainText('Meeting room B');
    await expect(workerMedia.getByTestId('tile-remote')).toHaveCount(0);
    await expect(leadMedia.getByTestId('tile-remote')).toHaveCount(0);
    expect(await hearsAudio(lead)).toBe(false);
    expect(await hearsAudio(worker)).toBe(false);

    // Back in the same room: audio flows again (repeated transitions reconnect cleanly).
    await goTo(worker, 'Meeting room A');
    await expect(workerMedia.getByTestId('tile-remote')).toHaveAttribute('data-identity', USERS.lead.id);
    await expect(leadMedia.getByTestId('tile-remote')).toHaveCount(1);
    await expect.poll(() => hearsAudio(lead), { timeout: 20_000 }).toBe(true);
  } finally {
    await worker.context().close();
    await lead.context().close();
  }
});
