import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getB2Usage, addB2Usage, setB2Usage, quotaBytes, usageRatio } from '../src/lib/b2Usage.ts';

function stubKv() {
  const store = new Map();
  return {
    store,
    async get(k, _fmt) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async put(k, v, _opts) { store.set(k, v); return undefined; },
  };
}

test('getB2Usage empty → 0', async () => {
  assert.equal(await getB2Usage(stubKv(), 0), 0);
});

test('addB2Usage accumulates per idx independently', async () => {
  const kv = stubKv();
  await addB2Usage(kv, 0, 100);
  await addB2Usage(kv, 0, 50);
  await addB2Usage(kv, 1, 999);
  assert.equal(await getB2Usage(kv, 0), 150);
  assert.equal(await getB2Usage(kv, 1), 999);
});

test('setB2Usage overwrites', async () => {
  const kv = stubKv();
  await setB2Usage(kv, 0, 42);
  assert.equal(await getB2Usage(kv, 0), 42);
});

test('quotaBytes default 10GB, env override', () => {
  assert.equal(quotaBytes({}), 10 * 1024 * 1024 * 1024);
  assert.equal(quotaBytes({ B2_QUOTA_BYTES: '2048' }), 2048);
});

test('usageRatio = used/quota', async () => {
  const kv = stubKv();
  await setB2Usage(kv, 0, 5 * 1024 * 1024 * 1024); // 5GB
  assert.equal(await usageRatio({}, kv, 0), 0.5);
  assert.equal(await usageRatio({ B2_QUOTA_BYTES: '100' }, kv, 0), 53687091.2);
});
