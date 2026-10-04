// Secrets and session-verification keys must be identical across every Worker the
// BFF proxy can route to, because one browser request can land on any of them.
//
// This was not theoretical. `manga-api` shipped without AUTH_SIGNING_KEY while
// its three siblings had it: createSession throws 'AUTH_SIGNING_KEY not
// configured' there, and with the proxy rotating every request, roughly a
// quarter of logins and session reads hit a Worker that could not sign or could
// not verify. Nothing in the codebase or the deploy tooling noticed — wrangler
// deploys happily with a secret missing, and the failure only shows up as a
// random 1101 or a random logout.
//
// `secrets` cannot be asserted from a toml, so REQUIRED_WORKER_SECRETS below is
// the list each Worker must carry, checked against the live API in
// scripts/check-worker-secrets.mjs. What is asserted here is the part that does
// live in version control: the public half of the signing keys, which every
// Worker needs to verify a token minted by any sibling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONFIG_DIR = 'apps/api-cf';
const CONFIGS = readdirSync(join(root, CONFIG_DIR))
  .filter((name) => /^wrangler.*\.toml$/.test(name))
  .sort()
  .map((name) => join(CONFIG_DIR, name));

const varOf = (toml, key) => {
  const m = toml.match(new RegExp(`^${key}\\s*=\\s*([\\s\\S]*?)(?=\\n\\[|\\n\\s*#|$)`, 'm'));
  return m ? m[1].trim().replace(/,$/, '').trim() : null;
};

const unquote = (raw) => {
  const d = raw.match(/^"([\s\S]*)"$/);
  if (d) return d[1];
  const s = raw.match(/^'([\s\S]*)'$/);
  if (s) return s[1];
  return raw;
};

const configs = CONFIGS.map((rel) => ({ rel, toml: readFileSync(join(root, rel), 'utf8') }));

test('semua Worker memverifikasi sesi dengan public key yang sama', () => {
  // getSessionUser looks the key up by kid. A Worker missing another Worker's kid
  // silently rejects that Worker's cookies, which reads as a random logout.
  const sets = configs.map(({ rel, toml }) => {
    const raw = varOf(toml, 'AUTH_PUBLIC_KEYS');
    assert.ok(raw, `${rel} tidak mendeklarasikan AUTH_PUBLIC_KEYS`);
    const keys = JSON.parse(unquote(raw));
    assert.ok(Array.isArray(keys) && keys.length > 0, `${rel} punya AUTH_PUBLIC_KEYS kosong`);
    return { rel, kids: keys.map((k) => k.kid).sort() };
  });

  const expected = sets[0].kids;
  for (const { rel, kids } of sets) {
    assert.deepEqual(kids, expected, `${rel} punya kid yang berbeda: ${kids.join(',')} vs ${expected.join(',')}`);
  }
  assert.equal(new Set(expected).size, expected.length, 'kid duplikat di AUTH_PUBLIC_KEYS');
});

test('set kid auth cocok dengan jumlah Worker yang dikonfigurasi', () => {
  // One keypair per Worker (scripts/gen-auth-keys.mjs names each kid after the
  // Worker), so a Worker added later without its key would break every other
  // Worker's ability to verify its sessions.
  const names = configs
    .map(({ toml }) => varOf(toml, 'name'))
    .filter(Boolean)
    .map(unquote)
    .sort();
  const raw = varOf(configs[0].toml, 'AUTH_PUBLIC_KEYS');
  const kids = JSON.parse(unquote(raw)).map((k) => k.kid).sort();
  assert.deepEqual(kids, names, 'kid di AUTH_PUBLIC_KEYS harus sama dengan name Worker');
});

test('PEER_URLS identik dan urut di semua Worker', () => {
  // ownerFor hashes into this list by index. If the order or the membership
  // differs between Workers, the same user resolves to a different owning shard
  // on each one, and the fail-closed row check turns that into a random logout.
  const lists = configs.map(({ rel, toml }) => {
    const raw = varOf(toml, 'PEER_URLS');
    assert.ok(raw, `${rel} tidak mendeklarasikan PEER_URLS`);
    return { rel, urls: unquote(raw).split(',').map((u) => u.trim()) };
  });
  const expected = lists[0].urls;
  for (const { rel, urls } of lists) {
    assert.deepEqual(urls, expected, `${rel} punya PEER_URLS berbeda — urutan_peer menentukan shard owner`);
  }
});

test('PEER_INDEX menunjuk posisi sendiri di PEER_URLS', () => {
  // self-ness is derived from PEER_INDEX, so a stale index makes a Worker read a
  // shard it does not own (and skip the local read that would have worked).
  for (const { rel, toml } of configs) {
    const urls = unquote(varOf(toml, 'PEER_URLS')).split(',').map((u) => u.trim());
    const name = unquote(varOf(toml, 'name'));
    const idx = Number(unquote(varOf(toml, 'PEER_INDEX')));
    assert.ok(urls[idx]?.includes(name),
      `${rel}: PEER_INDEX=${idx} tapi PEER_URLS[idx]=${urls[idx]} (name=${name})`);
  }
});