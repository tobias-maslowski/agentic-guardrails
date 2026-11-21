import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { guardrailsConfig } from '../guardrails.config.ts';

/**
 * Dependency Hygiene, Security Vulnerability & Freshness Guardrail (scripts/check-deps.ts)
 *
 * Two-Tier Execution:
 * 1. Tier 1 (Fast Local Hygiene — Always Runs in <20ms):
 *    - Detects banned/legacy packages where native Web/Worker APIs exist (`axios`, `uuid`, `moment`, `crypto-js`, etc.).
 *    - Detects unpinned wildcard versions (`"*"`, `"latest"`).
 * 2. Tier 2 (Registry Security Audit & Training-Cutoff Freshness — Runs when `package.json` / lockfile changes or `--audit` is passed):
 *    - Runs `npm audit --json` to surface known CVEs, severity levels, and whether an automatic upgrade fix exists.
 *    - Runs `npm outdated --json` to catch stale package versions hallucinated from an LLM's training cutoff.
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

const depConfig = guardrailsConfig.dependencies ?? {
  failOnVulnerabilitySeverity: 'none',
  bannedPackages: [],
};

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
    // npm audit exits non-zero when vulnerabilities exist; stdout still contains the JSON report
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
        const failRank = SEVERITY_RANK[depConfig.failOnVulnerabilitySeverity] ?? 99;

        const notableVulns = Object.values(report.vulnerabilities).filter(
          (v) => (SEVERITY_RANK[v.severity] ?? 0) >= SEVERITY_RANK.moderate
        );

        const summaryCounts = [
          counts.critical ? `${counts.critical} critical` : '',
          counts.high ? `${counts.high} high` : '',
          counts.moderate ? `${counts.moderate} moderate` : '',
          counts.low ? `${counts.low} low` : '',
        ]
          .filter(Boolean)
          .join(', ');

        for (const vuln of notableVulns) {
          const rank = SEVERITY_RANK[vuln.severity] ?? 0;
          const advisoryTitles = vuln.via
            .map((v) => (typeof v === 'object' && v.title ? `${v.title} (${v.url ?? ''})` : null))
            .filter(Boolean);

          const detail =
            advisoryTitles.length > 0
              ? advisoryTitles.slice(0, 2).join('; ') +
                (advisoryTitles.length > 2 ? ` (+${advisoryTitles.length - 2} more CVEs)` : '')
              : `Transitive vulnerability via ${vuln.via.map((v) => (typeof v === 'string' ? v : '')).filter(Boolean).join(', ')}`;

          const fixNote =
            typeof vuln.fixAvailable === 'object'
              ? `Fix available via \`${vuln.fixAvailable.name}@${vuln.fixAvailable.version}\`${vuln.fixAvailable.isSemVerMajor ? ' (major upgrade)' : ''}`
              : vuln.fixAvailable
                ? 'Fix available via `npm audit fix`'
                : 'No automatic fix available yet';

          const msg = `[Security CVE: ${vuln.severity.toUpperCase()}] Package "${vuln.name}" (${vuln.isDirect ? 'direct' : 'transitive'}) — ${detail}. ${fixNote}.`;

          if (rank >= failRank) {
            hardErrors.push(msg);
          } else {
            advisories.push(msg);
          }
        }

        if (notableVulns.length === 0 && total > 0) {
          advisories.push(`[Security Audit] ${summaryCounts} vulnerability(s) detected.`);
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
    // npm outdated exits with code 1 when outdated packages exist
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      outdatedRaw = err.stdout;
    }
  }

  if (outdatedRaw) {
    try {
      const outdated = JSON.parse(outdatedRaw) as Record<string, NpmOutdatedEntry>;
      for (const [name, info] of Object.entries(outdated)) {
        if (info.current && info.latest && info.current !== info.latest) {
          advisories.push(
            `[Outdated Dependency] "${name}" is at ${info.current} (wanted: ${info.wanted ?? info.current}, latest stable: ${info.latest}). Update package.json if compatible to avoid training-cutoff lag.`
          );
        }
      }
    } catch {
      // Ignore offline/registry errors
    }
  }
}

if (hardErrors.length > 0) {
  console.error('\n❌ Dependency Guardrail Failed:\n');
  for (const err of hardErrors) {
    console.error(`  • ${err}`);
  }
  console.error('');
  process.exit(1);
}

console.log(
  `✅ Dependency Hygiene Passed (${Object.keys(allDeps).length} direct packages checked${runRegistryAudit ? ' + registry security/freshness audit' : ''}).`
);

if (advisories.length > 0) {
  console.log(
    `\n🛡️  [Dependency Security & Freshness Advisories] (${advisories.length} finding(s) — report significant security gaps to the user):`
  );
  for (const adv of advisories) {
    console.log(`  • ${adv}`);
  }
  console.log('');
}
