import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getB2Usage, getB2UsageLive, addB2Usage, setB2Usage, quotaBytes, usageRatio } from '../src/lib/b2Usage.ts';

function stubKv() {
  const store = new Map();
  return {
    store,
    puts: [],
    async get(k, _fmt) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async put(k, v, _opts) { this.puts.push(k); store.set(k, v); return undefined; },
  };
}

// pendingKv / knownKv are module-level, so a delta left buffered by one test
// shows up in the next one's getB2UsageLive. Each test uses its own idx.

test('getB2Usage empty → 0', async () => {
  assert.equal(await getB2Usage(stubKv(), 0), 0);
});

test('addB2Usage accumulates per idx independently', async () => {
  const kv = stubKv();
  assert.equal(await addB2Usage(kv, 3, 100), 100);
  assert.equal(await addB2Usage(kv, 3, 50), 150);
  assert.equal(await addB2Usage(kv, 4, 999), 999);
  // uploadToStorage reads the live figure, which must include deltas still
  // buffered instead of waiting on the flush window.
  assert.equal(await getB2UsageLive(kv, 3), 150);
  assert.equal(await getB2UsageLive(kv, 4), 999);
});

test('addB2Usage batches KV writes inside one flush window', async () => {
  const kv = stubKv();
  for (let i = 0; i < 5; i += 1) await addB2Usage(kv, 9, 10);
  // Five adds, one window. The free tier allows 1000 KV writes/day, so a write
  // per call is exactly the regression this batching exists to prevent.
  assert.ok(kv.puts.length <= 1, `expected at most one flush, got ${kv.puts.length}`);
  assert.equal(await getB2UsageLive(kv, 9), 50);
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
  await setB2Usage(kv, 5, 5 * 1024 * 1024 * 1024); // 5GB
  assert.equal(await usageRatio({}, kv, 5), 0.5);
  assert.equal(await usageRatio({ B2_QUOTA_BYTES: '100' }, kv, 5), 53687091.2);
});
