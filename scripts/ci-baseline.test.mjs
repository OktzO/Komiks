import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ci-baseline.mjs', import.meta.url));

function run({ input, allowlist = '' }) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, allowlist], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stderr: String(err.stderr) };
  }
}

const red = (s) => `\x1b[91m${s}\x1b[0m`;
const report = (...positions) =>
  positions.map((p) => `${red(p)}:47 - error ts(2345): bad\n`).join('') +
  `${red('Result (98 files):')}\n${red('- 1 error')}\n- 0 warnings\n`;

test('passes when the reported errors are exactly the allowlist', () => {
  const r = run({ input: report('src/a.tsx:5'), allowlist: 'src/a.tsx:5' });
  assert.equal(r.code, 0, r.stderr);
});

test('passes on a clean run against an empty allowlist', () => {
  const r = run({ input: report() });
  assert.equal(r.code, 0, r.stderr);
});

test('fails on an error outside the allowlist', () => {
  const r = run({ input: report('src/a.tsx:5', 'src/b.tsx:9'), allowlist: 'src/a.tsx:5' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NEW error — src\/b\.tsx:9/);
});

test('fails when an allowlisted error is fixed, so the list cannot grow stale', () => {
  const r = run({ input: report('src/a.tsx:5'), allowlist: 'src/a.tsx:5|src/gone.tsx:2' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FIXED, drop from the allowlist — src\/gone\.tsx:2/);
});

test('fails when the report is missing, so a dead runner cannot read as clean', () => {
  const r = run({ input: 'error: command failed with exit code 1\n', allowlist: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not run to completion/);
});

test('two errors in one file are pinned separately, and a repeat is counted once', () => {
  assert.equal(run({ input: report('src/a.tsx:5', 'src/a.tsx:9'), allowlist: 'src/a.tsx:5' }).code, 1);
  assert.equal(run({ input: report('src/a.tsx:5'), allowlist: 'src/a.tsx:5|src/a.tsx:9' }).code, 1);
  assert.equal(run({ input: report('src/a.tsx:5', 'src/a.tsx:5'), allowlist: 'src/a.tsx:5' }).code, 0);
});
