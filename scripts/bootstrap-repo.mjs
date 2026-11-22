#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * 1-Command Repository Guardrails Bootstrapper (scripts/bootstrap-repo.mjs)
 *
 * Usage:
 *   node scripts/bootstrap-repo.mjs --target /path/to/your-repo [--preset standard|storyblok] [--force]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const RESOURCES = path.join(SKILL_ROOT, 'resources');

let cli;
try {
  cli = parseArgs({
    options: {
      target: { type: 'string' },
      preset: { type: 'string', default: 'standard' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  console.error(`❌ ${err.message}\nUsage: node bootstrap-repo.mjs [--target <dir>] [--preset standard|storyblok] [--force]`);
  process.exit(1);
}

const targetDir = path.resolve(cli.target ?? process.cwd());
const preset = cli.preset.toLowerCase();
if (!['standard', 'storyblok'].includes(preset)) {
  console.error(`❌ Unknown preset "${cli.preset}". Use "standard" or "storyblok".`);
  process.exit(1);
}
const isStoryblok = preset === 'storyblok';
const force = cli.force;

// Validate existing manifests BEFORE writing anything, so a bad input never leaves a partial install.
const pkgPath = path.join(targetDir, 'package.json');
let pkg = null;
if (fs.existsSync(pkgPath)) {
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    console.error(`❌ ${pkgPath} is not valid JSON (${err.message}). Fix it and re-run; nothing was written.`);
    process.exit(1);
  }
  if (pkg.scripts !== undefined && (typeof pkg.scripts !== 'object' || pkg.scripts === null || Array.isArray(pkg.scripts))) {
    console.error(`❌ "scripts" in ${pkgPath} must be an object. Nothing was written.`);
    process.exit(1);
  }
}

// Auto-create target directory if it does not exist yet
fs.mkdirSync(targetDir, { recursive: true });

function copyIfMissingOrForce(srcRel, destRel, allowOverwrite = false, userOwned = false) {
  const srcPath = path.join(RESOURCES, srcRel);
  const destPath = path.join(targetDir, destRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && !allowOverwrite) {
    console.log(`⏭️  Skipped existing ${destRel}${userOwned ? ' (user-owned, never overwritten)' : ' (pass --force to overwrite)'}`);
    return false;
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`✅ Installed ${destRel}`);
  return true;
}

function writeIfMissingOrForce(destRel, content, allowOverwrite = false) {
  const destPath = path.join(targetDir, destRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && !allowOverwrite) {
    console.log(`⏭️  Skipped existing ${destRel}`);
    return false;
  }
  fs.writeFileSync(destPath, content, 'utf8');
  console.log(`✅ Created ${destRel}`);
  return true;
}

// 1. Install core guardrail scripts and dependency-cruiser rules
const installedConfig = copyIfMissingOrForce('guardrails.config.ts', 'guardrails.config.ts', force);
copyIfMissingOrForce('run-guardrails.ts', 'scripts/run-guardrails.ts', force);
copyIfMissingOrForce('git-changes.ts', 'scripts/git-changes.ts', force);
copyIfMissingOrForce('check-doc-drift.ts', 'scripts/check-doc-drift.ts', force);
copyIfMissingOrForce('check-complexity.ts', 'scripts/check-complexity.ts', force);
copyIfMissingOrForce('check-deps.ts', 'scripts/check-deps.ts', force);
copyIfMissingOrForce('dependency-cruiser.cjs', '.dependency-cruiser.cjs', force);

// If --preset storyblok, patch guardrails.config.ts with the 5 Storyblok scoped modules and storyblok block
if (isStoryblok && !installedConfig) {
  console.warn("⚠️  Existing guardrails.config.ts kept: add the Storyblok scopedModules and `storyblok` block manually (see README), or re-run with --force.");
} else if (isStoryblok) {
  const cfgPath = path.join(targetDir, 'guardrails.config.ts');
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  const patched = cfg.replace(
    "scopedModules: ['src/domain', 'src/worker', 'src/ui'],",
    "scopedModules: ['src/domain', 'src/cms', 'src/storyblok', 'src/ui', 'src/worker'],\n  storyblok: {\n    wrapperDir: 'src/storyblok',\n    requireStoryblokEditable: true,\n  },"
  );
  if (patched === cfg && !cfg.includes("'src/storyblok'")) {
    console.error('❌ Could not apply the storyblok preset: scopedModules line not found in guardrails.config.ts.');
    process.exit(1);
  }
  fs.writeFileSync(cfgPath, patched, 'utf8');
  console.log('✅ Configured guardrails.config.ts for Storyblok preset');
}

// 2. Install Root Context Router (AGENTS.md), CLAUDE.md bridge, and GitHub Copilot instructions
const rootTemplate = isStoryblok
  ? 'templates/AGENTS.storyblok.md'
  : 'templates/AGENTS.root.md';
copyIfMissingOrForce(rootTemplate, 'AGENTS.md', false, true);
writeIfMissingOrForce('CLAUDE.md', '@AGENTS.md\n', false);
writeIfMissingOrForce(
  '.github/copilot-instructions.md',
  'Read and follow [AGENTS.md](../AGENTS.md) as the authoritative context router and guardrail specification for this repository.\n',
  false
);

// 3. Install ADR-0001 template (with valid applies_to & enforced_by YAML frontmatter)
const adrPath = path.join(targetDir, 'docs/adr/0001-layered-modular-boundaries.md');
if (!fs.existsSync(adrPath)) {
  let adrContent = fs.readFileSync(
    path.join(RESOURCES, 'templates/0001-layered-modular-boundaries.md'),
    'utf8'
  );
  if (isStoryblok) {
    const patchedAdr = adrContent.replace(
      '  - src/domain\n  - src/ui\n  - src/worker\n  - src/pages',
      '  - src/domain\n  - src/cms\n  - src/storyblok\n  - src/ui\n  - src/worker\n  - src/pages'
    );
    if (patchedAdr === adrContent) {
      console.warn('⚠️  ADR applies_to list not patched for the storyblok preset; edit it manually.');
    }
    adrContent = patchedAdr;
  }
  writeIfMissingOrForce('docs/adr/0001-layered-modular-boundaries.md', adrContent, false);
}

// 4. Scaffold starter scoped src/<layer>/AGENTS.md files if missing
const SCOPED_DESCRIPTIONS = {
  'src/domain': {
    title: 'Domain Layer Context (`src/domain/`)',
    purpose: 'Pure TypeScript domain models, view-models, and shared contracts.',
    constraints:
      '- **ALLOWED imports:** Only files within `src/domain/`.\n- **FORBIDDEN imports:** `src/ui/*`, `src/storyblok/*`, `src/cms/*`, `src/worker/*`, `src/pages/*`, or external runtime SDKs.',
  },
  'src/cms': {
    title: 'CMS Anti-Corruption Layer Context (`src/cms/`)',
    purpose:
      'Fetches CMS stories, parses `_editable` comments, and maps raw CMS bloks into pure `src/domain/` view models.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*` and `src/cms/*`.\n- **FORBIDDEN imports:** `src/ui/*`, `src/storyblok/*`, `src/worker/*`, or `src/pages/*`.',
  },
  'src/storyblok': {
    title: 'Storyblok Wrapper Layer Context (`src/storyblok/`)',
    purpose:
      'Thin `.astro` blok wrapper components that attach `storyblokEditable(blok)` and delegate presentation to `src/ui/`.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*`, `src/cms/*`, `src/ui/*`, and `src/storyblok/*`.\n- **FORBIDDEN imports:** `src/worker/*` or `src/pages/*`.\n- Every wrapper component MUST call `storyblokEditable(blok)`.',
  },
  'src/ui': {
    title: 'UI Presentation Layer Context (`src/ui/`)',
    purpose:
      'Pure design-system presentation components and client controllers decoupled from CMS and Edge Worker internals.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*` and `src/ui/*`.\n- **FORBIDDEN imports:** `src/worker/*`, `src/cms/*`, `src/storyblok/*`, or `src/pages/*`.\n- **SSR Purity:** Modules imported in `.astro` SSR frontmatter (`---`) must be 100% isomorphic (no `document`, `window`, `navigator`, `HTMLElement`).',
  },
  'src/worker': {
    title: 'Edge Worker Layer Context (`src/worker/`)',
    purpose:
      'Encapsulates Cloudflare Worker / Edge runtime bindings, preview detection, PoP metadata, and cache policy computation.',
    constraints:
      '- **ALLOWED imports:** `src/domain/*` and `src/worker/*`.\n- **FORBIDDEN imports:** `src/ui/*`, `src/storyblok/*`, `src/cms/*`, or `src/pages/*`.',
  },
};

const activeModules = isStoryblok
  ? ['src/domain', 'src/cms', 'src/storyblok', 'src/ui', 'src/worker']
  : ['src/domain', 'src/worker', 'src/ui'];

for (const mod of activeModules) {
  const meta = SCOPED_DESCRIPTIONS[mod];
  const modAgentsMd = `# ${meta.title}\n\n## Purpose\n${meta.purpose}\n\n## Constraints (Enforced by \`npm run guardrails\`)\n${meta.constraints}\n\n## Exported Modules\n<!-- check-doc-drift verifies every .ts/.astro file in this directory is listed below -->\n`;
  writeIfMissingOrForce(`${mod}/AGENTS.md`, modAgentsMd, false);
}
fs.mkdirSync(path.join(targetDir, 'src/pages'), { recursive: true });

// 5. If tsconfig.json exists, exclude Node CLI scripts from the (Worker) runtime typecheck.
// Only the exclude list is touched; `include`, `extends` and everything else stay as they are.
const tsconfigPath = path.join(targetDir, 'tsconfig.json');
if (fs.existsSync(tsconfigPath)) {
  const manual = 'add "scripts", "guardrails.config.ts", "playwright.config.ts" and "tests" to its "exclude" manually.';
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
  } catch {
    console.warn(`⚠️  tsconfig.json contains comments/trailing commas and was not modified; ${manual}`);
  }
  if (parsed && !Array.isArray(parsed.exclude) && parsed.extends) {
    console.warn(`⚠️  tsconfig.json extends another config and has no own "exclude"; not modified (it would replace the inherited list); ${manual}`);
  } else if (parsed) {
    const exclude = new Set(Array.isArray(parsed.exclude) ? parsed.exclude : ['dist', 'node_modules']);
    const before = exclude.size;
    for (const entry of ['scripts', 'guardrails.config.ts', 'playwright.config.ts', 'tests']) exclude.add(entry);
    if (exclude.size !== before) {
      parsed.exclude = Array.from(exclude);
      fs.writeFileSync(tsconfigPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      console.log('✅ Updated tsconfig.json exclude list to isolate Node CLI scripts from Worker runtime types');
    }
  }
}

// 6. Add guardrail scripts to package.json (never overwrite existing ones)
const GUARDRAIL_SCRIPTS = {
  'check:arch': 'depcruise src --config .dependency-cruiser.cjs',
  'check:drift': 'node --experimental-strip-types scripts/check-doc-drift.ts',
  'check:complexity': 'node --experimental-strip-types scripts/check-complexity.ts',
  'check:deps': 'node --experimental-strip-types scripts/check-deps.ts',
  'check:visual': 'playwright test',
  guardrails: 'node --experimental-strip-types scripts/run-guardrails.ts',
};
const allDeclared = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
if ('astro' in allDeclared) GUARDRAIL_SCRIPTS['check:types'] = 'astro check && tsc --noEmit';

const manifest = pkg ?? { name: path.basename(targetDir), private: true, type: 'module' };
manifest.scripts = manifest.scripts ?? {};
const added = [];
for (const [name, cmd] of Object.entries(GUARDRAIL_SCRIPTS)) {
  if (!(name in manifest.scripts)) {
    manifest.scripts[name] = cmd;
    added.push(name);
  } else if (manifest.scripts[name] !== cmd) {
    console.warn(`⚠️  package.json script "${name}" already exists and differs from the guardrail default; kept yours. Expected: ${cmd}`);
  }
}
if (added.length > 0 || !pkg) {
  fs.writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
console.log(
  pkg
    ? added.length ? `✅ Added package.json scripts: ${added.join(', ')}` : '⏭️  package.json scripts already present'
    : `✅ Created package.json with guardrail scripts: ${added.join(', ')}`
);
if (pkg && pkg.type !== 'module') {
  console.warn('ℹ️  package.json has no "type": "module"; Node prints a reparse warning for scripts/*.ts. Add it if your project allows.');
}
console.log('\nNext: npm install -D dependency-cruiser typescript   (add @playwright/test if you enable visualSpecPath)');

console.log(`\n🎯 Guardrails bootstrapped (${preset} preset) in ${targetDir}`);
