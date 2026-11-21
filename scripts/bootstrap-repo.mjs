#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 1-Command Repository Guardrails Bootstrapper (scripts/bootstrap-repo.mjs)
 *
 * Usage:
 *   node scripts/bootstrap-repo.mjs --target /path/to/your-repo
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const RESOURCES = path.join(SKILL_ROOT, 'resources');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = path.resolve(targetIdx !== -1 && args[targetIdx + 1] ? args[targetIdx + 1] : process.cwd());

if (!fs.existsSync(targetDir)) {
  console.error(`❌ Target directory does not exist: ${targetDir}`);
  process.exit(1);
}

function copyIfMissingOrForce(srcRel, destRel, force = false) {
  const srcPath = path.join(RESOURCES, srcRel);
  const destPath = path.join(targetDir, destRel);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath) && !force) {
    console.log(`⏭️  Skipped existing ${destRel} (pass --force to overwrite)`);
    return;
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`✅ Installed ${destRel}`);
}

const force = args.includes('--force');

copyIfMissingOrForce('guardrails.config.ts', 'guardrails.config.ts', force);
copyIfMissingOrForce('run-guardrails.ts', 'scripts/run-guardrails.ts', force);
copyIfMissingOrForce('check-doc-drift.ts', 'scripts/check-doc-drift.ts', force);
copyIfMissingOrForce('check-complexity.ts', 'scripts/check-complexity.ts', force);
copyIfMissingOrForce('dependency-cruiser.cjs', '.dependency-cruiser.cjs', force);
copyIfMissingOrForce('templates/AGENTS.root.md', 'AGENTS.md', false);

// Create 1-line CLAUDE.md bridge for Claude Code if not present
const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
if (!fs.existsSync(claudeMdPath)) {
  fs.writeFileSync(claudeMdPath, '@AGENTS.md\n', 'utf8');
  console.log('✅ Created CLAUDE.md -> @AGENTS.md bridge for Claude Code');
}

console.log(`\n🎯 Guardrails bootstrapped in ${targetDir}`);
console.log('   Next: tailor guardrails.config.ts and run `npm run guardrails`.');
