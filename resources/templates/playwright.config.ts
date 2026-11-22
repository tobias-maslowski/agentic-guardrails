import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4321);
const BASE_URL = `http://localhost:${PORT}`;
// TODO: replace '/' with a project-specific readiness route
const READY_PATH = process.env.PLAYWRIGHT_READY_PATH ?? '/';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 960 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // --strictPort: fail instead of silently hopping to another port
    command: `npx astro dev --port ${PORT} --strictPort`,
    // Readiness URL: set READY_PATH to a route that only THIS project serves (e.g. a unique page
    // or health route), so a dev server from another repo on the same port is never mistaken for ours.
    url: `${BASE_URL}${READY_PATH}`,
    // Never attach to an already-running server unless explicitly opted in (local iteration only).
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1' && !process.env.CI,
    timeout: 30_000,
  },
});
