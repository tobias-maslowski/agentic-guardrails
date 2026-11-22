import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Documentation claim checks (used by check-doc-drift.ts), all deterministic and dependency-free:
 *  a. every backticked repo path and markdown link target in an AGENTS.md routing table exists
 *     (an ADR/decision column must not point at an AGENTS.md);
 *  b. every `npm run <script>` / `npm test` / `npm start` quoted in an AGENTS.md or README.md exists in the
 *     package.json it belongs to (root file -> root; workspace file -> its own, falling back to the root;
 *     `--workspace=`/`-w`/`--prefix`/`--workspaces` are honoured);
 *  c. leftover template placeholders (`<TODO>`, `{{...}}`, `TODO:`, "replace me");
 *  d. (`requireAdr`) at least one decision record that is not an AGENTS.md;
 *  e. relative markdown links resolve (e.g. `../package-lock.json`, resolved from the file's own directory);
 *  f. in ALL markdown files (README.md, AGENTS.md, docs/**, workspace READMEs; git-tracked or untracked-but-not-ignored)
 *     every backticked repo path and link target outside fenced code blocks exists (URLs, globs, `<placeholders>`,
 *     generated output dirs and `docClaimsAllow` entries are skipped); bare file names are checked in tables and
 *     "Key Files" / "Exported Modules" style sections;
 *  g. `/route` claims in a section or table headed Routes / Pages / Endpoints match a file-based route under the
 *     workspace's `src/pages` (`index`, `[param]`, `[...rest]`, `.ts` endpoints).
 */

export interface DocProject {
  dir: string;
  abs: string;
  name: string;
}

export interface DocClaimOptions {
  root: string;
  projects: DocProject[];
  isMonorepo: boolean;
  scopedModules: string[];
  requireAdr: boolean;
  /** Globs (`*`) of doc path/route claims that are deliberately not on disk (generated output, external repos). */
  allow?: string[];
  /** Root-relative dir globs whose docs describe planned/migrating structure: dead-path claims there are not checked (default docs/migration, docs/plan*, docs/adr). */
  plannedPathDirs?: string[];
}

export const DEFAULT_PLANNED_PATH_DIRS = ['docs/migration', 'docs/plan*', 'docs/adr'];
const SECRET_LIKE = /(^|\/)(\.env[\w.-]*|\.dev\.vars[\w.-]*|[\w.-]*\.(pem|key|crt|p12)|\.[\w-]*storage-state\.json|[\w.-]*credentials[\w.-]*)$/i;
const ignoreCache = new Map<string, boolean>();
/** Gitignored or secret-like files are legitimately absent from a clean checkout: docs may mention them. */
function isIgnoredOrSecret(root: string, rel: string): boolean {
  if (SECRET_LIKE.test(rel)) return true;
  const key = `${root}\u0000${rel}`;
  let hit = ignoreCache.get(key);
  if (hit === undefined) {
    const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root });
    hit = r.status === 0;
    ignoreCache.set(key, hit);
  }
  return hit;
}

interface DocFile {
  abs: string;
  rel: string;
  lines: string[];
  /** true for lines inside fenced code blocks */
  fenced: boolean[];
  checkContent: boolean; // AGENTS.md / README.md / ADR: commands, placeholders
}

const ADR_DIRS = ['docs/adr', 'docs/adrs', 'docs/decisions', 'docs/architecture/decisions', 'adr', 'decisions'];
const PATH_EXT = /\.(md|ts|tsx|mts|js|jsx|mjs|cjs|json|astro|ya?ml|toml|css|sh|mdx)$/i;

const exists = (p: string): boolean => fs.existsSync(p);
const posix = (p: string): string => p.split(path.sep).join('/');

function loadDoc(root: string, abs: string, checkContent: boolean): DocFile | null {
  if (!exists(abs) || !fs.statSync(abs).isFile()) return null;
  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const fenced: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m && fence === null) {
      fence = m[1][0];
      fenced.push(true);
    } else if (m && fence !== null && m[1][0] === fence) {
      fence = null;
      fenced.push(true);
    } else fenced.push(fence !== null);
  }
  return { abs, rel: posix(path.relative(root, abs)), lines, fenced, checkContent };
}

function collectDocs(o: DocClaimOptions): DocFile[] {
  const docs: DocFile[] = [];
  const seen = new Set<string>();
  const add = (abs: string, checkContent: boolean): void => {
    const key = path.resolve(abs);
    if (seen.has(key)) return;
    const d = loadDoc(o.root, key, checkContent);
    if (d) {
      seen.add(key);
      docs.push(d);
    }
  };
  const bases = [{ abs: o.root }, ...o.projects.filter((p) => p.dir !== '')];
  for (const b of bases) {
    add(path.join(b.abs, 'AGENTS.md'), true);
    add(path.join(b.abs, 'README.md'), true);
    for (const mod of o.scopedModules) add(path.join(b.abs, mod, 'AGENTS.md'), true);
  }
  add(path.join(o.root, '.github/copilot-instructions.md'), false);
  for (const rel of markdownFiles(o.root)) {
    const base = path.basename(rel).toLowerCase();
    add(path.join(o.root, rel), base === 'agents.md' || base === 'readme.md' || /(^|\/)(docs\/)?(adrs?|decisions)\//.test(rel));
  }
  for (const dir of ADR_DIRS) {
    const abs = path.join(o.root, dir);
    if (!exists(abs) || !fs.statSync(abs).isDirectory()) continue;
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.md') && f.toLowerCase() !== 'agents.md') add(path.join(abs, f), true);
  }
  return docs;
}

const SKIP_MD_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.git', '.astro', '.wrangler', 'test-results', 'playwright-report']);
const SKIP_MD_NAMES = /^(changelog|history|releases?|license|code_of_conduct)(\.|$)/i;

/** Markdown files (repo-relative, POSIX): git's tracked + untracked-not-ignored list, or a directory walk without git. */
function markdownFiles(root: string): string[] {
  const g = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' });
  let list: string[];
  if (g.status === 0 && typeof g.stdout === 'string') list = g.stdout.split('\0').filter(Boolean);
  else {
    list = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SKIP_MD_DIRS.has(e.name)) walk(path.join(dir, e.name));
        } else if (e.isFile() && e.name.endsWith('.md')) list.push(posix(path.relative(root, path.join(dir, e.name))));
      }
    };
    try {
      walk(root);
    } catch {
      // unreadable tree: nothing extra to check
    }
  }
  return list.filter((f) => !f.split('/').some((seg) => SKIP_MD_DIRS.has(seg)) && !SKIP_MD_NAMES.test(path.basename(f)));
}

const isPathToken = (t: string): boolean =>
  !/\s/.test(t) &&
  !/[*<>{}|$]/.test(t) &&
  !/^(https?:|mailto:|#|\/|~)/.test(t) &&
  !/^[\w-]+:\/\//.test(t) &&
  (t.includes('/') || PATH_EXT.test(t));

const cleanPathToken = (t: string): string => t.replace(/[#?].*$/, '').replace(/:\d+(?::\d+)?$/, '');

// ---------- (a) routing tables ----------

function checkRoutingTables(doc: DocFile, root: string, out: string[]): void {
  let adrCols: Set<number> = new Set();
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i].trim();
    if (doc.fenced[i] || !line.startsWith('|')) {
      adrCols = new Set();
      continue;
    }
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const next = doc.lines[i + 1]?.trim() ?? '';
    const nextCells = next.startsWith('|') ? next.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()) : [];
    if (nextCells.length > 0 && nextCells.every((c) => /^:?-{2,}:?$/.test(c))) {
      adrCols = new Set(cells.flatMap((c, idx) => (/adr|decision/i.test(c) ? [idx] : [])));
      continue; // header row
    }
    cells.forEach((cell, idx) => {
      const refs: Array<{ target: string; isLink: boolean }> = [];
      for (const m of cell.matchAll(/`([^`]+)`/g)) if (isPathToken(m[1])) refs.push({ target: m[1], isLink: false });
      for (const m of cell.matchAll(/\]\(<?([^)\s>]+)>?[^)]*\)/g)) {
        if (!/^(https?:|mailto:|#)/.test(m[1])) refs.push({ target: m[1], isLink: true });
      }
      for (const { target, isLink } of refs) {
        const clean = cleanPathToken(target);
        if (!clean) continue;
        const fileDir = path.dirname(doc.abs);
        const candidates = isLink ? [path.resolve(fileDir, clean)] : [path.resolve(root, clean), path.resolve(fileDir, clean)];
        const hit = candidates.find((c) => exists(c));
        if (!hit && (isIgnoredOrSecret(root, clean) || isIgnoredOrSecret(root, posix(path.relative(root, candidates[0]))))) return;
        if (!hit) {
          out.push(`[Doc Drift: Dead Route] ${doc.rel}:${i + 1} routes to "${target}", which does not exist on disk. Fix the path or remove the row.`);
        } else if (adrCols.has(idx) && path.basename(hit).toLowerCase() === 'agents.md') {
          out.push(`[Doc Drift: ADR Is An AGENTS.md] ${doc.rel}:${i + 1} lists "${target}" as a governing ADR; point it at a real decision record (e.g. docs/adr/0001-*.md).`);
        }
      }
    });
  }
}

// ---------- (b) npm commands ----------

const NPM_RE = /\bnpm\s+(run-script|run|test|tst|t|start|stop|restart)\b([^`\n|;&)]*)/g;

function packageOf(dir: string): Record<string, any> | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
const hasScript = (pkg: Record<string, any> | null, name: string): boolean =>
  !!pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null && typeof pkg.scripts[name] === 'string';

function nearestPackageDir(from: string, root: string): string {
  let dir = from;
  for (;;) {
    if (exists(path.join(dir, 'package.json'))) return dir;
    if (path.resolve(dir) === path.resolve(root) || path.dirname(dir) === dir) return root;
    dir = path.dirname(dir);
  }
}

function checkNpmCommands(doc: DocFile, o: DocClaimOptions, out: string[]): void {
  const rootPkg = packageOf(o.root);
  const seen = new Set<string>();
  for (let i = 0; i < doc.lines.length; i++) {
    for (const m of doc.lines[i].matchAll(NPM_RE)) {
      const verb = m[1];
      const tokens = m[2].trim().split(/\s+/).filter(Boolean);
      let script: string | null = verb === 'run' || verb === 'run-script' ? null : verb === 'tst' || verb === 't' ? 'test' : verb;
      const wsTargets: string[] = [];
      let allWorkspaces = false;
      let prefix: string | null = null;
      for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t === '--') break;
        const take = (flag: string): string | null => (t === flag ? (tokens[++k] ?? null) : t.startsWith(flag + '=') ? t.slice(flag.length + 1) : null);
        const w = take('--workspace') ?? take('-w');
        if (w !== null) { wsTargets.push(w); continue; }
        const px = take('--prefix');
        if (px !== null) { prefix = px; continue; }
        if (t === '-ws' || t === '--workspaces' || t === '--all-workspaces') { allWorkspaces = true; continue; }
        if (t.startsWith('-')) continue;
        if (script === null) script = t;
      }
      if (script === null || !/^[\w:.@/-]+$/.test(script)) continue; // placeholder such as <script>
      const cmd = verb === 'run' || verb === 'run-script' ? `npm run ${script}` : `npm ${script}`;
      const key = `${doc.rel}:${i}:${cmd}:${wsTargets.join(',')}:${prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const fileDir = path.dirname(doc.abs);
      const where = `${doc.rel}:${i + 1}`;
      const resolveDir = (x: string): string | null => {
        const byName = o.projects.find((p) => p.name === x);
        if (byName) return byName.abs;
        for (const base of [o.root, fileDir]) {
          const c = path.resolve(base, x);
          if (exists(path.join(c, 'package.json'))) return c;
        }
        return null;
      };

      let targets: Array<{ pkg: Record<string, any> | null; label: string }>;
      if (wsTargets.length > 0 || prefix !== null) {
        targets = [];
        for (const x of [...wsTargets, ...(prefix !== null ? [prefix] : [])]) {
          const dir = resolveDir(x);
          if (!dir) {
            out.push(`[Doc Drift: Unknown Workspace] ${where} runs "${cmd}" for "${x}", which is not a workspace/package directory.`);
            continue;
          }
          targets.push({ pkg: packageOf(dir), label: posix(path.relative(o.root, dir)) || '.' });
        }
        if (targets.length === 0) continue;
      } else if (allWorkspaces) {
        targets = [{ pkg: rootPkg, label: '.' }, ...o.projects.filter((p) => p.dir !== '').map((p) => ({ pkg: packageOf(p.abs), label: p.dir }))];
      } else {
        const pkgDir = nearestPackageDir(fileDir, o.root);
        targets = [{ pkg: packageOf(pkgDir), label: posix(path.relative(o.root, pkgDir)) || '.' }];
        if (path.resolve(pkgDir) !== path.resolve(o.root)) targets.push({ pkg: rootPkg, label: '.' });
      }
      const ok = targets.some(
        (t) => hasScript(t.pkg, script!) || (script === 'start' && !!t.pkg && t.label !== undefined && exists(path.join(o.root, t.label === '.' ? '' : t.label, 'server.js')))
      );
      const anywhere = !ok && o.isMonorepo ? [{ abs: o.root }, ...o.projects].some((p) => hasScript(packageOf(p.abs), script!)) : false;
      if (!ok && !anywhere) {
        out.push(`[Doc Drift: Unknown npm Script] ${where} quotes \`${cmd}\`, but ${targets.map((t) => `${t.label}/package.json`).join(' / ')} has no "${script}" script. Add the script or fix the doc.`);
      }
    }
  }
}

// ---------- (c) placeholders ----------

function checkPlaceholders(doc: DocFile, out: string[]): void {
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.fenced[i]) continue;
    const line = doc.lines[i];
    const noInline = line.replace(/`[^`]*`/g, '');
    let what: string | null = null;
    if (/<TODO>/i.test(line)) what = '<TODO>';
    else if (/\{\{[^}]*\}\}/.test(noInline)) what = '{{...}}';
    else if (/\bTODO:/.test(line)) what = 'TODO:';
    else if (/(?<![\w-])replace[ _-]?me(?![\w-])/i.test(noInline)) what = 'replace me';
    if (what) out.push(`[Doc Drift: Template Placeholder] ${doc.rel}:${i + 1} still contains "${what}". Fill it in or delete the line.`);
  }
}

// ---------- (e) links ----------

function checkLinks(doc: DocFile, o: DocClaimOptions, out: string[]): void {
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.fenced[i]) continue;
    const line = doc.lines[i].replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
      const raw = m[1];
      if (/^([a-z][\w+.-]*:|#|\/|\{\{)/i.test(raw) || raw.includes('{{')) continue;
      let target = raw.replace(/[#?].*$/, '');
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        /* keep raw */
      }
      const abs = path.resolve(path.dirname(doc.abs), target);
      if (!exists(abs) && !allowed(o, raw, target)) {
        out.push(`[Doc Drift: Broken Link] ${doc.rel}:${i + 1} links to "${raw}", which does not exist (resolved from ${posix(path.relative(path.dirname(doc.abs), path.dirname(doc.abs))) || '.'} relative to ${doc.rel}).`);
      }
    }
  }
}

// ---------- (f) path claims anywhere, (g) route claims ----------

const GENERATED_ROOTS = new Set(['dist', 'build', 'out', 'coverage', 'node_modules', '.astro', '.wrangler', 'test-results', 'playwright-report']);
const KNOWN_ROOTS = new Set(['src', 'apps', 'packages', 'docs', 'scripts', 'tests', 'test', 'public', 'tools', 'lib', 'app', 'config', '.github']);
const KEY_FILES_HEADING = /key files|exported modules|files|modules|structure|layout|routing|contents|artifacts|entry ?points?/i;
const ROUTES_HEADING = /\b(routes?|pages?|endpoints?)\b/i;
const globToRe = (g: string): RegExp => new RegExp('^' + g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const allowed = (o: DocClaimOptions, ...values: string[]): boolean => (o.allow ?? []).some((g) => values.some((v) => globToRe(g).test(v)));

function pagesRoutes(pagesDir: string): string[][] {
  const routes: string[][] = [];
  const walk = (dir: string, prefix: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), [...prefix, e.name]);
      else if (e.isFile() && /\.(astro|md|mdx|html|ts|js|mts|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        const stem = e.name.replace(/\.(astro|md|mdx|html|ts|js|mts|mjs)$/, '');
        routes.push(stem === 'index' ? prefix : [...prefix, stem]);
      }
    }
  };
  walk(pagesDir, []);
  return routes;
}

function routeMatches(claim: string[], route: string[]): boolean {
  for (let i = 0; i < route.length; i++) {
    const seg = route[i];
    if (/^\[\.\.\..+\]$/.test(seg)) return true;
    if (i >= claim.length) return false;
    if (/^\[.+\]$/.test(seg)) continue;
    const c = claim[i];
    if (/^(\{.+\}|:\w+|\[.+\])$/.test(c)) continue;
    if (seg !== c) return false;
  }
  return claim.length === route.length;
}

function checkPathAndRouteClaims(doc: DocFile, o: DocClaimOptions, out: string[]): void {
  const fileDir = path.dirname(doc.abs);
  const wsDir = nearestPackageDir(fileDir, o.root);
  const isAgents = path.basename(doc.abs).toLowerCase() === 'agents.md';
  const planned = (o.plannedPathDirs ?? DEFAULT_PLANNED_PATH_DIRS).some((g) => globToRe(g.replace(/\/+$/, '') + (g.includes('*') ? '' : '*')).test(doc.rel) || doc.rel.startsWith(g.replace(/\*.*$/, '').replace(/\/+$/, '') + '/'));
  const isRootDoc = path.resolve(wsDir) === path.resolve(o.root);
  const scopes = isRootDoc && o.isMonorepo ? o.projects.map((p) => p.abs) : [wsDir];
  let routeTable: Array<string[]> | null | undefined;
  const routeSet = (): Array<string[]> | null => {
    if (routeTable !== undefined) return routeTable;
    const dirs = scopes.map((d) => path.join(d, 'src/pages')).filter((d) => exists(d));
    routeTable = dirs.length > 0 ? dirs.flatMap(pagesRoutes) : null;
    return routeTable;
  };
  let heading = '';
  let tableRoutes = false;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.fenced[i]) continue;
    const raw = doc.lines[i];
    const h = raw.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      heading = h[1];
      tableRoutes = false;
      continue;
    }
    const isRow = raw.trim().startsWith('|');
    if (isRow) {
      const next = doc.lines[i + 1]?.trim() ?? '';
      if (/^\|?\s*:?-{2,}/.test(next)) tableRoutes = raw.split('|').some((c) => /^\s*(routes?|pages?|endpoints?)\s*$/i.test(c));
    } else if (raw.trim() === '') tableRoutes = false;
    const inRoutes = ROUTES_HEADING.test(heading) || tableRoutes;
    if (isAgents && isRow && !inRoutes) continue; // AGENTS.md routing tables are covered by the dedicated table check
    for (const m of raw.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim();
      if (/\s/.test(tok) || /[*<>{}|$]/.test(tok.replace(/^\/.*$/, (x) => x.replace(/[{}]/g, ''))) && !tok.startsWith('/')) continue;
      if (inRoutes && /^\/[\w\-./\[\]{}:~@]*$/.test(tok) && !/^\/\//.test(tok)) {
        const clean = tok.replace(/[?#].*$/, '').replace(/\/+$/, '');
        if (/\.[a-z0-9]{1,5}$/i.test(clean) && !/\.(json|xml|txt|html|rss|atom)$/i.test(clean)) continue; // asset path, not a route
        const routes = routeSet();
        if (routes === null || allowed(o, tok, clean)) continue;
        const claim = clean.split('/').filter(Boolean);
        if (!routes.some((r) => routeMatches(claim, r))) {
          out.push(`[Doc Drift: Unknown Route] ${doc.rel}:${i + 1} documents route "${tok}", but no file under src/pages${scopes.length > 1 ? ' of any workspace' : ''} serves it. Fix the route, add the page/endpoint, or list it in docClaimsAllow.`);
        }
        continue;
      }
      if (tok.startsWith('/') || tok.startsWith('@') && !tok.includes('.') || tok.startsWith('~') || /^(https?|mailto|file|data):/.test(tok) || /:\/\//.test(tok)) continue;
      const clean = cleanPathToken(tok);
      if (!clean) continue;
      const first = clean.split('/')[0];
      if (GENERATED_ROOTS.has(first) || /^\.\.?$/.test(clean)) continue;
      const hasSlash = clean.includes('/');
      // A repo path has a known extension or a trailing slash AND starts with ./ ../ or an existing workspace/top-level
      // folder; `Path=/`, `Max-Age=0/x` and other HTTP/prose fragments are ignored.
      const bases = [o.root, fileDir, wsDir, ...(o.isMonorepo && isRootDoc ? o.projects.map((p) => p.abs) : [])];
      const rooted = clean.startsWith('./') || clean.startsWith('../') || (/^[\w.@~-]+$/.test(first) && (KNOWN_ROOTS.has(first) || bases.some((b) => exists(path.join(b, first)))));
      const looksPath = hasSlash ? (PATH_EXT.test(clean) || tok.endsWith('/')) && rooted : false; // bare filenames (`index.astro`) name a file next to its directory in prose; never root-relative
      if (!looksPath) continue;
      if (allowed(o, tok, clean)) continue;
      // app-relative claims (`lib/foo.ts` in apps/AGENTS.md): accepted when ANY workspace root or src has the path
      const rels = [o.root, fileDir, wsDir, ...(o.isMonorepo ? o.projects.flatMap((p) => [p.abs, path.join(p.abs, 'src')]) : [])];
      if (!rels.some((b) => exists(path.resolve(b, clean)))) {
        if (planned || isIgnoredOrSecret(o.root, clean) || isIgnoredOrSecret(o.root, posix(path.relative(o.root, path.resolve(fileDir, clean))))) continue;
        out.push(`[Doc Drift: Dead Path] ${doc.rel}:${i + 1} mentions \`${tok}\`, which does not exist on disk. Fix the path, remove it, or list it in docClaimsAllow.`);
      }
    }
  }
}

// ---------- (d) decision records ----------

function checkAdrPresence(o: DocClaimOptions, out: string[]): void {
  const records: string[] = [];
  for (const dir of ADR_DIRS) {
    const abs = path.join(o.root, dir);
    if (!exists(abs) || !fs.statSync(abs).isDirectory()) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.md') && !['agents.md', 'readme.md', 'claude.md'].includes(f.toLowerCase())) records.push(`${dir}/${f}`);
    }
  }
  if (records.length === 0) {
    out.push(
      '[Doc Drift: ADR Missing] no decision record found (docs/adr/*.md). An AGENTS.md does not count as an ADR. Add docs/adr/0001-<decision>.md with `applies_to` / `enforced_by` frontmatter, or set requireAdr: false.'
    );
  }
}

export function checkDocClaims(o: DocClaimOptions): string[] {
  const out: string[] = [];
  const docs = collectDocs(o);
  for (const doc of docs) {
    checkLinks(doc, o, out);
    checkPathAndRouteClaims(doc, o, out);
    if (!doc.checkContent) continue;
    if (path.basename(doc.abs).toLowerCase() === 'agents.md') checkRoutingTables(doc, o.root, out);
    checkNpmCommands(doc, o, out);
    checkPlaceholders(doc, out);
  }
  if (o.requireAdr) checkAdrPresence(o, out);
  return out;
}
