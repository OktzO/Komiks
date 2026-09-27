import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { PeerInventorySchema } from '@manga-platform/shared/types';
import { router } from '../src/routes/internal.ts';
import { getTopology } from '../src/lib/peers.ts';
import { peerInventoryFixture } from './helpers/inventory-fixture.mjs';

function stubEnv(over = {}) {
  const stmt = {
    sql: '', bound: [], boundArgs: [],
    bind(...args) { this.bound = args; return this; },
    run() { return { success: true, meta: {} }; },
    all() { return { results: [{ page_number: 1, r2_key: 'k', r2_account_idx: -1 }] }; },
    first() { return null; },
  };
  const kv = {
    store: { 'series:detail:komiku:naruto:id': JSON.stringify({ data: 1 }) },
    puts: [],
    async get(k, fmt) { const v = this.store[k] ?? null; return v == null ? null : (fmt === 'json' ? JSON.parse(v) : v); },
    async put(k, v, options) { this.store[k] = v; this.puts.push({ key: k, value: v, options }); },
  };
  return {
    DB: {
      prepare(sql) { stmt.sql = sql; stmt.bound = []; return stmt; },
      batch() { return Promise.resolve([]); },
    },
    CACHE_KV: kv,
    DB_FORWARD_KEY: 'sekret',
    ...over,
  };
}

const app = new Hono();
app.route('/api/_internal', router);

test('db/exec rejects without forward key', async () => {
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT 1', params: [], table: 'chapter_pages' }),
  }, stubEnv());
  assert.equal(res.status, 401);
});

test('db/exec rejects DROP/ALTER/TRUNCATE on allowlisted table', async () => {
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'DROP TABLE users', params: [], table: 'users' }),
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('db/query rejects write SQL (SELECT-only)', async () => {
  const res = await app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'UPDATE chapter_pages SET r2_key = NULL', params: [], table: 'chapter_pages' }),
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('db/query returns rows for SELECT on allowlisted table', async () => {
  const res = await app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({
      sql: 'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1',
      params: ['ch-1'], table: 'chapter_pages',
    }),
  }, stubEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.results.length, 1);
  assert.equal(j.results[0].page_number, 1);
});

// The novel tables shard by series, so lib/novelShard.ts forwards reads here.
// Without these two names on the allowlist every cross-shard novel read is a 403
// and the series is unreadable outside its owner.
for (const [table, sql] of [
  ['novel_series', 'SELECT id, title FROM novel_series WHERE id = ?1 LIMIT 1'],
  ['novel_chapters', 'SELECT id, content FROM novel_chapters WHERE series_id = ?1 AND source_chapter_id = ?2 LIMIT 1'],
]) {
  test(`db/query accepts a forwarded novel read on ${table}`, async () => {
    const res = await app.request('/api/_internal/db/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
      body: JSON.stringify({ sql, params: ['x', 'y'], table }),
    }, stubEnv());
    assert.equal(res.status, 200, `${table} must be forwardable`);
    const j = await res.json();
    assert.equal(j.results.length, 1);
  });
}

test('db/exec accepts a novel_series write so the crawler can reach a peer owner', async () => {
  // The catalogue crawl runs on one worker (novel:catalog is owner-gated), so
  // the three quarters this shard does not own have to reach their owner's D1
  // over this endpoint instead of being dropped.
  const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const env = stubEnv();
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({
      sql: 'INSERT INTO novel_series (id, source_series_id, source, title) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(source, source_series_id) DO UPDATE SET title = excluded.title',
      params: ['novelid-x', 'x', 'novelid', 'X'],
      table: 'novel_series',
    }),
  }, env, execCtx);
  assert.equal(res.status, 200, `the write must be accepted, got ${await res.clone().text()}`);
  assert.ok(env.DB, 'and it landed in the local D1');
  // …and still only for novel_series: the allowlist is not widened by proxy.
  const other = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'INSERT INTO novel_paragraphs (id) VALUES (?1)', params: ['x'], table: 'novel_paragraphs' }),
  }, stubEnv(), execCtx);
  assert.equal(other.status, 403);
});


test('the novel allowlist entries do not open up writes or other tables', async () => {
  const post = (sql, table) => app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql, params: [], table }),
  }, stubEnv());
  // Same novel table, write shape.
  assert.equal((await post('DELETE FROM novel_chapters', 'novel_chapters')).status, 403);
  // novel table named, but the FROM is a table that is not allowlisted.
  assert.equal((await post('SELECT id FROM users', 'novel_series')).status, 403);
  // A table nobody added.
  assert.equal((await post('SELECT id FROM novel_paragraphs', 'novel_paragraphs')).status, 403);
});

test('kv/get rejects non-allowlisted key prefix', async () => {
  const res = await app.request('/api/_internal/kv/get?key=secret:data', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('kv/get returns cached value for allowlisted prefix', async () => {
  const res = await app.request('/api/_internal/kv/get?key=series:detail:komiku:naruto:id', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, stubEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.value, { data: 1 });
});

test('kv/get returns cached value for f:resolve: prefix', async () => {
  const env = stubEnv();
  env.CACHE_KV.store['f:resolve:test-slug'] = JSON.stringify({ data: { slug: 'test-slug' } });
  const res = await app.request('/api/_internal/kv/get?key=f:resolve:test-slug', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.value, { data: { slug: 'test-slug' } });
});

test('admin inventory rejects missing/wrong internal key', async () => {
  const missing = await app.request('/api/_internal/admin/inventory', { method: 'POST' }, stubEnv());
  assert.equal(missing.status, 403);
  const wrong = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-forward-key': 'wrong' },
  }, stubEnv());
  assert.equal(wrong.status, 403);
});

test('admin inventory accepts constant-time mirror auth', async () => {
  const res = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-mirror-key': 'mirror-secret', 'x-db-mirror': '1' },
  }, stubEnv({ DB_MIRROR_KEY: 'mirror-secret' }));
  assert.equal(res.status, 200);
});

test('admin inventory rejects invalid mirror auth', async () => {
  const env = stubEnv({ DB_MIRROR_KEY: 'mirror-secret' });
  const wrong = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-mirror-key': 'wrong', 'x-db-mirror': '1' },
  }, env);
  assert.equal(wrong.status, 403);
  const missingMarker = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-mirror-key': 'mirror-secret' },
  }, env);
  assert.equal(missingMarker.status, 403);
});

test('admin inventory rejects query input except refresh=1', async () => {
  for (const query of [
    '?resource=other-account',
    '?refresh=0',
    '?refresh=1&resource=other-account',
    '?refresh=1&refresh=1',
  ]) {
    const res = await app.request(`/api/_internal/admin/inventory${query}`, {
      method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
    }, stubEnv());
    assert.equal(res.status, 400, query);
  }
});

test('admin inventory returns fixed safe peer shape', async () => {
  const env = stubEnv({
    PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
    CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
    DB_FORWARD_KEY: 'known-forward-secret',
    LB_ENCRYPTION_KEY: 'known-lb-secret',
    B2_CONFIG: JSON.stringify({ keyId: 'known-b2-key', appKey: 'known-b2-app', encrypted_token: 'known-encrypted-token' }),
  });
  const res = await app.request('/api/_internal/admin/inventory?refresh=1', {
    method: 'POST', headers: { 'x-db-forward-key': 'known-forward-secret' },
  }, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('vary'), 'Authorization, Cookie');
  const text = await res.text();
  assert.doesNotMatch(text, /CF_INVENTORY_TOKEN|known-forward-secret|known-lb-secret|known-b2-key|known-b2-app|known-encrypted-token/);
  const payload = JSON.parse(text);
  assert.deepEqual(Object.keys(payload), ['data']);
  const { data } = payload;
  assert.equal(PeerInventorySchema.safeParse(data).success, true);
  assert.equal(data.account.id, 'acct-1');
  assert.equal(data.account.name, 'oktz');
});

test('admin inventory rejects oversized declared body', async () => {
  const res = await app.request('/api/_internal/admin/inventory', {
    method: 'POST',
    headers: { 'x-db-forward-key': 'sekret', 'content-length': '1025' },
    body: 'x',
  }, stubEnv());
  assert.equal(res.status, 413);
});

test('admin inventory rejects unknown-length non-empty body without full buffering', async () => {
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls < 3) controller.enqueue(new TextEncoder().encode('x'));
      else controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const res = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' }, body, duplex: 'half',
  }, stubEnv());
  assert.equal(res.status, 400);
  assert.ok(pulls <= 2);
  assert.equal(canceled, true);
});

test('admin inventory rejects non-empty body', async () => {
  const res = await app.request('/api/_internal/admin/inventory', {
    method: 'POST',
    headers: { 'x-db-forward-key': 'sekret', 'content-type': 'application/json' },
    body: JSON.stringify({ resource: 'other-account' }),
  }, stubEnv());
  assert.equal(res.status, 400);
});

test('admin inventory caches fresh peer snapshot unless refresh=1', async () => {
  const env = stubEnv({
    PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
    CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
  });
  const hash = getTopology(env).hash;
  const cacheKey = `peer:inventory:v2:${hash}`;
  env.CACHE_KV.store[cacheKey] = JSON.stringify({ data: peerInventoryFixture({ topologyHash: hash, self: true }) });
  const cached = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal((await cached.json()).data.account.name, 'Oktz');
  assert.equal(env.CACHE_KV.puts.length, 0);
  const refreshed = await app.request('/api/_internal/admin/inventory?refresh=1', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).data.account.name, 'oktz');
  assert.equal(env.CACHE_KV.puts.length, 1);
  assert.equal(env.CACHE_KV.puts[0].key, cacheKey);
  assert.equal(env.CACHE_KV.puts[0].options.expirationTtl, 300);
});

test('admin inventory recollects malformed or wrong-hash cache', async () => {
  for (const cachedData of [
    { malformed: true },
    peerInventoryFixture({ topologyHash: 'wrong-hash', self: true }),
  ]) {
    const env = stubEnv({
      PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
      CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
    });
    const cacheKey = `peer:inventory:v2:${getTopology(env).hash}`;
    env.CACHE_KV.store[cacheKey] = JSON.stringify({ data: cachedData });
    const res = await app.request('/api/_internal/admin/inventory', {
      method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
    }, env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.account.name, 'oktz');
    assert.equal(env.CACHE_KV.puts.length, 1);
    assert.equal(env.CACHE_KV.puts[0].key, cacheKey);
  }
});

test('admin inventory recollects a same-hash cache whose self flag no longer matches the topology', async () => {
  for (const [label, peerIndex, cachedSelf, expectedSelf] of [
    ['peer gained a valid self', '0', false, true],
    ['peer lost its self', '9', true, false],
  ]) {
    const env = stubEnv({
      PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: peerIndex,
      CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
    });
    const cacheKey = `peer:inventory:v2:${getTopology(env).hash}`;
    env.CACHE_KV.store[cacheKey] = JSON.stringify({ data: peerInventoryFixture({ topologyHash: getTopology(env).hash, self: cachedSelf }) });
    const res = await app.request('/api/_internal/admin/inventory', {
      method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
    }, env);
    assert.equal(res.status, 200, label);
    const { data } = await res.json();
    assert.equal(data.self, expectedSelf, label);
    assert.equal(data.account.id, 'acct-1', label);
    assert.equal(env.CACHE_KV.puts.length, 1, label);
    assert.equal(env.CACHE_KV.puts[0].key, cacheKey, label);
  }
});

test('admin inventory serves a same-hash cache whose self flag already matches the topology', async () => {
  const env = stubEnv({
    PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
    CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
  });
  const cacheKey = `peer:inventory:v2:${getTopology(env).hash}`;
  env.CACHE_KV.store[cacheKey] = JSON.stringify({ data: peerInventoryFixture({ topologyHash: getTopology(env).hash, self: true }) });
  const res = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal((await res.json()).data.account.name, 'Oktz');
  assert.equal(env.CACHE_KV.puts.length, 0);
});

test('admin inventory returns collection when cache write fails', async () => {
  const env = stubEnv({
    PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
    CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
  });
  env.CACHE_KV.put = async () => { throw new Error('kv unavailable'); };
  const res = await app.request('/api/_internal/admin/inventory?refresh=1', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.account.id, 'acct-1');
});
