import type { FullConfig } from '@playwright/test';

/** Authenticated readiness probe (a negative/unauthenticated probe must use a plain `fetch` with no headers, never `use.extraHTTPHeaders`) for playwright.protected.config.ts: fails with a clear message when the gate rejects the credential. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const use = config.projects[0].use;
  const headers = (use.extraHTTPHeaders ?? {}) as Record<string, string>;
  if (Object.keys(headers).length === 0) {
    throw new Error('Set PLAYWRIGHT_AUTH_COOKIE ("name=value") or PLAYWRIGHT_AUTH_HEADER + PLAYWRIGHT_AUTH_VALUE; the site answers 404 without it.');
  }
  const url = `${use.baseURL}${process.env.PLAYWRIGHT_READY_PATH ?? '/'}`;
  const deadline = Date.now() + 60_000;
  let rejected = 0;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers, redirect: 'manual' });
      if (res.status < 400) return;
      last = `HTTP ${res.status}`;
      // The server is up but refuses us: wrong credential, not a slow start.
      if ([401, 403, 404].includes(res.status) && ++rejected >= 5) {
        throw new Error(`The access gate rejected the configured credential (${last} for ${url}). Check PLAYWRIGHT_AUTH_* (values are not printed).`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('The access gate')) throw err;
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Authenticated readiness probe for ${url} did not succeed within 60s (last: ${last}).`);
}
