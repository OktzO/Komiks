// apps/api-cf/test/resolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolveResponse, resolveLiveFallback, router } from '../src/routes/resolve.ts';

test('resolves canonical type+source, recommended = most chapters', () => {
  const out = buildResolveResponse(
    { slug: 'solo-leveling', type: 'manhwa', source: 'komiku' },
    [
      { source: 'komiku', source_slug: 'solo-leveling', has_chapter_list: 1, chapter_count: 100, last_scraped_at: 1 },
      { source: 'bacakomik', source_slug: 'solo-leveling', has_chapter_list: 1, chapter_count: 179, last_scraped_at: 2 },
    ]
  );
  assert.equal(out.type, 'manhwa');
  assert.equal(out.source, 'komiku');
  assert.equal(out.recommendedSource, 'bacakomik');
});

test('unknown slug → null', () => {
  assert.equal(buildResolveResponse(null, []), null);
});

test('wrong-type caller detected via type field', () => {
  const out = buildResolveResponse(
    { slug: 'one-piece', type: 'manga', source: 'komiku' },
    [{ source: 'komiku', source_slug: 'one-piece', has_chapter_list: 1, chapter_count: 10, last_scraped_at: 1 }]
  );
  assert.equal(out.type, 'manga');
});

// Regression phantom-write: halaman "detail" yang ter-fabrikasi parser
// (title = slug, mis. probe bot /manga/11) harus DITOLAK live-fallback —
// tidak di-persist ke D1, dan route men-set negative cache.
const phantomHtml = '<html><head></head><body><h1 class="entry-title">11</h1></body></html>';

const mkKV = (store = new Map()) => ({
  store,
  async get(key, type) {
    const v = store.has(key) ? store.get(key) : null;
    if (v === null || type !== 'json') return v;
    try { return JSON.parse(v); } catch { return v; }
  },
  async put(key, val) { store.set(key, val); },
  async delete(key) { store.delete(key); },
});

const mkDb = (sqlCalls) => ({
  prepare(sql) {
    sqlCalls.push(sql);
    return {
      bind() { return { first: async () => null, all: async () => ({ results: [] }) }; },
    };
  },
});

test('resolveLiveFallback rejects phantom candidate (title = slug) → null, no D1 writes', async () => {
  const orig = globalThis.fetch;
  const sqlCalls = [];
  try {
    globalThis.fetch = async () => new Response(phantomHtml, { status: 200 });
    const c = {
      env: { DB: mkDb(sqlCalls), CACHE_KV: mkKV() },
      executionCtx: { waitUntil: () => {} },
    };
    const out = await resolveLiveFallback(c, '11');
    assert.equal(out, null, 'phantom series must not be accepted');
    assert.deepEqual(sqlCalls.filter((s) => /INSERT|UPDATE/i.test(s)), [], 'no persist attempted');
  } finally {
    globalThis.fetch = orig;
  }
});

test('GET /resolve/:slug all candidates invalid → 404 + negative cache resolve404 set', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(phantomHtml, { status: 200 });
    const store = new Map();
    const env = { DB: mkDb([]), CACHE_KV: mkKV(store) };
    const ctx = { waitUntil: (p) => { p.catch(() => {}); }, passThroughOnException: () => {} };
    const res = await router.fetch(new Request('http://local/resolve/11'), env, ctx);
    assert.equal(res.status, 404);
    assert.equal(store.get('resolve404:11'), '1', 'negative cache must be set on all-invalid');
  } finally {
    globalThis.fetch = orig;
  }
});
