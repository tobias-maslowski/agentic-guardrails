import fs from 'node:fs';
import path from 'node:path';
import { ROOT, guardrailsConfig, isMonorepo, projects, toPosix } from './context.ts';
import { readText, walk } from './source-utils.ts';

/**
 * Gate Coverage Check (scripts/check-gate.ts) - STATIC heuristic, no build, no network.
 *
 * A site-wide access gate is a middleware or worker entry that answers `new Response(<body>, { status: 4xx })`
 * (usually 404) after a failed secret/key comparison. Config `gate: { file?, status? }` overrides the detection
 * (`file`: root-relative gate file(s); `status`: accepted status code(s), default any 4xx). On Cloudflare Workers with static assets (wrangler `assets`) the asset binding
 * answers matching requests BEFORE the Worker runs, so the gate never sees `/` or `/_astro/*` unless
 * `assets.run_worker_first` is true (or a custom `main` entry wraps the asset fetch).
 *
 * It does not prove runtime behaviour. Back it with a smoke test against the BUILT worker
 * (templates/playwright.protected.gate-smoke.spec.ts: expects 404 on `/` and a `/_astro/` asset without the key).
 *
 * Every wrangler*.json/.jsonc/.toml of the app that has `assets` needs
 * `run_worker_first`. Config `requireGate` (default true in monorepo mode when a wrangler config with assets and a
 * middleware/worker entry exist) fails when no gate is detected. A detected gate without a gate-smoke Playwright spec
 * (referencing the built `dist/` worker and asserting a real asset path) is an advisory.
 */

const GATE_FILE = /(^|\/)src\/(middleware(\/index)?|worker(\/[\w.-]+)?|_worker|entry[\w.-]*|index)\.(ts|js|mjs|mts)$/;
const SECRET_HINT = /(secret|key|token|poc_key|access)/i;
const gateCfg: { file?: string | string[]; status?: number | number[] } = (guardrailsConfig.gate && typeof guardrailsConfig.gate === 'object' ? guardrailsConfig.gate : {}) as any;
const statuses = gateCfg.status === undefined ? null : ([] as number[]).concat(gateCfg.status);
const gateFiles = gateCfg.file === undefined ? null : ([] as string[]).concat(gateCfg.file).map((f) => f.replace(/^\.\//, ''));
const respRe = (): RegExp => (statuses ? new RegExp(`new\\s+Response\\([^;]*?status\\s*:\\s*(${statuses.join('|')})\\b`, 'i') : /new\s+Response\([^;]*?status\s*:\s*4\d\d\b/i);

interface Wrangler { file: string; main?: string; assets: boolean; runWorkerFirst: boolean }

function stripJsonc(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
}

function parseWrangler(file: string): Wrangler {
  const raw = readText(file);
  if (file.endsWith('.toml')) {
    const main = raw.match(/^\s*main\s*=\s*["']([^"']+)["']/m)?.[1];
    const section = raw.match(/^\[assets\]([\s\S]*?)(?=^\[|(?![\s\S]))/m);
    const inline = raw.match(/^\s*assets\s*=\s*\{([^}]*)\}/m);
    const body = section?.[1] ?? inline?.[1] ?? '';
    return { file, main, assets: !!(section || inline), runWorkerFirst: /run_worker_first\s*=\s*(true|\[[^\]]*\S[^\]]*\])/.test(body) };
  }
  try {
    const j = JSON.parse(stripJsonc(raw));
    const a = j.assets;
    const rwf = a && (a.run_worker_first === true || (Array.isArray(a.run_worker_first) && a.run_worker_first.length > 0));
    return { file, main: typeof j.main === 'string' ? j.main : undefined, assets: !!a && typeof a === 'object', runWorkerFirst: !!rwf };
  } catch {
    return { file, assets: /"assets"\s*:/.test(raw), runWorkerFirst: /"run_worker_first"\s*:\s*(true|\[\s*")/.test(raw) };
  }
}

/** Every wrangler config of the app: `wrangler*.json|jsonc|toml` in its dir (or the repo root). Build output (dist/, .wrangler/) is never a detection source, so the result is identical before and after a build. */
function wranglerConfigs(dir: string): Wrangler[] {
  const out: Wrangler[] = [];
  const seen = new Set<string>();
  for (const base of dir === ROOT ? [dir] : [dir, ROOT]) {
    let names: string[] = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names.filter((x) => /^wrangler.*\.(json|jsonc|toml)$/.test(x))) {
      const f = path.join(base, n);
      if (!seen.has(f) && fs.existsSync(f)) { seen.add(f); out.push(parseWrangler(f)); }
    }
  }
  return out;
}

function gateFileCandidates(dir: string): string[] {
  const out: string[] = [];
  for (const abs of walk(path.join(dir, 'src'), { accept: (f: string) => /\.(ts|js|mjs|mts)$/.test(f) })) {
    const rel = toPosix(path.relative(ROOT, abs));
    if (/\.(test|spec)\./.test(rel)) continue;
    if (gateFiles ? gateFiles.includes(rel) : GATE_FILE.test(rel)) out.push(abs);
  }
  return out;
}

const gateFn: { function?: string; from?: string } = gateCfg as any;
const GATE_NAME = /gate|access|guard/i;

/** Names imported into `text` (`import { a as b, c } from '...'`, default imports) with their module specifier. */
function importedNames(text: string): Array<{ local: string; imported: string; from: string }> {
  const out: Array<{ local: string; imported: string; from: string }> = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) out.push({ local: m[1], imported: 'default', from: m[3] });
    for (const part of (m[2] ?? '').split(',')) {
      const [imp, loc] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (imp) out.push({ local: loc ?? imp, imported: imp, from: m[3] });
    }
  }
  return out;
}

/** A gate is: a configured function call, a call of an imported gate/access/guard function, or a literal 4xx Response after a secret check. */
function findGate(candidates: string[]): string | null {
  for (const abs of candidates) {
    const text = readText(abs);
    const rel = toPosix(path.relative(ROOT, abs));
    const imports = importedNames(text);
    const called = (local: string): boolean => new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*\\(`).test(text);
    if (gateFn.function) {
      if (imports.some((i) => i.imported === gateFn.function && (!gateFn.from || i.from === gateFn.from) && called(i.local))) return rel;
      continue;
    }
    if (imports.some((i) => GATE_NAME.test(i.imported === 'default' ? i.local : i.imported) && called(i.local))) return rel;
    if (respRe().test(text) && (gateFiles || SECRET_HINT.test(text))) return rel;
  }
  return null;
}

function smokeSpecAdvisory(): string | null {
  const dirs = [ROOT, ...projects.map((p) => p.abs)];
  for (const d of new Set(dirs)) {
    for (const sub of ['tests', 'test', 'e2e']) {
      for (const abs of walk(path.join(d, sub), { accept: (n: string) => /\.(spec|test)\.[cm]?[jt]s$/.test(n) })) {
        const t = readText(abs);
        if (/dist\/(server\/wrangler\.json|server|_worker)/.test(t) && /(\/_astro\/|\.(svg|js|css)\b)/.test(t)) return null;
      }
    }
  }
  return 'a site-wide gate is detected but no gate-smoke Playwright spec references the built worker (dist/server/wrangler.json) and asserts a real asset path (/_astro/..., .svg, .js, .css). fix: copy resources/templates/playwright.protected.gate-smoke.spec.ts and run it against the built worker.';
}

const requireGateCfg = guardrailsConfig.requireGate;
let errors = 0;
let checked = 0;
let gates = 0;
let advisory: string | null = null;
for (const p of projects) {
  const configs = wranglerConfigs(p.abs);
  const withAssets = configs.filter((c) => c.assets);
  const candidates = gateFileCandidates(p.abs);
  const gate = findGate(candidates);
  if (gate) gates++;
  if (withAssets.length === 0) continue;
  const requireGate = typeof requireGateCfg === 'boolean' ? requireGateCfg : isMonorepo && candidates.length > 0;
  if (!gate && requireGate) {
    errors++;
    console.error(`  • ${toPosix(path.relative(ROOT, withAssets[0].file))}:1  no site-wide access gate detected in ${p.dir || '.'} (requireGate is on).`);
    console.error('      fix: add a middleware/worker entry that answers a 4xx Response when the secret/key is missing, point config `gate: { file, status }` at it,');
    console.error('           or set `requireGate: false` (reported as weakened) if this app is intentionally public.');
    continue;
  }
  if (!gate) continue;
  for (const w of withAssets) {
    checked++;
    const rel = toPosix(path.relative(ROOT, w.file));
    let wrapsAssets = false;
    if (w.main && !w.main.startsWith('@') && !/^(\.\/)?dist\//.test(w.main)) {
      const mainAbs = path.resolve(path.dirname(w.file), w.main);
      wrapsAssets = fs.existsSync(mainAbs) && /ASSETS\s*\.\s*fetch|env\.ASSETS|\.fetch\(/.test(readText(mainAbs));
    }
    if (!w.runWorkerFirst && !wrapsAssets) {
      errors++;
      console.error(`  • ${rel}:1  site-wide access gate in ${gate} is bypassed for static assets: this wrangler config has "assets" without run_worker_first.`);
      console.error('      fix: set `assets.run_worker_first` to true (or a pattern list such as ["/*"]) so the Worker answers before the asset binding,');
      console.error('           or use a custom `main` entry that checks the key and then calls `env.ASSETS.fetch(request)`.');
      console.error('           Verify with the built-worker smoke test (templates/playwright.protected.gate-smoke.spec.ts).');
    }
  }
  advisory ??= smokeSpecAdvisory();
}

if (errors > 0) {
  console.error(`\n❌ Gate Coverage Check Failed: ${errors} issue(s). (static check; see the built-worker smoke test for runtime proof)`);
  process.exit(1);
}
if (advisory) console.log(`ℹ️  [Advisory] ${advisory}`);
console.log(
  gates === 0
    ? 'Gate Coverage Check Passed (no site-wide access gate detected; nothing to verify)'
    : `Gate Coverage Check Passed (${gates} gate(s) detected, ${checked} wrangler config(s) with assets verified; static check, add a built-worker smoke test)`
);
