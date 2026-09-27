// Novel route contract — no D1 in tests, a stub records prepare()/bind() and a
// stub fetch answers peer forwards. Asserted here: paging clamps, the %2F slug
// guard, the chapter read path touching no upstream, which shard may refresh a
// series, and that a series owned by another shard is still readable here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { murmur3_32 } from '@manga-platform/shared/r2-routing';
import { ownerFor } from '../src/lib/peers.ts';
import { router } from '../src/routes/novel.ts';
import { app as apiApp } from '../src/index.ts';

const nowSec = () => Math.floor(Date.now() / 1000);

const FOUR_PEERS = 'https://w0.test,https://w1.test,https://w2.test,https://w3.test';

const series = (id, over = {}) => ({
  id,
  source_series_id: id.replace(/^novelid-/, ''),
  source: 'novelid',
  title: 'Teka Buru',
  author: 'Someone',
  genre: '["Fantasy"]',
  status: 'Ongoing',
  cover_ref: 'covers/x.webp',
  cover_fallback: 'https://img.test/x.jpg',
  synopsis: 'A girl wakes in a fantasy world.',
  created_at: 1000,
  updated_at: 2000,
  ...over,
});

const SERIES = series('novelid-tekaburu');

const chapter = (over = {}) => ({
  id: 'novelid-tekaburu:tekaburu/1',
  series_id: 'novelid-tekaburu',
  source_chapter_id: 'tekaburu/1',
  number: 1,
  title: 'Bab 1',
  content: '<p>prose</p>',
  content_hash: 'hash-1',
  source_url: 'https://novelid.test/novel/tekaburu/bab/1',
  scraped_at: nowSec(),
  ...over,
});

// listSeries/listChapters bind (limit, offset[, genre]); getSeriesBySlug and
// getChapter bind no numbers, which is what the owner-forwarding facade's
// first() -> all()[0] collapse looks like, so both shapes have to answer.
const windowOf = (args, total) => {
  const nums = args.filter((a) => typeof a === 'number');
  return nums.length === 0 ? { offset: 0, limit: total } : { offset: nums[1] ?? 0, limit: nums[0] };
};

// `first`/`all` answer by table and by bound args, so one stub serves every read
// the four routes issue. It is a single shard's D1: a series that is not in here
// can only be found by forwarding.
const stubD1 = ({ series: rows = [], chapters = [] } = {}) => {
  const trace = [];
  const client = {
    prepare(sql) {
      const rec = { sql, args: [] };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() {
          if (sql.includes('COUNT(*)')) {
            return { c: sql.includes('novel_chapters') ? chapters.length : rows.length };
          }
          if (sql.includes('FROM novel_series')) return rows.find((s) => s.id === rec.args[0]) ?? null;
          if (sql.includes('FROM novel_chapters')) {
            const [slug, id] = rec.args;
            return chapters.find((c) => c.series_id === slug && (id === undefined || c.source_chapter_id === id)) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM novel_series')) {
            const { offset, limit } = windowOf(rec.args, rows.length);
            return { results: rows.slice(offset, offset + limit) };
          }
          if (sql.includes('FROM novel_chapters')) {
            const mine = chapters.filter((c) => c.series_id === rec.args[0]);
            const { offset, limit } = windowOf(rec.args, mine.length);
            // A real D1 answers only the projected columns. The stub must do the
            // same, or a summary query would still be handed the prose it did
            // not ask for and the payload assertions below would prove nothing.
            const cols = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM')).split(',').map((s) => s.trim());
            return {
              results: mine.slice(offset, offset + limit).map((c) => Object.fromEntries(cols.filter((k) => k in c).map((k) => [k, c[k]]))),
            };
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

// One peer by default: ownerFor is then always self, so a read is a local D1 read
// and the assertions stay about the route rather than about forwarding.
const envFor = (over = {}) => {
  const store = new Map();
  const kv = {
    puts: [],
    async get(key, type) {
      const raw = store.get(key);
      return raw === undefined ? null : (type === 'json' ? JSON.parse(raw) : raw);
    },
    async put(key, value) { kv.puts.push(key); store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
  return {
    PEER_URLS: 'https://w0.test',
    PEER_INDEX: '0',
    DB_FORWARD_KEY: 'forward-secret',
    CACHE_KV: kv,
    ...over,
  };
};

// Answers /api/_internal/db/query for the listed peer origins, which is how
// novelShard.ts reaches a shard it does not own. Anything else 500s, which is
// what makes a missing forward visible as a 404.
const peerForward = (byOrigin) => (input, init) => {
  const origin = new URL(String(input)).origin;
  const body = JSON.parse(init.body);
  const rows = byOrigin[origin]?.[body.table];
  if (!rows) return Promise.resolve(new Response('', { status: 500 }));
  const results = body.sql.includes('COUNT(*)') ? [{ c: rows.length }] : rows;
  return Promise.resolve(new Response(JSON.stringify({ ok: true, results }), {
    headers: { 'content-type': 'application/json' },
  }));
};

// `app.request` takes the ExecutionContext as its 4th argument, so every
// waitUntil() the route schedules lands in `pending` and can be awaited.
// Every fetch is logged: a forward is a fetch too, so `sourceFetches` is what
// separates "talked to a peer shard" from "scraped an upstream source".
const call = async (path, env, opts = {}) => {
  const pending = [];
  const fetchLog = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    fetchLog.push(String(input?.url ?? input));
    return opts.fetchImpl
      ? opts.fetchImpl(input, init)
      : Promise.reject(new Error('network disabled in tests'));
  };
  const target = opts.app ?? appFor();
  const started = Date.now();
  try {
    const res = await target.request(path, {}, env, {
      waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
      passThroughOnException: () => {},
    });
    const elapsed = Date.now() - started;
    await Promise.all(pending);
    const log = { fetchLog, sourceFetches: fetchLog.filter((u) => !u.includes('/api/_internal/')) };
    return { res, body: await res.json(), elapsed, ...log };
  } finally {
    globalThis.fetch = original;
  }
};

// The first slug whose shard is `want`, so a test states its ownership
// expectation instead of hard-coding a hash outcome.
const slugForShard = (want, prefix = 'novel') => {
  for (let i = 0; i < 2000; i++) {
    const slug = `${prefix}-${i}`;
    if (murmur3_32(slug) % 4 === want) return slug;
  }
  throw new Error(`no slug for shard ${want}`);
};

test('catalog clamps limit to 50 and defaults page to 1', async () => {
  const { client, trace } = stubD1({ series: [SERIES] });
  const { res, body, fetchLog } = await call('/api/novel/catalog?limit=5000', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.limit, 50, 'limit is clamped to 50');
  assert.equal(body.page, 1, 'page defaults to 1');
  assert.equal(body.data.length, 1);
  assert.equal(body.total, 1);
  assert.deepEqual(fetchLog, [], 'a single-shard deployment forwards nothing');

  const listed = trace.filter((r) => r.sql.includes('ORDER BY'));
  // Every shard is asked for the whole window from offset 0; the page offset is
  // applied after the merge, so a page is never a per-shard slice.
  assert.deepEqual(listed[0].args.slice(0, 2), [50, 0], 'the clamp is what reaches D1');

  // Distinct updated_at so the assertion is about paging, not the id tiebreak.
  const paged = stubD1({
    series: [
      series('a', { updated_at: 300 }),
      series('b', { updated_at: 200 }),
      series('c', { updated_at: 100 }),
    ],
  });
  const second = await call('/api/novel/catalog?page=2&limit=1', envFor({ DB: paged.client }));
  assert.equal(second.body.page, 2);
  assert.equal(second.body.limit, 1);
  assert.deepEqual(second.body.data.map((s) => s.id), ['b'], 'the page offset is applied to the merged list');
  const listed2 = paged.trace.filter((r) => r.sql.includes('ORDER BY'));
  assert.deepEqual(listed2[0].args.slice(0, 2), [2, 0], 'the window covers offset + limit');
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
  const { res, fetchLog } = await call('/api/novel/series/novelid%2Ftekaburu', envFor({ DB: client }));
  assert.equal(res.status, 404);
  assert.equal(trace.length, 0, 'a rejected slug must not resolve to some other series');
  assert.deepEqual(fetchLog, [], 'and must not be forwarded to a shard');

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
  const { res, body } = await call('/api/novel/series/novelid-tekaburu', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.data.id, 'novelid-tekaburu');
  assert.equal(body.data.chapters.length, 1);
  assert.equal(body.data.chapters[0].source_chapter_id, 'tekaburu/1');
});

// A 50-row window of chapter bodies is ~1MB that no list caller reads. Both
// list paths must answer with summaries; only the single-chapter read may carry
// prose. Asserted on the serialized body, which is what actually crosses the wire.
const PROSE = '<p>prose</p>';
const noProseIn = (payload, what) => {
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(PROSE), `${what} leaked chapter prose`);
  for (const col of ['"content"', '"content_hash"', '"source_url"']) {
    assert.ok(!json.includes(col), `${what} leaked ${col}`);
  }
};

test('the chapter list response carries no chapter prose', async () => {
  const many = Array.from({ length: 50 }, (_, i) => chapter({ id: `novelid-tekaburu:tekaburu/${i + 1}`, source_chapter_id: `tekaburu/${i + 1}`, number: i + 1, content: PROSE }));
  const { client, trace } = stubD1({ series: [SERIES], chapters: many });
  const { res, body } = await call('/api/novel/series/novelid-tekaburu/chapters?limit=50', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 50);
  assert.equal(body.data[0].source_chapter_id, 'tekaburu/1');
  assert.equal(body.data[0].title, 'Bab 1');
  assert.equal(body.data[0].content, undefined);
  noProseIn(body.data, 'chapter list');
  const list = trace.find((r) => r.sql.includes('FROM novel_chapters'));
  assert.doesNotMatch(list.sql, /content_hash|content,|source_url/);
});

test('the embedded chapter list in the series detail carries no prose either', async () => {
  const { client, trace } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { body } = await call('/api/novel/series/novelid-tekaburu', envFor({ DB: client }));
  assert.equal(body.data.chapters[0].source_chapter_id, 'tekaburu/1');
  noProseIn(body.data.chapters, 'series detail chapters');
  const list = trace.find((r) => r.sql.includes('FROM novel_chapters'));
  assert.doesNotMatch(list.sql, /content_hash|content,|source_url/);
});

test('the single-chapter read still returns the body', async () => {
  const { client } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { body } = await call('/api/novel/series/novelid-tekaburu/chapter/tekaburu%2F1', envFor({ DB: client }));
  assert.equal(body.data.content, PROSE);
});

test('chapter read returns stored content without calling any adapter', async () => {
  const { client, trace } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { res, body, fetchLog } = await call('/api/novel/series/novelid-tekaburu/chapter/tekaburu%2F1', envFor({ DB: client }));
  assert.equal(res.status, 200);
  assert.equal(body.data.content, '<p>prose</p>');
  assert.equal(body.data.number, 1);
  assert.equal(body.data.title, 'Bab 1');
  assert.ok(typeof body.data.scraped_at === 'number');
  assert.deepEqual(fetchLog, [], 'a fresh chapter is served from D1 with no upstream fetch');
  assert.equal(trace.filter((r) => r.sql.includes('FROM novel_series')).length, 0, 'no series row needed for a fresh read');
  const read = trace.find((r) => r.sql.includes('WHERE series_id = ?1 AND source_chapter_id = ?2'));
  assert.deepEqual(read.args, ['novelid-tekaburu', 'tekaburu/1'], 'the composite chapter id is bound whole');
});

test('an unknown chapter is a 404, not an empty 200', async () => {
  const { client } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const { res, body } = await call('/api/novel/series/novelid-tekaburu/chapter/tekaburu%2F99', envFor({ DB: client }));
  assert.equal(res.status, 404);
  assert.ok(body.error, 'the client can tell a miss from an empty chapter');
});

test('an unknown series chapter is a 404', async () => {
  const { client } = stubD1({ series: [], chapters: [] });
  const { res } = await call('/api/novel/series/novelid-ghost/chapter/ghost%2F1', envFor({ DB: client }));
  assert.equal(res.status, 404);
});

// Acceptance for the owner-forwarding gap: the series was synced to shard 0, the
// request is served by shard 1, and shard 1's own D1 has never heard of it.
test('a series owned by another shard is readable from this one', async () => {
  const slug = slugForShard(0);
  const row = series(slug);
  const chap = chapter({ id: `${slug}:x/1`, series_id: slug, source_chapter_id: 'x/1' });
  // Self is shard 1, the owner is shard 0, and the local D1 is empty.
  const { client, trace } = stubD1({ series: [], chapters: [] });
  const env = envFor({ DB: client, PEER_URLS: FOUR_PEERS, PEER_INDEX: '1' });
  assert.equal(ownerFor(env, slug).index, 0, 'the series belongs to shard 0');

  const forward = peerForward({
    'https://w0.test': { novel_series: [row], novel_chapters: [chap] },
  });
  const detail = await call(`/api/novel/series/${slug}`, env, { fetchImpl: forward });
  assert.equal(detail.res.status, 200, 'the owning shard answered');
  assert.equal(detail.body.data.id, slug);
  assert.equal(detail.body.data.chapters.length, 1, 'chapters came from the owner too');
  assert.deepEqual(detail.sourceFetches, [], 'no upstream scrape on a read');

  const read = await call(`/api/novel/series/${slug}/chapter/x%2F1`, env, { fetchImpl: forward });
  assert.equal(read.res.status, 200);
  assert.equal(read.body.data.content, '<p>prose</p>');
  assert.deepEqual(trace, [], 'nothing was read from the local D1 for a series it does not own');
});

test('the forward names the owning shard and binds the series id', async () => {
  const slug = slugForShard(0);
  const env = envFor({ DB: stubD1().client, PEER_URLS: FOUR_PEERS, PEER_INDEX: '1' });
  const { fetchLog } = await call(`/api/novel/series/${slug}`, env, {
    fetchImpl: peerForward({ 'https://w0.test': { novel_series: [series(slug)] } }),
  });
  const forwards = fetchLog.filter((u) => u.includes('/api/_internal/db/query'));
  assert.ok(forwards.length > 0, 'the read was forwarded');
  assert.ok(forwards.every((u) => u.startsWith('https://w0.test')), 'forwarded to the owner, not to a neighbour');
});

test('a peer that cannot answer falls back to the local D1', async () => {
  const slug = slugForShard(0);
  const { client } = stubD1({ series: [series(slug)] });
  const env = envFor({ DB: client, PEER_URLS: FOUR_PEERS, PEER_INDEX: '1' });
  // No forward responder: the peer 500s and the read must still succeed locally.
  const { res, body } = await call(`/api/novel/series/${slug}`, env);
  assert.equal(res.status, 200, 'a dead peer must not turn a stored series into a 404');
  assert.equal(body.data.id, slug);
});

test('the catalog merges every shard', async () => {
  const rows = {
    local: series('novelid-a', { updated_at: 400 }),
    w1: series('novelid-b', { updated_at: 500 }),
    w2: series('novelid-c', { updated_at: 300 }),
    w3: series('novelid-d', { updated_at: 200 }),
  };
  const { client } = stubD1({ series: [rows.local] });
  const env = envFor({ DB: client, PEER_URLS: FOUR_PEERS, PEER_INDEX: '0' });
  const { res, body } = await call('/api/novel/catalog', env, {
    fetchImpl: peerForward({
      'https://w1.test': { novel_series: [rows.w1] },
      'https://w2.test': { novel_series: [rows.w2] },
      'https://w3.test': { novel_series: [rows.w3] },
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body.data.map((s) => s.id), ['novelid-b', 'novelid-a', 'novelid-c', 'novelid-d'],
    'every shard is represented, ordered by updated_at DESC');
  assert.equal(body.total, 4, 'total is the sum across shards');
});

test('only the shard that owns the series refreshes a stale chapter', async () => {
  const staleAt = nowSec() - 90000;
  // Self is always shard 0; the series walks through all four shards, so exactly
  // one of these requests may scrape.
  for (let shard = 0; shard < 4; shard++) {
    const slug = slugForShard(shard);
    const row = series(slug);
    const { client } = stubD1({
      series: [row],
      chapters: [chapter({ id: `${slug}:x/1`, series_id: slug, source_chapter_id: 'x/1', scraped_at: staleAt })],
    });
    const env = envFor({ DB: client, PEER_URLS: FOUR_PEERS, PEER_INDEX: '0' });
    assert.equal(ownerFor(env, slug).index, shard, 'the test states the owner it expects');
    const { res, body, sourceFetches } = await call(`/api/novel/series/${slug}/chapter/x%2F1`, env);
    assert.equal(res.status, 200, `shard ${shard}: a stale chapter is served, not an error`);
    assert.equal(body.data.content, '<p>prose</p>', `shard ${shard}: the stale body still reaches the client`);
    if (shard === 0) {
      assert.ok(sourceFetches.length > 0, 'the owning shard refreshes the stale chapter');
    } else {
      assert.deepEqual(sourceFetches, [], `shard ${shard} does not own ${slug} and must not refresh it`);
    }
  }
});

test('a failing refresh is swallowed so the stale body still reaches the client', async () => {
  const staleAt = nowSec() - 90000;
  const row = series('novelid-stale');
  const { client } = stubD1({
    series: [row],
    chapters: [chapter({ series_id: 'novelid-stale', source_chapter_id: 's/1', scraped_at: staleAt })],
  });
  // A slow, always-failing upstream. Timed rather than inspected, because
  // "scheduled on waitUntil" and "awaited inline" look identical once the
  // harness drains the pending promises — only the latency tells them apart.
  const { res, body, elapsed } = await call('/api/novel/series/novelid-stale/chapter/s%2F1', envFor({ DB: client }), {
    fetchImpl: () => new Promise((_, reject) => { setTimeout(() => reject(new Error('offline')), 400); }),
  });
  assert.equal(res.status, 200, 'a failed refresh is not a failed read');
  assert.equal(body.data.content, '<p>prose</p>', 'the stale body still reaches the client');
  assert.ok(elapsed < 250, `the response waited ${elapsed}ms on the refresh — the read path must not block on upstream`);
});

// Registration in index.ts is otherwise unverified: a wrong mount prefix or a
// missed app.route() leaves every route above green and every URL 404.
test('a chapter read writes no KV entry at all', async () => {
  // The write was ~20KB of prose per read, against a 1000/day free-tier budget,
  // for a key nothing in the repo ever read.
  const { client } = stubD1({ series: [SERIES], chapters: [chapter()] });
  const env = envFor({ DB: client });
  const { res } = await call('/api/novel/series/novelid-tekaburu/chapter/tekaburu%2F1', env);
  assert.equal(res.status, 200);
  assert.deepEqual(env.CACHE_KV.puts, [], 'a read must not spend a KV write');
});

test('the router is mounted on the real app under /api/novel', async () => {
  const { client } = stubD1({ series: [SERIES] });
  const { res, body } = await call('/api/novel/catalog?limit=9999', envFor({ DB: client }), { app: apiApp });
  assert.equal(res.status, 200);
  assert.equal(body.limit, 50);
  assert.equal(body.data.length, 1);
});
