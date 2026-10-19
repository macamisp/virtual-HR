import { generateSync } from 'otplib';

/**
 * A valid TOTP code that will still be valid when the server checks it. The server accepts a code
 * only inside its own 30-second step (no tolerance window), and under the parallel test run the
 * request can arrive after the step changed: in the last seconds of a step, wait for the next one.
 */
export async function freshCode(secret: string): Promise<string> {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < 5) await new Promise((r) => setTimeout(r, left * 1000 + 250));
  return generateSync({ secret });
}
