// Bukti deterministik singleflight cold-path: 5 panggilan readThroughCache
// bersamaan utk key sama (fresh+stale kosong) → load() DIPANGGIL 1x.
// (Peta ke kasus "5 user buka page komik bersamaan = 1 request ke source".)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readThroughCache } from '../src/lib/readThroughCache.ts';

const fakeKV = () => {
  const m = new Map();
  return {
    _m: m,
    get: async (k, type) => {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
  };
};

const fakeCtx = () => ({
  env: { CACHE_KV: fakeKV() },
  executionCtx: { waitUntil: (p) => { p.catch(() => {}); } },
});

test('concurrent cold requests share ONE upstream load', async () => {
  const c = fakeCtx();
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 120));
    return { data: { chapters: [1, 2, 3] } };
  };
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => readThroughCache(c, 'series:full:komiku:foo:id', load, {}))
  );
  assert.equal(loads, 1, `expected 1 upstream load, got ${loads}`);
  for (const r of rs) {
    assert.equal(r.source, 'fresh');
    assert.deepEqual(r.data, { data: { chapters: [1, 2, 3] } });
  }
});

test('stale-hit path serves instantly (no blocking on upstream)', async () => {
  const c = fakeCtx();
  await c.env.CACHE_KV.put('s:k1', JSON.stringify({ v: 'old' }));
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 50));
    return { v: 'new' };
  };
  const t0 = Date.now();
  const r = await readThroughCache(c, 'k1', load, {});
  assert.deepEqual(r.data, { v: 'old' }, 'stale served immediately');
  assert.ok(Date.now() - t0 < 40, 'response tidak menunggu upstream');
  await new Promise((res) => setTimeout(res, 150)); // beri jatah background revalidate
  assert.equal(loads, 1, 'satu fetch background untuk revalidate');
});
