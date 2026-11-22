import path from 'node:path';
import { ROOT, projects, toPosix } from './context.ts';
import { readText, walk } from './source-utils.ts';

/** `.astro` files (under any workspace's `src`) with client-side behaviour: a `<script>` block or a `client:*` directive. */

const INTERACTIVE_RE = /<script\b([^>]*)>|\bclient:(?:load|idle|visible|media|only)\b/gi;
const NON_JS_SCRIPT = /\btype\s*=\s*["']?(?:application\/(?:ld\+)?json|importmap|speculationrules)/i;

export interface InteractiveFile {
  file: string;
  line: number;
  what: string;
}

export function interactiveFiles(): InteractiveFile[] {
  const found: InteractiveFile[] = [];
  for (const project of projects) {
    for (const abs of walk(path.join(project.abs, 'src'), { accept: (n) => n.endsWith('.astro') })) {
      const raw = readText(abs)
        .replace(/^\s*---\n[\s\S]*?\n---/, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
      for (const m of raw.matchAll(INTERACTIVE_RE)) {
        if (m[1] !== undefined && NON_JS_SCRIPT.test(m[1])) continue;
        found.push({
          file: toPosix(path.relative(ROOT, abs)),
          line: raw.slice(0, m.index).split('\n').length,
          what: m[1] !== undefined ? '<script>' : m[0],
        });
        break;
      }
    }
  }
  return found;
}
