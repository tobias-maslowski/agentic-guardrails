import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { guardrailsConfig } from '../guardrails.config.ts';

/**
 * Deterministic Dependency Hygiene, Security CVE & Freshness Guardrail (scripts/check-deps.ts)
 *
 * Enforces:
 * 1. Fast Local Hygiene (<20ms):
 *    - Fails on banned/legacy packages (`axios`, `uuid`, `moment`, `crypto-js`, `lodash`, etc.).
 *    - Fails on unpinned wildcard versions (`"*"`, `"latest"`).
 *    - Separates `'outdated'` version pins from `'cve'` security exceptions (a version pin NEVER silences a security CVE;
 *      a `'cve'` exception requires an explicit `ghsaId: 'GHSA-...'`).
 * 2. Registry Security Audit & Training-Cutoff Freshness (`--audit` / `--all`):
 *    - Runs `npm audit --json` and fails deterministically (`exit 1`) on unacknowledged CVEs >= `failOnVulnerabilitySeverity`.
 *    - Runs `npm outdated --json` and fails deterministically (`exit 1`) on outdated direct packages when `failOnOutdated: true`.
 *    - Fails closed: if a requested audit cannot run (no lockfile, offline, error JSON, malformed output, spawn failure)
 *      the script exits 1 with "audit unavailable: <reason>". It never reports "clean" for an audit that did not run.
 *    - Works from an npm workspace package directory: npm resolves the root lockfile itself.
 */

const ROOT = process.cwd();
const pkgPath = path.join(ROOT, 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.log('⏭️  Skipping dependency check (no package.json found).');
  process.exit(0);
}

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type PackageJson = Partial<Record<(typeof DEP_SECTIONS)[number], Record<string, string>>>;

let pkg: PackageJson;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error('top-level value is not an object');
  }
} catch (err: unknown) {
  console.error(
    `❌ Cannot read package.json: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

const directNames = new Set<string>();
for (const section of DEP_SECTIONS) {
  for (const name of Object.keys(pkg[section] ?? {})) directNames.add(name);
}

const hardErrors: string[] = [];
const advisories: string[] = [];
const acknowledgedNotes: string[] = [];

const depConfig = guardrailsConfig.dependencies ?? {
  failOnVulnerabilitySeverity: 'high',
  failOnOutdated: true,
  acknowledgedAdvisories: [],
  bannedPackages: [],
};

const acknowledgedOutdated = new Map<string, string>();
// Keyed by `${package}|${GHSA-ID upper-cased}`
const acknowledgedCveIds = new Map<string, string>();
const ackKey = (pkgName: string, ghsa: string) => `${pkgName}|${ghsa.toUpperCase()}`;
const GHSA_RE = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

for (const entry of depConfig.acknowledgedAdvisories ?? []) {
  if (!entry.reason || entry.reason.trim().length < 12) {
    hardErrors.push(
      `[Invalid Dependency Exception] guardrails.config.ts -> dependencies.acknowledgedAdvisories entry for "${entry.package}" must include a specific engineering \`reason\` (>= 12 chars).`
    );
    continue;
  }
  if (entry.kind === 'cve') {
    if (!entry.ghsaId || !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(entry.ghsaId)) {
      hardErrors.push(
        `[Invalid CVE Exception] guardrails.config.ts -> dependencies.acknowledgedAdvisories entry for "${entry.package}" with kind="cve" MUST specify a valid \`ghsaId\` (e.g. "GHSA-xxxx-xxxx-xxxx"). Blanket package-level CVE suppression is forbidden.`
      );
      continue;
    }
    acknowledgedCveIds.set(
      ackKey(entry.package, entry.ghsaId),
      `${entry.package}: ${entry.reason.trim()}`
    );
  } else if (entry.kind === 'outdated') {
    acknowledgedOutdated.set(entry.package, entry.reason.trim());
  } else {
    hardErrors.push(
      `[Invalid Dependency Exception] Entry for "${entry.package}" must specify \`kind: 'outdated' | 'cve'\`.`
    );
  }
}

// --- TIER 1: Fast Local Package Hygiene ---
/** Splits an `npm:target@range` alias spec; non-alias specs resolve to the declared name. */
function resolveAlias(name: string, spec: string): { target: string; range: string } {
  const trimmed = spec.trim();
  if (!trimmed.startsWith('npm:')) return { target: name, range: trimmed };
  const body = trimmed.slice(4);
  const at = body.lastIndexOf('@');
  return at > 0
    ? { target: body.slice(0, at), range: body.slice(at + 1) }
    : { target: body, range: '' };
}

// Each section is evaluated on its own so a devDependency cannot mask a runtime declaration.
for (const section of DEP_SECTIONS) {
  for (const [name, rawSpec] of Object.entries(pkg[section] ?? {})) {
    const spec = String(rawSpec);
    const { target, range } = resolveAlias(name, spec);
    const banned = depConfig.bannedPackages.find((b) => b.name === name || b.name === target);
    if (banned) {
      const alias = target !== name ? ` (alias of "${target}")` : '';
      hardErrors.push(
        `[Banned Legacy Dependency] "${name}"${alias} (${spec}) is declared in ${section}. Use ${banned.replacement} instead.`
      );
    }
    const wildcard = range.toLowerCase();
    if (wildcard === '*' || wildcard === 'latest') {
      hardErrors.push(
        `[Unpinned Dependency Version] "${name}": "${spec}" in ${section} uses a wildcard. Pin a semver range (e.g. "^1.0.0").`
      );
    }
  }
}

// --- TIER 2: Diff-Aware or Explicit Security & Freshness Audit ---
const runRegistryAudit = process.argv.includes('--audit') || process.argv.includes('--all');

type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

interface NpmAuditVia {
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
}

interface NpmAuditVulnerability {
  name: string;
  severity: Severity;
  isDirect: boolean;
  via: Array<string | NpmAuditVia>;
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

interface NpmAuditReport {
  error?: { code?: string; summary?: string; detail?: string };
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  dependent?: string;
}

interface Leaf {
  pkg: string;
  title: string;
  url: string;
  severity: string;
  ghsa?: string;
}

const SEVERITY_RANK: Record<string, number> = {
  none: 99,
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const NPM_TIMEOUT_MS = 120_000;
const NPM_MAX_BUFFER = 64 * 1024 * 1024;

type NpmResult = { ok: true; stdout: string; status: number | null } | { ok: false; reason: string };

function runNpm(args: string[]): NpmResult {
  const r = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NPM_TIMEOUT_MS,
    maxBuffer: NPM_MAX_BUFFER,
    shell: process.platform === 'win32',
  });
  if (r.error) {
    return { ok: false, reason: `\`npm ${args.join(' ')}\` could not run (${r.error.message})` };
  }
  return { ok: true, stdout: r.stdout ?? '', status: r.status };
}

function describeNpmError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { code?: string; summary?: string };
    return [e.code, e.summary].filter(Boolean).join(': ') || JSON.stringify(error);
  }
  return String(error);
}

/** Resolves string `via` chains (npm audit v2) to leaf advisories. `seen` guards against cycles. */
function resolveLeaves(
  name: string,
  vulns: Record<string, NpmAuditVulnerability>,
  seen: Set<string>
): Leaf[] {
  const vuln = vulns[name];
  if (!vuln || seen.has(name)) return [];
  seen.add(name);
  const leaves: Leaf[] = [];
  for (const via of vuln.via ?? []) {
    if (typeof via === 'string') {
      if (vulns[via]) {
        leaves.push(...resolveLeaves(via, vulns, seen));
      } else {
        leaves.push({
          pkg: via,
          title: `unresolved advisory source "${via}"`,
          url: '',
          severity: vuln.severity,
        });
      }
    } else if (via && typeof via === 'object') {
      leaves.push({
        pkg: via.name ?? vuln.name ?? name,
        title: via.title ?? 'untitled advisory',
        url: via.url ?? '',
        severity: via.severity ?? vuln.severity,
        ghsa: via.url?.match(GHSA_RE)?.[0]?.toUpperCase(),
      });
    }
  }
  return leaves;
}

let auditRan = false;
let outdatedRan = false;

if (runRegistryAudit) {
  // 2A. Security Audit (`npm audit --json`). Exit 1 with a JSON report is normal when vulnerabilities exist.
  const audit = runNpm(['audit', '--json']);
  let report: NpmAuditReport | undefined;
  let auditFailure = '';

  if (!audit.ok) {
    auditFailure = audit.reason;
  } else if (!audit.stdout.trim()) {
    auditFailure = `\`npm audit --json\` produced no output (exit ${audit.status})`;
  } else {
    try {
      report = JSON.parse(audit.stdout) as NpmAuditReport;
    } catch {
      auditFailure = `\`npm audit --json\` returned malformed JSON (exit ${audit.status})`;
    }
  }
  if (report) {
    if (report === null || typeof report !== 'object') {
      auditFailure = 'npm audit returned an unexpected report';
    } else if (report.error) {
      auditFailure = describeNpmError(report.error);
    } else if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
      auditFailure = 'npm audit report has no `vulnerabilities` section';
    }
  }

  if (auditFailure || !report?.vulnerabilities) {
    hardErrors.push(`[Audit Unavailable] audit unavailable: ${auditFailure}`);
  } else {
    auditRan = true;
    const vulns = report.vulnerabilities;
    const failRank = SEVERITY_RANK[depConfig.failOnVulnerabilitySeverity] ?? 3;
    const usedAckKeys = new Set<string>();
    const graphPackages = new Set<string>(Object.keys(vulns));

    for (const vuln of Object.values(vulns)) {
      let leaves = resolveLeaves(vuln.name, vulns, new Set());
      if (leaves.length === 0) {
        leaves = [
          { pkg: vuln.name, title: 'no advisory details reported', url: '', severity: vuln.severity },
        ];
      }

      const remaining: Leaf[] = [];
      for (const leaf of leaves) {
        graphPackages.add(leaf.pkg);
        const key = leaf.ghsa ? ackKey(leaf.pkg, leaf.ghsa) : undefined;
        if (key && acknowledgedCveIds.has(key)) {
          usedAckKeys.add(key);
          acknowledgedNotes.push(`[Acknowledged CVE ${leaf.ghsa}] ${acknowledgedCveIds.get(key)}`);
        } else {
          remaining.push(leaf);
        }
      }
      // A transitive entry is acknowledged only when every reachable leaf advisory is.
      if (remaining.length === 0) continue;

      const rank = Math.max(
        ...remaining.map((l) => SEVERITY_RANK[l.severity] ?? SEVERITY_RANK[vuln.severity] ?? 0)
      );
      if (rank < SEVERITY_RANK.moderate) continue;

      const titles = remaining.map(
        (l) =>
          `${l.title}${l.url ? ` (${l.url})` : ''}${l.pkg !== vuln.name ? ` via "${l.pkg}"` : ''}`
      );
      const detail =
        titles.slice(0, 2).join('; ') +
        (titles.length > 2 ? ` (+${titles.length - 2} more CVEs)` : '');

      const fixNote =
        typeof vuln.fixAvailable === 'object' && vuln.fixAvailable
          ? `Fix available via \`npm install ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}\`${vuln.fixAvailable.isSemVerMajor ? ' (major upgrade)' : ''}`
          : vuln.fixAvailable
            ? 'Fix available via `npm audit fix`'
            : 'No automatic upstream fix available yet';

      const severityLabel =
        Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === rank && k !== 'none') ??
        vuln.severity;
      const msg = `[Security CVE: ${severityLabel.toUpperCase()}] Package "${vuln.name}" (${vuln.isDirect ? 'direct' : 'transitive'}) — ${detail}. ${fixNote}.`;

      if (rank >= failRank) {
        hardErrors.push(msg);
      } else {
        advisories.push(msg);
      }
    }

    for (const [key, note] of acknowledgedCveIds) {
      if (usedAckKeys.has(key)) continue;
      const [ackPkg, ghsa] = key.split('|');
      advisories.push(
        graphPackages.has(ackPkg)
          ? `[Stale CVE Exception] ${ghsa} for "${ackPkg}" matches no current advisory (${note}). Remove it from guardrails.config.ts.`
          : `[Stale CVE Exception] "${ackPkg}" (${ghsa}) is not in the audit graph (${note}). Remove it from guardrails.config.ts.`
      );
    }
  }

  // 2B. Outdated Direct Dependencies (`npm outdated --json`). Exit 1 with JSON is normal when packages are outdated.
  const outdatedRes = runNpm(['outdated', '--json']);
  let outdated: Record<string, NpmOutdatedEntry | NpmOutdatedEntry[]> | undefined;
  let outdatedFailure = '';

  if (!outdatedRes.ok) {
    outdatedFailure = outdatedRes.reason;
  } else if (!outdatedRes.stdout.trim()) {
    if (outdatedRes.status === 0) {
      outdated = {};
    } else {
      outdatedFailure = `\`npm outdated --json\` produced no output (exit ${outdatedRes.status})`;
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(outdatedRes.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        outdatedFailure = '`npm outdated --json` returned an unexpected report';
      } else if ('error' in parsed) {
        outdatedFailure = describeNpmError((parsed as { error: unknown }).error);
      } else {
        outdated = parsed as Record<string, NpmOutdatedEntry | NpmOutdatedEntry[]>;
      }
    } catch {
      outdatedFailure = `\`npm outdated --json\` returned malformed JSON (exit ${outdatedRes.status})`;
    }
  }

  if (outdatedFailure || !outdated) {
    hardErrors.push(`[Outdated Check Unavailable] audit unavailable: ${outdatedFailure}`);
  } else {
    outdatedRan = true;
    for (const [name, rawInfo] of Object.entries(outdated)) {
      for (const info of Array.isArray(rawInfo) ? rawInfo : [rawInfo]) {
        const ackReason = acknowledgedOutdated.get(name);
        if (!info.current) {
          const msg = `[Dependency Not Installed] "${name}" is declared but not installed (wanted ${info.wanted ?? 'unknown'}, latest ${info.latest ?? 'unknown'}). Run \`npm install\` so it can be audited.`;
          if (ackReason) {
            acknowledgedNotes.push(`[Acknowledged Version Pin] "${name}" (not installed): ${ackReason}`);
          } else if (depConfig.failOnOutdated) {
            hardErrors.push(msg);
          } else {
            advisories.push(msg);
          }
        } else if (info.latest && info.current !== info.latest) {
          const msg = `[Outdated Direct Dependency] "${name}" is at ${info.current} (latest stable: ${info.latest}). Run \`npm install ${name}@latest\`.`;
          if (ackReason) {
            acknowledgedNotes.push(
              `[Acknowledged Version Pin] "${name}" (${info.current} vs latest ${info.latest}): ${ackReason}`
            );
          } else if (depConfig.failOnOutdated) {
            hardErrors.push(msg);
          } else {
            advisories.push(msg);
          }
        }
      }
    }
  }
}

const uniqueNotes = Array.from(new Set(acknowledgedNotes));
if (uniqueNotes.length > 0) {
  console.log(`\nℹ️  [Acknowledged Dependency Exceptions] (${uniqueNotes.length}):`);
  for (const note of uniqueNotes) {
    console.log(`  • ${note}`);
  }
}

if (advisories.length > 0) {
  console.log(
    `\n🛡️  [Dependency Advisories: moderate or higher below the failure threshold, and notes] (${advisories.length}):`
  );
  for (const adv of advisories) {
    console.log(`  • ${adv}`);
  }
  console.log('');
}

if (hardErrors.length > 0) {
  console.error(
    `\n❌ Dependency Security & Freshness Guardrail Failed (${hardErrors.length} unacknowledged issue(s)):\n`
  );
  for (const err of hardErrors) {
    console.error(`  • ${err}`);
  }
  console.error(
    '\n🔧 Mandatory Resolution Protocol (DO NOT SELF-EXEMPT):\n' +
      '  1. You MUST actually attempt to upgrade the outdated/vulnerable packages in `package.json` (`npm install <pkg>@latest`) and verify if `npm run build` and `npm run guardrails` pass.\n' +
      '  2. FORBIDDEN SHORTCUT: Do NOT add entries to `guardrails.config.ts -> dependencies.acknowledgedAdvisories` without testing the upgrade first. Version pins (`kind: "outdated"`) NEVER silence security CVEs (`kind: "cve"`, which require an explicit `ghsaId` and human approval).\n' +
      '  3. If an upgrade empirically fails during `npm install` or `npm run build`, revert only the broken package upgrade and explicitly warn the user with the exact compiler/peer error and every unresolved CRITICAL/HIGH CVE.\n' +
      '  4. If the audit is unavailable (no lockfile, offline, registry error), restore the prerequisite (`npm install` to create the lockfile, network access) and re-run; an unavailable audit is never treated as clean.\n'
  );
  process.exit(1);
}

console.log(
  `✅ Dependency Guardrail Passed (${directNames.size} direct packages checked${auditRan && outdatedRan ? ' + registry CVE & freshness audit clean' : ''}).`
);
