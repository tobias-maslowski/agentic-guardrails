#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 1-Command Repository Guardrails Bootstrapper (scripts/bootstrap-repo.mjs)
 *
 * Usage:
 *   node scripts/bootstrap-repo.mjs --target /path/to/your-repo [--preset standard|storyblok] [--force]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const RESOURCES = path.join(SKILL_ROOT, 'resources');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = path.resolve(
  targetIdx !== -1 && args[targetIdx + 1] ? args[targetIdx + 1] : process.cwd()
);

const presetIdx = args.indexOf('--preset');
const preset =
  presetIdx !== -1 && args[presetIdx + 1] ? args[presetIdx + 1].toLowerCase() : 'standard';
const isStoryblok = preset === 'storyblok';
const force = args.includes('--force');

// Auto-create target directory if it does not exist yet
fs.mkdirSync(targetDir, { recursive: true });

function copyIfMissingOrForce(srcRel, destRel, allowOverwrite = false) {
  const srcPath = path.join(RESOURCES, srcRel);
  const destPath = path.join(targetDir, destRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && !allowOverwrite) {
    console.log(`⏭️  Skipped existing ${destRel} (pass --force to overwrite)`);
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
copyIfMissingOrForce('guardrails.config.ts', 'guardrails.config.ts', force);
copyIfMissingOrForce('run-guardrails.ts', 'scripts/run-guardrails.ts', force);
copyIfMissingOrForce('check-doc-drift.ts', 'scripts/check-doc-drift.ts', force);
copyIfMissingOrForce('check-complexity.ts', 'scripts/check-complexity.ts', force);
copyIfMissingOrForce('check-deps.ts', 'scripts/check-deps.ts', force);
copyIfMissingOrForce('dependency-cruiser.cjs', '.dependency-cruiser.cjs', force);

// If --preset storyblok, patch guardrails.config.ts with the 5 Storyblok scoped modules and storyblok block
if (isStoryblok) {
  const cfgPath = path.join(targetDir, 'guardrails.config.ts');
  let cfg = fs.readFileSync(cfgPath, 'utf8');
  cfg = cfg.replace(
    "scopedModules: ['src/domain', 'src/worker', 'src/ui'],",
    "scopedModules: ['src/domain', 'src/cms', 'src/storyblok', 'src/ui', 'src/worker'],\n  storyblok: {\n    wrapperDir: 'src/storyblok',\n    requireStoryblokEditable: true,\n  },"
  );
  fs.writeFileSync(cfgPath, cfg, 'utf8');
  console.log('✅ Configured guardrails.config.ts for 6-layer Storyblok preset');
}

// 2. Install Root Context Router (AGENTS.md), CLAUDE.md bridge, and GitHub Copilot instructions
const rootTemplate = isStoryblok
  ? 'templates/AGENTS.storyblok.md'
  : 'templates/AGENTS.root.md';
copyIfMissingOrForce(rootTemplate, 'AGENTS.md', false);
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
    adrContent = adrContent.replace(
      '  - src/domain\n  - src/ui\n  - src/worker\n  - src/pages',
      '  - src/domain\n  - src/cms\n  - src/storyblok\n  - src/ui\n  - src/worker\n  - src/pages'
    );
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

// 5. If tsconfig.json exists, ensure Node CLI scripts are excluded from Worker runtime typecheck
const tsconfigPath = path.join(targetDir, 'tsconfig.json');
if (fs.existsSync(tsconfigPath)) {
  try {
    const rawTsconfig = fs.readFileSync(tsconfigPath, 'utf8');
    const parsed = JSON.parse(rawTsconfig);
    const excludeSet = new Set(Array.isArray(parsed.exclude) ? parsed.exclude : ['dist', 'node_modules']);
    excludeSet.add('scripts');
    excludeSet.add('guardrails.config.ts');
    excludeSet.add('playwright.config.ts');
    excludeSet.add('tests');
    parsed.exclude = Array.from(excludeSet);
    if (Array.isArray(parsed.include)) {
      parsed.include = parsed.include.filter((inc) => !inc.startsWith('scripts'));
    }
    fs.writeFileSync(tsconfigPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    console.log('✅ Updated tsconfig.json exclude list to isolate Node CLI scripts from Worker runtime types');
  } catch {
    // Ignore non-standard JSON comments in tsconfig.json
  }
}

console.log(`\n🎯 Guardrails bootstrapped (${preset} preset) in ${targetDir}`);
