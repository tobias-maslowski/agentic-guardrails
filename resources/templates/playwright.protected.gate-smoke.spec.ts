import { expect, test } from '@playwright/test';

/**
 * Smoke test for a site-wide access gate against the BUILT worker, not the dev server:
 *   npm run build && npx wrangler dev --config dist/server/wrangler.json --port 8787
 * Static assets are served before the Worker unless `assets.run_worker_first` is set, so the gate must cover a REAL
 * built asset, not only the HTML page.
 *
 * Env: GATE_BASE_URL (default http://localhost:8787), GATE_ASSET_PATH (a real file from dist/client, e.g. /_astro/app.abc123.css),
 *      GATE_KEY_HEADER + GATE_KEY_VALUE (the credential the gate accepts, e.g. x-access-key).
 *
 * Unauthenticated probes use plain `fetch`: the `request` fixture would inherit the credential from `extraHTTPHeaders`
 * of playwright.protected.config.ts and could never see the 404.
 */
const base = process.env.GATE_BASE_URL ?? 'http://localhost:8787';
const assetPath = process.env.GATE_ASSET_PATH;
const keyHeader = process.env.GATE_KEY_HEADER;
const keyValue = process.env.GATE_KEY_VALUE;

test.beforeAll(() => {
  if (!assetPath || !/(\/_astro\/.+|\.(svg|js|css)$)/.test(assetPath)) throw new Error('Set GATE_ASSET_PATH to a real built asset (e.g. /_astro/<file>.css).');
  if (!keyHeader || !keyValue) throw new Error('Set GATE_KEY_HEADER and GATE_KEY_VALUE to the credential the gate accepts.');
});

test('page without the key is 404', async () => {
  expect((await fetch(`${base}/`, { redirect: 'manual' })).status).toBe(404);
});

test('built asset without the key is 404', async () => {
  expect((await fetch(`${base}${assetPath}`, { redirect: 'manual' })).status).toBe(404);
});

test('the same built asset WITH the key is 200 (the asset itself must exist)', async () => {
  const res = await fetch(`${base}${assetPath}`, { redirect: 'manual', headers: { [keyHeader!]: keyValue! } });
  expect(res.status, `${assetPath} answered ${res.status} with the key: the asset does not exist in the build, the gate smoke test proves nothing`).toBe(200);
});
