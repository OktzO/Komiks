import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPeers, ownerFor, backupOwnerFor, getTopology, fetchPeerInventory, internalExec, internalExecCounted, internalQuery, peerKvGet } from '../src/lib/peers.ts';
import { peerInventoryFixture } from './helpers/inventory-fixture.mjs';
import { ResourceStatus, ResourceSource } from '@manga-platform/shared/types';

const URLS = 'https://a.example.com,https://b.example.com,https://c.example.com';
const env = (over = {}) => ({ PEER_URLS: URLS, PEER_INDEX: '1', DB_FORWARD_KEY: 'sekret', ...over });

test('resource contracts expose canonical literal values', () => {
  assert.deepEqual(ResourceStatus.options, ['ok', 'degraded', 'unavailable']);
  assert.deepEqual(ResourceSource.options, ['live', 'local', 'tracked', 'derived', 'unavailable']);
});

test('getPeers parses URLS + marks self via PEER_INDEX', () => {
  const peers = getPeers(env());
  assert.equal(peers.length, 3);
  assert.equal(peers[0].index, 0);
  assert.equal(peers[1].self, true);
  assert.equal(peers[0].self, false);
  assert.equal(peers[2].url, 'https://c.example.com');
});

for (const count of [0, 1, 2, 4, 5]) {
  test(`topology N=${count} is ordered and hash is deterministic`, () => {
    const urls = Array.from({ length: count }, (_, i) => `https://w${i}.example.com`);
    const a = getTopology(env({ PEER_URLS: urls.join(','), PEER_INDEX: count ? '0' : '' }));
    const b = getTopology(env({ PEER_URLS: urls.join(','), PEER_INDEX: count ? '0' : '' }));
    assert.equal(a.count, count);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.peers.map((p) => p.url), urls);
  });
}

test('topology hash changes when order changes', () => {
  const a = getTopology(env({ PEER_URLS: 'https://a.test,https://b.test', PEER_INDEX: '0' }));
  const b = getTopology(env({ PEER_URLS: 'https://b.test,https://a.test', PEER_INDEX: '1' }));
  assert.notEqual(a.hash, b.hash);
});

test('fetchPeerInventory uses internal key and fixed endpoint', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://b.example.com/api/_internal/admin/inventory');
    assert.equal(init.headers['x-db-forward-key'], 'sekret');
    return new Response(JSON.stringify({ data: peerInventoryFixture({ topologyHash: 'abc', self: false }) }), { status: 200 });
  };
  const result = await fetchPeerInventory(env(), { url: 'https://b.example.com', index: 1, self: false });
  assert.equal(result.ok, true);
  delete globalThis.fetch;
});

test('ownerFor maps deterministically into [0, len)', () => {
  for (let i = 0; i < 50; i++) {
    const o = ownerFor(env(), `ch-${i}`);
    assert.ok(o.index >= 0 && o.index < 3);
    assert.equal(o.url, URLS.split(',')[o.index]);
  }
});

test('ownerFor is stable across calls', () => {
  assert.equal(ownerFor(env(), 'naruto-chapter-1').index, ownerFor(env(), 'naruto-chapter-1').index);
});

test('distribution roughly balanced', () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 900; i++) counts[ownerFor(env(), `manga-${i}`).index]++;
  for (const c of counts) {
    assert.ok(c > 200, `count ${c} too low`);
    assert.ok(c < 400, `count ${c} too high`);
  }
});

test('N=1 (single peer) → ownerFor/backupOwnerFor selalu self, no-op sharding', async () => {
  const e = env({ PEER_URLS: 'https://only.example.com', PEER_INDEX: '0' });
  const peers = getPeers(e);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].self, true);
  for (let i = 0; i < 25; i++) {
    const o = ownerFor(e, `ch-${i}`);
    assert.equal(o.index, 0);
    assert.equal(o.self, true);
    const b = backupOwnerFor(e, `ch-${i}`);
    if (b) assert.equal(b.index, 0);
  }
});

test('N=2 → ownerFor memetakan ke salah satu dari 2 peer + backup = peer satunya', () => {
  const e = env({ PEER_URLS: 'https://a.example.com,https://b.example.com', PEER_INDEX: '1' });
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const o = ownerFor(e, `ch-${i}`);
    assert.ok(o.index === 0 || o.index === 1);
    seen.add(o.index);
    const b = backupOwnerFor(e, `ch-${i}`);
    assert.ok(b && b.index !== o.index, 'backup != primary di N=2');
  }
  assert.equal(seen.size, 2);
});

test('PEER_URLS kosong → no-op (0 peer, ownerFor self)', async () => {
  const e = env({ PEER_URLS: '' });
  assert.equal(getPeers(e).length, 0);
  const o = ownerFor(e, 'x');
  assert.equal(o.self, true);
  assert.equal(o.index, 0);
});

test('trailing slash is normalized so the same peer is not listed twice', () => {
  const e = env({ PEER_URLS: 'https://a.example.com/,https://b.example.com//,https://a.example.com', PEER_INDEX: '0' });
  const peers = getPeers(e);
  assert.deepEqual(peers.map((p) => p.url), ['https://a.example.com', 'https://b.example.com']);
  const topology = getTopology(e);
  assert.equal(topology.count, 2);
  assert.equal(topology.hash, getTopology(env({ PEER_URLS: 'https://a.example.com,https://b.example.com', PEER_INDEX: '0' })).hash);
});

test('topology keeps configured order after normalization', () => {
  const ordered = getTopology(env({ PEER_URLS: 'https://c.example.com/,https://a.example.com,https://b.example.com/', PEER_INDEX: '0' }));
  const reversed = getTopology(env({ PEER_URLS: 'https://b.example.com,https://c.example.com/,https://a.example.com', PEER_INDEX: '0' }));
  assert.deepEqual(ordered.peers.map((p) => p.url), ['https://c.example.com', 'https://a.example.com', 'https://b.example.com']);
  assert.notEqual(ordered.hash, reversed.hash);
});

test('getTopology throws stable INVALID_PEER_URLS for a malformed entry', () => {
  for (const bad of ['https://a.test,not-a-url', 'https://a.test,ftp://a.test', 'https://a.test,/']) {
    assert.throws(
      () => getTopology(env({ PEER_URLS: bad, PEER_INDEX: '0' })),
      (error) => error.code === 'INVALID_PEER_URLS' && !/not-a-url|ftp:\/\//.test(error.message),
      bad
    );
  }
});

test('malformed PEER_URLS does not break routing peers or ownerFor', () => {
  const e = env({ PEER_URLS: 'https://a.test,not-a-url', PEER_INDEX: '0' });
  assert.equal(getPeers(e).length, 2);
  assert.doesNotThrow(() => ownerFor(e, 'x'));
});

test('internalExec POSTs to /api/_internal/db/exec with forward key', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, changes: 3 }), { status: 200 });
  };
  assert.equal(
    await internalExec(env(), 'https://b.example.com', {
      sql: 'INSERT INTO chapter_pages ...', params: [1], table: 'chapter_pages',
    }),
    true
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://b.example.com/api/_internal/db/exec');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-db-forward-key'], 'sekret');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.table, 'chapter_pages');
  delete globalThis.fetch;
});

// The return type IS the contract, and 6fe6f18 broke it. Widening internalExec
// from `boolean` to `{ ok, changes }` for one caller made every other caller's
// `if (!ok)` dead — an object is always truthy — so a failed forward reported
// success with no local write and no outbox retry, at six call sites, and both
// `tsc` and the suite stayed green. Pinned per outcome, as a boolean.
test('internalExec answers a boolean, because the fallback depends on it being falsy', async () => {
  const payload = { sql: 'UPDATE chapter_pages SET r2_key = ?1', params: ['k'], table: 'chapter_pages' };
  const cases = [
    ['a 2xx write that changed a row', () => new Response(JSON.stringify({ ok: true, changes: 3 }), { status: 200 }), true],
    ['a 2xx write that matched nothing', () => new Response(JSON.stringify({ ok: true, changes: 0 }), { status: 200 }), true],
    ['a non-2xx', () => new Response('{}', { status: 500 }), false],
    ['an unreachable peer', () => Promise.reject(new Error('connection refused')), false],
  ];
  for (const [label, fetchImpl, expected] of cases) {
    globalThis.fetch = async () => (typeof fetchImpl === 'function' ? fetchImpl() : fetchImpl);
    const res = await internalExec(env(), 'https://b.example.com', payload);
    assert.equal(typeof res, 'boolean', `${label}: expected a boolean, got ${typeof res}`);
    assert.equal(res, expected, label);
    // The mistake a call site makes is reaching for `.ok`. On the boolean
    // contract that is undefined, so it can never be mistaken for success.
    assert.equal(res.ok, undefined, label);
  }
  delete globalThis.fetch;
});

test('internalExec is false without a key or without a peer', async () => {
  const payload = { sql: '', params: [], table: 'chapter_pages' };
  assert.equal(await internalExec(env({ DB_FORWARD_KEY: undefined }), 'https://b.example.com', payload), false);
  assert.equal(await internalExec(env(), '', payload), false);
});

// The row count has exactly one caller, and it has to ask for it by name.
test('internalExecCounted is the opt-in that carries the owner\'s row count', async () => {
  const payload = { sql: 'UPDATE novel_series SET author = ?1 WHERE id = ?2', params: ['x', 'y'], table: 'novel_series' };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, target: 'local', changes: 3 }), { status: 200 });
  assert.deepEqual(await internalExecCounted(env(), 'https://b.example.com', payload), { ok: true, changes: 3 });
  // 0 changes on a 2xx is the signal that the write reached a shard holding no
  // such row — forwarded, and matched nothing.
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, target: 'local', changes: 0 }), { status: 200 });
  assert.deepEqual(await internalExecCounted(env(), 'https://b.example.com', payload), { ok: true, changes: 0 });
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  assert.deepEqual(await internalExecCounted(env(), 'https://b.example.com', payload), { ok: false, changes: 0 });
  assert.deepEqual(
    await internalExecCounted(env({ DB_FORWARD_KEY: undefined }), 'https://b.example.com', payload),
    { ok: false, changes: 0 }
  );
  delete globalThis.fetch;
});

test('internalQuery returns rows on 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, results: [{ page_number: 1 }] }), { status: 200 });
  const rows = await internalQuery(env(), 'https://c.example.com', 'SELECT ...', [], 'chapter_pages');
  assert.deepEqual(rows, [{ page_number: 1 }]);
  delete globalThis.fetch;
});

test('internalQuery returns null on non-ok', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
  const rows = await internalQuery(env(), 'https://c.example.com', 'SELECT ...', [], 'chapter_pages');
  assert.equal(rows, null);
  delete globalThis.fetch;
});

test('peerKvGet returns first non-null value from peers', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ value: url.includes('a.example') ? { data: 42 } : null }), { status: 200 });
  };
  const v = await peerKvGet(env(), 'series:detail:komiku:naruto:id');
  assert.equal(v.data, 42);
  assert.ok(seen.some((u) => u.includes('kv/get')));
  delete globalThis.fetch;
});
