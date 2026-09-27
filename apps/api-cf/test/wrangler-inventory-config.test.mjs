import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// Every wrangler config is discovered, not listed. A new worker config that
// forgets the metadata vars has to fail this file, so nothing may be hardcoded.
const CONFIG_DIR = 'apps/api-cf';
const CONFIGS = readdirSync(join(root, CONFIG_DIR))
  .filter((name) => /^wrangler.*\.toml$/.test(name))
  .sort()
  .map((name) => `${CONFIG_DIR}/${name}`);

const INVENTORY_VARS = ['CF_ACCOUNT_ID', 'CF_WORKER_NAME', 'CF_D1_ID', 'CF_KV_ID'];

const unquote = (raw) => {
  const value = raw.trim().replace(/,$/, '').trim();
  const quoted = value.match(/^"([\s\S]*)"$/);
  if (quoted) return quoted[1];
  const single = value.match(/^'([\s\S]*)'$/);
  if (single) return single[1];
  return value;
};

const topLevel = (text, key) => {
  const hit = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return hit ? unquote(hit[1]) : null;
};

const varsSection = (text) => {
  const start = text.match(/^\[vars\][^\S\n]*$/m);
  if (!start) return '';
  const rest = text.slice(start.index + start[0].length);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
};

const varCount = (section, key) =>
  (section.match(new RegExp(`^${key}\\s*=`, 'gm')) || []).length;

const varValue = (section, key) => {
  const hit = section.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return hit ? unquote(hit[1]) : null;
};

test('at least one wrangler config is discovered', () => {
  assert.ok(CONFIGS.length >= 1, 'no apps/api-cf/wrangler*.toml found');
});

for (const rel of CONFIGS) {
  test(`${rel} inventory metadata vars mirror that file's own resource ids`, () => {
    const text = read(rel);
    const section = varsSection(text);
    const accountId = topLevel(text, 'account_id');
    const workerName = topLevel(text, 'name');
    const d1Id = topLevel(text, 'database_id');
    const kvId = topLevel(text, 'id');

    assert.ok(accountId, 'account_id missing');
    assert.ok(workerName, 'name missing');
    assert.ok(d1Id, 'database_id missing');
    assert.ok(kvId, 'kv namespace id missing');

    for (const key of INVENTORY_VARS) {
      assert.equal(varCount(section, key), 1, `${key} must be assigned exactly once inside [vars]`);
      assert.equal(
        varCount(text, key),
        1,
        `${key} must not be assigned outside [vars] as well`,
      );
      assert.notEqual(varValue(section, key), '', `${key} must carry a value`);
    }

    assert.equal(varValue(section, 'CF_ACCOUNT_ID'), accountId);
    assert.equal(varValue(section, 'CF_WORKER_NAME'), workerName);
    assert.equal(varValue(section, 'CF_D1_ID'), d1Id);
    assert.equal(varValue(section, 'CF_KV_ID'), kvId);
  });

  test(`${rel} never declares the inventory token`, () => {
    assert.equal(
      read(rel).match(/CF_INVENTORY_TOKEN/g),
      null,
      'CF_INVENTORY_TOKEN belongs in `wrangler secret put`, not in a toml file',
    );
  });
}

test('no two workers claim the same account, worker name, D1 or KV namespace', () => {
  // Cloudflare account ids, worker script names, D1 uuids and KV namespace ids
  // are unique per resource, so a repeat across two configs means one file
  // copied another worker's identity.
  const seen = Object.fromEntries(INVENTORY_VARS.map((key) => [key, new Map()]));
  for (const rel of CONFIGS) {
    const section = varsSection(read(rel));
    for (const key of INVENTORY_VARS) {
      const value = varValue(section, key);
      const owner = seen[key].get(value);
      assert.equal(
        owner,
        undefined,
        `${key} = ${value} is claimed by both ${owner} and ${rel}`,
      );
      seen[key].set(value, rel);
    }
  }
});

// Sharding is computed from the worker's own PEER_URLS: ownerFor is
// peers[murmur3_32(key) % N] (apps/api-cf/src/lib/peers.ts). If two workers
// disagree about the list or about their own ordinal, they disagree about who
// owns a key and forwarding lands on the wrong D1. Nothing detects that at
// runtime — a stale PEER_INDEX is silent, which is why it is asserted here.
test('every worker lists the same peers, byte for byte, in the same order', () => {
  const byFile = new Map(CONFIGS.map((rel) => [rel, varValue(varsSection(read(rel)), 'PEER_URLS')]));
  const reference = byFile.get(CONFIGS[0]);
  assert.ok(reference, `${CONFIGS[0]} has no PEER_URLS`);
  for (const [rel, value] of byFile) {
    assert.equal(
      value,
      reference,
      `PEER_URLS in ${rel} differs from ${CONFIGS[0]}; the ordinal is the shard id`,
    );
  }
});

test('PEER_INDEX is an exact permutation of 0..N-1 over the shared peer list', () => {
  const peers = (varValue(varsSection(read(CONFIGS[0])), 'PEER_URLS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const count = peers.length;
  assert.ok(count >= 1, 'PEER_URLS is empty, so there is no topology to check');

  const parsed = CONFIGS.map((rel) => {
    const raw = varValue(varsSection(read(rel)), 'PEER_INDEX');
    const value = Number(raw);
    assert.ok(
      raw !== null && raw.trim() !== '' && Number.isInteger(value) && value >= 0 && value < count,
      `${rel} has PEER_INDEX=${String(raw)}, which is not an integer inside 0..${count - 1}`,
    );
    return { rel, value };
  });

  assert.deepEqual(
    parsed.map((entry) => entry.value).sort((a, b) => a - b),
    Array.from({ length: count }, (_, index) => index),
    `PEER_INDEX must be a permutation of 0..${count - 1} with no duplicates; got ${parsed
      .map((entry) => `${entry.rel.split('/').pop()}=${entry.value}`)
      .join(', ')}`,
  );
});

test('.dev.vars.example lists the inventory vars blank', () => {
  const text = read('apps/api-cf/.dev.vars.example');
  for (const key of [...INVENTORY_VARS, 'CF_INVENTORY_TOKEN']) {
    const hit = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    assert.ok(hit, `${key} missing from .dev.vars.example`);
    assert.equal(hit[1].trim(), '', `${key} must ship blank in .dev.vars.example`);
  }
});
