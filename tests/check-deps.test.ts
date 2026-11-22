import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeProject, type Project } from './helpers.ts';

const GHSA = 'GHSA-abcd-1234-wxyz';
const GHSA2 = 'GHSA-efgh-5678-qrst';
const advisory = (name: string, ghsa: string, severity: string) => ({
  source: 1,
  name,
  title: `Problem in ${name}`,
  url: `https://github.com/advisories/${ghsa}`,
  severity,
});

/** Installs a fake `npm` first on PATH that replays `<cmd>.out` / `<cmd>.code` fixtures. */
function fakeNpm(
  p: Project,
  fixtures: { audit?: unknown; auditCode?: number; outdated?: unknown; outdatedCode?: number }
): NodeJS.ProcessEnv {
  const fixDir = path.join(p.dir, 'fixtures');
  fs.mkdirSync(fixDir, { recursive: true });
  const put = (cmd: string, body: unknown, code: number) => {
    if (body !== undefined) {
      fs.writeFileSync(path.join(fixDir, `${cmd}.out`), typeof body === 'string' ? body : JSON.stringify(body));
    }
    fs.writeFileSync(path.join(fixDir, `${cmd}.code`), String(code));
  };
  put('audit', fixtures.audit, fixtures.auditCode ?? 0);
  put('outdated', fixtures.outdated ?? {}, fixtures.outdatedCode ?? 0);
  const bin = path.join(p.dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh\ncat "${fixDir}/$1.out" 2>/dev/null\nexit "$(cat "${fixDir}/$1.code")"\n`,
    { mode: 0o755 }
  );
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

function acknowledge(p: Project, entries: object[]): void {
  const cfgPath = path.join(p.dir, 'guardrails.config.ts');
  const cfg = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(cfg.includes('acknowledgedAdvisories: [],'));
  p.write(
    'guardrails.config.ts',
    cfg.replace('acknowledgedAdvisories: [],', `acknowledgedAdvisories: ${JSON.stringify(entries)},`)
  );
}

function withProject(
  packageJson: object,
  fn: (p: Project) => void
): void {
  const p = makeProject({ packageJson });
  try {
    fn(p);
  } finally {
    p.cleanup();
  }
}

const pkg = { name: 'fixture', dependencies: { foo: '^1.0.0' } };

test('--audit fails closed when the audit cannot run', () => {
  withProject(pkg, (p) => {
    const env = fakeNpm(p, {
      audit: { error: { code: 'ENOLOCK', summary: 'audit requires a lockfile' } },
      auditCode: 1,
    });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 1);
    assert.match(r.output, /audit unavailable: ENOLOCK/);
    assert.doesNotMatch(r.output, /audit clean/);
  });
  withProject(pkg, (p) => {
    const env = fakeNpm(p, { audit: 'not json', auditCode: 0 });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 1);
    assert.match(r.output, /audit unavailable: .*malformed/);
  });
});

test('--audit passes and reports clean only when both checks ran', () => {
  withProject(pkg, (p) => {
    const env = fakeNpm(p, { audit: { vulnerabilities: {} } });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /audit clean/);
  });
});

test('transitive entries are acknowledged only when all leaf advisories are (lowercase GHSA accepted)', () => {
  const vuln = (via: unknown[]) => ({
    vulnerabilities: {
      lib: { name: 'lib', severity: 'high', isDirect: false, via: [advisory('lib', GHSA, 'high')], fixAvailable: false },
      lib2: { name: 'lib2', severity: 'moderate', isDirect: false, via: [advisory('lib2', GHSA2, 'moderate')], fixAvailable: false },
      parent: { name: 'parent', severity: 'high', isDirect: true, via, fixAvailable: false },
    },
  });
  const ack = [{ package: 'lib', kind: 'cve', ghsaId: GHSA.toLowerCase(), reason: 'no upstream fix yet' }];

  // Only the high advisory is acknowledged; the moderate leftover is below the threshold.
  withProject(pkg, (p) => {
    acknowledge(p, ack);
    const env = fakeNpm(p, { audit: vuln(['lib', 'lib2', 'parent']), auditCode: 1 });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /Acknowledged CVE GHSA-ABCD-1234-WXYZ/);
    assert.match(r.output, /Acknowledged Dependency Exceptions\] \(1\)/);
  });

  // Same graph with nothing acknowledged still fails.
  withProject(pkg, (p) => {
    const env = fakeNpm(p, { audit: vuln(['lib']), auditCode: 1 });
    assert.equal(p.run('check-deps.ts', ['--audit'], env).status, 1);
  });

  // A parent reaching an unacknowledged high leaf stays a failure.
  withProject(pkg, (p) => {
    acknowledge(p, ack);
    const report = vuln(['lib', 'lib3']);
    (report.vulnerabilities as Record<string, unknown>).lib3 = {
      name: 'lib3', severity: 'high', isDirect: false, via: [advisory('lib3', 'GHSA-zzzz-0000-aaaa', 'high')], fixAvailable: false,
    };
    const env = fakeNpm(p, { audit: report, auditCode: 1 });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 1);
    assert.match(r.output, /Package "parent"/);
  });
});

test('stale exception for a package outside the audit graph is a note, not an error', () => {
  withProject(pkg, (p) => {
    acknowledge(p, [{ package: 'gone', kind: 'cve', ghsaId: GHSA, reason: 'was needed before' }]);
    const env = fakeNpm(p, { audit: { vulnerabilities: {} } });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /not in the audit graph/);
  });
});

test('npm alias to a banned package is rejected, including in optionalDependencies', () => {
  withProject({ name: 'fixture', optionalDependencies: { http: 'npm:axios@^1.0.0' } }, (p) => {
    const r = p.run('check-deps.ts');
    assert.equal(r.status, 1);
    assert.match(r.output, /Banned Legacy Dependency.*alias of "axios"/);
  });
});

test('a devDependency does not mask a wildcard runtime declaration', () => {
  withProject(
    { name: 'fixture', dependencies: { foo: '*' }, devDependencies: { foo: '^1.0.0' } },
    (p) => {
      const r = p.run('check-deps.ts');
      assert.equal(r.status, 1);
      assert.match(r.output, /"foo": "\*" in dependencies/);
    }
  );
});

test('outdated entries without `current` are reported as not installed', () => {
  withProject(pkg, (p) => {
    const env = fakeNpm(p, {
      audit: { vulnerabilities: {} },
      outdated: { foo: { wanted: '1.2.0', latest: '1.2.0' } },
      outdatedCode: 1,
    });
    const r = p.run('check-deps.ts', ['--audit'], env);
    assert.equal(r.status, 1);
    assert.match(r.output, /Dependency Not Installed.*"foo"/);
  });
});
