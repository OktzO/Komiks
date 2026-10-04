// Verify every Worker in the BFF rotation pool carries the same secrets.
//
// A missing secret is invisible to `wrangler deploy` and to the type checker: the
// Worker ships, serves traffic, and only fails on the code path that reads it.
// `manga-api` ran without AUTH_SIGNING_KEY for exactly that reason — it could not
// sign a session, and with the proxy rotating every request a share of logins
// hit it and failed with an opaque 1101.
//
// Secrets are write-only, so nothing in the repo can assert this; only the live
// API can. Run with:  node scripts/check-worker-secrets.mjs
// Exits non-zero and prints the drift when a Worker is missing anything.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Secrets each Worker must have. A Worker missing any of these is broken for
 *  whatever path reads it — auth first, which is why this list starts there. */
const REQUIRED = [
  'AUTH_SIGNING_KEY', // createSession; absent => 1101 on the login that lands here
  'DB_FORWARD_KEY', // cross-account session/shard reads and writes
  'SERVICE_TOKEN', // BFF gate
  'SIGNED_IMG_SECRET', // /img signatures
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'TURNSTILE_SECRET_KEY',
  'ALLOWED_ORIGINS',
  'ADMIN_EMAILS',
];

// Secrets that are genuinely per-Worker and must NOT be compared across the pool.
const PER_WORKER = new Set(['B2_ACCOUNTS']);

const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const varOf = (toml, key) => {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([0-9a-f]{32}))`, 'm'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

const configs = readdirSync(join(root, 'apps/api-cf'))
  .filter((n) => /^wrangler.*\.toml$/.test(n))
  .sort()
  .map((n) => readFileSync(join(root, 'apps/api-cf', n), 'utf8'));

// Token is matched by account id, never by file order — the configs sort as
// wrangler.origin.toml before wrangler.toml, so positional pairing would hand
// account 1's token to account 2's Worker and report a false auth error.
const tokenByAccount = new Map();
for (let i = 1; i <= 9; i++) {
  const id = env[`CF_ACCOUNT_ID_AKUN${i}`];
  const tok = env[`CF_TOKEN_AKUN${i}`];
  if (id && tok) tokenByAccount.set(id, tok);
}

const workers = configs.map((toml) => {
  const accountId = varOf(toml, 'account_id');
  return { name: varOf(toml, 'name'), accountId, token: tokenByAccount.get(accountId) };
});

const secretsOf = async ({ name, accountId, token }) => {
  if (!name || !accountId || !token) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/secrets`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!json.success) throw new Error(`${name}: ${JSON.stringify(json.errors)}`);
  return new Set(json.result.map((s) => s.name));
};

let drift = 0;
const seen = new Map();

for (const w of workers) {
  const have = await secretsOf(w);
  if (!have) { console.error(`skip ${w.name} (account/token tidak ada di .env)`); continue; }
  seen.set(w.name, have);
  const missing = REQUIRED.filter((s) => !have.has(s));
  if (missing.length) {
    drift++;
    console.error(`FAIL ${w.name}: tidak punya ${missing.join(', ')}`);
  } else {
    console.log(`ok   ${w.name}: ${REQUIRED.length} secret wajib ada`);
  }
}

// Anything present on one Worker and absent on another is drift too, even when
// it is not on the REQUIRED list — that asymmetry is what caused the outage.
for (const [name, have] of seen) {
  for (const [other, otherHave] of seen) {
    if (name === other) continue;
    const only = [...have].filter((s) => !otherHave.has(s) && !PER_WORKER.has(s));
    if (only.length) {
      drift++;
      console.error(`DRIFT ${name} punya ${only.join(', ')} yang tidak ada di ${other}`);
    }
  }
}

console.log(drift ? `\n${drift} masalah parity.` : '\nSemua Worker punya secret yang sama.');
process.exit(drift ? 1 : 0);