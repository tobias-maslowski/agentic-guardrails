import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for a SITE-WIDE ACCESS GATE (every route answers 404/401 without a secret).
 *
 * Playwright's `webServer.url` probe is unauthenticated, so a gated site never becomes "ready" and the run hangs.
 * This variant waits for the TCP port instead and then verifies readiness with an AUTHENTICATED request in
 * `playwright.protected.global-setup.ts`; the same credential is sent with every test request.
 *
 * Credentials come from the environment (never commit them):
 *   PLAYWRIGHT_AUTH_COOKIE="name=value"                 sent as a Cookie header, or
 *   PLAYWRIGHT_AUTH_HEADER="x-access-key"  +  PLAYWRIGHT_AUTH_VALUE="<secret>"
 * Use it with: npx playwright test -c playwright.protected.config.ts
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4321);
const BASE_URL = `http://localhost:${PORT}`;

const cookie = process.env.PLAYWRIGHT_AUTH_COOKIE;
const headerName = process.env.PLAYWRIGHT_AUTH_HEADER;
const headerValue = process.env.PLAYWRIGHT_AUTH_VALUE;
const extraHTTPHeaders: Record<string, string> = {};
if (cookie) extraHTTPHeaders.cookie = cookie;
else if (headerName && headerValue) extraHTTPHeaders[headerName] = headerValue;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  globalSetup: './playwright.protected.global-setup.ts',
  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 960 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx astro dev --port ${PORT} --strictPort`,
    // TCP readiness: no HTTP request, so the gate cannot answer 404 to the probe.
    port: PORT,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1' && !process.env.CI,
    timeout: 60_000,
  },
});
