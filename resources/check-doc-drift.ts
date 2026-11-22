import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { guardrailsConfig } from '../guardrails.config.ts';

/**
 * Automated Doc-Drift & Astro Structural Guardrail Checker (scripts/check-doc-drift.ts)
 *
 * Configured via `guardrails.config.ts`. Verifies deterministically:
 * 1. Module Coverage: Every source file in each `scopedModules` directory (scanned recursively;
 *    extensions .ts .tsx .mts .astro .js .jsx .mjs; `.d.ts`, dot-dirs, `node_modules` and `AGENTS.md`
 *    are skipped; test/spec files ARE included) must be listed under `## Exported Modules` in that
 *    directory's `AGENTS.md` as a path relative to the module dir (e.g. `nested/Foo.astro`).
 *    The section ends at the next `#`/`##` heading. Listed entries that no longer exist are ghosts.
 * 2. ADR Path Integrity: Every path in an ADR's `applies_to` (list) or `enforced_by` (scalar or list)
 *    frontmatter key must exist on disk. Other keys (tags, authors, ...) are ignored.
 * 3. Astro Import Boundaries (real TypeScript parsing of frontmatter and `<script>` blocks; comments
 *    never count; static, side-effect, re-export, dynamic `import()` and `import.meta.glob` are checked):
 *    - `.astro` files under `src/ui/` cannot import worker, pages, cms, storyblok layers or `@storyblok/*`.
 *    - `.astro` files under the Storyblok `wrapperDir` cannot import worker or pages layers.
 *    Layers are matched by path SEGMENT on relative/alias specifiers (`../worker`, `@cms/x`, `@/pages/y`);
 *    bare npm packages only match `@storyblok/`.
 * 4. Style Encapsulation: every `<style>` block of the global layout `.astro` file must not contain
 *    leaked component CSS prefixes.
 * 5. Interactive UI Coverage: Any `.astro` file under `src/ui/` with `<button` or `<script` must have at
 *    least one stable selector VALUE (`id`, `data-*`, `aria-label`) referenced by a string/regex in
 *    `visualSpecPath` (comments in the spec do not count). A configured but missing spec is an error.
 * 6. Storyblok Visual Editor Invariant (Optional): If `guardrailsConfig.storyblok` is configured,
 *    every wrapper under `storyblok.wrapperDir` must contain an actual `storyblokEditable(<identifier>)` call.
 */

const ROOT = process.cwd();
const errors: string[] = [];

const MODULE_EXTENSIONS = /\.(ts|tsx|mts|astro|js|jsx|mjs)$/;

const toPosix = (p: string): string => p.split(path.sep).join('/');
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n');
const readText = (p: string): string => normalizeEol(fs.readFileSync(p, 'utf8'));

/** Recursively lists files (relative POSIX paths) below `dir`, skipping dot-dirs and node_modules. */
function walkFiles(dir: string, accept: (name: string) => boolean, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, accept, relPath));
    else if (entry.name !== 'AGENTS.md' && accept(entry.name)) out.push(relPath);
  }
  return out.sort();
}

const isModuleFile = (name: string): boolean => MODULE_EXTENSIONS.test(name) && !name.endsWith('.d.ts');
const isAstroFile = (name: string): boolean => name.endsWith('.astro');

// ---------- Astro / TypeScript helpers ----------

function parseTs(code: string, fileName = 'snippet.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
}

/** Frontmatter (`---` fence at file start) plus all `<script>` block bodies. */
function extractAstroCode(content: string): string[] {
  const blocks: string[] = [];
  const fm = content.match(/^\s*---\n([\s\S]*?)\n---/);
  if (fm) blocks.push(fm[1]);
  for (const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) blocks.push(m[1]);
  return blocks;
}

function stringArg(node: ts.Expression | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** Every module specifier referenced by the code: import/export-from/import()/require-style/import.meta.glob. */
function collectSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = stringArg(node.moduleSpecifier);
      if (spec !== null) specs.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = stringArg(node.moduleReference.expression);
      if (spec !== null) specs.push(spec);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = stringArg(node.arguments[0]);
        if (spec !== null) specs.push(spec);
      } else if (node.expression.getText() === 'import.meta.glob') {
        const first = node.arguments[0];
        const globs = first && ts.isArrayLiteralExpression(first) ? [...first.elements] : first ? [first] : [];
        for (const g of globs) {
          const spec = stringArg(g as ts.Expression);
          if (spec !== null) specs.push(spec);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseTs(code));
  return specs;
}

type Layer = 'worker' | 'pages' | 'cms' | 'storyblok';
const LOCAL_SPECIFIER = /^(\.{1,2}(\/|$)|\/|@\/|~\/|#)/;
const SEGMENT_LAYER = /(?:^|\/)(worker|pages|cms|storyblok)(?:\/|$)/;
const SCOPED_ALIAS_LAYER = /^@(worker|pages|cms|storyblok)(?:\/|$)/;

/**
 * Maps a specifier to an architecture layer. Only relative/alias specifiers resolve to layers by path
 * segment; bare npm packages only match the `@storyblok/` scope.
 */
function layerOf(spec: string): Layer | null {
  if (spec.startsWith('@storyblok/')) return 'storyblok';
  const alias = spec.match(SCOPED_ALIAS_LAYER);
  if (alias) return alias[1] as Layer;
  if (LOCAL_SPECIFIER.test(spec)) {
    const seg = spec.match(SEGMENT_LAYER);
    if (seg) return seg[1] as Layer;
  }
  return null;
}

function astroImportLayers(content: string): Array<{ spec: string; layer: Layer }> {
  const found: Array<{ spec: string; layer: Layer }> = [];
  for (const code of extractAstroCode(content)) {
    for (const spec of collectSpecifiers(code)) {
      const layer = layerOf(spec);
      if (layer) found.push({ spec, layer });
    }
  }
  return found;
}

/**
 * True when the file contains a real `storyblokEditable(<identifier>)` call in frontmatter, scripts, or
 * a template `{...}` expression (HTML comments, JS comments and strings do not count).
 */
function hasStoryblokEditableCall(content: string): boolean {
  const sources: Array<{ code: string; tsx: boolean }> = extractAstroCode(content).map((code) => ({
    code,
    tsx: false,
  }));
  const template = content
    .replace(/^\s*---\n[\s\S]*?\n---/, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const expr of braceGroups(template)) {
    sources.push({ code: `(${expr.replace(/^\s*\.\.\./, '')});`, tsx: true });
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (name === 'storyblokEditable' && node.arguments[0] && ts.isIdentifier(node.arguments[0])) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const { code, tsx } of sources) {
    visit(ts.createSourceFile(tsx ? 'expr.tsx' : 'snippet.ts', code, ts.ScriptTarget.Latest, true));
    if (found) break;
  }
  return found;
}

/** Contents of top-level balanced `{...}` groups in a template. */
function braceGroups(template: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) groups.push(template.slice(start, i));
    }
  }
  return groups;
}

// 1. Check module files <-> scoped AGENTS.md
function exportedModulesSection(agentsMd: string): string {
  const lines = agentsMd.split('\n');
  const startIdx = lines.findIndex((l) => /^##\s+Exported Modules\s*$/.test(l));
  if (startIdx === -1) return '';
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n');
}

for (const modDir of guardrailsConfig.scopedModules) {
  const absDir = path.join(ROOT, modDir);
  const agentsMdPath = path.join(absDir, 'AGENTS.md');

  if (!fs.existsSync(agentsMdPath)) {
    errors.push(`[Missing Scoped Context] ${modDir}/AGENTS.md does not exist.`);
    continue;
  }

  const actualFiles = walkFiles(absDir, isModuleFile);
  const documentedFiles = Array.from(
    exportedModulesSection(readText(agentsMdPath)).matchAll(/^- `([^`]+)`/gm),
    (m: RegExpExecArray) => m[1].replace(/^\.\//, '')
  );

  for (const file of actualFiles) {
    if (!documentedFiles.includes(file)) {
      errors.push(
        `[Doc Drift: Undocumented File] "${modDir}/${file}" exists in code but is not listed (as a path relative to ${modDir}) under "## Exported Modules" in ${modDir}/AGENTS.md.`
      );
    }
  }

  for (const docFile of documentedFiles) {
    if (!fs.existsSync(path.join(absDir, docFile))) {
      errors.push(
        `[Doc Drift: Ghost Entry] "${docFile}" is documented in ${modDir}/AGENTS.md, but "${modDir}/${docFile}" does not exist on disk.`
      );
    }
  }
}

// 2. Check ADR frontmatter references exist on disk
function cleanYamlScalar(raw: string): string {
  const v = raw.trim();
  const quoted = v.match(/^(["'])(.*?)\1/);
  if (quoted) return quoted[2];
  return v.replace(/\s+#.*$/, '').trim();
}

/** Parses only the `applies_to` and `enforced_by` keys (scalar, block list, or inline `[a, b]` list). */
function adrReferencePaths(frontmatter: string): string[] {
  const refs: string[] = [];
  let currentKey: string | null = null;
  for (const line of frontmatter.split('\n')) {
    const keyMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      if (currentKey !== 'applies_to' && currentKey !== 'enforced_by') continue;
      const value = keyMatch[2].trim();
      if (value.startsWith('[')) {
        const inner = value.replace(/\s+#.*$/, '').replace(/^\[/, '').replace(/\]\s*$/, '');
        for (const item of inner.split(',')) refs.push(cleanYamlScalar(item));
      } else if (value && !value.startsWith('#')) {
        refs.push(cleanYamlScalar(value));
      }
      continue;
    }
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item && (currentKey === 'applies_to' || currentKey === 'enforced_by')) {
      refs.push(cleanYamlScalar(item[1]));
    }
  }
  return refs.filter((r) => r !== '' && r !== 'null' && r !== '~');
}

const adrDir = path.join(ROOT, 'docs/adr');
if (fs.existsSync(adrDir)) {
  const adrFiles = fs.readdirSync(adrDir).filter((f) => f.endsWith('.md'));
  for (const adrFile of adrFiles) {
    const frontmatterMatch = readText(path.join(adrDir, adrFile)).match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      errors.push(`[ADR Schema] docs/adr/${adrFile} is missing YAML frontmatter.`);
      continue;
    }

    for (const refPath of adrReferencePaths(frontmatterMatch[1])) {
      if (!fs.existsSync(path.join(ROOT, refPath))) {
        errors.push(
          `[Doc Drift: Stale ADR Reference] docs/adr/${adrFile} references "${refPath}", which no longer exists.`
        );
      }
    }
  }
}

// 5 helpers: selector values and spec string literals
function specLiterals(specSource: string, fileName: string): string[] {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, specSource, ts.ScriptTarget.Latest, true));
  return literals;
}

function selectorValues(content: string): string[] {
  const values = new Set<string>();
  const attr = /\b(id|data-[a-z0-9-]+|aria-label)=(?:"([^"]+)"|'([^']+)')/gi;
  for (const m of content.matchAll(attr)) {
    const value = m[2] ?? m[3];
    if (!value.includes('{')) values.add(value);
  }
  return [...values];
}

function isValueReferenced(literals: string[], value: string): boolean {
  const esc = escapeRegExp(value);
  const idForm = new RegExp(`#${esc}(?![\\w-])`);
  const wordForm = new RegExp(`(?<![\\w-])${esc}(?![\\w-])`);
  return literals.some(
    (lit) =>
      lit === value ||
      lit.includes(`"${value}"`) ||
      lit.includes(`'${value}'`) ||
      idForm.test(lit) ||
      (lit.startsWith('/') && wordForm.test(lit))
  );
}

// 3. Import boundaries & 5. Interactive UI coverage in src/ui/
const specPath = guardrailsConfig.visualSpecPath;
const specAbs = specPath ? path.join(ROOT, specPath) : null;
const specLits = specAbs && fs.existsSync(specAbs) ? specLiterals(readText(specAbs), specAbs) : null;
let reportedMissingSpec = false;

const uiDir = path.join(ROOT, 'src/ui');
if (fs.existsSync(uiDir)) {
  for (const file of walkFiles(uiDir, isAstroFile)) {
    const content = readText(path.join(uiDir, file));

    for (const { spec } of astroImportLayers(content)) {
      errors.push(
        `[Astro Boundary Violation] src/ui/${file} imports "${spec}". ADR-0001 forbids src/ui/ from importing worker, pages, storyblok wrappers, or CMS adapter internals.`
      );
    }

    if (specPath && /<(button|script)\b/i.test(content)) {
      if (specLits === null) {
        if (!reportedMissingSpec) {
          reportedMissingSpec = true;
          errors.push(
            `[Missing Visual Spec] visualSpecPath is configured as "${specPath}" but the file does not exist, so interactive UI (e.g. src/ui/${file}) cannot be verified. Create the spec or set visualSpecPath to null.`
          );
        }
        continue;
      }
      const selectors = selectorValues(content);
      if (!selectors.some((value) => isValueReferenced(specLits, value))) {
        const hint = selectors.length === 0 ? ' Add a stable `data-testid="..."` to the control and test it.' : '';
        errors.push(
          `[Untested Interactive UI] src/ui/${file} contains interactive controls (<button>/<script>), but none of its selector values (${selectors.join(', ') || 'none'}) are referenced in ${specPath}.${hint}`
        );
      }
    }
  }
}

// 3b. Import boundaries in the Storyblok wrapper dir (if present)
const wrapperDirRel = guardrailsConfig.storyblok?.wrapperDir ?? 'src/storyblok';
const storyblokDir = path.join(ROOT, wrapperDirRel);
if (fs.existsSync(storyblokDir)) {
  for (const file of walkFiles(storyblokDir, isAstroFile)) {
    const content = readText(path.join(storyblokDir, file));
    for (const { spec, layer } of astroImportLayers(content)) {
      if (layer === 'worker' || layer === 'pages') {
        errors.push(
          `[Astro Boundary Violation] ${wrapperDirRel}/${file} imports "${spec}". Storyblok wrappers cannot import from worker or pages.`
        );
      }
    }
  }
}

// 4. Check style encapsulation in global layout .astro file
if (
  guardrailsConfig.globalLayoutAstroPath &&
  guardrailsConfig.forbiddenGlobalClassPrefixes.length > 0
) {
  const layoutPath = path.join(ROOT, guardrailsConfig.globalLayoutAstroPath);
  if (fs.existsSync(layoutPath)) {
    const layoutContent = readText(layoutPath);
    const prefixAlternation = guardrailsConfig.forbiddenGlobalClassPrefixes.map(escapeRegExp).join('|');
    const regex = new RegExp(`\\.(?:${prefixAlternation})`, 'g');
    const leaked = new Set<string>();
    for (const block of layoutContent.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      for (const hit of block[1].match(regex) ?? []) leaked.add(hit);
    }
    if (leaked.size > 0) {
      errors.push(
        `[Style Encapsulation Violation] ${guardrailsConfig.globalLayoutAstroPath} contains component-specific CSS selectors (${[...leaked].join(', ')}). Keep component styles encapsulated inside src/ui/*.astro.`
      );
    }
  }
}

// 6. Optional Storyblok Visual Editor invariant (`storyblokEditable`)
if (guardrailsConfig.storyblok?.requireStoryblokEditable) {
  const sbDir = path.join(ROOT, guardrailsConfig.storyblok.wrapperDir);
  if (fs.existsSync(sbDir)) {
    for (const file of walkFiles(sbDir, isAstroFile)) {
      if (!hasStoryblokEditableCall(readText(path.join(sbDir, file)))) {
        errors.push(
          `[Storyblok Visual Editor Drift] ${toPosix(guardrailsConfig.storyblok.wrapperDir)}/${file} is missing a real \`storyblokEditable(blok)\` call (required for Visual Editor live preview).`
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error('\n❌ Guardrail & Doc-Drift Check Failed:\n');
  for (const err of errors) {
    console.error(`  • ${err}`);
  }
  console.error('\nFix the violation above and re-run `npm run guardrails`.\n');
  process.exit(1);
} else {
  console.log(
    '✅ Doc-Drift & Astro Structural Guardrails Passed: Code, scoped AGENTS.md files, ADRs, and interactive UI selectors are in sync.'
  );
}
