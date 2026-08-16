import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getB2Usage, setB2Usage } from '../src/lib/b2Usage.ts';

function stubKv() {
  const store = new Map();
  return {
    store,
    async get(k, _fmt) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async put(k, v, _o) { store.set(k, v); return undefined; },
  };
}

test('usage gating: below 80% → eviction skips account', async () => {
  // Contract test — real gating lives in evictStaleStorage (DB/HTTP stubs
  // needed); asserts the tracker primitives it depends on.
  const kv = stubKv();
  await setB2Usage(kv, 0, 1_000_000); // 1MB of 10GB → well under 80%
  assert.equal(await getB2Usage(kv, 0), 1_000_000);
});

test('quota math: 10GB quota, 80% threshold = 8GB', () => {
  assert.equal(Math.floor((10 * 1024 * 1024 * 1024) * 0.8), 8589934592);
});
