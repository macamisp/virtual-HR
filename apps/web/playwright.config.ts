import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real API and Postgres (no mocks). Uses dedicated ports so it does not
 * collide with `npm run dev`: API 3101, web 3100. Database comes from the PG* / DATABASE_URL
 * env (same as the API test suite); global-setup re-seeds a dedicated org on every run.
 */
const API_PORT = 3101;
const WEB_PORT = 3100;
const apiUrl = `http://localhost:${API_PORT}`;
const webUrl = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    // Same calendar day as the server's org timezone (Asia/Colombo), so "today" matches.
    timezoneId: 'Asia/Colombo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ../../dist/apps/api/src/main.js',
      url: `${apiUrl}/users/me`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        CORS_ORIGINS: webUrl,
        RATE_LIMIT_LOGIN: '500',
        RATE_LIMIT_REFRESH: '500',
        // The suite signs the same people in many times per minute; production default is 10/min.
        RATE_LIMIT_HEARTBEAT: '500',
        BREACHED_PASSWORD_CHECK: 'local',
        MAIL_TRANSPORT: 'memory',
        // No Redis needed: notification emails are sent inline and no schedulers run.
        JOBS_ENABLED: 'false',
      } as Record<string, string>,
    },
    {
      command: `npx next build && npx next start -p ${WEB_PORT}`,
      url: `${webUrl}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: apiUrl,
        NEXT_PUBLIC_STORAGE_URL: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? '',
        NEXT_TELEMETRY_DISABLED: '1',
      } as Record<string, string>,
    },
  ],
});
