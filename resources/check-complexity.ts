import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { guardrailsConfig } from '../guardrails.config.ts';
import { getChangedFiles } from './git-changes.ts';

/**
 * AST Code Complexity & Architectural Smell Advisor (scripts/check-complexity.ts)
 *
 * Configured via `guardrails.config.ts`. Uses the TypeScript Compiler AST (`ts.createSourceFile`)
 * and Astro template analysis to detect:
 * 1. Function Cognitive & Cyclomatic Complexity for functions, class methods, constructors,
 *    accessors, object-literal methods and (exported/default) arrow functions. CogC and CC here are
 *    simplified approximations of SonarSource Cognitive Complexity and McCabe Cyclomatic Complexity,
 *    not exact reimplementations; treat the numbers as relative signals.
 * 2. Fat Inline Astro <script> Smell: Inline <script> blocks in .astro templates should be
 *    thin DOM wiring glue; business/rendering logic belongs in .ts modules.
 * 3. SSR <-> Client Dual-Render Duplication Smell: Detects when an .astro client <script>
 *    uses `.innerHTML` to rebuild the exact same CSS classes/markup already rendered in SSR.
 * 4. SSR Frontmatter Runtime Impurity: Detects when an .astro SSR frontmatter (`---`) imports
 *    (directly, or transitively through local imports) a module that references browser-only DOM
 *    globals (`document`, `window`, `navigator`, `HTMLElement`, also via `globalThis.*`). Detection is
 *    scope-aware: property names, object keys, local bindings, type positions and
 *    `typeof window` guards are not flagged.
 * 5. Cross-File AST Clone Detection: Detects copy-pasted executable statement blocks across files.
 * 6. Inline Type-Cast Escapes: Flags `as any`, `as unknown as`, and inline structural casts `as { ... }`.
 * 7. Untyped Public Runtime Scripts (`public/*.js`): Scans raw JS scripts in `public/` and warns
 *    when runtime logic lives outside TypeScript & AGENTS.md governance.
 *
 * Ratchet mode (`ratchetChangedFilesOnly`) limits advisories AND the scorecard to files reported by
 * `getChangedFiles` (`--base <ref>` also includes files changed since that ref). If git is
 * unavailable, a warning is printed and all files are analysed. Cross-file clone advisories are kept
 * when ANY participating file changed.
 *
 * Exit code: 0 by default (advisories are informational). With
 * `failOnComplexityAdvisories: true`, exits 1 when any advisory remains after ratchet filtering.
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
  /** Every file participating in the finding (cross-file clones); defaults to `file`. */
  files?: string[];
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

const toPosix = (p: string) => p.split(path.sep).join('/').replace(/\\/g, '/');

function getBaseArg(): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith('--base='));
  if (eq) return eq.slice('--base='.length) || undefined;
  const idx = argv.indexOf('--base');
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function getGitChangedFilesSet(): Set<string> | null {
  if (!guardrailsConfig.ratchetChangedFilesOnly) return null;
  const files = getChangedFiles({ cwd: ROOT, base: getBaseArg() });
  if (files === null) {
    console.warn(
      '⚠️  Ratchet mode is enabled but git is unavailable: analysing ALL files instead of only changed ones.'
    );
    return null;
  }
  return new Set(files.map(toPosix));
}

const BROWSER_GLOBAL_ADVICE =
  'Keep modules imported in Astro SSR frontmatter (`---`) 100% isomorphic (Edge/Worker safe). Separate pure projection/math helpers from browser DOM controllers (`document`, `navigator`, `HTMLElement`), which should only be imported inside `<script>`.';

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.js') || file.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function bindingNames(name: ts.BindingName, out: Set<string>) {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindingNames(el.name, out);
  }
}

function collectHoistedVars(node: ts.Node, out: Set<string>) {
  if (ts.isVariableDeclaration(node)) bindingNames(node.name, out);
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
  ts.forEachChild(node, (c) => collectHoistedVars(c, out));
}

function collectStatementDeclarations(statements: readonly ts.Statement[], out: Set<string>) {
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) bindingNames(d.name, out);
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
      out.add(st.name.text);
    } else if (ts.isImportDeclaration(st) && st.importClause) {
      const clause = st.importClause;
      if (clause.name) out.add(clause.name.text);
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) out.add(nb.name.text);
      else if (nb) for (const el of nb.elements) out.add(el.name.text);
    } else if (ts.isImportEqualsDeclaration(st)) {
      out.add(st.name.text);
    }
  }
}

const declaredNamesCache = new WeakMap<ts.Node, Set<string>>();

function declaredNames(scope: ts.Node): Set<string> {
  const cached = declaredNamesCache.get(scope);
  if (cached) return cached;
  const names = new Set<string>();
  if (ts.isSourceFile(scope)) {
    collectStatementDeclarations(scope.statements, names);
    collectHoistedVars(scope, names);
  } else if (ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    collectStatementDeclarations(scope.statements, names);
  } else if (ts.isCaseBlock(scope)) {
    for (const clause of scope.clauses) collectStatementDeclarations(clause.statements, names);
  } else if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) bindingNames(p.name, names);
    if (ts.isFunctionExpression(scope) && scope.name) names.add(scope.name.text);
    if ('body' in scope && scope.body) collectHoistedVars(scope.body, names);
  } else if (ts.isClassExpression(scope) && scope.name) {
    names.add(scope.name.text);
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    bindingNames(scope.variableDeclaration.name, names);
  } else if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const d of scope.initializer.declarations) bindingNames(d.name, names);
  }
  declaredNamesCache.set(scope, names);
  return names;
}

function isLocallyDeclared(id: ts.Identifier): boolean {
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (declaredNames(p).has(id.text)) return true;
  }
  return false;
}

function isInTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
    if (ts.isExpressionWithTypeArguments(p)) {
      const heritage = p.parent;
      // `class A extends HTMLElement` is a runtime reference; `implements` is type-only.
      if (ts.isHeritageClause(heritage) && heritage.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(heritage.parent)) {
        return false;
      }
      return true;
    }
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

function isNonReferenceName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  ) {
    return true;
  }
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
  // `typeof window !== 'undefined'` is a guard, not a use.
  if (ts.isTypeOfExpression(p)) return true;
  return false;
}

function conditionGuardsGlobal(cond: ts.Expression, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isTypeOfExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(cond);
  return found;
}

function isGuardedByTypeof(node: ts.Node, name: string): boolean {
  for (let child: ts.Node = node, p = node.parent; p; child = p, p = p.parent) {
    if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false;
    if (ts.isIfStatement(p) && p.thenStatement === child && conditionGuardsGlobal(p.expression, name)) return true;
    if (ts.isConditionalExpression(p) && p.whenTrue === child && conditionGuardsGlobal(p.condition, name)) return true;
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      p.right === child &&
      conditionGuardsGlobal(p.left, name)
    ) {
      return true;
    }
  }
  return false;
}

/** Browser-only globals referenced at runtime and not resolved to a local declaration. */
function findBrowserGlobalRefs(sf: ts.SourceFile): Map<string, number> {
  const found = new Map<string, number>();
  const record = (name: string, node: ts.Node) => {
    if (found.has(name)) return;
    found.set(name, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  };

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      if (
        BROWSER_ONLY_GLOBALS.has(node.text) &&
        !isNonReferenceName(node) &&
        !isInTypePosition(node) &&
        !isLocallyDeclared(node) &&
        !isGuardedByTypeof(node, node.text)
      ) {
        record(node.text, node);
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      BROWSER_ONLY_GLOBALS.has(node.name.text) &&
      !isLocallyDeclared(node.expression) &&
      !isInTypePosition(node) &&
      !isGuardedByTypeof(node, node.name.text)
    ) {
      record(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveLocalModule(fromDir: string, spec: string): string | null {
  const base = path.resolve(fromDir, spec);
  const candidates: string[] = [];
  const jsMap: Record<string, string[]> = {
    '.js': ['.ts', '.tsx'],
    '.mjs': ['.mts'],
    '.jsx': ['.tsx'],
  };
  const ext = path.extname(base);
  if (['.ts', '.tsx', '.mts'].includes(ext)) candidates.push(base);
  if (jsMap[ext]) for (const e of jsMap[ext]) candidates.push(base.slice(0, -ext.length) + e);
  for (const e of ['.ts', '.tsx', '.mts']) candidates.push(base + e);
  for (const e of ['.ts', '.tsx', '.mts']) candidates.push(path.join(base, `index${e}`));
  return candidates.find(isFile) ?? null;
}

function localImportSpecs(sf: ts.SourceFile): { spec: string; node: ts.Node }[] {
  const specs: { spec: string; node: ts.Node }[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specs.push({ spec: stmt.moduleSpecifier.text, node: stmt });
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      specs.push({ spec: stmt.moduleSpecifier.text, node: stmt });
    }
  }
  return specs.filter((s) => s.spec.startsWith('.'));
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

  const direct = findBrowserGlobalRefs(sf);
  if (direct.size > 0) {
    const first = Math.min(...direct.values());
    findings.push({
      file: astroFile,
      line: first + 1,
      category: 'SSR Frontmatter Runtime Impurity',
      summary: `SSR frontmatter directly references browser-only DOM APIs (${Array.from(direct.keys()).join(', ')}).`,
      advice: BROWSER_GLOBAL_ADVICE,
    });
  }

  for (const { spec, node } of localImportSpecs(sf)) {
    if (!ts.isImportDeclaration(node)) continue;
    const start = resolveLocalModule(astroDir, spec);
    if (!start) continue;

    const visited = new Set<string>();
    const offenders = new Map<string, Set<string>>();
    const queue = [start];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (visited.has(file)) continue;
      visited.add(file);
      const tsf = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(file)
      );
      const refs = findBrowserGlobalRefs(tsf);
      if (refs.size > 0) offenders.set(toPosix(path.relative(ROOT, file)), new Set(refs.keys()));
      for (const dep of localImportSpecs(tsf)) {
        const resolved = resolveLocalModule(path.dirname(file), dep.spec);
        if (resolved && !visited.has(resolved)) queue.push(resolved);
      }
    }

    if (offenders.size > 0) {
      const importLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 2;
      const detail = Array.from(offenders, ([f, g]) => `${f} (${Array.from(g).join(', ')})`).join('; ');
      findings.push({
        file: astroFile,
        line: importLine,
        category: 'SSR Frontmatter Runtime Impurity',
        summary: `SSR frontmatter import "${spec}" reaches modules that reference browser-only DOM APIs: ${detail}.`,
        advice: BROWSER_GLOBAL_ADVICE,
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
    mode === 'public-js' ? ts.ScriptKind.JS : scriptKindFor(relFile)
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

  const addUnit = (node: ts.Node, unitName: string) => {
    units.push(
      analyzeAstUnit(node, sourceFile, relFile, unitName, 'function', lineOffset, false)
    );
  };

  const isFunctionValue = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression =>
    !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

  const ownerName = (node: ts.Node): string => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isClassLike(p)) return p.name?.text ?? '<anonymous class>';
      if (ts.isObjectLiteralExpression(p)) {
        const holder = p.parent;
        if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
        return '<object>';
      }
    }
    return '<anonymous>';
  };

  function findFunctions(node: ts.Node) {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) addUnit(node, `${node.name.text}()`);
      else if (node.body) addUnit(node, 'default export function()');
    } else if (ts.isConstructorDeclaration(node) && node.body) {
      addUnit(node, `${ownerName(node)}.constructor()`);
    } else if (
      (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
      node.body
    ) {
      const prefix = ts.isGetAccessorDeclaration(node) ? 'get ' : ts.isSetAccessorDeclaration(node) ? 'set ' : '';
      addUnit(node, `${ownerName(node)}.${prefix}${node.name.getText(sourceFile)}()`);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionValue(node.initializer)) {
      addUnit(node.initializer, `${node.name.text}()`);
    } else if (ts.isPropertyAssignment(node) && isFunctionValue(node.initializer)) {
      addUnit(node.initializer, `${ownerName(node)}.${node.name.getText(sourceFile)}()`);
    } else if (ts.isPropertyDeclaration(node) && isFunctionValue(node.initializer)) {
      addUnit(node.initializer, `${ownerName(node)}.${node.name.getText(sourceFile)}()`);
    } else if (ts.isExportAssignment(node) && isFunctionValue(node.expression)) {
      addUnit(node.expression, 'default export()');
    }
    ts.forEachChild(node, findFunctions);
  }

  findFunctions(sourceFile);

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
    } else if (/\.(ts|tsx|mts|astro|js)$/.test(entry.name)) {
      results.push(toPosix(rel));
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
    const raw = fs.readFileSync(path.join(ROOT, relFile), 'utf8').replace(/\r\n/g, '\n');
    if (/\.(ts|tsx|mts)$/.test(relFile)) {
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
        const { units, castSmells, fingerprints } = analyzeCodeSnippet(
          fmMatch[1],
          relFile,
          'astro-frontmatter',
          1
        );
        allUnits.push(...units);
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
      files: Array.from(distinctFiles),
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
  smellAdvisories = smellAdvisories.filter((a) => (a.files ?? [a.file]).some((f) => changedSet.has(f)));
}

const reportedUnits = changedSet === null ? allUnits : allUnits.filter((u) => changedSet.has(u.file));
const reportedDeclarative =
  changedSet === null ? declarativeFiles : declarativeFiles.filter((f) => changedSet.has(f));

console.log('\n📊 AST Complexity & Architectural Smell Scorecard (Declarative Data & CSS Ignored):');
console.log(
  `   • Pure Declarative Modules (CC=1, CogC=0): ${reportedDeclarative.join(', ') || 'none'}`
);

const sortedUnits = [...reportedUnits].sort(
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

if (guardrailsConfig.failOnComplexityAdvisories && smellAdvisories.length > 0) {
  console.error(
    `❌ failOnComplexityAdvisories is enabled and ${smellAdvisories.length} advisory finding(s) remain: failing.`
  );
  process.exit(1);
}
