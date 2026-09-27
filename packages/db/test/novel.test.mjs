// NovelDb SQL contract — no D1 in tests, a stub records prepare()/bind().
// What is asserted is the SQL and its bound arguments, because that is the part
// that silently corrupts a real D1: a lost ON CONFLICT target, an unclamped
// LIMIT, or a value interpolated instead of bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novelDb } from '../index.ts';

const makeStub = ({ rows = [] } = {}) => {
  const trace = [];
  const batches = [];
  const client = {
    prepare(sql) {
      const rec = { sql, args: [], ran: null };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() { rec.ran = 'first'; return (rows[0] ?? null); },
        async all() { rec.ran = 'all'; return { results: rows }; },
        async run() { rec.ran = 'run'; return { success: true, meta: {} }; },
      };
      return stmt;
    },
    async batch(stmts) {
      batches.push(stmts.map((s) => s.rec));
      for (const s of stmts) s.rec.ran = 'batch';
      return stmts.map(() => ({ success: true, meta: {} }));
    },
  };
  return { client, trace, batches };
};

const sqls = (trace) => trace.map((r) => r.sql);

const SERIES = {
  id: 'novelid/tekaburu',
  source_series_id: 'tekaburu',
  source: 'novelid',
  title: 'Teka Buru',
  author: null,
  genre: '["Fantasy","Isekai"]',
  status: 'Ongoing',
  cover_ref: 'covers/tekaburu.webp',
  cover_fallback: 'https://example.test/cover.jpg',
  synopsis: 'A girl wakes in a fantasy world.',
  created_at: 1000,
  updated_at: 2000,
};

const chapter = (n, hash, body) => ({
  id: `ch-${n}`,
  series_id: 'novelid/tekaburu',
  source_chapter_id: `src-${n}`,
  number: n,
  title: `Chapter ${n}`,
  content: body,
  content_hash: hash,
  source_url: `https://example.test/${n}`,
  scraped_at: 5000,
});

test('upsertSeries conflicts on the natural key, not the surrogate id', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).upsertSeries(SERIES);
  assert.match(trace[0].sql, /INSERT INTO novel_series/);
  assert.match(trace[0].sql, /ON CONFLICT\(source, source_series_id\)/);
  assert.ok(trace[0].args.includes('tekaburu'), 'source_series_id is bound');
  assert.equal(trace[0].ran, 'run');
});

test('upsertSeries survives a re-scrape of the same upstream id', async () => {
  const { client, trace } = makeStub();
  const novel = novelDb(client);
  await novel.upsertSeries(SERIES);
  await novel.upsertSeries({ ...SERIES, synopsis: 'rewritten', updated_at: 3000 });
  assert.equal(trace.length, 2);
  assert.equal(trace[1].sql, trace[0].sql, 'the same statement serves both writes');
  assert.ok(trace[1].args.includes('rewritten'));
});

test('listSeries clamps limit to [1,100]', async () => {
  for (const [requested, expected] of [[0, 1], [1, 1], [20, 20], [100, 100], [100000, 100], [-5, 1]]) {
    const { client, trace } = makeStub();
    await novelDb(client).listSeries({ limit: requested, offset: 0 });
    assert.equal(trace[0].args[0], expected, `limit ${requested} -> ${expected}`);
  }
});

test('listSeries binds genre into a LIKE pattern instead of interpolating it', async () => {
  const injection = `x" OR "1"="1`;
  const { client, trace } = makeStub();
  await novelDb(client).listSeries({ limit: 20, offset: 0, genre: injection });
  assert.ok(!trace[0].sql.includes(injection), 'genre never reaches the SQL text');
  assert.ok(!trace[0].sql.includes('JSON_EXTRACT'), 'genre matches the stored JSON array with LIKE');
  assert.ok(trace[0].args.includes(`%"${injection}"%`), 'the LIKE pattern is the bound value');
});

test('listSeries without a genre drops the filter and its parameter', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).listSeries({ limit: 20, offset: 40 });
  assert.doesNotMatch(trace[0].sql, /WHERE/);
  assert.deepEqual(trace[0].args, [20, 40]);
});

test('countSeries counts the same genre filter listSeries applies', async () => {
  const { client, trace } = makeStub({ rows: [{ c: 7 }] });
  const n = await novelDb(client).countSeries('Fantasy');
  assert.equal(n, 7);
  assert.ok(trace[0].sql.includes('COUNT(*)'));
  assert.ok(!trace[0].sql.includes('Fantasy'), 'the genre stays a bound value');
  assert.ok(trace[0].args.includes('%"Fantasy"%'));
});

test('getSeriesBySourceId and getSeriesBySlug both resolve to a single row', async () => {
  const { client, trace } = makeStub({ rows: [SERIES] });
  const novel = novelDb(client);
  assert.equal((await novel.getSeriesBySourceId('novelid', 'tekaburu'))?.title, 'Teka Buru');
  assert.equal((await novel.getSeriesBySlug('novelid/tekaburu'))?.title, 'Teka Buru');
  assert.deepEqual(trace[0].args, ['novelid', 'tekaburu']);
  assert.match(trace[0].sql, /FROM novel_series WHERE source = \?1 AND source_series_id = \?2/);
  assert.deepEqual(trace[1].args, ['novelid/tekaburu']);
});

test('getSeriesBySlug returns null when the row is absent', async () => {
  const { client } = makeStub();
  assert.equal(await novelDb(client).getSeriesBySlug('nope'), null);
});

test('listChapters orders by number ASC and clamps its limit', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).listChapters('novelid/tekaburu', { limit: 9999, offset: 0 });
  assert.match(trace[0].sql, /ORDER BY number ASC/);
  assert.equal(trace[0].args[1], 100);
});

test('fillSeriesGaps writes only the columns present in its patch', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('novelid/tekaburu', { synopsis: 'filled' });
  assert.match(trace[0].sql, /UPDATE novel_series SET synopsis = \?1/);
  assert.doesNotMatch(trace[0].sql, /author|cover_fallback/);
  assert.equal(trace[0].args.at(-1), 'novelid/tekaburu');
});

test('fillSeriesGaps with every key writes all three gap columns', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('s', {
    cover_fallback: 'https://example.test/c.jpg',
    synopsis: 'syn',
    author: 'Anon',
  });
  assert.match(trace[0].sql, /cover_fallback = \?1, synopsis = \?2, author = \?3/);
});

test('fillSeriesGaps with an empty patch issues no write at all', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('s', {});
  assert.equal(trace.length, 0);
});

test('upsertChapters counts insert, update and unchanged separately', async () => {
  const { client, trace, batches } = makeStub({
    rows: [
      { source_chapter_id: 'src-1', content_hash: 'hash-a' },
      { source_chapter_id: 'src-2', content_hash: 'hash-old' },
    ],
  });
  const result = await novelDb(client).upsertChapters('novelid/tekaburu', [
    chapter(1, 'hash-a', 'SAME HASH, NEW BODY'),
    chapter(2, 'hash-new', 'new body'),
    chapter(3, 'hash-c', 'first time'),
  ]);
  assert.deepEqual(result, { inserted: 1, updated: 1, unchanged: 1 });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2, 'only the two differing chapters are written');
});

test('upsertChapters leaves the stored body intact when the hash matches', async () => {
  const { client, trace, batches } = makeStub({
    rows: [{ source_chapter_id: 'src-1', content_hash: 'hash-a' }],
  });
  const result = await novelDb(client).upsertChapters('novelid/tekaburu', [
    chapter(1, 'hash-a', 'ATTACKER SUPPLIED BODY'),
  ]);
  assert.deepEqual(result, { inserted: 0, updated: 0, unchanged: 1 });
  assert.equal(batches.length, 0, 'an unchanged chapter costs no write');
  const writes = trace.filter((r) => r.ran !== null && r.ran !== 'all');
  assert.equal(writes.length, 0);
  for (const rec of trace) {
    assert.ok(!rec.args.includes('ATTACKER SUPPLIED BODY'), 'the differing body is never written');
  }
});

test('upsertChapters is additive: chapters absent upstream are never deleted', async () => {
  const { client, trace } = makeStub({
    rows: [
      { source_chapter_id: 'src-1', content_hash: 'hash-a' },
      { source_chapter_id: 'src-2', content_hash: 'hash-b' },
      { source_chapter_id: 'src-99', content_hash: 'hash-z' },
    ],
  });
  await novelDb(client).upsertChapters('s', [chapter(1, 'hash-a', 'b')]);
  assert.equal(trace.length, 1, 'only the hash lookup runs');
  for (const sql of sqls(trace)) assert.doesNotMatch(sql, /DELETE/i, 'no destructive statement');
});

test('upsertChapters compares hashes with one scoped lookup, not a row per chapter', async () => {
  const { client, trace } = makeStub({ rows: [] });
  await novelDb(client).upsertChapters('s', [chapter(1, 'h', 'b'), chapter(2, 'h2', 'b2')]);
  assert.equal(trace.length, 3, '1 SELECT + 2 INSERTs, not 2 SELECTs + 2 INSERTs');
  assert.match(trace[0].sql, /SELECT source_chapter_id, content_hash FROM novel_chapters WHERE series_id = \?1/);
  assert.deepEqual(trace[0].args, ['s']);
  assert.match(trace[1].sql, /INSERT INTO novel_chapters/);
  assert.match(trace[1].sql, /ON CONFLICT\(series_id, source_chapter_id\)/);
});

test('upsertChapters with no chapters touches nothing', async () => {
  const { client, trace } = makeStub();
  const empty = { inserted: 0, updated: 0, unchanged: 0 };
  assert.deepEqual(await novelDb(client).upsertChapters('s', []), empty);
  assert.equal(trace.length, 0);
});

test('getChapter and countChapters stay inside one series', async () => {
  const { client, trace } = makeStub({ rows: [chapter(1, 'hash-a', 'body')] });
  const novel = novelDb(client);
  assert.equal((await novel.getChapter('s', 'src-1'))?.content, 'body');
  assert.match(trace[0].sql, /WHERE series_id = \?1 AND source_chapter_id = \?2/);
  assert.deepEqual(trace[0].args, ['s', 'src-1']);

  const counted = makeStub({ rows: [{ c: 12 }] });
  assert.equal(await novelDb(counted.client).countChapters('s'), 12);
  assert.deepEqual(counted.trace[0].args, ['s']);
});

test('listStaleSeries derives its cutoff from a relative age', async () => {
  const { client, trace } = makeStub({ rows: [SERIES] });
  const before = Math.floor(Date.now() / 1000);
  const rows = await novelDb(client).listStaleSeries(86400, 50);
  const after = Math.floor(Date.now() / 1000);
  assert.equal(rows.length, 1);
  assert.match(trace[0].sql, /FROM novel_series WHERE updated_at < \?1/);
  const cutoff = trace[0].args[0];
  assert.ok(
    cutoff >= before - 86400 && cutoff <= after - 86400,
    'the bound cutoff is a timestamp derived from the age, not the age itself',
  );
  assert.equal(trace[0].args[1], 50);
});
