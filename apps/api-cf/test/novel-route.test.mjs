// Novel route contract — no D1 in tests, a stub records prepare()/bind().
// Asserted here: paging clamps, the %2F slug guard, the chapter read path
// touching no upstream, and which shard is allowed to refresh a series.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { murmur3_32 } from '@manga-platform/shared/r2-routing';
import { ownerFor } from '../src/lib/peers.ts';
import { router } from '../src/routes/novel.ts';
import { app as apiApp } from '../src/index.ts';

const nowSec = () => Math.floor(Date.now() / 1000);

const SERIES = {
  id: 'tekaburu',
  source_series_id: 'tekaburu',
  source: 'novelid',
  title: 'Teka Buru',
  author: 'Someone',
  genre: '["Fantasy"]',
  status: 'Ongoing',
  cover_ref: 'covers/tekaburu.webp',
  cover_fallback: 'https://img.test/tekaburu.jpg',
  synopsis: 'A girl wakes in a fantasy world.',
  created_at: 1000,
  updated_at: 2000,
};

const chapter = (over = {}) => ({
  id: 'tekaburu:tekaburu/1',
  series_id: 'tekaburu',
  source_chapter_id: 'tekaburu/1',
  number: 1,
  title: 'Bab 1',
  content: '<p>prose</p>',
  content_hash: 'hash-1',
  source_url: 'https://novelid.test/novel/tekaburu/bab/1',
  scraped_at: nowSec(),
  ...over,
});

// `first`/`all` answer by table and by bound args, so one stub serves every read
// the four routes issue. `fetchLog` counts global fetch calls: a chapter read
// that reaches an adapter shows up here.
const stubD1 = ({ series = [], chapters = [] } = {}) => {
  const trace = [];
  const client = {
    prepare(sql) {
      const rec = { sql, args: [] };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() {
          if (sql.includes('COUNT(*)')) return { c: chapters.length };
          if (sql.includes('FROM novel_series')) return series.find((s) => s.id === rec.args[0]) ?? null;
          if (sql.includes('FROM novel_chapters')) {
            const [slug, id] = rec.args;
            return chapters.find((c) => c.series_id === slug && (id === undefined || c.source_chapter_id === id)) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM novel_series')) return { results: series };
          if (sql.includes('FROM novel_chapters')) {
            const [slug] = rec.args;
            const [limit, offset] = rec.args.filter((a) => typeof a === 'number');
            return { results: chapters.filter((c) => c.series_id === slug).slice(offset, offset + limit) };
          }
          return { results: [] };
        },
        async run() { return { success: true, meta: {} }; },
      };
      return stmt;
    },
    async batch(stmts) { return stmts.map(() => ({ success: true, meta: {} })); },
  };
  return { client, trace };
};

const appFor = () => {
  const app = new Hono();
  app.route('/api', router);
  return app;
};

const envFor = (over = {}) => {
  const store = new Map();
  return {
    PEER_URLS: 'https://w0.test,https://w1.test,https://w2.test,https://w3.test',
    PEER_INDEX: '0',
    CACHE_KV: {
      async get(key, type) {
        const raw = store.get(key);
        return raw === undefined ? null : (type === 'json' ? JSON.parse(raw) : raw);
      },
      async put(key, value) { store.set(key, value); },
    },
    ...over,
  };
};

// `app.request` takes the ExecutionContext as its 4th argument, so every
// waitUntil() the route schedules lands in `pending` and can be awaited.
// `fetchImpl` lets a test supply a slow upstream; by default every fetch is
// logged and rejected, which is how a read path that scrapes gets caught.
const call = async (path, env, opts = {}) => {
  const pending = [];
  const fetchLog = [];
  const original = globalThis.fetch;
  globalThis.fetch = opts.fetchImpl ?? ((input) => {
    fetchLog.push(String(input));
    return Promise.reject(new Error('network disabled in tests'));
  });
  const target = opts.app ?? appFor();
  const started = Date.now();
  try {
    const res = await target.request(path, {}, env, {
      waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
      passThroughOnException: () => {},
    });
    const elapsed = Date.now() - started;
    await Promise.all(pending);
    return { res, body: await res.json(), fetchLog, elapsed };
  } finally {
    globalThis.fetch = original;
  }
};

test('catalog clamps limit to 50 and defaults page to 1', async () => {
  const { client, trace } = stubD1({ series: [SERIES] });
  const { res, body } = await call('/api/novel/catalog?limit=5000', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.limit, 50, 'limit is clamped to 50');
  assert.equal(body.page, 1, 'page defaults to 1');
  assert.equal(body.data.length, 1);

  const listed = trace.filter((r) => r.sql.includes('ORDER BY'));
  assert.deepEqual(listed[0].args.slice(0, 2), [50, 0], 'the clamp is what reaches D1');

  const paged = stubD1({ series: [SERIES] });
  const second = await call('/api/novel/catalog?page=3&limit=20', envFor({ DB: paged.client }));
  assert.equal(second.body.page, 3);
  assert.equal(second.body.limit, 20);
  const listed2 = paged.trace.filter((r) => r.sql.includes('ORDER BY'));
  assert.deepEqual(listed2[0].args.slice(0, 2), [20, 40], 'offset = (page - 1) * limit');
});

test('catalog binds genre instead of interpolating it', async () => {
  const { client, trace } = stubD1({ series: [SERIES] });
  const injection = 'x" OR "1"="1';
  await call(`/api/novel/catalog?genre=${encodeURIComponent(injection)}`, envFor({ DB: client }));
  const listed = trace.find((r) => r.sql.includes('ORDER BY'));
  assert.ok(!listed.sql.includes(injection), 'genre never reaches the SQL text');
  assert.ok(listed.args.includes(`%"${injection}"%`), 'the LIKE pattern is a bound argument');
});

test('a slug containing %2F is rejected before any D1 read', async () => {
  const { client, trace } = stubD1({ series: [SERIES] });
  const { res } = await call('/api/novel/series/novelid%2Ftekaburu', envFor({ DB: client }));
  assert.equal(res.status, 404);
  assert.equal(trace.length, 0, 'a rejected slug must not resolve to some other series');

  // Control: %252F decodes to the literal "%2F", which holds no slash, so the
  // same router must reach the row lookup. Without it, the 404 above could just
  // be a route that never matches.
  const control = await call('/api/novel/series/novelid%252Ftekaburu', envFor({ DB: client }));
  assert.equal(control.res.status, 404, 'no stored row for the literal %2F id');
  assert.equal(trace.length, 1);
  assert.deepEqual(trace[0].args, ['novelid%2Ftekaburu'], 'the decoded slug is bound, not interpolated');
});

test('series detail embeds the stored chapters', async () => {
  const { client } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { res, body } = await call('/api/novel/series/tekaburu', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.data.id, 'tekaburu');
  assert.equal(body.data.chapters.length, 1);
  assert.equal(body.data.chapters[0].source_chapter_id, 'tekaburu/1');
});

test('chapter read returns stored content without calling any adapter', async () => {
  const { client, trace } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { res, body, fetchLog } = await call('/api/novel/series/tekaburu/chapter/tekaburu%2F1', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.data.content, '<p>prose</p>');
  assert.equal(body.data.number, 1);
  assert.equal(body.data.title, 'Bab 1');
  assert.ok(typeof body.data.scraped_at === 'number');
  assert.deepEqual(fetchLog, [], 'a fresh chapter is served from D1 with no upstream fetch');
  assert.equal(trace.filter((r) => r.sql.includes('FROM novel_series')).length, 0, 'no series row needed for a fresh read');
  const read = trace.find((r) => r.sql.includes('WHERE series_id = ?1 AND source_chapter_id = ?2'));
  assert.deepEqual(read.args, ['tekaburu', 'tekaburu/1'], 'the composite chapter id is bound whole');
});

test('an unknown chapter is a 404, not an empty 200', async () => {
  const { client } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { res, body } = await call('/api/novel/series/tekaburu/chapter/tekaburu%2F99', envFor({ DB: client }));
  assert.equal(res.status, 404);
  assert.ok(body.error, 'the client can tell a miss from an empty chapter');
});

test('an unknown series chapter is a 404', async () => {
  const { client } = stubD1({ series: [], chapters: [] });
  const { res } = await call('/api/novel/series/ghost/chapter/ghost%2F1', envFor({ DB: client }));
  assert.equal(res.status, 404);
});

test('only the shard that owns the series refreshes a stale chapter', async () => {
  const staleAt = nowSec() - 90000;
  // Four slugs, one per shard. Which is self is decided by the same expression
  // the route must use, so a wrong shard key is a failure, not a coincidence.
  const byShard = new Map();
  for (let i = 0; byShard.size < 4; i++) {
    const slug = `novel-${i}`;
    const shard = murmur3_32(slug) % 4;
    if (!byShard.has(shard)) byShard.set(shard, slug);
  }
  assert.equal(byShard.size, 4, 'found a slug for every shard');

  for (const [shard, slug] of byShard) {
    const row = { ...SERIES, id: slug, source_series_id: slug };
    const { client } = stubD1({
      series: [row],
      chapters: [chapter({ series_id: slug, source_chapter_id: `${slug}/1`, scraped_at: staleAt })],
    });
    const env = envFor({ DB: client });
    assert.equal(ownerFor(env, slug).index, shard, 'the test shard expectation matches ownerFor');
    const { res, body, fetchLog } = await call(`/api/novel/series/${slug}/chapter/${slug}%2F1`, env);
    assert.equal(res.status, 200, `shard ${shard}: a stale chapter is served, not an error`);
    assert.equal(body.data.content, '<p>prose</p>', `shard ${shard}: the stale body still reaches the client`);
    if (shard === 0) {
      assert.ok(fetchLog.length > 0, 'the owning shard refreshes the stale chapter');
    } else {
      assert.deepEqual(fetchLog, [], `shard ${shard} does not own ${slug} and must not refresh it`);
    }
  }
});

test('a failing refresh is swallowed so the stale body still reaches the client', async () => {
  const staleAt = nowSec() - 90000;
  let slug = null;
  for (let i = 0; slug === null && i < 500; i++) {
    if (murmur3_32(`own-${i}`) % 4 === 0) slug = `own-${i}`;
  }
  const row = { ...SERIES, id: slug, source_series_id: slug };
  const { client } = stubD1({
    series: [row],
    chapters: [chapter({ series_id: slug, source_chapter_id: `${slug}/1`, scraped_at: staleAt })],
  });
  const env = envFor({ DB: client });
  // A slow, always-failing upstream. Timed rather than inspected, because
  // "scheduled on waitUntil" and "awaited inline" look identical once the
  // harness drains the pending promises — only the latency tells them apart.
  const { res, body, elapsed } = await call(`/api/novel/series/${slug}/chapter/${slug}%2F1`, env, {
    fetchImpl: () => new Promise((_, reject) => { setTimeout(() => reject(new Error('offline')), 400); }),
  });
  assert.equal(res.status, 200, 'a failed refresh is not a failed read');
  assert.equal(body.data.content, '<p>prose</p>', 'the stale body still reaches the client');
  assert.ok(elapsed < 250, `the response waited ${elapsed}ms on the refresh — the read path must not block on upstream`);
});

// Registration in index.ts is otherwise unverified: a wrong mount prefix or a
// missed app.route() leaves every route above green and every URL 404.
test('the router is mounted on the real app under /api/novel', async () => {
  const { client } = stubD1({ series: [SERIES] });
  const { res, body } = await call('/api/novel/catalog?limit=9999', envFor({ DB: client }), { app: apiApp });
  assert.equal(res.status, 200);
  assert.equal(body.limit, 50);
  assert.equal(body.data.length, 1);
});
