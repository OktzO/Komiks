#!/usr/bin/env node
// Secret-scan gate. Exits 1 when anything looks like a live credential.
// Replaces manual README review, which is the control that let a Google OAuth
// client secret reach a commit.
//
// Usage: node scripts/scan-secrets.mjs [root]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Explicit deny list. `.github` is deliberately absent: a workflow file is
// tracked source and a secret committed there is a real leak, so dot-entries
// cannot be skipped by prefix. `.worktrees` holds sibling checkouts of this repo,
// where findings would gate on another agent's uncommitted work.
const SKIP_NAMES = new Set([
  'node_modules',
  'dist',
  'test-results',
  '.git',
  '.astro',
  '.wrangler',
  '.playwright-mcp',
  '.superpowers',
  '.worktrees',
  '.dev.vars',
]);

// The dotenv family holds real credentials and is gitignored: .env, .env.deploy,
// .env.local, .env.production. An explicit deny rather than a "starts with ."
// rule, which would also have hidden .github/ from the gate.
const SKIP_DOTENV = /^\.env(\.|$)/;

const RULES = [
  {
    // Cloudflare API tokens are exactly 40 chars of base64url and only count as
    // a finding when assigned to a CF_*/CLOUDFLARE_* name — a bare 40-char run
    // is indistinguishable from a hash and would be noise.
    name: 'cloudflare-api-token',
    re: /\b(?:CLOUDFLARE|CF)_(?:API_)?(?:TOKEN|KEY|SECRET)\b["']?[ \t]*[=:][ \t]*["']?(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{40})(?![A-Za-z0-9_-])/g,
  },
  {
    // GOCSPX- is a Google-only prefix, so the shape alone is enough signal.
    name: 'google-oauth-client-secret',
    re: /GOCSPX-[A-Za-z0-9_-]{20,}/g,
  },
  {
    // ponytail: covers legacy sk-<48> and sk-proj-…. The lookbehind must exclude
    // '-' as well as alnum, or a hyphenated slug like risk-sk-<32> matches.
    // Ceiling is one vendor's key family per entry; widen only when one lands
    // here, since permitting hyphens below 32 chars matches prose slugs.
    name: 'sk-key',
    re: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
];

const NOQA = /noqa:secretscan/;

// Findings quote the secret nowhere: a gate that echoes the credential into CI
// logs has just moved the leak somewhere with wider read access.
const redact = (s) => `${s.slice(0, 6)}… (${s.length} chars)`;

/**
 * @param {string} text
 * @param {string} [file] label carried on each finding
 * @returns {Array<{file: string, line: number, rule: string, match: string}>}
 */
export function scan(text, file = '') {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (NOQA.test(line)) continue;
    for (const { name, re } of RULES) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        findings.push({ file, line: i + 1, rule: name, match: redact(m[0]) });
      }
    }
  }
  return findings;
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name) || SKIP_DOTENV.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * @param {string} root directory to walk
 * @returns {{findings: Array<object>, scanned: number}}
 */
export function scanTree(root) {
  const findings = [];
  let scanned = 0;
  for (const file of walkFiles(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`scan-secrets: unreadable, skipped: ${relative(root, file)} (${err.code})`);
      continue;
    }
    if (text.includes('\0')) continue; // binary asset (png/jpeg), not source
    scanned++;
    findings.push(...scan(text, relative(root, file)));
  }
  return { findings, scanned };
}

function main(argv) {
  const { findings, scanned } = scanTree(resolve(argv[2] ?? '.'));

  if (findings.length === 0) {
    console.log(`scan-secrets: clean — ${scanned} files, 0 findings`);
    return;
  }
  for (const f of findings) {
    console.error(`scan-secrets: ${f.file}:${f.line}  ${f.rule}  ${f.match}`);
  }
  console.error(`scan-secrets: ${findings.length} finding(s) in ${scanned} files`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
