import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Captures the product screenshots used by the public landing page (src/app/welcome/shots) from
 * the real app against the synthetic e2e organisation. Not part of the regular suite:
 *   npx playwright test --config playwright.landing-shots.config.ts
 * Same API/web servers and global setup as playwright.config.ts (a fresh e2e org each run).
 */
export default defineConfig({
  ...base,
  testDir: './e2e-capture',
  retries: 0,
  timeout: 180_000,
});
