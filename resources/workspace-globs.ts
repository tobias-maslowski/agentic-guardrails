import fs from 'node:fs';
import path from 'node:path';

// Deliberately annotation-free JavaScript: the bootstrapper loads this file as plain JS (no type stripping needed).

const SKIP_DIRS = new Set(['node_modules']);

function segmentRegex(seg) {
  return new RegExp('^' + seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
}

/** Resolves npm-style workspace globs (`apps/*`, `packages/**`, literal paths, `!negations`) to directories with a package.json. */
export function resolveWorkspaceGlobs(root, patterns) {
  if (!Array.isArray(patterns)) return [];
  const positives = [];
  const negatives = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p) continue;
    (p.startsWith('!') ? negatives : positives).push(p.replace(/^!/, ''));
  }

  const expand = (pattern) => {
    const segs = pattern.split('/').filter((s) => s !== '' && s !== '.');
    const out = [];
    const walk = (i, rel) => {
      if (i === segs.length) {
        if (rel && fs.existsSync(path.join(root, rel, 'package.json'))) out.push(rel);
        return;
      }
      const seg = segs[i];
      if (seg === '..') return;
      if (seg === '**') {
        walk(i + 1, rel);
        for (const d of childDirs(rel)) walk(i, rel ? `${rel}/${d}` : d);
      } else if (seg.includes('*')) {
        const re = segmentRegex(seg);
        for (const d of childDirs(rel)) if (re.test(d)) walk(i + 1, rel ? `${rel}/${d}` : d);
      } else {
        walk(i + 1, rel ? `${rel}/${seg}` : seg);
      }
    };
    const childDirs = (rel) => {
      try {
        return fs
          .readdirSync(path.join(root, rel), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
          .map((e) => e.name);
      } catch {
        return [];
      }
    };
    walk(0, '');
    return out;
  };

  const found = new Set(positives.flatMap(expand));
  for (const n of negatives) for (const d of expand(n)) found.delete(d);
  return [...found].sort();
}

/** `workspaces` of a package.json: array or `{ packages: [...] }`. */
export function packageWorkspaceGlobs(pkg) {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((x) => typeof x === 'string');
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) return ws.packages.filter((x) => typeof x === 'string');
  return null;
}
