import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real API and Postgres (no mocks). Uses dedicated ports so it does not
 * collide with `npm run dev`: API 3101, web 3100. Database comes from the PG* / DATABASE_URL
 * env (same as the API test suite); global-setup re-seeds a dedicated org on every run.
 */
const API_PORT = 3101;
const WEB_PORT = 3100;
// A local OpenID Connect provider standing in for Google (apps/api/test/support/fake-google.ts).
const FAKE_GOOGLE_PORT = 3102;
const apiUrl = `http://localhost:${API_PORT}`;
const webUrl = `http://localhost:${WEB_PORT}`;
const fakeGoogleUrl = `http://localhost:${FAKE_GOOGLE_PORT}`;

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
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Fake camera and microphone for the meeting specs (FR-MEET-011), granted without a prompt.
      permissions: ['camera', 'microphone'],
      launchOptions: {
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--auto-select-desktop-capture-source=Entire screen',
          '--autoplay-policy=no-user-gesture-required',
          // OFFICE_BENCH_GPU=1 with --headed: let Chromium use the real GPU for the office render bench.
          ...(process.env.OFFICE_BENCH_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] : []),
        ],
      },
    },
  }],
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
        // No Redis needed: notification emails are sent inline and no schedulers run, except the
        // attendance reconciler, which the accuracy spec (23) needs for tab-close and network-loss.
        JOBS_ENABLED: 'false',
        ATTENDANCE_RECONCILE_INLINE_MS: '5000',
        // Sign in with Google against the fake provider (FR-AUTH-005; ADR 037); the specs start
        // many sign-ins per minute, so the signup and OAuth buckets are raised like the login one.
        RATE_LIMIT_SIGNUP: '500',
        RATE_LIMIT_OAUTH: '500',
        APP_WEB_URL: webUrl,
        GOOGLE_CLIENT_ID: 'fake-google-client',
        GOOGLE_CLIENT_SECRET: 'fake-google-secret',
        GOOGLE_REDIRECT_URI: `${apiUrl}/auth/google/callback`,
        GOOGLE_OAUTH_AUTH_URL: `${fakeGoogleUrl}/auth`,
        GOOGLE_OAUTH_TOKEN_URL: `${fakeGoogleUrl}/token`,
        GOOGLE_OIDC_JWKS_URL: `${fakeGoogleUrl}/certs`,
        GOOGLE_OIDC_ISSUER: fakeGoogleUrl,
      } as Record<string, string>,
    },
    {
      command: 'node --experimental-strip-types --no-warnings=ExperimentalWarning ../api/test/support/fake-google-server.ts',
      url: `${fakeGoogleUrl}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: 'development', FAKE_GOOGLE_PORT: String(FAKE_GOOGLE_PORT) } as Record<string, string>,
    },
    {
      command: `npx next build && npx next start -p ${WEB_PORT}`,
      url: `${webUrl}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: apiUrl,
        NEXT_PUBLIC_STORAGE_URL: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? '',
        NEXT_PUBLIC_LIVEKIT_URL: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_DIST_DIR: '.next-e2e',
      } as Record<string, string>,
    },
  ],
});
