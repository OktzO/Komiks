// Zero-dependency unit tests for the secret scanner. `scan` is pure so these
// run without touching the filesystem, except for the two regression guards
// that read real committed files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './scan-secrets.mjs';

// Fixture literals below carry `noqa:secretscan`: they are fake credentials, and
// that marker is the scanner's sanctioned way to say so. The marker is matched
// per line of the text handed to scan(), so it never reaches these assertions.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesOf = (text) => scan(text).map((f) => f.rule);

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

test('does not flag the committed novel-module design doc', () => {
  const text = readFileSync(join(root, 'docs/superpowers/specs/2026-09-27-novel-module-design.md'), 'utf8');
  assert.deepEqual(scan(text), []);
});

test('does not flag package-lock.json integrity hashes', () => {
  const text = readFileSync(join(root, 'package-lock.json'), 'utf8');
  assert.deepEqual(scan(text), []);
});

test('does not flag the dummy sk- token already committed in repo tests', () => {
  const text = readFileSync(join(root, 'apps/api-cf/test/admin-lb-validate.test.mjs'), 'utf8');
  assert.deepEqual(scan(text), []);
});

test('does not flag a key-shaped word that is a prose placeholder', () => {
  assert.deepEqual(rulesOf("const TOKEN = 'inventory-token-supplied-by-operator';\n"), []);
  assert.deepEqual(rulesOf('see CF_API_TOKEN in docs/DEPLOY.md for details\n'), []);
});

test('finds every occurrence on a line and keeps them all', () => {
  const text = 'a=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 b=sk-Ab3dEf6hIj9lMn2pQr4sTv7wXy0zAcDeFgHiJkLmNoPqRsTu\n'; // noqa:secretscan
  assert.deepEqual(rulesOf(text), ['google-oauth-client-secret', 'sk-key']);
});
