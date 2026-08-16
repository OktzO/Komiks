import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readThroughCache } from '../src/lib/readThroughCache.ts';

function stubCtx(store = {}) {
  const kv = {
    store,
    async get(k, fmt) { const v = this.store[k] ?? null; return v == null ? null : (fmt === 'json' ? JSON.parse(v) : v); },
    async put(k, v, opts) { this.store[k] = v; return undefined; },
    async delete(k) { delete this.store[k]; return undefined; },
  };
  return {
    env: { CACHE_KV: kv },
    executionCtx: { waitUntil: async (p) => { try { await p; } catch {} } },
  };
}

test('peerFallback used on both-miss and cached locally', async () => {
  const c = stubCtx();
  let originCalls = 0;
  const res = await readThroughCache(
    c,
    'series:detail:komiku:naruto:id',
    async () => { originCalls++; return { from: 'origin' }; },
    {
      freshTtl: 600, staleTtl: 86400,
      peerFallback: async () => ({ from: 'peer' }),
    }
  );
  assert.equal(res.source, 'fresh');
  assert.deepEqual(res.data, { from: 'peer' });
  assert.equal(originCalls, 0);
  assert.ok(c.env.CACHE_KV.store['f:series:detail:komiku:naruto:id'] !== undefined);
  assert.ok(c.env.CACHE_KV.store['s:series:detail:komiku:naruto:id'] !== undefined);
});

test('peerFallback null → falls through to origin', async () => {
  const c = stubCtx();
  let originCalls = 0;
  const res = await readThroughCache(
    c,
    'chapters:list:komiku:naruto:id',
    async () => { originCalls++; return { from: 'origin' }; },
    { peerFallback: async () => null }
  );
  assert.equal(originCalls, 1);
  assert.deepEqual(res.data, { from: 'origin' });
});

test('peerFallback skipped on fresh hit', async () => {
  const fresh = JSON.stringify({ from: 'fresh' });
  const c = stubCtx({ 'f:chapter:detail:komiku:ch-1': fresh });
  let peerCalls = 0;
  const res = await readThroughCache(
    c,
    'chapter:detail:komiku:ch-1',
    async () => { throw new Error('should not load'); },
    { peerFallback: async () => { peerCalls++; return null; } }
  );
  assert.equal(res.source, 'fresh');
  assert.equal(peerCalls, 0);
});
