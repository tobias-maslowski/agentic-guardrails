import { execSync } from 'node:child_process';
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
 */

const ROOT = process.cwd();
const pkgPath = path.join(ROOT, 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.log('⏭️  Skipping dependency check (no package.json found).');
  process.exit(0);
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
const allDeps: Record<string, string> = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};

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
const acknowledgedCveIds = new Map<string, string>();

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
    acknowledgedCveIds.set(entry.ghsaId, `${entry.package}: ${entry.reason.trim()}`);
  } else if (entry.kind === 'outdated') {
    acknowledgedOutdated.set(entry.package, entry.reason.trim());
  } else {
    hardErrors.push(
      `[Invalid Dependency Exception] Entry for "${entry.package}" must specify \`kind: 'outdated' | 'cve'\`.`
    );
  }
}

// --- TIER 1: Fast Local Package Hygiene ---
for (const banned of depConfig.bannedPackages) {
  if (allDeps[banned.name]) {
    hardErrors.push(
      `[Banned Legacy Dependency] "${banned.name}" (${allDeps[banned.name]}) is installed. Use ${banned.replacement} instead.`
    );
  }
}

for (const [name, versionRange] of Object.entries(allDeps)) {
  const trimmed = versionRange.trim().toLowerCase();
  if (trimmed === '*' || trimmed === 'latest') {
    hardErrors.push(
      `[Unpinned Dependency Version] "${name}": "${versionRange}" uses a wildcard. Pin a semver range (e.g. "^1.0.0").`
    );
  }
}

// --- TIER 2: Diff-Aware or Explicit Security & Freshness Audit ---
const runRegistryAudit = process.argv.includes('--audit') || process.argv.includes('--all');

interface NpmAuditVulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  isDirect: boolean;
  via: Array<string | { title?: string; url?: string; severity?: string }>;
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: {
      info?: number;
      low?: number;
      moderate?: number;
      high?: number;
      critical?: number;
      total?: number;
    };
  };
}

interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  dependent?: string;
}

const SEVERITY_RANK: Record<string, number> = {
  none: 99,
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

if (runRegistryAudit) {
  // 2A. Security Audit (`npm audit --json`)
  let auditJsonRaw = '';
  try {
    auditJsonRaw = execSync('npm audit --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      auditJsonRaw = err.stdout;
    }
  }

  if (auditJsonRaw) {
    try {
      const report = JSON.parse(auditJsonRaw) as NpmAuditReport;
      const counts = report.metadata?.vulnerabilities ?? {};
      const total = counts.total ?? 0;

      if (total > 0 && report.vulnerabilities) {
        const failRank = SEVERITY_RANK[depConfig.failOnVulnerabilitySeverity] ?? 3;

        const notableVulns = Object.values(report.vulnerabilities).filter(
          (v) => (SEVERITY_RANK[v.severity] ?? 0) >= SEVERITY_RANK.moderate
        );

        for (const vuln of notableVulns) {
          const rank = SEVERITY_RANK[vuln.severity] ?? 0;
          const directAdvisories = vuln.via.filter(
            (v): v is { title?: string; url?: string; severity?: string } =>
              typeof v === 'object' && v !== null && Boolean(v.title)
          );

          // Check if every direct GHSA ID on this package has been explicitly acknowledged
          const ghsaIds = directAdvisories
            .map((v) => v.url?.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0])
            .filter((id): id is string => Boolean(id));

          const unacknowledgedAdvisories = directAdvisories.filter((v) => {
            const id = v.url?.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0];
            return !id || !acknowledgedCveIds.has(id);
          });

          for (const id of ghsaIds) {
            if (acknowledgedCveIds.has(id)) {
              acknowledgedNotes.push(`[Acknowledged CVE ${id}] ${acknowledgedCveIds.get(id)}`);
            }
          }

          if (directAdvisories.length > 0 && unacknowledgedAdvisories.length === 0) {
            continue;
          }

          const advisoryTitles = unacknowledgedAdvisories.map(
            (v) => `${v.title} (${v.url ?? ''})`
          );

          const detail =
            advisoryTitles.length > 0
              ? advisoryTitles.slice(0, 2).join('; ') +
                (advisoryTitles.length > 2 ? ` (+${advisoryTitles.length - 2} more CVEs)` : '')
              : `Transitive vulnerability via ${vuln.via.map((v) => (typeof v === 'string' ? v : '')).filter(Boolean).join(', ')}`;

          const fixNote =
            typeof vuln.fixAvailable === 'object'
              ? `Fix available via \`npm install ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}\`${vuln.fixAvailable.isSemVerMajor ? ' (major upgrade)' : ''}`
              : vuln.fixAvailable
                ? 'Fix available via `npm audit fix`'
                : 'No automatic upstream fix available yet';

          const msg = `[Security CVE: ${vuln.severity.toUpperCase()}] Package "${vuln.name}" (${vuln.isDirect ? 'direct' : 'transitive'}) — ${detail}. ${fixNote}.`;

          if (rank >= failRank) {
            hardErrors.push(msg);
          } else {
            advisories.push(msg);
          }
        }
      }
    } catch {
      // Ignore malformed audit JSON if offline
    }
  }

  // 2B. Outdated Direct Dependencies (`npm outdated --json`)
  let outdatedRaw = '';
  try {
    outdatedRaw = execSync('npm outdated --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      outdatedRaw = err.stdout;
    }
  }

  if (outdatedRaw) {
    try {
      const outdated = JSON.parse(outdatedRaw) as Record<string, NpmOutdatedEntry>;
      for (const [name, info] of Object.entries(outdated)) {
        if (info.current && info.latest && info.current !== info.latest) {
          const ackReason = acknowledgedOutdated.get(name);
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
    } catch {
      // Ignore offline/registry errors
    }
  }
}

if (acknowledgedNotes.length > 0) {
  console.log(`\nℹ️  [Acknowledged Dependency Exceptions] (${acknowledgedNotes.length}):`);
  for (const note of Array.from(new Set(acknowledgedNotes))) {
    console.log(`  • ${note}`);
  }
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
      '  3. If an upgrade empirically fails during `npm install` or `npm run build`, revert only the broken package upgrade and explicitly warn the user with the exact compiler/peer error and every unresolved CRITICAL/HIGH CVE.\n'
  );
  process.exit(1);
}

console.log(
  `✅ Dependency Guardrail Passed (${Object.keys(allDeps).length} direct packages checked${runRegistryAudit ? ' + registry CVE & freshness audit clean' : ''}).`
);

if (advisories.length > 0) {
  console.log(`\n🛡️  [Low/Moderate Dependency Advisories] (${advisories.length}):`);
  for (const adv of advisories) {
    console.log(`  • ${adv}`);
  }
  console.log('');
}
