// novelIngest contract — no D1 and no network. Adapters and the D1 binding are
// stubs, so what is asserted is the patch that reaches fillSeriesGaps, the
// chapter rows that reach upsertChapters, and which adapter methods get called
// at all. Those are the parts that silently corrupt stored content.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { murmur3_32 } from '@manga-platform/shared/r2-routing';
import { flushOutbox } from '../src/lib/dbWrite.ts';
import { sha256Hex } from '../src/lib/context.ts';
import {
  fillMetadataGaps,
  isCatalogCrawler,
  refreshSeries,
  refreshStaleSeries,
  refreshVisitsFor,
  refreshWindowFor,
  REFRESH_SUBREQUEST_BUDGET,
  REFRESH_VISIT_COST,
  seriesIdFor,
  syncCatalog,
} from '../src/lib/novelIngest.ts';

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

const candidate = (over = {}) => ({
  sourceSeriesId: '9',
  source: 'gooddreamer',
  title: 'Teka Buru',
  author: 'Nobody',
  synopsis: 'Filled text',
  coverUrl: 'https://img.test/tekaburu.jpg',
  ...over,
});

// Every method records its call, so "never called" is assertable rather than
// assumed, and a custom body cannot hide the call it replaced.
const stubAdapter = (over = {}) => {
  const calls = [];
  const adapter = {
    sourceKey: over.sourceKey ?? 'gooddreamer',
    capability: over.capability ?? 'metadata',
    calls,
    async search(params) {
      calls.push(['search', params.q]);
      if (over.searchThrows) throw over.searchThrows;
      return over.searchResult ?? [];
    },
    async getSeries(id) {
      calls.push(['getSeries', id]);
      if (over.seriesThrows) throw over.seriesThrows;
      return over.seriesResult;
    },
    async listChapters(id, opts) {
      calls.push(['listChapters', id, opts]);
      const all = over.chaptersFor ? over.chaptersFor(id) : (over.chapters ?? []);
      // A real adapter honours the window; the stub has to, or a bounded
      // refresh would still be handed the whole list and prove nothing.
      if (!opts || opts.limit === undefined) return all;
      return all.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit);
    },
  };
  // Deliberately absent unless asked for: that is how the metadata adapters
  // ship, and refreshSeries must not call upstream without it.
  if (over.getChapterContent) {
    adapter.getChapterContent = async (id) => {
      calls.push(['getChapterContent', id]);
      return over.getChapterContent(id);
    };
  }
  return adapter;
};

const summaries = [
  { sourceChapterId: 'tekaburu/1', number: 1, title: 'Bab 1', sourceUrl: 'https://novelid.test/novel/tekaburu/bab/1' },
  { sourceChapterId: 'tekaburu/2', number: 2, title: 'Bab 2', sourceUrl: 'https://novelid.test/novel/tekaburu/bab/2' },
];

const chapterAdapter = (bodies, over = {}) => stubAdapter({
  sourceKey: 'novelid',
  capability: 'chapter',
  chapters: summaries,
  getChapterContent: (id) => {
    const body = bodies[id];
    if (body instanceof Error) throw body;
    return body;
  },
  ...over,
});

// `listStale` feeds the stale-series listing, which honours the bound LIMIT the
// way D1 does. `existing` is a series row (or rows) that are already stored, so
// an upsert path can be told apart from an insert path. _outbox is kept as rows
// too, because a queue that is only visible in the trace cannot be replayed.
const stubD1 = ({ listStale, existing = null } = {}) => {
  const trace = [];
  const stored = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  // Ids this stub has been asked to insert, so a re-sync sees the row a previous
  // upsert would have created instead of inserting it again.
  const written = new Set(stored.map((r) => r.id));
  let nextOutboxId = 1;
  const outbox = [];
  const client = {
    prepare(sql) {
      const rec = { sql, args: [] };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() {
          if (sql.includes('FROM _outbox')) return { c: outbox.length };
          const row = stored.find((r) => sql.includes('FROM novel_series') && r.id === rec.args[0]);
          if (row) return row;
          if (written.has(rec.args[0])) return { id: rec.args[0] };
          return null;
        },
        async all() {
          if (sql.includes('FROM _outbox')) return { results: outbox };
          if (!listStale) return { results: [] };
          // listStaleSeries binds (cutoff, limit) — the limit is the last arg.
          return { results: listStale.slice(0, rec.args.at(-1)) };
        },
        async run() {
          if (sql.startsWith('INSERT INTO _outbox')) {
            const [owner_url, table_name, sqlText, params] = rec.args;
            outbox.push({ id: nextOutboxId++, owner_url, table_name, sql: sqlText, params, attempts: 0 });
          } else if (sql.startsWith('DELETE FROM _outbox WHERE id')) {
            const at = outbox.findIndex((r) => r.id === rec.args[0]);
            if (at >= 0) outbox.splice(at, 1);
          } else if (sql.startsWith('UPDATE _outbox SET attempts')) {
            const row = outbox.find((r) => r.id === rec.args[0]);
            if (row) row.attempts++;
          }
          // D1 reports rows_written, and a forwarded /db/exec passes it back, so
          // a write that reached a shard holding no such row is distinguishable
          // from one that landed. An UPDATE filters on its trailing id.
          const changed = sql.startsWith('UPDATE novel_series SET')
            && !sql.startsWith('UPDATE novel_series SET updated_at')
            ? (written.has(String(rec.args.at(-1))) ? 1 : 0)
            : 1;
          if (sql.includes('INSERT INTO novel_series')) written.add(rec.args[0]);
          return { success: true, meta: { changes: changed, rows_written: changed } };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      for (const st of stmts) if (st.rec.sql.includes('INSERT INTO novel_series')) written.add(st.rec.args[0]);
      return stmts.map(() => ({ success: true, meta: { changes: 1, rows_written: 1 } }));
    },
  };
  return { client, trace };
};

const envFor = (client, over = {}) => {
  const kv = new Map();
  const kvKeys = { deleted: [] };
  const env = {
    DB: client,
    CACHE_KV: {
      async get(key, type) {
        const raw = kv.get(key);
        const asJson = typeof type === 'string' ? type : type?.type;
        return raw === undefined ? null : (asJson === 'json' ? JSON.parse(raw) : raw);
      },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { kvKeys.deleted.push(key); kv.delete(key); },
    },
    ...over,
  };
  return { env, kvKeys, cursor: (id) => JSON.parse(kv.get(`novel:refresh:${id}`) ?? 'null')?.offset ?? null };
};

// The chapter line is the only thing that separates a complete refresh from a
// prefix, so it is asserted, not assumed.
const captureLog = async (fn) => {
  const lines = [];
  const original = console.log;
  const originalError = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { lines, result: await fn() };
  } finally {
    console.log = original;
    console.error = original;
  }
};

// novel_chapters binds (id, series_id, source_chapter_id, number, title, content,
// content_hash, source_url, scraped_at).
const inserted = (trace) => trace.filter((r) => r.sql.includes('INSERT INTO novel_chapters'));
const gapUpdate = (trace) => trace.find((r) => r.sql.startsWith('UPDATE novel_series SET cover_fallback')
  || r.sql.startsWith('UPDATE novel_series SET synopsis')
  || r.sql.startsWith('UPDATE novel_series SET author'));

test('a fully populated series is never written', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ searchResult: [candidate({ author: 'Nobody', synopsis: 'Other text' })] });
  await fillMetadataGaps(envFor(client).env, SERIES, [adapter]);
  assert.equal(adapter.calls.length, 0, 'no gap means no tier-2 round trip at all');
  assert.equal(trace.length, 0, 'and no write');
});

test('only the empty column is filled, and only from a matching title', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({
    searchResult: [
      candidate({ sourceSeriesId: '4', title: 'Some Other Novel', coverUrl: 'https://img.test/wrong.jpg' }),
      candidate({ sourceSeriesId: '9', title: 'teka buru' }),
    ],
  });
  // cover_ref is what the read path checks and the tier-2 cover lands in
  // cover_fallback, so a row with neither has a real cover gap.
  const series = { ...SERIES, cover_ref: null, cover_fallback: null };
  await fillMetadataGaps(envFor(client).env, series, [adapter]);

  const update = gapUpdate(trace);
  assert.ok(update, 'the fill goes through fillSeriesGaps');
  assert.match(update.sql, /cover_fallback = COALESCE/);
  assert.doesNotMatch(update.sql, /synopsis|author/, 'a populated column is not in the patch');
  assert.deepEqual(update.args, ['https://img.test/tekaburu.jpg', series.id], 'the matched cover, then the id');
});

test('an unmatched title fills nothing', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ searchResult: [candidate({ title: 'Totally Different' })] });
  await fillMetadataGaps(envFor(client).env, { ...SERIES, cover_ref: null, cover_fallback: null, synopsis: null, author: null }, [adapter]);
  assert.equal(trace.length, 0, 'metadata from an unrelated novel is worse than a blank');
});

test('tier-2 is never consulted for chapters, and never through a chapter adapter', async () => {
  const { client, trace } = stubD1();
  const chapter = stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    chapters: summaries,
    getChapterContent: () => { throw new Error('must not be called'); },
  });
  const metadata = stubAdapter({ searchResult: [candidate()] });
  await fillMetadataGaps(envFor(client).env, { ...SERIES, synopsis: null, author: null }, [chapter, metadata]);
  assert.deepEqual(chapter.calls, [], 'a chapter adapter is not a metadata source');
  assert.deepEqual(metadata.calls, [['search', 'Teka Buru']], 'search only, with the stored title');
  const update = gapUpdate(trace);
  assert.ok(update);
  assert.match(update.sql, /synopsis = COALESCE/);
  assert.match(update.sql, /author = COALESCE/);
  assert.doesNotMatch(update.sql, /cover_fallback/, 'cover_ref was populated, so the cover is not a gap');
});

test('a failed tier-2 lookup does not throw', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ searchThrows: new Error('upstream down') });
  await fillMetadataGaps(envFor(client).env, { ...SERIES, synopsis: null }, [adapter]);
  assert.equal(trace.length, 0);
});

// The series payload is KV-cached for 600s, so a fill that does not drop that
// key is invisible for 10 minutes and every request in between re-detects the
// same gap and re-runs the two tier-2 searches.
test('a gap fill invalidates the cached series payload', async () => {
  const { client } = stubD1();
  const { env, kvKeys } = envFor(client);
  const adapter = stubAdapter({ searchResult: [candidate()] });
  await fillMetadataGaps(env, { ...SERIES, synopsis: null }, [adapter]);
  assert.deepEqual(kvKeys.deleted, ['novel:series:tekaburu'], 'the reader sees the fill on the next request');
});

test('no gap means no tier-2 call and no cache invalidation', async () => {
  const { client } = stubD1();
  const { env, kvKeys } = envFor(client);
  const adapter = stubAdapter({ searchResult: [candidate()] });
  await fillMetadataGaps(env, SERIES, [adapter]);
  assert.deepEqual(kvKeys.deleted, [], 'a full row is not re-fetched or re-cached');
});

test('refreshSeries stores the composite chapter id and a sha256 content hash', async () => {
  const { client, trace } = stubD1();
  const { env } = envFor(client);
  const adapter = chapterAdapter({ 'tekaburu/1': { html: '<p>one</p>' } });
  await refreshSeries(env, SERIES, adapter);

  const rows = inserted(trace);
  assert.equal(rows.length, 1, 'only the chapter that came back with prose is written');
  assert.equal(rows[0].args[1], SERIES.id);
  assert.equal(rows[0].args[2], 'tekaburu/1', 'the composite id is stored verbatim, never split');
  assert.equal(rows[0].args[3], 1);
  assert.equal(rows[0].args[6], await sha256Hex('<p>one</p>'), 'content_hash is sha256 of the body');
  assert.deepEqual(adapter.calls, [
    ['listChapters', 'tekaburu', { limit: refreshWindowFor(env), offset: 0 }],
    ['getChapterContent', 'tekaburu/1'],
    ['getChapterContent', 'tekaburu/2'],
  ], 'the empty one is fetched, then dropped without a write');
});

test('an empty upstream body is skipped, never written over stored content', async () => {
  for (const bad of [{ html: '' }, { html: '   ' }, {}, undefined]) {
    const { client, trace } = stubD1();
    const adapter = chapterAdapter({ 'tekaburu/1': { html: '<p>one</p>' }, 'tekaburu/2': bad });
    await refreshSeries(envFor(client).env, SERIES, adapter);
    const rows = inserted(trace);
    assert.equal(rows.length, 1, `one write for a ${JSON.stringify(bad)} body`);
    assert.equal(rows[0].args[2], 'tekaburu/1', `skipped the chapter with body ${JSON.stringify(bad)}`);
  }
});

test('every chapter empty means no write at all', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': { html: '' }, 'tekaburu/2': { html: '' } });
  await refreshSeries(envFor(client).env, SERIES, adapter);
  assert.equal(inserted(trace).length, 0);
});

test('a metadata adapter cannot refresh chapter bodies', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ sourceKey: 'gooddreamer', capability: 'metadata', chapters: summaries });
  await refreshSeries(envFor(client).env, SERIES, adapter);
  assert.deepEqual(adapter.calls, [], 'no upstream call without a chapter fetcher');
  assert.equal(inserted(trace).length, 0);
});

test('a chapter that throws does not abort the rest of the batch', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': new Error('403'), 'tekaburu/2': { html: '<p>two</p>' } });
  await refreshSeries(envFor(client).env, SERIES, adapter);
  assert.equal(inserted(trace)[0].args[2], 'tekaburu/2');
});

test('a successful refresh bumps updated_at so the cron does not re-pick it', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': { html: '<p>one</p>' } });
  await refreshSeries(envFor(client).env, SERIES, adapter);
  const touch = trace.find((r) => r.sql.startsWith('UPDATE novel_series SET updated_at'));
  assert.ok(touch, 'listStaleSeries orders by updated_at, so a refresh must advance it');
  assert.deepEqual(touch.args.slice(1), [SERIES.id], 'the id is bound, not interpolated');
  assert.ok(!touch.sql.includes(SERIES.id));
  assert.ok(touch.args[0] >= SERIES.updated_at, 'updated_at moves forward');
});

test('refreshStaleSeries stops at limit and counts only what it refreshed', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...SERIES, id: `s${i}`, source_series_id: `s${i}` }));
  const { client, trace } = stubD1({ listStale: rows });
  const before = Math.floor(Date.now() / 1000);
  // Two visits is the ask, so the window is the one the budget buys two of.
  const asked = [];
  const resolve = () => stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    chaptersFor: (id) => { asked.push(id); return [{ sourceChapterId: `${id}/1`, number: 1 }]; },
    getChapterContent: (id) => ({ html: `<p>${id}</p>` }),
  });

  const { env } = envFor(client, { NOVEL_REFRESH_WINDOW: '16' });
  const pass = await refreshStaleSeries(env, 86400, 2, resolve);
  assert.equal(pass.refreshed, 2, "stopped at limit");
  assert.deepEqual(asked, ['s0', 's1'], 'rows are processed oldest-first, up to limit');
  assert.deepEqual(inserted(trace).map((r) => r.args[1]), ['s0', 's1']);
  const cutoff = trace[0].args[0];
  assert.ok(cutoff >= before - 86400 && cutoff <= Date.now() / 1000 - 86400, 'olderThanSec arrives as a cutoff timestamp');
  assert.equal(trace[0].args[1], 2, 'limit is passed through to listStaleSeries');
});

test('one failing row does not end the batch', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ ...SERIES, id: `s${i}`, source_series_id: `s${i}` }));
  const { client } = stubD1({ listStale: rows });
  const resolve = () => stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    chaptersFor: (id) => {
      if (id === 's0') throw new Error('upstream 500');
      return [{ sourceChapterId: `${id}/1`, number: 1 }];
    },
    getChapterContent: (id) => ({ html: `<p>${id}</p>` }),
  });
  const { env } = envFor(client, { NOVEL_REFRESH_WINDOW: '1' });
  const pass = await refreshStaleSeries(env, 86400, 5, resolve);
  assert.equal(pass.refreshed, 2, "the failed row is not counted, the rest are");
});

test('a row whose source has no adapter is skipped, not fatal', async () => {
  const { client, trace } = stubD1({ listStale: [{ ...SERIES, source: 'nope' }] });
  const pass = await refreshStaleSeries(envFor(client).env, 86400, 5, () => null);
  assert.equal(pass.refreshed, 0);
  assert.equal(inserted(trace).length, 0);
});

// ── bounded refresh window + resume cursor ─────────────────────────────────
// A novelid light novel runs 200-800 episodes and every chapter costs a
// subrequest, so one visit may not walk the whole list. The window bounds the
// upstream calls, the cursor hands the remainder to the next cron, and the log
// says which of the two happened.
const manySummaries = (n) =>
  Array.from({ length: n }, (_, i) => ({
    sourceChapterId: `tekaburu/${i + 1}`, number: i + 1, title: `Bab ${i + 1}`,
  }));

const bodyFor = () => (id) => ({ html: `<p>${id}</p>` });

// chapterAdapter's first argument is a body map; the window tests want a
// generator instead, so they pass their own fetcher through `over`.
const windowAdapter = (n, getChapterContent) => chapterAdapter(
  Object.fromEntries(manySummaries(n).map((s) => [s.sourceChapterId, { html: `<p>${s.sourceChapterId}</p>` }])),
  { chapters: manySummaries(n), getChapterContent }
);

// The Workers free plan allows 50 subrequests per Worker invocation and this
// pass runs inside the hourly cron invocation, so the window has to come out of
// a budget rather than be a constant. REFRESH_VISIT_COST is what one visit
// spends outside the window, mirrored in subrequestBudgetFor's arithmetic below.
const VISIT_COST = 6;
const FREE_PLAN_LIMIT = 50;

const windowFor = (env) => refreshWindowFor(env);

test('the default window is derived from the subrequest budget, not hardcoded', () => {
  const plain = {};
  assert.equal(windowFor(plain), 38, '50 minus the crons other work, minus what a visit costs');
  assert.equal(REFRESH_SUBREQUEST_BUDGET, 44);
  assert.equal(refreshVisitsFor(plain), 1, 'and one visit is all the budget buys at that window');
  assert.ok(REFRESH_VISIT_COST + windowFor(plain) <= FREE_PLAN_LIMIT, 'never over the free plan limit');
});

test('the window is configuration, and no value of it can exceed the plan', () => {
  assert.equal(windowFor({ NOVEL_REFRESH_WINDOW: '5' }), 5);
  // Clamped: a 50-chapter window is 56 subrequests, over the free plan's 50.
  assert.equal(windowFor({ NOVEL_REFRESH_WINDOW: '50' }), 38);
  assert.equal(windowFor({ NOVEL_REFRESH_WINDOW: '9999' }), 38);
  // A paid plan raises the budget, and only then does a bigger window fit.
  assert.equal(windowFor({ NOVEL_REFRESH_BUDGET: '1000', NOVEL_REFRESH_WINDOW: '500' }), 500);
  for (const junk of ['', '0', '-4', 'lots', 'NaN', undefined, null, {}]) {
    assert.equal(windowFor({ NOVEL_REFRESH_WINDOW: junk }), 38, `rejects ${JSON.stringify(junk)}`);
  }
  assert.equal(windowFor({ NOVEL_REFRESH_BUDGET: '99999', NOVEL_REFRESH_WINDOW: '99999' }), 994);
});

test('a small window buys more visits inside the same budget', () => {
  assert.equal(refreshVisitsFor({ NOVEL_REFRESH_WINDOW: '1' }), 6, 'floor(44 / (6 + 1))');
  assert.equal(refreshVisitsFor({ NOVEL_REFRESH_WINDOW: '16' }), 2);
  assert.equal(refreshVisitsFor({ NOVEL_REFRESH_WINDOW: '1e9' }), 1, 'and never zero: a series must still advance');
  for (const w of [1, 4, 16, 38, 500]) {
    const v = refreshVisitsFor({ NOVEL_REFRESH_WINDOW: String(w), NOVEL_REFRESH_BUDGET: '1000' });
    assert.ok(
      v * (VISIT_COST + Math.min(w, 994)) <= 1000,
      `${v} visits at window ${w} must fit the budget`,
    );
  }
});

test('one refresh visit costs the cursor, the list, its chapters and its D1 writes — and no more', async () => {
  const { client, trace } = stubD1();
  const counted = { d1: 0, kv: 0 };
  // A subrequest counter over everything a visit reaches: D1 prepare/bind
  // rounds and KV reads and writes each bill one.
  const countedClient = {
    prepare(sql) {
      const stmt = client.prepare(sql);
      const wrap = (fn) => (...args) => { counted.d1++; return fn(...args); };
      return {
        bind: (...a) => { const b = stmt.bind(...a); return { ...b, all: wrap(b.all), first: wrap(b.first), run: wrap(b.run) }; },
        all: wrap(stmt.all), first: wrap(stmt.first), run: wrap(stmt.run),
      };
    },
    batch: (stmts) => { counted.d1++; return client.batch(stmts); },
  };
  const { env } = envFor(countedClient);
  const kv = env.CACHE_KV;
  env.CACHE_KV = {
    get: (...a) => { counted.kv++; return kv.get(...a); },
    put: (...a) => { counted.kv++; return kv.put(...a); },
    delete: (...a) => { counted.kv++; return kv.delete(...a); },
  };
  const w = windowFor(env);
  const adapter = windowAdapter(200, bodyFor());
  const result = await refreshSeries(env, SERIES, adapter);

  const chapters = adapter.calls.filter(([m]) => m === 'getChapterContent').length;
  assert.equal(chapters, w, 'the walk stops at the window');
  const total = counted.d1 + counted.kv + chapters + 1; // +1: the chapter list
  assert.equal(result.fetched, w);
  assert.ok(total <= FREE_PLAN_LIMIT, `${total} subrequests must fit the free plan's ${FREE_PLAN_LIMIT}`);
  assert.equal(total, VISIT_COST + w, 'and the accounting matches the cost the budget assumes');
  assert.equal(inserted(trace).length, w);
});

test('the pass makes no more visits than the subrequest budget buys', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...SERIES, id: `v${i}`, source_series_id: `v${i}` }));
  const { client, trace } = stubD1({ listStale: rows });
  const { env } = envFor(client);
  const resolve = () => stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    chaptersFor: (id) => manySummaries(200),
    getChapterContent: bodyFor(),
  });

  // 20 rows at a 38-chapter window is 20 x 44 = 880 subrequests in one cron
  // invocation, five times what the free plan allows.
  const { lines, result } = await captureLog(() => refreshStaleSeries(env, 86400, 20, resolve));
  assert.equal(result.refreshed, refreshVisitsFor(env), 'the visit count comes from the budget');
  assert.ok(result.refreshed < 20, 'not every row in the listing');
  assert.equal(refreshVisitsFor(env), 1);
  const w = windowFor(env);
  assert.ok(
    result.refreshed * (VISIT_COST + w) <= REFRESH_SUBREQUEST_BUDGET,
    `${result.refreshed} visits at window ${w} must fit ${REFRESH_SUBREQUEST_BUDGET}`,
  );
  // The rows it did not visit keep their old updated_at, so listStaleSeries hands
  // them back next tick: skipping is a rotation, not a drop.
  const listed = trace.find((r) => r.sql.includes('FROM novel_series') && r.sql.includes('updated_at <'));
  assert.equal(listed.args[1], result.refreshed, 'and it does not even read the rows it cannot visit');
  assert.equal(inserted(trace).length, result.refreshed * w);
  assert.match(lines.join('\n'), /truncated, resume at/, 'the one visit it could afford stopped at the window');
});

test('a refresh walks one window and leaves a cursor for the next visit', async () => {
  const { client, trace } = stubD1();
  const { env } = envFor(client);
  const w = windowFor(env);
  const adapter = windowAdapter(200, bodyFor());
  const { lines, result } = await captureLog(() => refreshSeries(env, SERIES, adapter));

  assert.equal(result.fetched, w, 'only the window is fetched');
  assert.equal(inserted(trace).length, w);
  assert.equal(
    adapter.calls.filter(([m]) => m === 'getChapterContent').length,
    w,
    'the window of upstream bodies, not the whole 200',
  );
  assert.equal(adapter.calls[0][1], SERIES.source_series_id);
  assert.deepEqual(adapter.calls[0][2], { limit: w, offset: 0 }, 'listChapters is bounded, not unbounded');
  assert.equal(result.exhausted, false);
  assert.equal(result.nextOffset, w, 'the next cron resumes where this one stopped');
  const logged = lines.join('\n');
  assert.match(logged, /truncated/);
  assert.match(logged, new RegExp(`resume at ${w}`));
  assert.doesNotMatch(logged, /series complete/);
});

test('the next visit resumes at the cursor and the last window is not truncated', async () => {
  const { client } = stubD1();
  const { env, cursor } = envFor(client);
  const w = windowFor(env);
  const adapter = windowAdapter(w * 2 + 20, bodyFor());

  const first = await refreshSeries(env, SERIES, adapter);
  assert.equal(first.nextOffset, w);
  assert.equal(cursor(SERIES.id), w, 'the cursor is where the window stopped');

  const second = await refreshSeries(env, SERIES, adapter);
  const offsets = adapter.calls.filter(([m]) => m === 'listChapters').map((c) => c[2].offset);
  assert.deepEqual(offsets, [0, w], 'the second visit starts at the cursor, not at 0');
  assert.equal(second.fetched, w);

  const third = await captureLog(() => refreshSeries(env, SERIES, adapter));
  assert.equal(third.result.fetched, 20, 'the tail window is short');
  assert.equal(third.result.exhausted, true, 'a short window means the list ended inside it');
  assert.equal(third.result.nextOffset, null, 'nothing left to resume');
  assert.match(third.lines.join('\n'), /series complete/);
  assert.equal(cursor(SERIES.id), null, 'the cursor is cleared once the list is exhausted');
});

test('a budget stop ends the window and is never counted as a chapter miss', async () => {
  const { client, trace } = stubD1();
  const { env } = envFor(client);
  let n = 0;
  const adapter = chapterAdapter({}, { chapters: manySummaries(200), getChapterContent: () => {
    n++;
    if (n > 10) throw new Error('Too many subrequests.');
    return { html: `<p>${n}</p>` };
  } });

  const { lines, result } = await captureLog(() => refreshSeries(env, SERIES, adapter));
  assert.equal(result.budget, 1, 'the swallowed budget error is counted on its own');
  assert.equal(result.missing, 0, 'and not as a missing chapter');
  assert.equal(result.fetched, 10);
  assert.equal(result.nextOffset, 10, 'the cursor points at the chapter that was never fetched');
  assert.equal(result.exhausted, false);
  const logged = lines.join('\n');
  assert.match(logged, /truncated/);
  assert.match(logged, /1 budget-stopped/);
  assert.doesNotMatch(logged, /series complete/, 'a truncated run must not read as a complete one');
  assert.equal(inserted(trace).length, 10);
});

test('an aborted fetch stops the window, a 404 does not', async () => {
  const { env } = envFor(stubD1().client);
  const adapter = chapterAdapter({}, { chapters: manySummaries(120), getChapterContent: (id) => {
    if (id === 'tekaburu/2') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    return { html: `<p>${id}</p>` };
  } });
  const aborted = await captureLog(() => refreshSeries(env, SERIES, adapter));
  assert.equal(aborted.result.budget, 1);
  assert.equal(aborted.result.missing, 0);
  assert.equal(aborted.result.nextOffset, 1, 'the aborted chapter is retried, not skipped past');
  assert.equal(aborted.result.fetched, 1, 'the chapter before it still landed');

  const { env: env2 } = envFor(stubD1().client);
  const miss = chapterAdapter({}, { chapters: manySummaries(120), getChapterContent: (id) => {
    if (id === 'tekaburu/2') throw new Error('novelid fetch 404');
    return { html: `<p>${id}</p>` };
  } });
  const after = await captureLog(() => refreshSeries(env2, SERIES, miss));
  assert.equal(after.result.budget, 0);
  assert.equal(after.result.missing, 1, 'a real 404 does not truncate the walk');
  assert.equal(after.result.nextOffset, windowFor(env2), 'the window ran to its end, so the cursor is the next window');
  assert.equal(after.result.exhausted, false, 'and the tail is not claimed to be seen');
});

test('refreshStaleSeries counts a truncated pass apart from a complete one', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ ...SERIES, id: `s${i}`, source_series_id: `s${i}` }));
  const { client } = stubD1({ listStale: rows });
  const { env } = envFor(client);
  const resolve = () => stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    chaptersFor: (id) => (id === 's0' ? manySummaries(200) : manySummaries(3)),
    getChapterContent: bodyFor(),
  });

  const { lines, result } = await captureLog(() => refreshStaleSeries({ ...env, NOVEL_REFRESH_WINDOW: '4' }, 86400, 5, resolve));
  assert.equal(result.refreshed, 3, 'all three rows were visited');
  assert.equal(result.complete, 2, 'two short lists are complete passes');
  assert.equal(result.truncated, 1, 'the 200-chapter one stopped at the window');
  const logged = lines.join('\n');
  assert.match(logged, /\[novel] s0: .*truncated, resume at 4\b/, 'the long series reads as truncated');
  assert.match(logged, /\[novel] s1: .*series complete/);
  assert.match(logged, /\[novel] s2: .*series complete/);
});

// ── catalog sync ────────────────────────────────────────────────────────────
// The catalog starts empty, so syncCatalog is the only thing that ever creates a
// series row. It is discovery: search + upsert, never a chapter body.
const catalogHit = (over = {}) => ({
  sourceSeriesId: 'halal-tapi-asing',
  source: 'novelid',
  title: 'Halal Tapi Asing',
  slug: 'halal-tapi-asing',
  genres: ['Fantasi', 'Romance'],
  coverUrl: 'https://img.test/halal.jpg',
  ...over,
});

// Search is paged by offset, so the responder counts calls per seed.
const catalogAdapter = (pages, over = {}) => {
  const calls = [];
  const adapter = stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    getChapterContent: () => { throw new Error('the catalog sync must not fetch chapters'); },
    ...over,
  });
  adapter.search = async (params) => {
    calls.push(params);
    return pages[Math.floor(params.offset / 18)] ?? [];
  };
  return { adapter, calls };
};

// Only novelid is chapter-capable, so the resolver answers for that key alone —
// the sync walks every source in the registry.
const onlyNovelId = (adapter) => (key) => (key === 'novelid' ? adapter : null);

const onePeer = (over = {}) => ({ PEER_URLS: 'https://w0.test', PEER_INDEX: '0', ...over });
const fourPeers = (over = {}) => ({
  PEER_URLS: 'https://w0.test,https://w1.test,https://w2.test,https://w3.test',
  PEER_INDEX: '0',
  ...over,
});

// Search cards carry title, one genre and a thumbnail — no author, no synopsis,
// no status. The series page has all three, so a row synced from search alone
// shipped a blank author and an empty synopsis forever: tier-2 cannot rescue it
// because gooddreamer and noveltoon do not carry the same novels.
const detailFor = (hit, over = {}) => ({
  sourceSeriesId: hit.sourceSeriesId,
  source: 'novelid',
  title: hit.title,
  slug: hit.slug,
  author: 'Pengarang',
  genres: ['Fantasi', 'Romance', 'Aksi'],
  status: 'Ongoing',
  coverUrl: 'https://img.test/halal-full.jpg',
  synopsis: 'Seorang frigorista bangun di dunia fantasi.',
  ...over,
});

const detailSync = (over = {}) =>
  catalogAdapter({ 0: [catalogHit()] }, { seriesResult: detailFor(catalogHit(), over) });

test('a newly inserted series is written with the detail page, not the search card', async () => {
  const { client, trace } = stubD1();
  const { adapter } = detailSync();
  const res = await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });

  assert.equal(res.inserted, 1);
  assert.deepEqual(
    adapter.calls.filter(([m]) => m === 'getSeries'),
    [['getSeries', 'halal-tapi-asing']],
    'one getSeries for the upstream id, once',
  );
  const row = trace.find((r) => r.sql.includes('INSERT INTO novel_series'));
  assert.equal(row.args[4], 'Pengarang', 'author, which the search card never carries');
  assert.equal(row.args[6], 'Ongoing', 'status, which neither the search card nor tier-2 carries');
  assert.equal(row.args[8], 'https://img.test/halal-full.jpg', 'the detail page cover, not the 120x160 thumbnail');
  assert.equal(row.args[9], 'Seorang frigorista bangun di dunia fantasi.');
  assert.equal(row.args[5], '["Fantasi","Romance","Aksi"]', 'genres come from the detail page too');
});

test('a series whose detail is still missing is filled from getSeries', async () => {
  const stored = {
    ...SERIES,
    id: 'novelid-halal-tapi-asing',
    source_series_id: 'halal-tapi-asing',
    author: null,
    synopsis: null,
    status: null,
    cover_ref: null,
    cover_fallback: null,
  };
  const { client, trace } = stubD1({ existing: stored });
  const { adapter } = detailSync();
  const res = await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });

  assert.equal(res.inserted, 0, 'the row already exists');
  assert.equal(res.filled, 1);
  assert.equal(adapter.calls.filter(([m]) => m === 'getSeries').length, 1);
  const update = trace.find((r) => r.sql.startsWith('UPDATE novel_series SET cover_fallback'));
  assert.ok(update, 'the fill goes through fillSeriesGaps');
  assert.match(update.sql, /synopsis = COALESCE/);
  assert.match(update.sql, /author = COALESCE/);
  assert.match(update.sql, /status = COALESCE/);
  assert.deepEqual(
    update.args,
    [
      'https://img.test/halal-full.jpg',
      'Seorang frigorista bangun di dunia fantasi.',
      'Pengarang',
      'Ongoing',
      stored.id,
    ],
    'the columns are bound in the order fillSeriesGaps emits them',
  );
});

test('a complete series is not re-fetched on a later tick', async () => {
  const { client, trace } = stubD1({ existing: { ...SERIES, id: 'novelid-halal-tapi-asing', source_series_id: 'halal-tapi-asing' } });
  const { adapter } = detailSync();
  await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
  assert.deepEqual(adapter.calls.filter(([m]) => m === 'getSeries'), [], 'nothing is missing, so no detail fetch');
  const update = trace.find((r) => r.sql.startsWith('UPDATE novel_series SET cover_fallback'));
  assert.equal(update, undefined, 'and no write: a column the card still carries but the owner already has is not a gap');
});

test('a failing getSeries still inserts the series from the search card', async () => {
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ author: 'Dari Kartu' })] }, { seriesThrows: new Error('novelid getSeries: 500') });
  const res = await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
  assert.equal(res.inserted, 1, 'a dead detail page must not lose the series');
  const row = trace.find((r) => r.sql.includes('INSERT INTO novel_series'));
  assert.equal(row.args[4], 'Dari Kartu', 'whatever the search card did carry is kept');
});


test('a cover is stored in B2 by the same sync, so cover_ref gets a real key', async () => {
  const { client, trace } = stubD1();
  const { env } = envFor(client);
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes('backblazeb2.com') && init?.method === 'PUT') return Promise.resolve(new Response('', { status: 200 }));
    if (url.includes('wp.com')) {
      return Promise.resolve(new Response('BYTES', { status: 200, headers: { 'content-type': 'image/webp' } }));
    }
    return Promise.reject(new Error(`network disabled: ${url}`));
  };
  const { adapter } = detailSync({ coverUrl: 'https://i2.wp.com/novelid.org/uploads/halal.webp' });
  try {
    const res = await syncCatalog({
      ...onePeer(),
      DB: client,
      B2_ACCOUNTS: JSON.stringify([
        { name: 'b1', bucket: 'manga-images', keyId: 'k1', appKey: 'a1', region: 'us-east-005', host: 's3.us-east-005.backblazeb2.com' },
      ]),
      CACHE_KV: env.CACHE_KV,
    }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
    assert.equal(res.inserted, 1);
    const row = trace.find((r) => r.sql.includes('INSERT INTO novel_series'));
    assert.equal(row.args[7], 'novel/covers/novelid-halal-tapi-asing', 'cover_ref is the B2 key, so the web never hotlinks');
    assert.equal(row.args[8], 'https://i2.wp.com/novelid.org/uploads/halal.webp', 'cover_fallback survives as the fallback');
  } finally {
    globalThis.fetch = original;
  }
});


test('syncCatalog creates series with single-segment ids and never fetches chapters', async () => {
  const { client, trace } = stubD1();
  const { adapter, calls } = catalogAdapter({ 0: [catalogHit()] });
  const res = await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['fantasi'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });

  assert.equal(res.inserted, 1);
  assert.deepEqual(calls.map((c) => c.offset), [0], 'one search page for one seed');
  const row = trace.find((r) => r.sql.includes('INSERT INTO novel_series'));
  assert.equal(row.args[0], 'novelid-halal-tapi-asing', 'the id is source-prefixed and single-segment');
  assert.ok(!row.args[0].includes('/'), 'a slash in the id would be unroutable');
  assert.equal(row.args[1], 'halal-tapi-asing');
  assert.equal(row.args[2], 'novelid');
  assert.equal(row.args[3], 'Halal Tapi Asing');
  assert.equal(row.args[5], '["Fantasi","Romance"]', 'genres are stored as the JSON array the filter LIKE-matches');
  assert.equal(row.args[7], null, 'cover_ref is left to the cover pipeline');
  assert.equal(row.args[8], 'https://img.test/halal.jpg', 'the upstream cover lands in cover_fallback');
  assert.deepEqual(adapter.calls.filter(([m]) => m === 'getChapterContent'), []);
});

test('seriesIdFor is the routing id, and the sync refuses an unroutable one', async () => {
  assert.equal(seriesIdFor('novelid', 'halal-tapi-asing'), 'novelid-halal-tapi-asing');
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: 'nested/slug' })] });
  const res = await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
  assert.equal(res.inserted, 0);
  assert.equal(res.skipped, 1, 'an id with a separator can never be read back, so it is dropped');
  assert.equal(trace.filter((r) => r.sql.includes('INSERT INTO novel_series')).length, 0);
});

test('syncCatalog pages through the search window and stops on a short page', async () => {
  const { client } = stubD1();
  const full = Array.from({ length: 18 }, (_, i) => catalogHit({ sourceSeriesId: `s${i}` }));
  const { adapter, calls } = catalogAdapter({ 0: full, 1: full, 2: [catalogHit({ sourceSeriesId: 'tail' })] });
  const res = await syncCatalog({ ...onePeer(), DB: client }, {
    seeds: ['fantasi'],
    pagesPerSeed: 3,
    resolve: onlyNovelId(adapter),
  });
  assert.deepEqual(calls.map((c) => c.offset), [0, 18, 36], 'the window advances by a full page');
  assert.equal(res.inserted, 19, '18 unique, then 1 from the short page that ends the walk');
});

// The 12h discovery crawl is owner-gated, so only one worker pays the upstream
// requests. The three quarters of the catalogue it does not own therefore have
// to reach their owner's D1 over /api/_internal/db/exec instead of being
// dropped — which is what the old per-worker owner gate did.
//
// `ownerRows` are the rows the peer answers /api/_internal/db/query with, keyed
// by series id, so a test can put a row on a shard this worker does not own.
// `execChanges` is what the peer reports for a write, so "the write reached a
// shard that holds no such row" is reproducible.
const capturingPeers = ({ ownerRows = {}, execChanges = 1, serveCover = false } = {}) => {
  const forwarded = [];
  const queries = [];
  const coverUploads = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes('/api/_internal/db/exec')) {
      forwarded.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve(new Response(
        JSON.stringify({ ok: true, target: 'local', changes: execChanges }),
        { headers: { 'content-type': 'application/json' } },
      ));
    }
    if (url.includes('/api/_internal/db/query')) {
      const { params } = JSON.parse(init.body);
      queries.push({ url, params });
      const id = params?.[0];
      return Promise.resolve(new Response(
        JSON.stringify({ results: ownerRows[id] ? [ownerRows[id]] : [] }),
        { headers: { 'content-type': 'application/json' } },
      ));
    }
    if (url.includes('backblazeb2.com') && init?.method === 'PUT') {
      coverUploads.push(url);
      return Promise.resolve(new Response('', { status: 200 }));
    }
    if (serveCover && (url.includes('wp.com') || url.includes('novelid.org'))) {
      return Promise.resolve(new Response('BYTES', { status: 200, headers: { 'content-type': 'image/webp' } }));
    }
    return Promise.reject(new Error(`network disabled in tests: ${url}`));
  };
  return { forwarded, queries, coverUploads, restore: () => { globalThis.fetch = original; } };
};

const capturingExec = () => capturingPeers();

const shardOf = (sourceSeriesId) => {
  for (let i = 0; i < 4000; i++) {
    const id = `${sourceSeriesId}-${i}`;
    if (murmur3_32(`novelid-${id}`) % 4 !== 0) return id;
  }
  throw new Error('no id for a non-zero shard');
};

// A value whose murmur3 lands on a *different* shard than the series id it would
// be bound beside. writeOwned used to derive the owner from params[0], so a gap
// fill — whose first bound parameter is the patch value, not the id — was
// routed by this hash and the UPDATE matched nothing on the shard that holds
// the row. `wanted` is the shard the fixture text must NOT hash to.
const valueOnOtherShard = (id, prefix) => {
  const want = murmur3_32(id) % 4;
  for (let i = 0; i < 4000; i++) {
    const v = `${prefix}-${i}`;
    if (murmur3_32(v) % 4 !== want) return v;
  }
  throw new Error('no value for a different shard');
};

test('the ring elects exactly one catalogue crawler, and it is the same one every time', () => {
  const elected = [0, 1, 2, 3].filter((i) => isCatalogCrawler({ ...fourPeers(), PEER_INDEX: String(i) }));
  assert.equal(elected.length, 1, `exactly one of four may crawl, got ${JSON.stringify(elected)}`);
  // Re-resolving must not move the election, or every tick would crawl a
  // different quarter of the ring.
  for (let i = 0; i < 5; i++) {
    assert.equal(isCatalogCrawler({ ...fourPeers(), PEER_INDEX: String(elected[0]) }), true);
  }
  // Single-peer deployment: there is no ring to elect from, and the one worker
  // owns everything, so it crawls.
  assert.equal(isCatalogCrawler(onePeer()), true);
});

test('a series another shard owns is forwarded to its owner, not dropped', async () => {
  const elsewhere = shardOf('not-mine');
  assert.notEqual(murmur3_32(`novelid-${elsewhere}`) % 4, 0, 'the id belongs to a peer');
  const ownerIndex = murmur3_32(`novelid-${elsewhere}`) % 4;
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere })] });
  const { forwarded, restore } = capturingExec();
  try {
    const res = await syncCatalog({
      ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret',
    }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
    assert.equal(res.inserted, 1, 'the row was written, just not here');
    assert.equal(res.skipped, 0);
    assert.equal(forwarded.length, 1, 'one forward, to the owner');
    assert.ok(forwarded[0].url.startsWith(`https://w${ownerIndex}.test/`), 'forwarded to the owner, not a neighbour');
    assert.equal(forwarded[0].body.table, 'novel_series');
    assert.equal(forwarded[0].body.params[0], `novelid-${elsewhere}`, 'the id is bound, not interpolated');
    assert.ok(forwarded[0].body.sql.startsWith('INSERT INTO novel_series'));
    assert.ok(!forwarded[0].body.sql.includes(elsewhere), 'no user input in the SQL text');
    assert.equal(trace.filter((r) => r.sql.includes('INSERT INTO novel_series')).length, 0, 'and nothing local');
  } finally {
    restore();
  }
});

test('a forward that fails is queued in the outbox rather than lost', async () => {
  const elsewhere = shardOf('not-mine');
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere })] });
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('owner unreachable'));
  try {
    const res = await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
    assert.equal(res.inserted, 1);
    const queued = trace.find((r) => r.sql.includes('INSERT INTO _outbox'));
    assert.ok(queued, 'the write is retried by the next cron flush');
    // _outbox binds (owner_url, table_name, sql, params, created_at).
    assert.equal(queued.args[1], 'novel_series');
    assert.ok(String(queued.args[2]).startsWith('INSERT INTO novel_series'));
  } finally {
    globalThis.fetch = original;
  }
});

// writeOwned used to read the owner out of params[0]. The upsert binds the
// series id first, so that happened to work; the gap fill binds the patch value
// first and the id last, so every tier-2 fill was forwarded to whichever shard
// owns hash(authorText), matched zero rows there, and still counted as filled.
//
// Isolated on a series this shard already owns: the fill must be a local write,
// and must not leave the shard because the value it binds first hashes elsewhere.
test('a gap fill for a series this shard owns is never routed by the patch value', async () => {
  const mine = [];
  for (let i = 0; mine.length < 1; i++) {
    if (murmur3_32(`novelid-fill-own-${i}`) % 4 === 0) mine.push(`fill-own-${i}`);
  }
  const id = `novelid-${mine[0]}`;
  const card = valueOnOtherShard(id, 'https://img.test/halal');
  assert.notEqual(murmur3_32(card) % 4, 0, 'the value bound first hashes to a peer');

  const { client, trace } = stubD1({
    existing: { ...SERIES, id, source_series_id: mine[0], source: 'novelid', cover_fallback: null },
  });
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: mine[0] })] });
  const { forwarded, restore } = capturingExec();
  try {
    const res = await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
    assert.equal(res.filled, 1);
    assert.deepEqual(forwarded, [], 'a row this shard owns is written here, whatever the first bound value hashes to');
    const update = trace.find((r) => r.sql.startsWith('UPDATE novel_series SET'));
    assert.ok(update, 'and the fill is a local UPDATE');
    assert.equal(update.args.at(-1), id);
  } finally {
    restore();
  }
});

test('a gap fill is routed by the series id, not by the patch value bound first', async () => {
  const elsewhere = shardOf('fill-owner');
  const id = `novelid-${elsewhere}`;
  const ownerIndex = murmur3_32(id) % 4;
  const author = valueOnOtherShard(id, 'Pengarang');
  assert.notEqual(murmur3_32(author) % 4, ownerIndex, 'the patch value hashes to a different shard');

  const { client } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere })] });
  const { forwarded, restore } = capturingPeers({
    ownerRows: {
      [id]: { ...SERIES, id, source_series_id: elsewhere, source: 'novelid', author: null, synopsis: null, cover_fallback: null },
    },
  });
  try {
    await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
  } finally {
    restore();
  }
  assert.equal(forwarded.length, 1, 'the fill is the one forwarded write');
  assert.ok(forwarded[0].url.startsWith(`https://w${ownerIndex}.test/`), 'it went to the shard that owns the series id');
  assert.ok(forwarded[0].body.sql.startsWith('UPDATE novel_series SET'), 'and it is a fill, not an upsert');
  assert.equal(forwarded[0].body.params.at(-1), id, 'the id is the WHERE parameter');
});

test('a fill that reached a shard holding no such row is not counted as filled', async () => {
  const elsewhere = shardOf('fill-miss');
  const id = `novelid-${elsewhere}`;
  const { client } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere })] });
  // changes: 0 is what the owner reports for an UPDATE that matched nothing.
  const { forwarded, restore } = capturingPeers({
    execChanges: 0,
    ownerRows: {
      [id]: { ...SERIES, id, source_series_id: elsewhere, source: 'novelid', author: null, synopsis: null, cover_fallback: null },
    },
  });
  try {
    const res = await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
    assert.equal(forwarded.length, 1, 'the write was still attempted');
    assert.equal(res.filled, 0, 'but a fill that changed no row is not a fill');
    assert.equal(res.inserted, 0);
  } finally {
    restore();
  }
});

test('a series this shard owns still goes straight to the local D1', async () => {

  const mine = [];
  for (let i = 0; mine.length < 2; i++) {
    if (murmur3_32(`novelid-own-${i}`) % 4 === 0) mine.push(`own-${i}`);
  }
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: mine.map((id) => catalogHit({ sourceSeriesId: id })) });
  const { forwarded, restore } = capturingExec();
  try {
    const res = await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
    assert.equal(res.inserted, mine.length);
    assert.deepEqual(
      trace.filter((r) => r.sql.includes('INSERT INTO novel_series')).map((r) => r.args[0]),
      mine.map((id) => `novelid-${id}`),
      'the four D1s partition the catalogue'
    );
    assert.deepEqual(forwarded, [], 'an owned series never leaves the shard');
  } finally {
    restore();
  }
});

test('a re-sync gap-fills an existing series instead of overwriting it', async () => {
  const stored = {
    ...SERIES,
    id: 'novelid-halal-tapi-asing',
    source_series_id: 'halal-tapi-asing',
    // A tier-2 fill that a naive upsert would wipe: search hits carry no synopsis.
    synopsis: 'Filled by tier 2',
    author: 'Nobody',
    cover_fallback: null,
  };
  const { client, trace } = stubD1({ existing: stored });
  const { adapter } = catalogAdapter({ 0: [catalogHit()] });
  const res = await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });

  assert.equal(res.inserted, 0);
  assert.equal(res.filled, 1);
  assert.equal(trace.filter((r) => r.sql.includes('INSERT INTO novel_series')).length, 0, 'no re-upsert');
  const update = trace.find((r) => r.sql.startsWith('UPDATE novel_series SET cover_fallback'));
  assert.ok(update, 'the cover was filled through fillSeriesGaps');
  assert.doesNotMatch(update.sql, /synopsis|author/, 'a populated column is not written');
  assert.deepEqual(update.args, ['https://img.test/halal.jpg', stored.id]);
});

// A row the crawler does not own used to be invisible to it, so every 12-hour
// tick re-ran the INSERT path for it: the B2 cover was uploaded again, and a
// failed getSeries wrote the search card's nulls over the author and synopsis
// tier-2 had filled. The pre-INSERT read goes to the owner, and a detail update
// never clobbers a populated column.
const b2AccountEnv = (over = {}) => ({
  B2_ACCOUNTS: JSON.stringify([
    { name: 'b1', bucket: 'manga-images', keyId: 'k1', appKey: 'a1', region: 'us-east-005', host: 's3.us-east-005.backblazeb2.com' },
  ]),
  ...over,
});

const storedOnPeer = (elsewhere, over = {}) => ({
  ...SERIES,
  id: `novelid-${elsewhere}`,
  source_series_id: elsewhere,
  source: 'novelid',
  cover_ref: null,
  cover_fallback: null,
  ...over,
});

test('a row already on the owner is gap-filled, not re-upserted, on a failing getSeries', async () => {
  const elsewhere = shardOf('owner-row');
  const id = `novelid-${elsewhere}`;
  const stored = storedOnPeer(elsewhere, {
    author: 'Nobody',
    synopsis: 'Filled by tier 2',
    status: 'Ongoing',
    cover_ref: 'novel/covers/' + id,
    cover_fallback: 'https://i2.wp.com/novelid.org/uploads/halal.webp',
  });
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere, coverUrl: 'https://i2.wp.com/novelid.org/uploads/thumb.webp' })] }, {
    seriesThrows: new Error('novelid getSeries: 500'),
  });
  const { client: kvClient } = { client };
  const { forwarded, queries, coverUploads, restore } = capturingPeers({    ownerRows: { [id]: stored },
    serveCover: true,
  });
  try {
    const res = await syncCatalog({
      ...fourPeers(), ...b2AccountEnv(), DB: client, CACHE_KV: envFor(kvClient).env.CACHE_KV,
      DB_FORWARD_KEY: 'forward-secret',
    }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
    assert.equal(res.inserted, 0, 'the row already exists on the owner');
    assert.equal(queries.length, 1, 'and this shard asked the owner, not its own D1');
    assert.equal(queries[0].params[0], id);
    assert.deepEqual(forwarded, [], 'nothing to write: the owner already has a cover, an author and a synopsis');
    assert.deepEqual(coverUploads, [], 'the cover is not uploaded again every 12 hours');
  } finally {
    restore();
  }
  assert.equal(
    trace.filter((r) => r.sql.includes('INSERT INTO novel_series')).length,
    0,
    'the ON CONFLICT path is never reached',
  );
});

test('a partial owner row is filled with a COALESCE update that writes no null over a populated column', async () => {
  const elsewhere = shardOf('owner-partial');
  const id = `novelid-${elsewhere}`;
  const stored = storedOnPeer(elsewhere, {
    author: 'Nobody',
    synopsis: 'Filled by tier 2',
    status: null,
  });
  const { client } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere })] }, {
    seriesThrows: new Error('novelid getSeries: 500'),
  });
  const { forwarded, restore } = capturingPeers({ ownerRows: { [id]: stored } });
  try {
    const res = await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
    assert.equal(res.inserted, 0);
    assert.equal(forwarded.length, 1);
    const sql = forwarded[0].body.sql;
    assert.ok(sql.startsWith('UPDATE novel_series SET'), 'a fill, not an upsert: ' + sql);
    assert.doesNotMatch(sql, /author = |synopsis = /, 'the two tier-2 fills are not in the SET list at all');
    assert.match(sql, /cover_fallback = COALESCE\(NULLIF\(cover_fallback, ''\), \?1\)/);
    assert.equal(forwarded[0].body.params.at(-1), id);
  } finally {
    restore();
  }
});

test('an upsert that does reach a shard holding the row still cannot null a populated column', async () => {
  // The owner read is the first line of defence; this is the one that holds when
  // it fails and the row only turns up at INSERT time.
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit()] }, { seriesThrows: new Error('novelid getSeries: 500') });
  await syncCatalog({ ...onePeer(), DB: client }, { seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter) });
  const row = trace.find((r) => r.sql.includes('INSERT INTO novel_series'));
  for (const col of ['author', 'genre', 'status', 'cover_ref', 'cover_fallback', 'synopsis']) {
    assert.match(
      row.sql,
      new RegExp(`${col} = COALESCE\\(NULLIF\\(excluded\\.${col}, ''\\), novel_series\\.${col}\\)`),
      `${col} must not be overwritten with the incoming null`,
    );
  }
});

// The refresh path resolves its adapter with novelAdapterEnv, so the robots KV
// cache engages there. syncCatalog defaulted to the bare registry function,
// which takes (key, env?) — called with one argument, env was undefined and the
// cache never engaged, so every search page paid its own robots.txt request.
test('the catalog sync resolves its adapter with env, so the robots cache engages', async () => {
  const searchFixture = readFileSync(
    new URL('../../../packages/sources/test/fixtures/novelid-search.html', import.meta.url),
    'utf8',
  );
  const robotsRequests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/robots.txt')) {
      robotsRequests.push(u);
      return new Response('User-agent: *\nDisallow: /includes/\n', { status: 200 });
    }
    // The series page is irrelevant here and only adds noise to the count.
    if (u.includes('/novel/')) return new Response('gone', { status: 500 });
    return new Response(searchFixture, { status: 200 });
  };
  const { client } = stubD1();
  const { env } = envFor(client);
  try {
    const res = await syncCatalog({ ...onePeer(), DB: client, CACHE_KV: env.CACHE_KV }, { seeds: ['a', 'b'], pagesPerSeed: 1 });
    assert.ok(res.inserted > 0, 'the walk really happened, so the count means something');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(robotsRequests.length, 1, 'robots.txt is read once for the whole catalogue walk, not once per page');
});

test('a forwarded write can only ever reach the shard that owns the series id', async () => {
  // writeOwned's owner key is explicit now, so a novel_series write can only land
  // on ownerFor(id) or nowhere. The batch runs both statements: an id already
  // stored is gap-filled and binds the patch value first, a new one is upserted
  // and binds the id first — only the fill separates this from routing by
  // params[0].
  //
  // An id this worker owns takes the local branch, never a forward to its own
  // URL: the row is in this D1 already, so forwarding it would write it twice
  // through two paths. The ring split, not the batch size, is what sets the
  // forward count.
  const ids = Array.from({ length: 12 }, (_, i) => `fwd-${i}`);
  const ownerOf = (seriesId) => `https://w${murmur3_32(seriesId) % 4}.test/`;
  const stored = ids.filter((_, i) => i % 2 === 0);
  const mine = ids.filter((id) => ownerOf(`novelid-${id}`) === 'https://w0.test/');
  const theirs = ids.filter((id) => !mine.includes(id));
  const storedRow = (id) => ({ ...SERIES, id: `novelid-${id}`, source_series_id: id, source: 'novelid', synopsis: null });

  const { client, trace } = stubD1({ existing: stored.filter((id) => mine.includes(id)).map(storedRow) });
  const { adapter } = catalogAdapter({
    0: ids.map((id) => catalogHit({
      sourceSeriesId: id,
      // A fill binds this text first, so it is hashed to a shard that is not the
      // one owning the id: a write routed by params[0] reaches no such row.
      synopsis: valueOnOtherShard(`novelid-${id}`, 'sinopsis'),
    })),
  });
  const { forwarded, restore } = capturingExec();
  try {
    await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
  } finally {
    restore();
  }
  assert.ok(mine.length > 0 && theirs.length > 0, 'the batch has to span this shard and its peers');
  // Each forward is named by the shard owning the id it carries, so this one
  // comparison pins both statements to ownerFor(id), to no other shard, and to
  // exactly once. A forward carrying no id of this batch stays as its own url.
  assert.deepEqual(
    forwarded.map((f) => {
      const carried = f.body.params.find((p) => ids.some((id) => p === `novelid-${id}`));
      return carried ? ownerOf(carried) : f.url;
    }).sort(),
    theirs.map((id) => ownerOf(`novelid-${id}`)).sort(),
    'a peer-owned id is forwarded to its own owner, once, and to no other shard',
  );
  const local = trace.filter((r) => /^(INSERT INTO|UPDATE) novel_series/.test(r.sql));
  assert.equal(local.length, mine.length, 'a peer-owned row never lands in this D1');
  for (const id of mine) {
    assert.equal(local.filter((r) => r.args.includes(`novelid-${id}`)).length, 1, `${id} was written here, once, and not forwarded`);
  }
});

test('a peer failure leaves exactly one outbox row, and a successful flush removes it', async () => {
  const elsewhere = shardOf('outbox');
  const { client, trace } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit({ sourceSeriesId: elsewhere })] });
  const ownerUrl = `https://w${murmur3_32(`novelid-${elsewhere}`) % 4}.test`;
  const original = globalThis.fetch;
  // The owner is down for the write, then back for the flush.
  let peerDown = true;
  const execs = [];
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes('/api/_internal/db/exec')) {
      if (peerDown) return Promise.reject(new Error('owner unreachable'));
      execs.push(JSON.parse(init.body));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, changes: 1 }), { status: 200 }));
    }
    return Promise.reject(new Error(`network disabled: ${url}`));
  };
  try {
    const res = await syncCatalog({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' }, {
      seeds: ['x'], pagesPerSeed: 1, resolve: onlyNovelId(adapter),
    });
    assert.equal(res.inserted, 1, 'the write is not lost, it is queued');
    const queued = trace.filter((r) => r.sql.includes('INSERT INTO _outbox'));
    assert.equal(queued.length, 1, 'queued once, not once per attempt');
    assert.equal(queued[0].args[0], ownerUrl, 'and addressed to the owner, not to whoever answered');

    peerDown = false;
    const flushed = await flushOutbox({ ...fourPeers(), DB: client, DB_FORWARD_KEY: 'forward-secret' });
    assert.equal(flushed.flushed, 1);
    assert.equal(execs.length, 1, 'the queued write is replayed exactly once, not re-queued behind itself');
    assert.equal(execs[0].table, 'novel_series');
    assert.ok(String(execs[0].sql).startsWith('INSERT INTO novel_series'));
    const deletes = trace.filter((r) => r.sql.includes('DELETE FROM _outbox WHERE id'));
    assert.equal(deletes.length, 1, 'and the retry row is retired, so a later flush cannot write it again');
  } finally {
    globalThis.fetch = original;
  }
});

test('a metadata source is never crawled for the catalogue', async () => {
  const { client, trace } = stubD1();
  const calls = [];
  const metadata = stubAdapter({ sourceKey: 'gooddreamer', capability: 'metadata' });
  const original = metadata.search;
  metadata.search = async (p) => { calls.push(p); return original(p); };
  const res = await syncCatalog({ ...onePeer(), DB: client }, {
    seeds: ['x'],
    pagesPerSeed: 1,
    resolve: (key) => (key === 'novelid' ? null : metadata),
  });
  assert.deepEqual(calls, [], 'only a chapter source can back a series we could read chapters for');
  assert.equal(res.inserted, 0);
  assert.equal(trace.length, 0);
});

test('a failing search ends that seed without losing the rest', async () => {
  const { client } = stubD1();
  const { adapter } = catalogAdapter({ 0: [catalogHit()] });
  const attempted = [];
  adapter.search = async (params) => {
    attempted.push(params.q);
    if (params.q === 'a') throw new Error('upstream 500');
    return [catalogHit()];
  };
  const res = await syncCatalog({ ...onePeer(), DB: client }, {
    seeds: ['a', 'b'],
    pagesPerSeed: 1,
    resolve: onlyNovelId(adapter),
  });
  assert.deepEqual(attempted, ['a', 'a', 'b'], 'the failing seed is retried once, then the walk continues');
  assert.equal(res.inserted, 1, 'the second seed still landed');
});
