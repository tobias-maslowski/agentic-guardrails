import fs from 'node:fs';
import path from 'node:path';

/** Small filesystem and `.astro` helpers shared by the checks (no TypeScript dependency). */

export const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n');
export const readText = (p: string): string => normalizeEol(fs.readFileSync(p, 'utf8'));

export interface CodeBlock {
  code: string;
  /** 1-based line in the file where `code` starts. */
  line: number;
  kind: 'frontmatter' | 'script';
}

const NON_JS_SCRIPT = /\btype\s*=\s*["']?(?:application\/(?:ld\+)?json|importmap|speculationrules|text\/template)/i;

/** Frontmatter and `<script>` bodies of an `.astro` file with their start lines. `content` must use `\n` EOLs. */
export function astroBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lineAt = (index: number): number => content.slice(0, index).split('\n').length;
  const fm = content.match(/^\s*---\n([\s\S]*?)\n---/);
  if (fm) {
    const start = fm[0].length - '\n---'.length - fm[1].length;
    blocks.push({ code: fm[1], line: lineAt(start), kind: 'frontmatter' });
  }
  for (const m of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!m[2].trim() || NON_JS_SCRIPT.test(m[1])) continue;
    const start = (m.index ?? 0) + m[0].length - '</script>'.length - m[2].length;
    blocks.push({ code: m[2], line: lineAt(start), kind: 'script' });
  }
  return blocks;
}

export interface WalkOptions {
  ignoreDirs?: Set<string>;
  accept: (name: string) => boolean;
}

export const DEFAULT_IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.astro', '.wrangler', '.git']);

/** Files below `dir` (absolute paths), skipping dot-directories and ignored directories. Symlinked directories are not followed. */
export function walk(dir: string, opts: WalkOptions): string[] {
  const ignore = opts.ignoreDirs ?? DEFAULT_IGNORED_DIRS;
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || ignore.has(e.name)) continue;
      out.push(...walk(path.join(dir, e.name), opts));
    } else if (e.isFile() && opts.accept(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}
