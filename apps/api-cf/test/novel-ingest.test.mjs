// novelIngest contract — no D1 and no network. Adapters and the D1 binding are
// stubs, so what is asserted is the patch that reaches fillSeriesGaps, the
// chapter rows that reach upsertChapters, and which adapter methods get called
// at all. Those are the parts that silently corrupt stored content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/lib/context.ts';
import { fillMetadataGaps, refreshSeries, refreshStaleSeries } from '../src/lib/novelIngest.ts';

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
    async listChapters(id) {
      calls.push(['listChapters', id]);
      return over.chaptersFor ? over.chaptersFor(id) : (over.chapters ?? []);
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

// `rows` answers every read; `listStale` feeds the stale-series listing, which
// honours the bound LIMIT the way D1 does.
const stubD1 = ({ listStale } = {}) => {
  const trace = [];
  const client = {
    prepare(sql) {
      const rec = { sql, args: [] };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() { return { c: 0 }; },
        async all() {
          if (!listStale) return { results: [] };
          // listStaleSeries binds (cutoff, limit) — the limit is the last arg.
          return { results: listStale.slice(0, rec.args.at(-1)) };
        },
        async run() { return { success: true, meta: {} }; },
      };
      return stmt;
    },
    async batch(stmts) { return stmts.map(() => ({ success: true, meta: {} })); },
  };
  return { client, trace };
};

const envFor = (client) => ({ DB: client });

// novel_chapters binds (id, series_id, source_chapter_id, number, title, content,
// content_hash, source_url, scraped_at).
const inserted = (trace) => trace.filter((r) => r.sql.includes('INSERT INTO novel_chapters'));
const gapUpdate = (trace) => trace.find((r) => r.sql.startsWith('UPDATE novel_series SET cover_fallback')
  || r.sql.startsWith('UPDATE novel_series SET synopsis')
  || r.sql.startsWith('UPDATE novel_series SET author'));

test('a fully populated series is never written', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ searchResult: [candidate({ author: 'Nobody', synopsis: 'Other text' })] });
  await fillMetadataGaps(envFor(client), SERIES, [adapter]);
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
  await fillMetadataGaps(envFor(client), series, [adapter]);

  const update = gapUpdate(trace);
  assert.ok(update, 'the fill goes through fillSeriesGaps');
  assert.match(update.sql, /cover_fallback = COALESCE/);
  assert.doesNotMatch(update.sql, /synopsis|author/, 'a populated column is not in the patch');
  assert.deepEqual(update.args, ['https://img.test/tekaburu.jpg', series.id], 'the matched cover, then the id');
});

test('an unmatched title fills nothing', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ searchResult: [candidate({ title: 'Totally Different' })] });
  await fillMetadataGaps(envFor(client), { ...SERIES, cover_ref: null, cover_fallback: null, synopsis: null, author: null }, [adapter]);
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
  await fillMetadataGaps(envFor(client), { ...SERIES, synopsis: null, author: null }, [chapter, metadata]);
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
  await fillMetadataGaps(envFor(client), { ...SERIES, synopsis: null }, [adapter]);
  assert.equal(trace.length, 0);
});

test('refreshSeries stores the composite chapter id and a sha256 content hash', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': { html: '<p>one</p>' } });
  await refreshSeries(envFor(client), SERIES, adapter);

  const rows = inserted(trace);
  assert.equal(rows.length, 1, 'only the chapter that came back with prose is written');
  assert.equal(rows[0].args[1], SERIES.id);
  assert.equal(rows[0].args[2], 'tekaburu/1', 'the composite id is stored verbatim, never split');
  assert.equal(rows[0].args[3], 1);
  assert.equal(rows[0].args[6], await sha256Hex('<p>one</p>'), 'content_hash is sha256 of the body');
  assert.deepEqual(adapter.calls, [
    ['listChapters', 'tekaburu'],
    ['getChapterContent', 'tekaburu/1'],
    ['getChapterContent', 'tekaburu/2'],
  ], 'the empty one is fetched, then dropped without a write');
});

test('an empty upstream body is skipped, never written over stored content', async () => {
  for (const bad of [{ html: '' }, { html: '   ' }, {}, undefined]) {
    const { client, trace } = stubD1();
    const adapter = chapterAdapter({ 'tekaburu/1': { html: '<p>one</p>' }, 'tekaburu/2': bad });
    await refreshSeries(envFor(client), SERIES, adapter);
    const rows = inserted(trace);
    assert.equal(rows.length, 1, `one write for a ${JSON.stringify(bad)} body`);
    assert.equal(rows[0].args[2], 'tekaburu/1', `skipped the chapter with body ${JSON.stringify(bad)}`);
  }
});

test('every chapter empty means no write at all', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': { html: '' }, 'tekaburu/2': { html: '' } });
  await refreshSeries(envFor(client), SERIES, adapter);
  assert.equal(inserted(trace).length, 0);
});

test('a metadata adapter cannot refresh chapter bodies', async () => {
  const { client, trace } = stubD1();
  const adapter = stubAdapter({ sourceKey: 'gooddreamer', capability: 'metadata', chapters: summaries });
  await refreshSeries(envFor(client), SERIES, adapter);
  assert.deepEqual(adapter.calls, [], 'no upstream call without a chapter fetcher');
  assert.equal(inserted(trace).length, 0);
});

test('a chapter that throws does not abort the rest of the batch', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': new Error('403'), 'tekaburu/2': { html: '<p>two</p>' } });
  await refreshSeries(envFor(client), SERIES, adapter);
  assert.equal(inserted(trace)[0].args[2], 'tekaburu/2');
});

test('a successful refresh bumps updated_at so the cron does not re-pick it', async () => {
  const { client, trace } = stubD1();
  const adapter = chapterAdapter({ 'tekaburu/1': { html: '<p>one</p>' } });
  await refreshSeries(envFor(client), SERIES, adapter);
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
  const asked = [];
  const resolve = () => stubAdapter({
    sourceKey: 'novelid',
    capability: 'chapter',
    chaptersFor: (id) => { asked.push(id); return [{ sourceChapterId: `${id}/1`, number: 1 }]; },
    getChapterContent: (id) => ({ html: `<p>${id}</p>` }),
  });

  const count = await refreshStaleSeries(envFor(client), 86400, 2, resolve);
  assert.equal(count, 2, 'stopped at limit');
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
  const count = await refreshStaleSeries(envFor(client), 86400, 5, resolve);
  assert.equal(count, 2, 'the failed row is not counted, the rest are');
});

test('a row whose source has no adapter is skipped, not fatal', async () => {
  const { client, trace } = stubD1({ listStale: [{ ...SERIES, source: 'nope' }] });
  const count = await refreshStaleSeries(envFor(client), 86400, 5, () => null);
  assert.equal(count, 0);
  assert.equal(inserted(trace).length, 0);
});
