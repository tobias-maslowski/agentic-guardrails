import fs from 'node:fs';
import path from 'node:path';
import { guardrailsConfig } from '../guardrails.config.ts';

/**
 * Automated Doc-Drift & Astro Structural Guardrail Checker (scripts/check-doc-drift.ts)
 *
 * Configured via `guardrails.config.ts`. Verifies deterministically:
 * 1. Module Coverage: Every file in `scopedModules` must be listed under `## Exported Modules`
 *    in that directory's `AGENTS.md` (and no deleted ghost files may remain listed).
 * 2. ADR Path Integrity: Every path listed in an ADR's `applies_to` or `enforced_by`
 *    frontmatter must exist on disk.
 * 3. Astro Import Boundaries:
 *    - `.astro` files in `src/ui/` cannot import from `worker`, `pages`, `cms`, `storyblok`, or `@storyblok/*`.
 *    - `.astro` files in `src/storyblok/` (if present) cannot import from `worker` or `pages`.
 * 4. Style Encapsulation: Global layout `.astro` file must not contain leaked component CSS prefixes.
 * 5. Interactive UI Coverage: Any `src/ui/*.astro` component with `<button` or `<script`
 *    must have at least one selector covered in `visualSpecPath`.
 * 6. Storyblok Visual Editor Invariant (Optional): If `guardrailsConfig.storyblok` is configured,
 *    verifies every wrapper in `storyblok.wrapperDir` calls `storyblokEditable`.
 */

const ROOT = process.cwd();
const errors: string[] = [];

// 1. Check module files <-> scoped AGENTS.md
for (const modDir of guardrailsConfig.scopedModules) {
  const absDir = path.join(ROOT, modDir);
  const agentsMdPath = path.join(absDir, 'AGENTS.md');

  if (!fs.existsSync(agentsMdPath)) {
    errors.push(`[Missing Scoped Context] ${modDir}/AGENTS.md does not exist.`);
    continue;
  }

  const agentsMd = fs.readFileSync(agentsMdPath, 'utf8');
  const actualFiles = fs
    .readdirSync(absDir)
    .filter((f) => f !== 'AGENTS.md' && !f.startsWith('.') && /\.(ts|astro|tsx)$/.test(f));

  const exportedSection = agentsMd.split('## Exported Modules')[1] ?? '';
  const documentedFiles = Array.from(
    exportedSection.matchAll(/^- `([^`]+)`/gm),
    (m: RegExpExecArray) => m[1]
  );

  for (const file of actualFiles) {
    if (!documentedFiles.includes(file)) {
      errors.push(
        `[Doc Drift: Undocumented File] "${modDir}/${file}" exists in code but is not listed under "## Exported Modules" in ${modDir}/AGENTS.md.`
      );
    }
  }

  for (const docFile of documentedFiles) {
    if (!actualFiles.includes(docFile)) {
      errors.push(
        `[Doc Drift: Ghost Entry] "${docFile}" is documented in ${modDir}/AGENTS.md, but "${modDir}/${docFile}" does not exist on disk.`
      );
    }
  }
}

// 2. Check ADR frontmatter references exist on disk
const adrDir = path.join(ROOT, 'docs/adr');
if (fs.existsSync(adrDir)) {
  const adrFiles = fs.readdirSync(adrDir).filter((f) => f.endsWith('.md'));
  for (const adrFile of adrFiles) {
    const adrContent = fs.readFileSync(path.join(adrDir, adrFile), 'utf8');
    const frontmatterMatch = adrContent.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      errors.push(`[ADR Schema] docs/adr/${adrFile} is missing YAML frontmatter.`);
      continue;
    }

    const fm = frontmatterMatch[1];
    const pathMatches = Array.from(
      fm.matchAll(/^\s*-\s+(.+)$/gm),
      (m: RegExpExecArray) => m[1].trim()
    );
    const enforcedMatch = fm.match(/^enforced_by:\s*(.+)$/m);
    if (enforcedMatch) {
      pathMatches.push(enforcedMatch[1].trim());
    }

    for (const refPath of pathMatches) {
      if (!fs.existsSync(path.join(ROOT, refPath))) {
        errors.push(
          `[Doc Drift: Stale ADR Reference] docs/adr/${adrFile} references "${refPath}", which no longer exists.`
        );
      }
    }
  }
}

// 3. Check .astro import boundaries & 5. Interactive UI test coverage in src/ui/
const uiDir = path.join(ROOT, 'src/ui');
const visualSpecContent =
  guardrailsConfig.visualSpecPath &&
  fs.existsSync(path.join(ROOT, guardrailsConfig.visualSpecPath))
    ? fs.readFileSync(path.join(ROOT, guardrailsConfig.visualSpecPath), 'utf8')
    : null;

if (fs.existsSync(uiDir)) {
  const astroFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith('.astro'));
  for (const file of astroFiles) {
    const content = fs.readFileSync(path.join(uiDir, file), 'utf8');
    const imports = Array.from(
      content.matchAll(/from\s+['"]([^'"]+)['"]/g),
      (m: RegExpExecArray) => m[1]
    );
    for (const imp of imports) {
      if (
        imp.includes('/worker/') ||
        imp.startsWith('@worker/') ||
        imp.includes('/pages/') ||
        imp.includes('/cms/') ||
        imp.startsWith('@cms/') ||
        imp.includes('/storyblok/') ||
        imp.startsWith('@storyblok/')
      ) {
        errors.push(
          `[Astro Boundary Violation] src/ui/${file} imports "${imp}". ADR-0001 forbids src/ui/ from importing worker, pages, storyblok wrappers, or CMS adapter internals.`
        );
      }
    }

    if (visualSpecContent !== null && /<(button|script)\b/i.test(content)) {
      const selectors = [
        ...Array.from(content.matchAll(/\bid=["']([^"']+)["']/g), (m: RegExpExecArray) => m[1]),
        ...Array.from(
          content.matchAll(/\b(data-[a-z0-9-]+)=/gi),
          (m: RegExpExecArray) => m[1]
        ),
      ];
      const isCovered = selectors.some((sel) => visualSpecContent.includes(sel));
      if (!isCovered) {
        errors.push(
          `[Untested Interactive UI] src/ui/${file} contains interactive controls (<button>/<script>), but none of its selectors (${selectors.join(', ') || 'none'}) are tested in ${guardrailsConfig.visualSpecPath}.`
        );
      }
    }
  }
}

// 3b. Check .astro import boundaries in src/storyblok/ (if present)
const storyblokDir = path.join(
  ROOT,
  guardrailsConfig.storyblok?.wrapperDir ?? 'src/storyblok'
);
if (fs.existsSync(storyblokDir)) {
  const sbAstroFiles = fs.readdirSync(storyblokDir).filter((f) => f.endsWith('.astro'));
  for (const file of sbAstroFiles) {
    const content = fs.readFileSync(path.join(storyblokDir, file), 'utf8');
    const imports = Array.from(
      content.matchAll(/from\s+['"]([^'"]+)['"]/g),
      (m: RegExpExecArray) => m[1]
    );
    for (const imp of imports) {
      if (imp.includes('/worker/') || imp.startsWith('@worker/') || imp.includes('/pages/')) {
        errors.push(
          `[Astro Boundary Violation] src/storyblok/${file} imports "${imp}". Storyblok wrappers cannot import from worker or pages.`
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
    const indexContent = fs.readFileSync(layoutPath, 'utf8');
    const styleMatch = indexContent.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
    if (styleMatch) {
      const prefixAlternation = guardrailsConfig.forbiddenGlobalClassPrefixes.join('|');
      const regex = new RegExp(`\\.(${prefixAlternation})`, 'g');
      const leaked = styleMatch[1].match(regex);
      if (leaked) {
        errors.push(
          `[Style Encapsulation Violation] ${guardrailsConfig.globalLayoutAstroPath} contains component-specific CSS selectors (${Array.from(new Set(leaked)).join(', ')}). Keep component styles encapsulated inside src/ui/*.astro.`
        );
      }
    }
  }
}

// 6. Optional Storyblok Visual Editor invariant (`storyblokEditable`)
if (guardrailsConfig.storyblok?.requireStoryblokEditable) {
  const sbDir = path.join(ROOT, guardrailsConfig.storyblok.wrapperDir);
  if (fs.existsSync(sbDir)) {
    const sbFiles = fs.readdirSync(sbDir).filter((f) => f.endsWith('.astro'));
    for (const file of sbFiles) {
      const content = fs.readFileSync(path.join(sbDir, file), 'utf8');
      if (!content.includes('storyblokEditable(')) {
        errors.push(
          `[Storyblok Visual Editor Drift] ${guardrailsConfig.storyblok.wrapperDir}/${file} is missing \`storyblokEditable(blok)\` required for Visual Editor live preview.`
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
