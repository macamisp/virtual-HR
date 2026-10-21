import { generateSync } from 'otplib';

const STEP_MS = 30_000;
const lastStep = new Map<string, number>();

/**
 * A valid TOTP code that has not been used yet by this process. The server accepts one step either
 * side of its own (clock-drift tolerance) and each person's codes only once, newest step first
 * (FR-AUTH-004). A second code for the same secret therefore comes from the next step; once that
 * is used up, it waits for the clock to reach it.
 */
export async function freshCode(secret: string): Promise<string> {
  const nowStep = Math.floor(Date.now() / STEP_MS);
  const last = lastStep.get(secret) ?? -1;
  let step = Math.max(nowStep, last + 1);
  if (step > nowStep + 1) {
    // Ahead of the tolerance: wait until the clock is one step behind the code.
    await new Promise((r) => setTimeout(r, (step - 1) * STEP_MS - Date.now() + 250));
    step = Math.max(Math.floor(Date.now() / STEP_MS), last + 1);
  }
  lastStep.set(secret, step);
  return generateSync({ secret, epoch: step * 30 });
}
