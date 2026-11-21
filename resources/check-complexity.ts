import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { guardrailsConfig } from '../guardrails.config.ts';

/**
 * AST Code Complexity & Architectural Smell Advisor (scripts/check-complexity.ts)
 *
 * Configured via `guardrails.config.ts`. Uses the TypeScript Compiler AST (`ts.createSourceFile`)
 * and Astro template analysis to detect:
 * 1. Function Cognitive & Cyclomatic Complexity (SonarSource CogC & CC).
 * 2. Fat Inline Astro <script> Smell: Inline <script> blocks in .astro templates should be
 *    thin DOM wiring glue; business/rendering logic belongs in .ts modules.
 * 3. SSR <-> Client Dual-Render Duplication Smell: Detects when an .astro client <script>
 *    uses `.innerHTML` to rebuild the exact same CSS classes/markup already rendered in SSR.
 * 4. SSR Frontmatter Runtime Impurity: Detects when an .astro SSR frontmatter (`---`) imports
 *    a `.ts` module that references browser-only DOM globals (`document`, `window`, `navigator`, `HTMLElement`).
 * 5. Cross-File AST Clone Detection: Detects copy-pasted executable statement blocks across files.
 * 6. Inline Type-Cast Escapes: Flags `as any`, `as unknown as`, and inline structural casts `as { ... }`.
 * 7. Untyped Public Runtime Scripts (`public/*.js`): Scans raw JS scripts in `public/` and warns
 *    when runtime logic lives outside TypeScript & AGENTS.md governance.
 */

const ROOT = process.cwd();
const {
  functionCognitive: ADVISORY_COGNITIVE_THRESHOLD,
  functionCyclomatic: ADVISORY_CYCLOMATIC_THRESHOLD,
  astroScriptMaxStatements: ASTRO_SCRIPT_MAX_STATEMENTS,
  astroScriptMaxCognitive: ASTRO_SCRIPT_MAX_COGNITIVE,
} = guardrailsConfig.thresholds;

interface UnitMetrics {
  file: string;
  unitName: string;
  kind: 'function' | 'astro-script' | 'public-js';
  line: number;
  statementCount: number;
  cyclomatic: number;
  cognitive: number;
  maxNesting: number;
}

interface CodeSmellAdvisory {
  file: string;
  line: number;
  category:
    | 'High Function Complexity'
    | 'Fat Inline Astro <script>'
    | 'SSR/Client Dual-Render Duplication'
    | 'SSR Frontmatter Runtime Impurity'
    | 'Cross-File Logic Duplication'
    | 'Inline Type-Cast Escape'
    | 'Untyped Public Runtime Script';
  summary: string;
  advice: string;
}

interface StatementFingerprint {
  file: string;
  line: number;
  normalized: string;
  preview: string;
}

const BROWSER_ONLY_GLOBALS = new Set([
  'document',
  'window',
  'navigator',
  'localStorage',
  'sessionStorage',
  'HTMLElement',
  'HTMLButtonElement',
  'Document',
]);

function getGitChangedFilesSet(): Set<string> | null {
  if (!guardrailsConfig.ratchetChangedFilesOnly) return null;
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf8' });
    return new Set(
      out
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .flatMap((entry) => entry.split(' -> '))
    );
  } catch {
    return null;
  }
}

function detectSsrImportedBrowserGlobals(
  astroFile: string,
  frontmatterCode: string
): CodeSmellAdvisory[] {
  const findings: CodeSmellAdvisory[] = [];
  const astroDir = path.dirname(path.join(ROOT, astroFile));

  const sf = ts.createSourceFile(
    astroFile,
    frontmatterCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause?.isTypeOnly) {
      continue;
    }
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) {
      continue;
    }
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith('.')) {
      continue;
    }

    const candidatePath = path.resolve(astroDir, spec.endsWith('.ts') ? spec : `${spec}.ts`);
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    const relTarget = path.relative(ROOT, candidatePath);
    const targetCode = fs.readFileSync(candidatePath, 'utf8');
    const targetSf = ts.createSourceFile(
      relTarget,
      targetCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const foundGlobals = new Set<string>();
    function visit(node: ts.Node) {
      if (ts.isIdentifier(node) && BROWSER_ONLY_GLOBALS.has(node.text)) {
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
          return;
        }
        foundGlobals.add(node.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(targetSf);

    if (foundGlobals.size > 0) {
      const importLine = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 2;
      findings.push({
        file: astroFile,
        line: importLine,
        category: 'SSR Frontmatter Runtime Impurity',
        summary: `SSR frontmatter imports "${relTarget}", which references browser-only DOM APIs (${Array.from(foundGlobals).join(', ')}).`,
        advice:
          'Keep modules imported in Astro SSR frontmatter (`---`) 100% isomorphic (Edge/Worker safe). Separate pure projection/math helpers from browser DOM controllers (`document`, `navigator`, `HTMLElement`), which should only be imported inside `<script>`.',
      });
    }
  }

  return findings;
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function analyzeAstUnit(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  file: string,
  unitName: string,
  kind: 'function' | 'astro-script' | 'public-js',
  lineOffset = 0,
  includeInnerFunctions = false
): UnitMetrics {
  let cyclomatic = 1;
  let cognitive = 0;
  let maxNesting = 0;
  let statementCount = 0;

  function visit(current: ts.Node, nesting: number) {
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) {
      return;
    }

    if (
      !includeInnerFunctions &&
      current !== node &&
      ts.isFunctionDeclaration(current) &&
      current.name
    ) {
      return;
    }

    if (ts.isStatement(current) && !ts.isBlock(current)) {
      statementCount++;
    }

    let increasesNesting = false;

    if (ts.isIfStatement(current)) {
      cyclomatic++;
      const isElseIf =
        current.parent &&
        ts.isIfStatement(current.parent) &&
        current.parent.elseStatement === current;

      if (isElseIf) {
        cognitive += 1;
      } else {
        cognitive += 1 + nesting;
        increasesNesting = true;
      }

      if (current.elseStatement && !ts.isIfStatement(current.elseStatement)) {
        cognitive += 1;
      }
    } else if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isCatchClause(current)
    ) {
      cyclomatic++;
      cognitive += 1 + nesting;
      increasesNesting = true;
    } else if (ts.isSwitchStatement(current)) {
      cognitive += 1 + nesting;
      increasesNesting = true;
    } else if (ts.isCaseClause(current)) {
      cyclomatic++;
    } else if (
      ts.isBinaryExpression(current) &&
      isLogicalOperator(current.operatorToken.kind)
    ) {
      cyclomatic++;
      const parentIsSameOp =
        ts.isBinaryExpression(current.parent) &&
        current.parent.operatorToken.kind === current.operatorToken.kind;
      if (!parentIsSameOp) {
        cognitive += 1;
      }
    } else if (
      current !== node &&
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    ) {
      increasesNesting = true;
    }

    const nextNesting = increasesNesting ? nesting + 1 : nesting;
    if (nextNesting > maxNesting) {
      maxNesting = nextNesting;
    }

    ts.forEachChild(current, (child) => visit(child, nextNesting));
  }

  visit(node, 0);

  const startLine =
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1 +
    lineOffset;

  return {
    file,
    unitName,
    kind,
    line: startLine,
    statementCount,
    cyclomatic,
    cognitive,
    maxNesting,
  };
}

function detectTypeCastEscapes(
  sourceFile: ts.SourceFile,
  relFile: string,
  lineOffset = 0
): CodeSmellAdvisory[] {
  const findings: CodeSmellAdvisory[] = [];

  function visit(node: ts.Node) {
    if (ts.isAsExpression(node)) {
      const typeNode = node.type;
      const isAnyCast = typeNode.kind === ts.SyntaxKind.AnyKeyword;
      const isInlineTypeLiteral = ts.isTypeLiteralNode(typeNode);
      const isDoubleUnknownCast =
        ts.isAsExpression(node.expression) &&
        node.expression.type.kind === ts.SyntaxKind.UnknownKeyword;

      if (isAnyCast || isInlineTypeLiteral || isDoubleUnknownCast) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
          1 +
          lineOffset;
        const snippet = node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 85);

        findings.push({
          file: relFile,
          line,
          category: 'Inline Type-Cast Escape',
          summary: `Inline type assertion \`${snippet}\` bypasses centralized type checking.`,
          advice:
            'Define runtime/CMS/environment types centrally (e.g. `src/env.d.ts` or generated schema types) or use a typed helper adapter instead of inline `as { ... }` / `as any` casts.',
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function collectStatementWindows(
  sourceFile: ts.SourceFile,
  relFile: string,
  lineOffset = 0
): StatementFingerprint[] {
  const windows: StatementFingerprint[] = [];

  function scanStatements(statements: ts.NodeArray<ts.Statement>) {
    const eligible = statements.filter(
      (s) =>
        !ts.isImportDeclaration(s) &&
        !ts.isInterfaceDeclaration(s) &&
        !ts.isTypeAliasDeclaration(s) &&
        !ts.isReturnStatement(s)
    );

    for (let i = 0; i < eligible.length - 1; i++) {
      const s1 = eligible[i].getText(sourceFile).replace(/\s+/g, ' ').trim();
      const s2 = eligible[i + 1].getText(sourceFile).replace(/\s+/g, ' ').trim();
      const combined = `${s1} ${s2}`;
      if (combined.length >= 95 && /[?:]|typeof|get\(/.test(combined)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(eligible[i].getStart(sourceFile)).line +
          1 +
          lineOffset;
        windows.push({
          file: relFile,
          line,
          normalized: combined,
          preview: combined.slice(0, 95) + (combined.length > 95 ? '...' : ''),
        });
      }
    }

    for (const stmt of statements) {
      ts.forEachChild(stmt, visitChildBlocks);
    }
  }

  function visitChildBlocks(node: ts.Node) {
    if (ts.isBlock(node)) {
      scanStatements(node.statements);
    } else {
      ts.forEachChild(node, visitChildBlocks);
    }
  }

  scanStatements(sourceFile.statements);
  return windows;
}

function analyzeCodeSnippet(
  code: string,
  relFile: string,
  mode: 'ts' | 'astro-frontmatter' | 'astro-script' | 'public-js',
  lineOffset = 0
): {
  units: UnitMetrics[];
  castSmells: CodeSmellAdvisory[];
  fingerprints: StatementFingerprint[];
} {
  const sourceFile = ts.createSourceFile(
    relFile,
    code,
    ts.ScriptTarget.Latest,
    true,
    mode === 'public-js' ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );

  const units: UnitMetrics[] = [];
  const castSmells = detectTypeCastEscapes(sourceFile, relFile, lineOffset);
  const fingerprints = collectStatementWindows(sourceFile, relFile, lineOffset);

  if (mode === 'astro-script') {
    units.push(
      analyzeAstUnit(
        sourceFile,
        sourceFile,
        relFile,
        '<script> (total inline glue)',
        'astro-script',
        lineOffset,
        true
      )
    );
  } else if (mode === 'public-js') {
    units.push(
      analyzeAstUnit(
        sourceFile,
        sourceFile,
        relFile,
        'public runtime script (top-level)',
        'public-js',
        lineOffset,
        true
      )
    );
  }

  if (mode !== 'astro-frontmatter') {
    function findFunctions(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        units.push(
          analyzeAstUnit(
            node,
            sourceFile,
            relFile,
            `${node.name.text}()`,
            'function',
            lineOffset,
            false
          )
        );
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        units.push(
          analyzeAstUnit(
            node.initializer,
            sourceFile,
            relFile,
            `${node.name.text}()`,
            'function',
            lineOffset,
            false
          )
        );
      }
      ts.forEachChild(node, findFunctions);
    }

    findFunctions(sourceFile);
  }

  return { units, castSmells, fingerprints };
}

function extractClassNames(markup: string): Set<string> {
  const classes = new Set<string>();
  for (const match of markup.matchAll(/\bclass=["']([^"'{]+)["']/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token && !token.includes('$')) {
        classes.add(token.trim());
      }
    }
  }
  return classes;
}

function detectAstroTemplateSmells(relFile: string, raw: string): CodeSmellAdvisory[] {
  const smells: CodeSmellAdvisory[] = [];

  const ssrMarkup = raw
    .replace(/^---[\s\S]*?---/, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  const ssrClasses = extractClassNames(ssrMarkup);

  const scriptMatches = Array.from(
    raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)
  );

  for (const match of scriptMatches) {
    const scriptCode = match[1];
    const prefix = raw.slice(0, match.index ?? 0);
    const scriptLine = prefix.split('\n').length;

    if (scriptCode.includes('.innerHTML')) {
      const scriptClasses = extractClassNames(scriptCode);
      const duplicatedClasses = Array.from(scriptClasses).filter((c) => ssrClasses.has(c));
      if (duplicatedClasses.length > 0) {
        smells.push({
          file: relFile,
          line: scriptLine,
          category: 'SSR/Client Dual-Render Duplication',
          summary: `Client <script> uses .innerHTML to reconstruct DOM elements already rendered in the SSR template (duplicated classes: ${duplicatedClasses.join(', ')}).`,
          advice:
            'Extract a shared pure rendering/projection function in `src/domain/` or `src/ui/*.ts` so SSR and client updates share a single source of truth.',
        });
      }
    }
  }

  return smells;
}

function collectFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(rel));
    } else if (/\.(ts|astro|js)$/.test(entry.name)) {
      results.push(rel);
    }
  }
  return results;
}

const changedSet = getGitChangedFilesSet();
const allUnits: UnitMetrics[] = [];
const declarativeFiles: string[] = [];
let smellAdvisories: CodeSmellAdvisory[] = [];
const allFingerprints: StatementFingerprint[] = [];

const scanDirs = Array.from(
  new Set([
    ...guardrailsConfig.scopedModules,
    ...(guardrailsConfig.extraComplexityScanDirs ?? ['src/pages', 'public']),
  ])
);

for (const dir of scanDirs) {
  for (const relFile of collectFiles(dir)) {
    const raw = fs.readFileSync(path.join(ROOT, relFile), 'utf8');
    if (relFile.endsWith('.ts')) {
      const { units, castSmells, fingerprints } = analyzeCodeSnippet(raw, relFile, 'ts', 0);
      smellAdvisories.push(...castSmells);
      allFingerprints.push(...fingerprints);
      if (units.length === 0) {
        declarativeFiles.push(relFile);
      } else {
        allUnits.push(...units);
      }
    } else if (relFile.endsWith('.js') && relFile.startsWith('public/')) {
      const { units } = analyzeCodeSnippet(raw, relFile, 'public-js', 0);
      allUnits.push(...units);

      const rootAgentsPath = path.join(ROOT, 'AGENTS.md');
      const rootAgentsMd = fs.existsSync(rootAgentsPath)
        ? fs.readFileSync(rootAgentsPath, 'utf8')
        : '';
      if (!rootAgentsMd.includes(relFile) && !rootAgentsMd.includes('public/')) {
        smellAdvisories.push({
          file: relFile,
          line: 1,
          category: 'Untyped Public Runtime Script',
          summary: `Executable JavaScript runtime file "${relFile}" lives in public/ outside TypeScript type-checking and is not referenced in AGENTS.md.`,
          advice:
            'Document `public/` runtime assets (like Service Workers) in `AGENTS.md` or compile them from typed TypeScript source.',
        });
      }
    } else if (relFile.endsWith('.astro')) {
      smellAdvisories.push(...detectAstroTemplateSmells(relFile, raw));

      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        smellAdvisories.push(...detectSsrImportedBrowserGlobals(relFile, fmMatch[1]));
        const { castSmells, fingerprints } = analyzeCodeSnippet(
          fmMatch[1],
          relFile,
          'astro-frontmatter',
          1
        );
        smellAdvisories.push(...castSmells);
        allFingerprints.push(...fingerprints);
      }

      const scriptMatches = Array.from(
        raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)
      ) as RegExpExecArray[];
      for (const match of scriptMatches) {
        const scriptCode = match[1];
        const prefix = raw.slice(0, match.index ?? 0);
        const lineOffset = prefix.split('\n').length - 1;
        const { units, castSmells, fingerprints } = analyzeCodeSnippet(
          scriptCode,
          relFile,
          'astro-script',
          lineOffset
        );
        allUnits.push(...units);
        smellAdvisories.push(...castSmells);
        allFingerprints.push(...fingerprints);
      }
    }
  }
}

const fingerprintGroups = new Map<string, StatementFingerprint[]>();
for (const fp of allFingerprints) {
  const group = fingerprintGroups.get(fp.normalized) ?? [];
  group.push(fp);
  fingerprintGroups.set(fp.normalized, group);
}

for (const [, group] of fingerprintGroups) {
  const distinctFiles = new Set(group.map((g) => g.file));
  if (distinctFiles.size > 1) {
    const locations = group.map((g) => `${g.file}:${g.line}`).join(' and ');
    smellAdvisories.push({
      file: group[0].file,
      line: group[0].line,
      category: 'Cross-File Logic Duplication',
      summary: `Identical statement block duplicated across ${locations}: \`${group[0].preview}\``,
      advice:
        'Extract duplicated logic into a shared single-source-of-truth helper function.',
    });
  }
}

for (const u of allUnits) {
  if (
    u.kind === 'astro-script' &&
    (u.statementCount > ASTRO_SCRIPT_MAX_STATEMENTS ||
      u.cognitive > ASTRO_SCRIPT_MAX_COGNITIVE)
  ) {
    smellAdvisories.push({
      file: u.file,
      line: u.line,
      category: 'Fat Inline Astro <script>',
      summary: `Inline <script> contains ${u.statementCount} statements (max ${ASTRO_SCRIPT_MAX_STATEMENTS}) and Cognitive Complexity ${u.cognitive} (max ${ASTRO_SCRIPT_MAX_COGNITIVE}).`,
      advice:
        'Keep .astro <script> blocks as thin DOM event glue; extract state machines, coordinate math, and helpers into a dedicated `.ts` module.',
    });
  } else if (
    u.kind === 'function' &&
    (u.cognitive >= ADVISORY_COGNITIVE_THRESHOLD ||
      u.cyclomatic >= ADVISORY_CYCLOMATIC_THRESHOLD)
  ) {
    smellAdvisories.push({
      file: u.file,
      line: u.line,
      category: 'High Function Complexity',
      summary: `${u.unitName} has Cognitive Complexity ${u.cognitive} (threshold ${ADVISORY_COGNITIVE_THRESHOLD}) and Cyclomatic Complexity ${u.cyclomatic} (threshold ${ADVISORY_CYCLOMATIC_THRESHOLD}).`,
      advice:
        'Decompose branching and DOM/string assembly into smaller single-purpose functions.',
    });
  }
}

if (changedSet !== null) {
  smellAdvisories = smellAdvisories.filter((a) => changedSet.has(a.file));
}

console.log('\n📊 AST Complexity & Architectural Smell Scorecard (Declarative Data & CSS Ignored):');
console.log(
  `   • Pure Declarative Modules (CC=1, CogC=0): ${declarativeFiles.join(', ') || 'none'}`
);

const sortedUnits = [...allUnits].sort(
  (a, b) => b.cognitive - a.cognitive || b.cyclomatic - a.cyclomatic
);

for (const u of sortedUnits.slice(0, 8)) {
  const isFlagged =
    (u.kind === 'astro-script' &&
      (u.statementCount > ASTRO_SCRIPT_MAX_STATEMENTS ||
        u.cognitive > ASTRO_SCRIPT_MAX_COGNITIVE)) ||
    (u.kind === 'function' &&
      (u.cognitive >= ADVISORY_COGNITIVE_THRESHOLD ||
        u.cyclomatic >= ADVISORY_CYCLOMATIC_THRESHOLD));

  const status = isFlagged ? '⚠️ ADVISORY' : '✅ OK      ';
  console.log(
    `   ${status} | CogC: ${String(u.cognitive).padStart(2, ' ')} | CC: ${String(u.cyclomatic).padStart(2, ' ')} | Stmts: ${String(u.statementCount).padStart(2, ' ')} | ${u.file}:${u.line} -> ${u.unitName}`
  );
}

if (smellAdvisories.length > 0) {
  console.log(
    `\n💡 [Architectural & Complexity Advisories] (${smellAdvisories.length} finding(s)):`
  );
  for (const adv of smellAdvisories) {
    console.log(
      `  • [${adv.category}] ${adv.file}:${adv.line}\n    ↳ Smell:  ${adv.summary}\n    ↳ Advice: ${adv.advice}`
    );
  }
  console.log('');
} else {
  console.log('\n✅ Complexity & Smell Advisor: All executable units and Astro scripts are clean.\n');
}
