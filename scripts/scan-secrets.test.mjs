// Zero-dependency unit tests for the secret scanner. `scan` is pure so these
// run without touching the filesystem, except for the two regression guards
// that read real committed files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, scanTree } from './scan-secrets.mjs';

// Fixture literals below carry `noqa:secretscan`: they are fake credentials, and
// that marker is the scanner's sanctioned way to say so. The marker is matched
// per line of the text handed to scan(), so it never reaches these assertions.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesOf = (text) => scan(text).map((f) => f.rule);
const CF = 'CLOUDFLARE_API_TOKEN=cfut_Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgH'; // noqa:secretscan
const GCS = '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'; // noqa:secretscan

const withTree = (files, fn) => {
  const root = mkdtempSync(join(tmpdir(), 'scan-secrets-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('flags a Cloudflare API token assigned to a known key name', () => {
  const text = 'CLOUDFLARE_API_TOKEN=cfut_Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgH\n'; // noqa:secretscan
  assert.deepEqual(rulesOf(text), ['cloudflare-api-token']);
  const json = '{ "CF_API_TOKEN": "cfut_Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgH" }\n'; // noqa:secretscan
  assert.deepEqual(rulesOf(json), ['cloudflare-api-token']);
});

test('flags a Google OAuth client secret', () => {
  const text = 'client_secret: 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\n'; // noqa:secretscan
  assert.deepEqual(rulesOf(text), ['google-oauth-client-secret']);
});

test('flags a generic sk- key', () => {
  const text = 'export OPENAI_KEY=sk-Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgHiJkLmNoPqRsTu\n'; // noqa:secretscan
  assert.deepEqual(rulesOf(text), ['sk-key']);
});

test('flags a PEM private key block', () => {
  assert.deepEqual(rulesOf('-----BEGIN RSA PRIVATE KEY-----\n'), ['private-key-block']); // noqa:secretscan
  assert.deepEqual(rulesOf('-----BEGIN PRIVATE KEY-----\n'), ['private-key-block']); // noqa:secretscan
});

test('reports 1-based line numbers and the file label', () => {
  const [finding] = scan('\n\nCLOUDFLARE_API_TOKEN=cfut_Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgH\n', 'x.toml'); // noqa:secretscan
  assert.equal(finding.line, 3);
  assert.equal(finding.file, 'x.toml');
});

test('redacts the secret in the finding so CI logs do not re-leak it', () => {
  const secret = 'cfut_Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgH'; // noqa:secretscan
  const [finding] = scan(`CLOUDFLARE_API_TOKEN=${secret}\n`); // noqa:secretscan
  assert.ok(!finding.match.includes(secret), 'raw secret leaked into finding.match');
  assert.match(finding.match, /…/);
});

test('ignores lines marked noqa:secretscan, including inside fenced code blocks', () => {
  const text = [
    '```sh',
    'export CLOUDFLARE_API_TOKEN=cfut_Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgH # noqa:secretscan',
    '```',
    '',
  ].join('\n');
  assert.deepEqual(scan(text), []);
});

test('a bare 40-char run and a long hash are not findings', () => {
  // A lockfile, a design doc and an account-id table are full of exactly this
  // shape. Matching it would be the noise that gets this gate switched off, so
  // the 40-char length bound has to stay anchored to a known key name.
  const bare40 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4'; // noqa:secretscan
  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(bare40.length, 40);
  assert.equal(digest.length, 64);
  const doc = [
    '# Novel module design',
    '',
    'Account id 9befea142865276dab131815c729cd8f and digest',
    `${digest} are identifiers,`,
    `not credentials, and neither is this run: ${bare40}`,
    'The deploy token is written `cfut_<REDACTED>` in this repo.',
    '',
  ].join('\n');
  assert.deepEqual(scan(doc), []);
});

test('lockfile integrity hashes and git SHAs are not findings', () => {
  // Real npm lock shapes: an 88-char base64 digest under "integrity", a 40-char
  // sha1 from a v1 lockfile, and a 40-char commit SHA in a resolved URL. All
  // three are key-shaped to a rule that matches bare 40-char runs.
  const integrity = 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==';
  const sha1 = 'sha1-1e0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d'; // noqa:secretscan
  const lock = JSON.stringify(
    {
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/left-pad': {
          version: '1.3.0',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
          integrity,
        },
        'node_modules/legacy': { version: '0.1.0', integrity: sha1 },
        'node_modules/from-git': {
          version: '1.0.0',
          resolved: 'git+ssh://git@github.com/acme/thing.git#e3b0c44298fc1c149afbf4c8996fb92427ae41e4',
        },
      },
    },
    null,
    2
  );
  assert.equal(integrity.length, 95, 'sha512- (7) plus an 88-char digest');
  assert.equal(sha1.length, 45, 'sha1- plus a 40-char hex digest');
  assert.deepEqual(scan(lock), []);
});

test('walker scans .github/ — a secret in a workflow file is found', () => {
  withTree({ '.github/workflows/deploy.yml': `${CF}\n` }, (dir) => {
    const { findings } = scanTree(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, join('.github', 'workflows', 'deploy.yml'));
    assert.equal(findings[0].rule, 'cloudflare-api-token');
  });
});

test('walker denies dotenv, skip-listed dirs, and binary files', () => {
  const tree = {
    '.env': `${GCS}\n`,
    '.env.deploy': `${GCS}\n`,
    '.env.local': `${GCS}\n`,
    '.dev.vars': `${GCS}\n`,
    '.git/config': `${GCS}\n`,
    '.astro/manifest.json': `${GCS}\n`,
    '.wrangler/state.json': `${GCS}\n`,
    '.playwright-mcp/log.md': `${GCS}\n`,
    '.superpowers/notes.md': `${GCS}\n`,
    '.worktrees/other/src/x.mjs': `${GCS}\n`,
    'node_modules/pkg/index.js': `${GCS}\n`,
    'dist/bundle.js': `${GCS}\n`,
    'test-results/out.js': `${GCS}\n`,
    'src/logo.png': `\0${GCS}\n`,
    'src/ok.mjs': 'export const ok = 1;\n',
  };
  withTree(tree, (dir) => {
    const { findings, scanned } = scanTree(dir);
    assert.deepEqual(findings, []);
    assert.equal(scanned, 1, 'only src/ok.mjs should have been read');
  });
});

test('does not flag the dummy sk- token already committed in repo tests', () => {
  const text = readFileSync(join(root, 'apps/api-cf/test/admin-lb-validate.test.mjs'), 'utf8');
  assert.ok(text.includes('sk-'), 'fixture file must contain an sk- token');
  assert.deepEqual(scan(text), []);
});

test('does not flag a key-shaped word that is a prose placeholder', () => {
  assert.deepEqual(rulesOf("const TOKEN = 'inventory-token-supplied-by-operator';\n"), []);
  assert.deepEqual(rulesOf('see CF_API_TOKEN in docs/DEPLOY.md for details\n'), []);
});

test('a hyphenated slug before sk- is not a finding', () => {
  // risk-/task- prefixes are prose, not credentials; the lookbehind must reject
  // a preceding '-' as well as a preceding letter.
  const body = 'b'.repeat(32);
  assert.deepEqual(rulesOf(`risk-sk-${body}\n`), []);
  assert.deepEqual(rulesOf(`task-sk-${body}\n`), []);
  assert.deepEqual(rulesOf(`sk-${body}\n`), ['sk-key']);
});

test('finds every occurrence on a line and keeps them all', () => {
  const text = 'a=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 b=sk-Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgHiJkLmNoPqRsTu\n'; // noqa:secretscan
  assert.deepEqual(rulesOf(text), ['google-oauth-client-secret', 'sk-key']);
});
