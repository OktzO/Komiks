import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { AdminInventorySchema, InventoryRegistrationSchema } from '@manga-platform/shared/types';
import { getTopology } from '../src/lib/peers.ts';
import { peerInventoryFixture } from './helpers/inventory-fixture.mjs';
import { buildAdminInventory, buildRegistrations, router } from '../src/routes/admin/inventory.ts';
import { app as apiApp } from '../src/index.ts';

const emptyB2 = { accounts: [], warnings: [] };

const account = (index, name = `Account ${index}`) => ({
  id: `lb-${index}`,
  provider: 'cloudflare',
  label: name,
  account_ref: `cf-w${index}`,
  token_last4: '1234',
  encrypted_token: 'secret-encrypted-token',
  status: 'verified',
  last_tested_at: 1000 + index,
  created_at: 900 + index,
});

const origin = (url, overrides = {}) => ({
  id: `origin-${new URL(url).hostname}`,
  account_id: null,
  origin_url: url,
  priority: 0,
  weight: 1,
  enabled: 1,
  last_health_status: 'healthy',
  last_checked_at: 1000,
  created_at: 900,
  ...overrides,
});

const peerInventoryFor = (url, refresh = false, topologyHash = 'peer-hash', self = true) => {
  void refresh;
  const name = new URL(url).hostname.split('.')[0];
  return peerInventoryFixture({
    topologyHash,
    self,
    account: {
      id: `cf-${name}`,
      name,
      type: 'standard',
      state: { status: 'ok', source: 'live', observedAt: 1000, errorCode: null },
    },
    worker: {
      name,
      createdAt: null,
      modifiedAt: null,
      state: { status: 'ok', source: 'live', observedAt: 1000, errorCode: null },
    },
    d1: {
      id: `d1-${name}`,
      name: `db-${name}`,
      fileBytes: 10,
      jurisdiction: 'us',
      region: 'wnam',
      counts: { series: 1, chapters: 2, chapterPages: 3, users: 4, bookmarks: 5 },
      state: { status: 'ok', source: 'live', observedAt: 1000, errorCode: null },
    },
    kv: {
      id: `kv-${name}`,
      title: `cache-${name}`,
      jurisdiction: 'us',
      keyCount: 6,
      byteCount: 7,
      operationalD1Bytes: 8,
      state: { status: 'ok', source: 'live', observedAt: 1000, errorCode: null },
    },
  });
};

const envForCount = (count, over = {}) => {
  const urls = Array.from({ length: count }, (_, index) => `https://w${index}.test`).join(',');
  return {
    PEER_URLS: urls,
    PEER_INDEX: count > 0 ? '0' : '',
    DB_FORWARD_KEY: 'forward-secret',
    CF_WORKER_NAME: 'w0',
    CF_ACCOUNT_ID: 'cf-w0',
    CF_D1_ID: 'd1-self',
    CF_KV_ID: 'kv-self',
    CACHE_KV: {
      store: {},
      async get() { return null; },
      async put() {},
    },
    ...over,
  };
};

const selfInventoryFor = (env, refresh = false) =>
  peerInventoryFor('https://w0.test', refresh, getTopology(env).hash);

const fourPeerEnv = (over = {}) => envForCount(4, over);
const onePeerEnv = (over = {}) => envForCount(1, over);

const stubDb = (overrides = {}) => ({
  listAccounts: async () => [],
  listOrigins: async () => [],
  getInventoryCounts: async () => ({ series: 0, chapters: 0, chapterPages: 0, users: 0, bookmarks: 0 }),
  ...overrides,
});

// Real ECDSA session cookie: requireAdminSession verifies a signature and reads
// the session + user rows from D1, so ordering can only be proven with a
// genuinely accepted session. One peer keeps the session shard on self, so no
// cross-Worker fetch is attempted.
const adminSession = async (env) => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const kid = 'test-kid';
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const payload = {
    sid: '7:test-sid',
    uid: 7,
    email: 'admin@test.invalid',
    role: 'admin',
    kid,
    iat: 1,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const payloadStr = JSON.stringify(payload);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    new TextEncoder().encode(payloadStr)
  );
  const token = `${Buffer.from(payloadStr).toString('base64url')}.${Buffer.from(signature).toString('base64url')}`;
  const session = {
    sid: payload.sid,
    user_id: 7,
    created_at: 1,
    expires_at: payload.exp,
    revoked_at: null,
    ua: null,
    ip: null,
  };
  const DB = {
    prepare(sql) {
      return {
        sql,
        bind() { return this; },
        async first() {
          if (sql.includes('FROM sessions')) return session;
          if (sql.includes('FROM users')) return { id: 7, role: 'admin', status: 'active' };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { success: true }; },
      };
    },
    batch() { return Promise.resolve([]); },
  };
  return {
    env: { ...env, DB, AUTH_PUBLIC_KEYS: JSON.stringify([{ kid, key: jwk }]) },
    cookie: `__Host-session=${token}`,
  };
};

const adminInventoryFixture = (overrides = {}, baseEnv = envForCount(4)) => {
  const topology = getTopology(baseEnv);
  const observedAt = Date.now();
  return {
    observedAt,
    stale: false,
    topology: { source: 'PEER_URLS', count: topology.count, hash: topology.hash, consistent: true },
    accounts: topology.peers.map((peer) => ({
      ...peerInventoryFor(peer.url, false, topology.hash),
      topologyHash: topology.hash,
      index: peer.index,
      url: peer.url,
      self: peer.self,
      reachable: true,
    })),
    registrations: [],
    b2: [],
    warnings: [],
    ...overrides,
  };
};

const recordingKv = () => {
  const store = new Map();
  const puts = [];
  return {
    puts,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      puts.push({ key, value });
      store.set(key, value);
    },
  };
};

test('N=0 skips self collector and returns schema-valid empty inventory', async () => {
  const env = envForCount(0);
  let selfCalls = 0;
  const result = await buildAdminInventory(env, stubDb(), true, {
    collectSelf: async () => { selfCalls += 1; return selfInventoryFor(env); },
    collectB2: async () => emptyB2,
    readCache: async () => null,
  });
  assert.equal(selfCalls, 0);
  assert.equal(result.topology.count, 0);
  assert.equal(result.accounts.length, 0);
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('one topology row is produced for every configured peer count', async () => {
  for (const count of [0, 1, 2, 4, 5]) {
    const env = envForCount(count);
    const result = await buildAdminInventory(env, stubDb(), true, {
      fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
      collectSelf: async () => selfInventoryFor(env, true),
      collectB2: async () => emptyB2,
      readCache: async () => null,
    });
    assert.equal(result.accounts.length, count);
    assert.equal(AdminInventorySchema.safeParse(result).success, true, `N=${count}`);
  }
});

test('self collector is direct while remote peers fan out in parallel', async () => {
  const env = fourPeerEnv();
  let active = 0;
  let maxActive = 0;
  let selfCalls = 0;
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) };
    },
    collectSelf: async () => {
      selfCalls += 1;
      return selfInventoryFor(env, true);
    },
    collectB2: async () => emptyB2,
    readCache: async () => null,
  });
  assert.equal(selfCalls, 1);
  assert.equal(result.accounts.length, 4);
  assert.ok(maxActive >= 2);
});

test('four topology peers remain visible with only two D1 accounts', async () => {
  const env = fourPeerEnv();
  const localAccounts = [account(0), account(1)];
  const localOrigins = [
    origin('https://w0.test', { account_id: 'lb-0' }),
    origin('https://w1.test', { account_id: 'lb-1' }),
  ];
  const withMetadata = (url) => {
    const index = Number(new URL(url).hostname.slice(1));
    const base = peerInventoryFor(url, false, getTopology(env).hash);
    return index < 2
      ? { ...base, lb: { account: localAccounts[index], origins: [localOrigins[index]] } }
      : base;
  };
  const result = await buildAdminInventory(env, stubDb({
    listAccounts: async () => localAccounts,
    listOrigins: async () => localOrigins,
  }), true, {
    fetchPeer: async (_env, peer) => ({ ok: true, data: withMetadata(peer.url) }),
    collectSelf: async () => ({ ...withMetadata('https://w0.test'), self: true }),
    collectB2: async () => emptyB2,
    readCache: async () => null,
  });
  assert.equal(result.topology.count, 4);
  assert.equal(result.topology.consistent, true);
  assert.equal(result.accounts.length, 4);
  assert.equal(result.registrations.length, 0);
});

test('unreachable peer yields a row and stable warning', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => peer.url.includes('w2')
      ? { ok: false, errorCode: 'PEER_HTTP_503' }
      : { ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) },
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
    readCache: async () => null,
  });
  assert.equal(result.accounts.length, 4);
  assert.equal(result.accounts[2].reachable, false);
  assert.ok(result.warnings.some((warning) => warning.code === 'PEER_HTTP_503' && warning.peerUrl === 'https://w2.test'));
});

test('reachable peer hash mismatch marks topology inconsistent', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, peer.url.includes('w2') ? 'different-hash' : getTopology(env).hash) }),
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
    readCache: async () => null,
  });
  assert.equal(result.topology.consistent, false);
});

test('stale cache is returned with warnings when refresh fan-out fails', async () => {
  const env = fourPeerEnv();
  const cached = adminInventoryFixture({ observedAt: Date.now() - 600_000, stale: true });
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async () => ({ ok: false, errorCode: 'PEER_UNREACHABLE' }),
    collectSelf: async () => { throw new Error('raw self failure'); },
    collectB2: async () => emptyB2,
    readCache: async () => cached,
  });
  assert.equal(result.stale, true);
  assert.equal(result.accounts.length, 4);
  assert.ok(result.warnings.length > 0);
  assert.doesNotMatch(JSON.stringify(result), /raw self failure/);
});

test('fresh coordinator cache bypasses collectors and uses topology hash key', async () => {
  const env = fourPeerEnv();
  const cached = adminInventoryFixture({}, env);
  let key = '';
  const result = await buildAdminInventory(env, stubDb(), false, {
    readCache: async (cacheKey) => { key = cacheKey; return cached; },
    collectSelf: async () => { throw new Error('must not collect'); },
    fetchPeer: async () => { throw new Error('must not fetch'); },
    collectB2: async () => { throw new Error('must not collect B2'); },
  });
  assert.equal(key, `admin:inventory:v2:${getTopology(env).hash}`);
  assert.deepEqual(result, cached);
  assert.notEqual(result, cached, 'cached snapshot must be returned as a parsed value, not the raw reference');
});

test('refresh is forwarded only when coordinator cache is bypassed', async () => {
  const env = fourPeerEnv();
  const seen = [];
  const stale = adminInventoryFixture({ observedAt: 0 });
  await buildAdminInventory(env, stubDb(), false, {
    readCache: async () => stale,
    fetchPeer: async (_env, peer, refresh) => { seen.push(refresh); return { ok: true, data: peerInventoryFor(peer.url, refresh, getTopology(env).hash) }; },
    collectSelf: async () => selfInventoryFor(env, false),
    collectB2: async () => emptyB2,
  });
  await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => stale,
    fetchPeer: async (_env, peer, refresh) => { seen.push(refresh); return { ok: true, data: peerInventoryFor(peer.url, refresh, getTopology(env).hash) }; },
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.deepEqual(seen, [false, false, false, true, true, true]);
});

test('B2 configuration warning reaches final inventory', async () => {
  const env = onePeerEnv();
  const warning = { code: 'B2_CONFIG_INVALID', peerUrl: null, message: 'B2 configuration invalid', observedAt: 1000 };
  const result = await buildAdminInventory(env, stubDb(), true, {
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => ({ accounts: [], warnings: [warning] }),
    readCache: async () => null,
  });
  assert.ok(result.warnings.some((item) => item.code === warning.code));
  assert.equal(result.b2.length, 0);
});

test('registration builder returns pending local account with matching origin and no secrets', () => {
  const local = account(0);
  const result = buildRegistrations([], [local], [origin('https://w0.test', { account_id: local.id })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].topologyStatus, 'pending_topology');
  assert.equal(result[0].origin?.origin_url, 'https://w0.test');
  assert.equal(InventoryRegistrationSchema.safeParse(result[0]).success, true);
  assert.doesNotMatch(JSON.stringify(result), /token_last4|encrypted_token|secret-encrypted-token/);
});

test('registration builder includes unmatched account with null origin', () => {
  const result = buildRegistrations([], [account(0)], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin, null);
  assert.equal(result[0].topologyStatus, 'pending_topology');
});

test('registration builder includes matched account without origin as pending null', () => {
  const local = account(0);
  const row = {
    topologyHash: 'hash',
    index: 0,
    url: 'https://w0.test',
    self: true,
    reachable: true,
    account: { id: 'cf-w0', name: 'w0', type: 'standard', state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    worker: { name: 'w0', createdAt: null, modifiedAt: null, state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    d1: { id: 'd1', name: null, fileBytes: null, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    kv: { id: 'kv', title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    lb: { account: null, origins: [] },
  };
  const result = buildRegistrations([row], [local], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin, null);
  assert.equal(result[0].topologyStatus, 'pending_topology');
});

test('registration builder gathers and deduplicates reachable peer metadata', () => {
  const peerAccount = account(9, 'Remote');
  peerAccount.account_ref = 'cf-w9';
  const peerOrigin = origin('https://w9.test', { id: 'origin-9', account_id: peerAccount.id });
  const row = (index) => ({
    topologyHash: 'hash', index, url: `https://w${index}.test`, self: false, reachable: true,
    account: { id: `cf-w${index}`, name: `w${index}`, type: 'standard', state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    worker: { name: `w${index}`, createdAt: null, modifiedAt: null, state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    d1: { id: null, name: null, fileBytes: null, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    kv: { id: null, title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    lb: { account: peerAccount, origins: [peerOrigin] },
  });
  const result = buildRegistrations([row(0), row(1)], [], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].account.id, peerAccount.id);
  assert.equal(result[0].origin?.id, peerOrigin.id);
});

test('fresh collection is not stale and is cached under the topology key with 3600 second ttl', async () => {
  const env = envForCount(1);
  const puts = [];
  env.CACHE_KV = {
    store: {},
    async get() { return null; },
    async put(key, value, options) { puts.push({ key, value, options }); },
  };
  const result = await buildAdminInventory(env, stubDb(), true, {
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.stale, false);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, `admin:inventory:v2:${getTopology(env).hash}`);
  assert.equal(puts[0].options.expirationTtl, 3600);
});

test('corrupt coordinator cache is discarded instead of served', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), false, {
    readCache: async () => ({ observedAt: Date.now(), unexpected: true }),
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, false, getTopology(env).hash) }),
    collectSelf: async () => selfInventoryFor(env, false),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.stale, false);
  assert.equal(result.accounts.length, 4);
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('partial peer failure with a valid cached snapshot returns stale cache without rewriting it', async () => {
  const env = fourPeerEnv();
  const cached = adminInventoryFixture({}, env);
  const writes = [];
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => cached,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => peer.url.includes('w2')
      ? { ok: false, errorCode: 'PEER_HTTP_503' }
      : { ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) },
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.stale, true);
  assert.equal(result.accounts.length, 4);
  assert.ok(result.warnings.some((warning) => warning.code === 'PEER_HTTP_503'));
  assert.equal(writes.length, 0, 'degraded refresh must not be cached as fresh');
});

test('all failed refresh without a cache still returns schema-valid unavailable rows', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    fetchPeer: async () => ({ ok: false, errorCode: 'PEER_UNREACHABLE' }),
    collectSelf: async () => { throw new Error('self collector detail'); },
    collectB2: async () => emptyB2,
  });
  assert.equal(result.stale, false);
  assert.equal(result.accounts.length, 4);
  assert.equal(result.accounts.every((row) => row.reachable === false), true);
  assert.equal(result.accounts[0].account.state.errorCode, 'SELF_COLLECT_FAILED');
  assert.equal(result.accounts[0].worker.state.errorCode, 'SELF_COLLECT_FAILED');
  assert.ok(result.warnings.some((warning) => warning.code === 'SELF_COLLECT_FAILED' && warning.peerUrl === 'https://w0.test'));
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

for (const [label, mutate] of [
  ['topology hash', (cached) => ({ ...cached, topology: { ...cached.topology, hash: 'other-hash' } })],
  ['topology count', (cached) => ({ ...cached, topology: { ...cached.topology, count: 3 } })],
  ['topology source', (cached) => ({ ...cached, topology: { ...cached.topology, source: 'SOMETHING_ELSE' } })],
  ['account url', (cached) => ({ ...cached, accounts: cached.accounts.map((row, i) => (i === 1 ? { ...row, url: 'https://elsewhere.test' } : row)) })],
  ['account index', (cached) => ({ ...cached, accounts: cached.accounts.map((row, i) => (i === 2 ? { ...row, index: 9 } : row)) })],
  ['account order', (cached) => ({ ...cached, accounts: [cached.accounts[1], cached.accounts[0], cached.accounts[2], cached.accounts[3]] })],
  ['account count', (cached) => ({ ...cached, accounts: cached.accounts.slice(0, 3) })],
]) {
  test(`cached snapshot with a mismatched ${label} is discarded and recollected`, async () => {
    const env = fourPeerEnv();
    const cached = mutate(adminInventoryFixture({}, env));
    let selfCalls = 0;
    const result = await buildAdminInventory(env, stubDb(), false, {
      readCache: async () => cached,
      fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, false, getTopology(env).hash) }),
      collectSelf: async () => { selfCalls += 1; return selfInventoryFor(env, false); },
      collectB2: async () => emptyB2,
    });
    assert.equal(selfCalls, 1, `${label} cache must not be served`);
    assert.equal(result.stale, false);
    assert.equal(result.accounts.length, 4);
    assert.deepEqual(result.accounts.map((row) => row.url), getTopology(env).peers.map((peer) => peer.url));
  });
}

test('cached snapshot unknown fields are stripped from the served value', async () => {
  const env = fourPeerEnv();
  const base = adminInventoryFixture({}, env);
  const cached = { ...base, extraTopLevel: 'leak', accounts: base.accounts.map((row, i) => (i === 0 ? { ...row, extraRowField: 'leak' } : row)) };
  const result = await buildAdminInventory(env, stubDb(), false, {
    readCache: async () => cached,
    collectSelf: async () => { throw new Error('must not collect'); },
    fetchPeer: async () => { throw new Error('must not fetch'); },
    collectB2: async () => { throw new Error('must not collect B2'); },
  });
  assert.equal(result.stale, false);
  assert.equal(result.extraTopLevel, undefined);
  assert.equal(result.accounts[0].extraRowField, undefined);
  assert.doesNotMatch(JSON.stringify(result), /leak/);
});

test('stale fallback warnings are deduplicated by code and peer url', async () => {
  const env = fourPeerEnv();
  const cached = adminInventoryFixture({
    observedAt: 0,
    warnings: [{ code: 'PEER_HTTP_503', peerUrl: 'https://w2.test', message: 'Peer inventory unavailable', observedAt: 1 }],
  }, env);
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => cached,
    fetchPeer: async () => ({ ok: false, errorCode: 'PEER_HTTP_503' }),
    collectSelf: async () => { throw new Error('self down'); },
    collectB2: async () => emptyB2,
  });
  const matching = result.warnings.filter((warning) => warning.code === 'PEER_HTTP_503' && warning.peerUrl === 'https://w2.test');
  assert.equal(result.stale, true);
  assert.equal(matching.length, 1);
});

test('B2 collector rejection yields a stable warning and is not cached as fresh', async () => {
  const env = fourPeerEnv();
  const writes = [];
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => { throw new Error('b2 provider keyId leaked'); },
  });
  assert.equal(result.b2.length, 0);
  assert.ok(result.warnings.some((warning) => warning.code === 'B2_INVENTORY_UNAVAILABLE' && warning.peerUrl === null));
  assert.equal(writes.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /keyId|leaked/);
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

for (const [label, db] of [
  ['listAccounts', stubDb({ listAccounts: async () => { throw new Error('accounts table gone'); } })],
  ['listOrigins', stubDb({ listOrigins: async () => { throw new Error('origins table gone'); } })],
]) {
  test(`local ${label} rejection yields a stable warning and is not cached as fresh`, async () => {
    const env = fourPeerEnv();
    const writes = [];
    const result = await buildAdminInventory(env, db, true, {
      readCache: async () => null,
      writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
      fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
      collectSelf: async () => selfInventoryFor(env, true),
      collectB2: async () => emptyB2,
    });
    assert.ok(result.warnings.some((warning) => warning.code === 'LB_REGISTRY_UNAVAILABLE' && warning.peerUrl === null));
    assert.equal(writes.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /table gone/);
    assert.equal(AdminInventorySchema.safeParse(result).success, true);
  });

  test(`local ${label} rejection falls back to a stale snapshot when one exists`, async () => {
    const env = fourPeerEnv();
    const cached = adminInventoryFixture({}, env);
    const result = await buildAdminInventory(env, db, true, {
      readCache: async () => cached,
      fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
      collectSelf: async () => selfInventoryFor(env, true),
      collectB2: async () => emptyB2,
    });
    assert.equal(result.stale, true);
    assert.ok(result.warnings.some((warning) => warning.code === 'LB_REGISTRY_UNAVAILABLE'));
  });
}

test('registration keeps the first matching origin so a topology origin beats a D1-only origin', () => {
  const local = account(5, 'Multi');
  local.account_ref = 'cf-w9';
  const topologyOrigin = origin('https://w0.test', { id: 'origin-topo', account_id: local.id });
  const d1OnlyOrigin = origin('https://d1-only.test', { id: 'origin-d1', account_id: local.id });
  const row = {
    topologyHash: 'hash', index: 0, url: 'https://w0.test', self: true, reachable: true,
    account: { id: 'cf-w0', name: 'w0', type: 'standard', state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    worker: { name: 'w0', createdAt: null, modifiedAt: null, state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    d1: { id: 'd1', name: null, fileBytes: null, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    kv: { id: 'kv', title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    lb: { account: local, origins: [topologyOrigin] },
  };
  const result = buildRegistrations([row], [local], [d1OnlyOrigin]);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin.id, 'origin-topo');
  assert.equal(result[0].topologyStatus, 'pending_topology');
});

test('an unreachable peer is neither a false pending registration nor a fabricated registered one', () => {
  const local = account(3, 'Remote unreachable');
  local.account_ref = 'cf-w3';
  const reachableRow = (index) => ({
    topologyHash: 'hash', index, url: `https://w${index}.test`, self: index === 0, reachable: true,
    account: { id: `cf-w${index}`, name: `w${index}`, type: 'standard', state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    worker: { name: `w${index}`, createdAt: null, modifiedAt: null, state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    d1: { id: null, name: null, fileBytes: null, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    kv: { id: null, title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    lb: { account: null, origins: [] },
  });
  const unreachableState = { status: 'unavailable', source: 'unavailable', observedAt: 1, errorCode: 'PEER_UNREACHABLE' };
  const unreachableRow = {
    ...reachableRow(3),
    reachable: false,
    self: false,
    account: { id: null, name: null, type: null, state: unreachableState },
    worker: { name: null, createdAt: null, modifiedAt: null, state: unreachableState },
    d1: { id: null, name: null, fileBytes: null, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: unreachableState },
    kv: { id: null, title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: unreachableState },
    lb: { account: null, origins: [] },
  };
  const result = buildRegistrations(
    [reachableRow(0), unreachableRow],
    [local],
    [origin('https://w3.test', { account_id: local.id })],
  );
  assert.deepEqual(result, [], 'an unreachable peer must not demote its credential to pending_topology');
  for (const entry of result) {
    assert.notEqual(entry.topologyStatus, 'registered', 'registrations[] never carries a registered row');
  }
  assert.equal(
    result.some((entry) => entry.topologyStatus === 'pending_topology'),
    false,
    'no false pending registration is emitted for a peer whose url is already in topology'
  );
  assert.deepEqual(
    [reachableRow(0), unreachableRow].map((row) => row.reachable),
    [true, false],
    'the outage surfaces as an unreachable topology row, not as a registration'
  );
  assert.equal(unreachableRow.url, 'https://w3.test', 'the unreachable peer is still a configured topology url');
  assert.equal(unreachableRow.account.state.errorCode, 'PEER_UNREACHABLE', 'its state explains why it is unreachable');
});

test('registration stays pending when the only origin for a matched account is outside the topology', () => {
  const local = account(6, 'D1 only');
  local.account_ref = 'cf-w0';
  const d1OnlyOrigin = origin('https://elsewhere.test', { id: 'origin-elsewhere', account_id: local.id });
  const row = {
    topologyHash: 'hash', index: 0, url: 'https://w0.test', self: true, reachable: true,
    account: { id: 'cf-w0', name: 'w0', type: 'standard', state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    worker: { name: 'w0', createdAt: null, modifiedAt: null, state: { status: 'ok', source: 'live', observedAt: 1, errorCode: null } },
    d1: { id: 'd1', name: null, fileBytes: null, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    kv: { id: 'kv', title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: { status: 'ok', source: 'local', observedAt: 1, errorCode: null } },
    lb: { account: null, origins: [] },
  };
  const result = buildRegistrations([row], [local], [d1OnlyOrigin]);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin.id, 'origin-elsewhere');
  assert.equal(result[0].topologyStatus, 'pending_topology');
});

test('a remote peer unable to resolve its own self warns and marks the topology inconsistent', async () => {
  const env = fourPeerEnv();
  const writes = [];
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash, !peer.url.includes('w1')) }),
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.topology.consistent, false);
  assert.equal(result.accounts[1].self, false, 'row keeps the requester-local topology self flag');
  assert.equal(result.accounts[2].self, false, 'a healthy remote also reports requester-local self false');
  assert.equal(result.warnings.filter((warning) => warning.code === 'SELF_FLAG_MISMATCH').length, 1);
  assert.ok(result.warnings.some((warning) => warning.code === 'SELF_FLAG_MISMATCH' && warning.peerUrl === 'https://w1.test'));
  assert.equal(writes.length, 0);
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('a healthy topology with healthy remotes is consistent and gets cached', async () => {
  const env = fourPeerEnv();
  const writes = [];
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.topology.consistent, true);
  assert.equal(result.warnings.filter((warning) => warning.code === 'SELF_FLAG_MISMATCH').length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].snapshot.topology.consistent, true);
});

test('an inconsistent topology is not hidden by stale fallback when collection is also incomplete', async () => {
  const env = fourPeerEnv({ PEER_INDEX: '9' });
  const cached = adminInventoryFixture({ observedAt: Date.now() - 600_000, stale: true }, env);
  const writes = [];
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => cached,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => peer.url.includes('w2')
      ? { ok: false, errorCode: 'PEER_HTTP_503' }
      : { ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) },
    collectSelf: async () => { throw new Error('must not collect'); },
    collectB2: async () => emptyB2,
  });
  assert.equal(result.stale, false, 'inconsistency must stay visible');
  assert.equal(result.topology.consistent, false);
  assert.notEqual(result.observedAt, cached.observedAt);
  assert.equal(result.accounts.filter((row) => !row.reachable).length, 1);
  assert.ok(result.warnings.some((warning) => warning.code === 'SELF_NOT_CONFIGURED'));
  assert.ok(result.warnings.some((warning) => warning.code === 'PEER_HTTP_503'));
  assert.equal(writes.length, 0);
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('nonempty topology without a self peer is inconsistent and reports SELF_NOT_CONFIGURED', async () => {
  const env = fourPeerEnv({ PEER_INDEX: '9' });
  const writes = [];
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
    collectSelf: async () => { throw new Error('must not collect'); },
    collectB2: async () => emptyB2,
  });
  assert.equal(result.accounts.length, 4);
  assert.equal(result.topology.consistent, false);
  assert.equal(result.stale, false, 'inconsistency must stay visible instead of stale-falling-back');
  assert.equal(writes.length, 0, 'inconsistent snapshot must not be cached');
  assert.ok(result.warnings.some((warning) => warning.code === 'SELF_NOT_CONFIGURED' && warning.peerUrl === null));
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('self collector payload failing the peer schema becomes an unavailable self row', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
    collectSelf: async () => ({ ...selfInventoryFor(env, true), account: { id: null, name: null } }),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.accounts[0].reachable, false);
  assert.equal(result.accounts[0].account.state.errorCode, 'SELF_SCHEMA_INVALID');
  assert.ok(result.warnings.some((warning) => warning.code === 'SELF_SCHEMA_INVALID' && warning.peerUrl === 'https://w0.test'));
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('remote payload failing the peer schema becomes an unavailable row', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    fetchPeer: async (_env, peer) => peer.url.includes('w1')
      ? { ok: true, data: { topologyHash: 'abc', self: false } }
      : { ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) },
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.equal(result.accounts[1].reachable, false);
  assert.equal(result.accounts[1].account.state.errorCode, 'PEER_SCHEMA_INVALID');
  assert.ok(result.warnings.some((warning) => warning.code === 'PEER_SCHEMA_INVALID' && warning.peerUrl === 'https://w1.test'));
  assert.equal(AdminInventorySchema.safeParse(result).success, true);
});

test('a changed PEER_INDEX cannot reuse a cache built for the same urls', async () => {
  const original = envForCount(4);
  const shifted = fourPeerEnv({ PEER_INDEX: '2' });
  const cached = adminInventoryFixture({}, original);
  assert.equal(getTopology(original).hash, getTopology(shifted).hash, 'hash must stay url-order-only');
  let selfCalls = 0;
  const result = await buildAdminInventory(shifted, stubDb(), false, {
    readCache: async () => cached,
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, false, getTopology(shifted).hash) }),
    collectSelf: async () => { selfCalls += 1; return selfInventoryFor(shifted, false); },
    collectB2: async () => emptyB2,
  });
  assert.equal(selfCalls, 1, 'changed self peer must invalidate the cache');
  assert.equal(result.accounts[2].self, true);
  assert.equal(result.accounts[0].self, false);
});

for (const [label, configure] of [
  ['self flag mismatch', (env) => ({
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash, !peer.url.includes('w1')) }),
    collectSelf: async () => selfInventoryFor(env, true),
  })],
  ['reachable hash mismatch', (env) => ({
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, peer.url.includes('w2') ? 'different-hash' : getTopology(env).hash) }),
    collectSelf: async () => selfInventoryFor(env, true),
  })],
  ['missing self peer', (env) => ({
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
  })],
]) {
  test(`${label} keeps the fresh response visible and is not cached`, async () => {
    const env = label === 'missing self peer' ? fourPeerEnv({ PEER_INDEX: '9' }) : fourPeerEnv();
    const writes = [];
    const result = await buildAdminInventory(env, stubDb(), true, {
      readCache: async () => null,
      writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
      collectB2: async () => emptyB2,
      ...configure(env),
    });
    assert.equal(result.accounts.every((row) => row.reachable), true, `${label} fixture must keep every peer reachable`);
    assert.equal(result.topology.consistent, false, label);
    assert.equal(result.stale, false, label);
    assert.equal(writes.length, 0, `${label} must not be cached`);
    assert.equal(AdminInventorySchema.safeParse(result).success, true, label);
  });

  test(`${label} does not stale-fall-back over an existing cache`, async () => {
    const env = label === 'missing self peer' ? fourPeerEnv({ PEER_INDEX: '9' }) : fourPeerEnv();
    const cached = adminInventoryFixture({ observedAt: Date.now() - 600_000, stale: true }, env);
    const result = await buildAdminInventory(env, stubDb(), true, {
      readCache: async () => cached,
      collectB2: async () => emptyB2,
      ...configure(env),
    });
    assert.equal(result.stale, false, label);
    assert.equal(result.topology.consistent, false, label);
    assert.notEqual(result.observedAt, cached.observedAt, label);
  });
}

test('a consistent snapshot is still cached so the invariant is not vacuous', async () => {
  const env = fourPeerEnv();
  const writes = [];
  await buildAdminInventory(env, stubDb(), true, {
    readCache: async () => null,
    writeCache: async (key, snapshot) => { writes.push({ key, snapshot }); },
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
  });
  assert.equal(writes.length, 1);
});

test('remote fanout runs in parallel but never exceeds four concurrent collectors', async () => {
  for (const count of [5, 8]) {
    const env = envForCount(count);
    let active = 0;
    let maxActive = 0;
    await buildAdminInventory(env, stubDb(), true, {
      readCache: async () => null,
      fetchPeer: async (_env, peer) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) };
      },
      collectSelf: async () => selfInventoryFor(env, true),
      collectB2: async () => emptyB2,
    });
    assert.ok(maxActive > 1, `N=${count} expected parallel fanout, saw ${maxActive}`);
    assert.ok(maxActive <= 4, `N=${count} expected bounded fanout, saw ${maxActive}`);
  }
});

test('malformed PEER_URLS fails before any collector runs', async () => {
  const env = fourPeerEnv({ PEER_URLS: 'https://w0.test,not-a-url' });
  await assert.rejects(
    buildAdminInventory(env, stubDb(), true, {
      readCache: async () => null,
      fetchPeer: async () => { throw new Error('must not fetch'); },
      collectSelf: async () => { throw new Error('must not collect'); },
      collectB2: async () => { throw new Error('must not collect B2'); },
    }),
    (error) => error.code === 'INVALID_PEER_URLS'
  );
});

test('coordinator cache round-trips through the real KV json read and write path', async () => {
  const env = fourPeerEnv();
  const kv = recordingKv();
  env.CACHE_KV = kv;
  let selfCalls = 0;
  const first = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url, true, getTopology(env).hash) }),
    collectSelf: async () => { selfCalls += 1; return selfInventoryFor(env, true); },
    collectB2: async () => emptyB2,
  });
  assert.equal(kv.puts.length, 1);
  assert.equal(selfCalls, 1);
  const second = await buildAdminInventory(env, stubDb(), false, {
    fetchPeer: async () => { throw new Error('must not fetch'); },
    collectSelf: async () => { selfCalls += 1; return selfInventoryFor(env, true); },
    collectB2: async () => { throw new Error('must not collect B2'); },
  });
  assert.equal(selfCalls, 1, 'second request must be served from the real KV cache');
  assert.deepEqual(second, first);
});

test('admin inventory route is protected and no-store', async () => {
  const app = new Hono();
  app.route('/api/admin', router);
  const response = await app.request('/api/admin/inventory', {}, fourPeerEnv());
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('inventory router middleware does not leak onto a sibling admin route', async () => {
  const response = await apiApp.request('/api/admin/overview?days=7', {}, fourPeerEnv());
  assert.notEqual(response.status, 400, 'inventory query guard must not reject sibling routes');
  assert.equal(response.status, 403, 'sibling route keeps its own auth behavior');
});

test('inventory router middleware does not leak onto a sibling admin route with an unusual query', async () => {
  const response = await apiApp.request('/api/admin/scrape-jobs?limit=5&status=failed&source=komiku', {}, fourPeerEnv());
  assert.notEqual(response.status, 400);
  assert.equal(response.status, 403);
});

test('inventory route still rejects unknown, duplicate and non-one refresh queries', async () => {
  const app = new Hono();
  app.route('/api/admin', router);
  const { env, cookie } = await adminSession(onePeerEnv());
  for (const query of ['?refresh=0', '?refresh=1&refresh=1', '?refresh=1&extra=1', '?extra=1']) {
    const unauth = await app.request(`/api/admin/inventory${query}`, {}, onePeerEnv());
    assert.equal(unauth.status, 403, `unauthenticated ${query} must not reveal the query allowlist`);
    const response = await app.request(`/api/admin/inventory${query}`, { headers: { cookie } }, env);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'invalid query' });
  }
});

test('a valid refresh query passes the allowlist for an authenticated admin', async () => {
  const app = new Hono();
  app.route('/api/admin', router);
  const { env, cookie } = await adminSession(onePeerEnv({ CACHE_KV: { store: {}, async get() { return null; }, async put() {} } }));
  const response = await app.request('/api/admin/inventory?refresh=1', { headers: { cookie } }, env);
  assert.notEqual(response.status, 400, '?refresh=1 is the one allowed query');
  assert.notEqual(response.status, 403, 'the session must be accepted by the auth seam');
});

test('admin inventory route enforces the admin rate limit before auth', async () => {
  const app = new Hono();
  app.route('/api/admin', router);
  const ip = `10.77.0.${Math.floor(Math.random() * 250) + 1}`;
  const headers = { 'cf-connecting-ip': ip };
  let limited = false;
  for (let attempt = 0; attempt < 2 && !limited; attempt++) {
    for (let i = 0; i < 601; i++) {
      const response = await app.request('/api/admin/inventory', headers, fourPeerEnv());
      if (response.status === 429) { limited = true; break; }
      assert.equal(response.status, 403);
    }
  }
  assert.equal(limited, true, 'admin rate limit must apply to the inventory route');
});

test('coordinator response excludes secrets', async () => {
  const env = onePeerEnv({ CF_INVENTORY_TOKEN: 'inventory-secret' });
  const result = await buildAdminInventory(env, stubDb({ listAccounts: async () => [account(0)] }), true, {
    collectSelf: async () => selfInventoryFor(env, true),
    collectB2: async () => emptyB2,
    readCache: async () => null,
  });
  assert.doesNotMatch(JSON.stringify(result), /CF_INVENTORY_TOKEN|keyId|appKey|encrypted_token|inventory-secret/);
});
