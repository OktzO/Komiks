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

// Splits on top-level commas only, so a function-valued SET item such as
// COALESCE(a, b) stays one item.
const splitTopLevel = (s) => {
  const out = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of s) {
    if (ch === "'") quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
};

// Handles both shapes: an upsert `... DO UPDATE SET a = 1 WHERE ...` and a
// plain `UPDATE t SET a = 1 WHERE ...`.
const setClause = (sql) => {
  const after = sql.includes('DO UPDATE SET') ? sql.split('DO UPDATE SET')[1] : sql.split(' SET ')[1];
  return splitTopLevel(after.split(' WHERE ')[0]);
};
const setColumn = (item) => item.split('=')[0].trim();

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

// novel_chapters.id is a global PRIMARY KEY, so a chapter id must be scoped to
// its series or the second series to ingest chapter 1 fails on the constraint.
const chapter = (n, hash, body, series = 'novelid/tekaburu') => ({
  id: `${series}/ch-${n}`,
  series_id: series,
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

test('upsertSeries refreshes every mutable column on a re-scrape, and only those', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).upsertSeries(SERIES);
  const updated = setClause(trace[0].sql).map(setColumn);
  assert.deepEqual(
    updated,
    ['title', 'author', 'genre', 'status', 'cover_ref', 'cover_fallback', 'synopsis', 'updated_at'],
    'a column dropped here silently stops refreshing on every later re-scrape',
  );
  assert.ok(!updated.includes('id'), 'id is the routing key and must not move');
  assert.ok(!updated.includes('created_at'), 'created_at is insert-only');
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

test('genre wildcards are escaped so Sci_Fi cannot match SciXFi', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).listSeries({ limit: 20, offset: 0, genre: 'Sci_Fi%' });
  assert.match(trace[0].sql, /ESCAPE '\\'/);
  assert.ok(trace[0].args.includes(String.raw`%"Sci\_Fi\%"%`), `unexpected pattern: ${JSON.stringify(trace[0].args)}`);

  const counted = makeStub({ rows: [{ c: 0 }] });
  await novelDb(counted.client).countSeries('Sci_Fi');
  assert.match(counted.trace[0].sql, /ESCAPE '\\'/);
  assert.ok(counted.trace[0].args.includes('%' + '"' + 'Sci\\_Fi' + '"' + '%'));
});

test('getSeriesBySourceId resolves on the natural key', async () => {
  const { client, trace } = makeStub({ rows: [SERIES] });
  assert.equal((await novelDb(client).getSeriesBySourceId('novelid', 'tekaburu'))?.title, 'Teka Buru');
  assert.deepEqual(trace[0].args, ['novelid', 'tekaburu']);
  assert.doesNotMatch(trace[0].sql, /FROM novel_series LIMIT 1/);
});

test('getSeriesBySlug filters on the slug, so an unknown slug cannot match row one', async () => {
  const { client, trace } = makeStub({ rows: [SERIES] });
  const novel = novelDb(client);
  await novel.getSeriesBySlug('novelid/tekaburu');
  assert.match(trace[0].sql, /FROM novel_series WHERE id = \?1/);
  assert.deepEqual(trace[0].args, ['novelid/tekaburu']);

  const other = makeStub();
  await novelDb(other.client).getSeriesBySlug('novelid/other');
  assert.deepEqual(other.trace[0].args, ['novelid/other']);
  assert.notEqual(other.trace[0].args[0], trace[0].args[0]);
  assert.match(other.trace[0].sql, /WHERE id = \?1/);
});

test('getSeriesBySlug returns null when the row is absent', async () => {
  const { client } = makeStub();
  assert.equal(await novelDb(client).getSeriesBySlug('nope'), null);
});

test('getSeriesBySourceId never degrades to an unfiltered first-row lookup', async () => {
  const { client, trace } = makeStub({ rows: [SERIES] });
  await novelDb(client).getSeriesBySourceId('novelid', 'tekaburu');
  assert.match(trace[0].sql, /WHERE source = \?1 AND source_series_id = \?2/);
  assert.doesNotMatch(trace[0].sql, /FROM novel_series LIMIT 1/);
});

test('listChapters orders by number ASC and clamps its limit', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).listChapters('novelid/tekaburu', { limit: 9999, offset: 0 });
  assert.match(trace[0].sql, /ORDER BY number ASC/);
  assert.equal(trace[0].args[1], 100);
});

// The list routes answer with summaries: a 50-row window of chapter bodies is
// ~1MB that no list caller reads. Only getChapter may carry the prose.
test('listChapterSummaries selects no prose columns', async () => {
  const { client, trace } = makeStub({ rows: [{ id: 's:s/1', source_chapter_id: 's/1', number: 1, title: 'Bab 1' }] });
  const rows = await novelDb(client).listChapterSummaries('novelid/tekaburu', { limit: 50, offset: 0 });
  const select = trace[0].sql.slice(trace[0].sql.indexOf('SELECT') + 6, trace[0].sql.indexOf('FROM'));
  assert.equal(select.trim(), 'id, series_id, source_chapter_id, number, title');
  assert.doesNotMatch(trace[0].sql, /content_hash|content|source_url|scraped_at/);
  assert.match(trace[0].sql, /ORDER BY number ASC/);
  assert.deepEqual(trace[0].args, ['novelid/tekaburu', 50, 0]);
  assert.ok(rows.length > 0);
});

test('listChapterSummaries clamps its window exactly like listChapters', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).listChapterSummaries('s', { limit: 9999, offset: -5 });
  assert.equal(trace[0].args[1], 100, 'limit clamped to the db ceiling');
  assert.equal(trace[0].args[2], 0, 'negative offset clamped to 0');
});

test('getChapter still selects the full column set', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).getChapter('s', 's/1');
  assert.match(trace[0].sql, /content_hash/);
  assert.match(trace[0].sql, /WHERE series_id = \?1 AND source_chapter_id = \?2/);
});

test('fillSeriesGaps writes only the columns present in its patch', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('novelid/tekaburu', { synopsis: 'filled' });
  assert.deepEqual(setClause(trace[0].sql).map(setColumn), ['synopsis']);
  assert.doesNotMatch(trace[0].sql, /author|cover_fallback/);
  assert.equal(trace[0].args.at(-1), 'novelid/tekaburu');
});

test('fillSeriesGaps with every key writes all four gap columns', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('s', {
    cover_fallback: 'https://example.test/c.jpg',
    synopsis: 'syn',
    author: 'Anon',
    // novelid's search cards carry no status and neither tier-2 source does, so
    // the tier-1 detail page is the only thing that can ever set it.
    status: 'Ongoing',
  });
  assert.deepEqual(
    setClause(trace[0].sql).map(setColumn),
    ['cover_fallback', 'synopsis', 'author', 'status'],
  );
  assert.deepEqual(trace[0].args, ['https://example.test/c.jpg', 'syn', 'Anon', 'Ongoing', 's']);
});

test('fillSeriesGaps never overwrites a populated column', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('s', {
    cover_fallback: 'https://example.test/c.jpg',
    synopsis: 'syn',
    author: 'Anon',
    status: 'Ongoing',
  });
  for (const col of ['cover_fallback', 'synopsis', 'author', 'status']) {
    assert.ok(
      trace[0].sql.includes(`${col} = COALESCE(NULLIF(${col}, ''), ?`),
      `${col} must only be written while it is still empty`,
    );
  }
  assert.doesNotMatch(trace[0].sql, /updated_at/, 'a metadata fill must not reset the staleness clock');
  assert.doesNotMatch(trace[0].sql, /IS NULL OR/, 'a row-wide guard would couple the columns together');
});

// A WHERE-level guard is row-wide: one populated sibling suppresses the whole
// update, silently skipping the empty columns in the same patch.
test('fillSeriesGaps fills the empty column even when a sibling is populated', async () => {
  const { client, trace } = makeStub();
  await novelDb(client).fillSeriesGaps('s', { synopsis: 'from tier 2', author: 'Anon' });
  const [synopsis, author] = setClause(trace[0].sql);
  assert.equal(setColumn(synopsis), 'synopsis');
  assert.equal(setColumn(author), 'author', 'both columns are assigned, not filtered out of the SET list');
  assert.match(synopsis, /COALESCE\(NULLIF\(synopsis, ''\), \?1\)/);
  assert.match(author, /COALESCE\(NULLIF\(author, ''\), \?2\)/);
  assert.match(trace[0].sql, /WHERE id = \?3$/, 'the only WHERE condition is the row id');
  assert.deepEqual(trace[0].args, ['from tier 2', 'Anon', 's']);
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

test('two series may hold the same chapter number without a primary key clash', async () => {
  const { client, trace, batches } = makeStub({ rows: [] });
  const novel = novelDb(client);
  await novel.upsertChapters('novelid/tekaburu', [chapter(1, 'hash-a', 'body-a')]);
  await novel.upsertChapters('noveltoon/tekaburu', [chapter(1, 'hash-b', 'body-b', 'noveltoon/tekaburu')]);
  const inserts = trace.filter((r) => r.sql.includes('INSERT INTO novel_chapters'));
  assert.equal(inserts.length, 2);
  const [idA, idB] = inserts.map((r) => r.args[0]);
  assert.notEqual(idA, idB, 'novel_chapters.id is a global primary key, so it must be series-scoped');
  assert.deepEqual(inserts.map((r) => r.args[1]), ['novelid/tekaburu', 'noveltoon/tekaburu']);
  assert.equal(batches.length, 2);
});

test('upsertChapters skips a row with no content_hash instead of writing it', async () => {
  const { client, trace } = makeStub({
    rows: [{ source_chapter_id: 'src-1', content_hash: 'hash-a' }],
  });
  const empty = { inserted: 0, updated: 0, unchanged: 0 };
  const novel = novelDb(client);
  assert.deepEqual(await novel.upsertChapters('s', [{ ...chapter(1, 'hash-a', 'b'), content_hash: undefined }]), empty);
  assert.equal(trace.length, 0, 'a hashless row is dropped before the lookup, not written');
  assert.deepEqual(await novel.upsertChapters('s', [{ ...chapter(1, 'hash-a', undefined), content: undefined }]), empty);
  assert.equal(trace.length, 0, 'content is NOT NULL, so a row without it is dropped too');
  assert.deepEqual(await novel.upsertChapters('s', [chapter(1, '', 'b')]), empty);
  assert.equal(trace.length, 0, 'an empty hash compares unequal and would defeat the quota guard');
});

test('listStaleSeries derives its cutoff from a relative age', async () => {
  const { client, trace } = makeStub({ rows: [SERIES] });
  const before = Math.floor(Date.now() / 1000);
  const rows = await novelDb(client).listStaleSeries(86400, 50);
  const after = Math.floor(Date.now() / 1000);
  assert.equal(rows.length, 1);
  assert.match(trace[0].sql, /FROM novel_series\s+WHERE updated_at < \?1/);
  const cutoff = trace[0].args[0];
  assert.ok(
    cutoff >= before - 86400 && cutoff <= after - 86400,
    'the bound cutoff is a timestamp derived from the age, not the age itself',
  );
  assert.equal(trace[0].args[1], 50);
  // The chapterless branch binds no second value: it is not a window a caller
  // could widen, but "this row has never been visited", which is a fact about
  // the row rather than a duration. Any window long enough to cover the gap
  // between a cron tick and a series created just after it also covers the next
  // tick, so it cannot promise a single-shot exemption.
  assert.equal(trace[0].args.length, 2);
  assert.match(trace[0].sql, /updated_at = created_at/);
  assert.match(trace[0].sql, /NOT EXISTS \(SELECT 1 FROM novel_chapters WHERE series_id = novel_series\.id\)/);
});
