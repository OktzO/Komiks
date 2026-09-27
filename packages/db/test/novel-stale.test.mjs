// listStaleSeries against a real SQL engine, on the committed migration schema.
//
// The rest of this suite stubs D1, which proves the SQL string and its bound
// arguments but cannot prove what the query *returns* — and the first real sync
// shipped two defects that a string assertion cannot see. So this file opens an
// in-memory SQLite, applies packages/db/migrations/0021_novel_module.sql
// verbatim, and drives the real NovelDb through a D1-shaped shim.
//
// Runs under bun because `bun:sqlite` is the only SQL engine available without
// adding a dependency; the other two files in this package stay on tsx + a stub.
import { readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novelDb } from '../index.ts';

const MIGRATION = readFileSync(
  new URL('../migrations/0021_novel_module.sql', import.meta.url),
  'utf8',
);

// Enough of D1Database for NovelDb: prepare().bind().all() and nothing else.
const d1Shim = (db) => ({
  prepare(sql) {
    const stmt = db.query(sql);
    const shim = {
      bind: (...args) => ({ all: () => ({ results: stmt.all(...args) }) }),
      all: () => ({ results: stmt.all() }),
    };
    return shim;
  },
});

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const fresh = () => {
  const db = new Database(':memory:');
  for (const sql of MIGRATION.split(';')) {
    const trimmed = sql.trim();
    if (trimmed) db.run(trimmed);
  }
  return db;
};

const series = (db, id, updatedAt) =>
  db
    .query(
      `INSERT INTO novel_series (id, source_series_id, source, title, created_at, updated_at)
       VALUES (?1, ?2, 'novelid', ?3, ?4, ?4)`,
    )
    .run(id, id.replace('novelid-', ''), id, updatedAt);

const chapter = (db, seriesId, n) =>
  db
    .query(
      `INSERT INTO novel_chapters
         (id, series_id, source_chapter_id, number, content, content_hash, scraped_at)
       VALUES (?1, ?2, ?3, ?4, 'prosa', 'hash', ?5)`,
    )
    .run(`${seriesId}:${n}`, seriesId, `${seriesId}/${n}`, n, NOW);

// Unsorted: the query orders by updated_at, and one assertion below is about that
// order rather than about membership.
const staleIds = async (db, olderThanSec = DAY, limit = 20) =>
  (await novelDb(d1Shim(db)).listStaleSeries(olderThanSec, limit)).map((r) => r.id);


// The first real sync: a series inserted seconds ago is not older than the 24h
// window, so its chapters were never fetched and every series sat at
// chapters: 0 for a day. Zero chapters is the signal that a row exists but was
// never filled, so it is stale on its own.
test('a series inserted now with no chapters is stale, so the first fill is not a day away', async () => {
  const db = fresh();
  series(db, 'novelid-just-inserted', NOW);
  assert.deepEqual(await staleIds(db), ['novelid-just-inserted']);
});

test('a fresh series that already has chapters is not stale', async () => {
  const db = fresh();
  series(db, 'novelid-filled', NOW);
  chapter(db, 'novelid-filled', 1);
  assert.deepEqual(await staleIds(db), []);
});

test('the chapterless exemption is a bootstrap, not a permanent re-fetch', async () => {
  const db = fresh();
  // A series whose fill kept failing is never bumped by refreshSeries, so it ages
  // out of the bootstrap window and the age test takes over: retried once per
  // window, not once per cron tick.
  series(db, 'novelid-failed-fill', NOW - 2 * DAY);
  assert.deepEqual(await staleIds(db), ['novelid-failed-fill']);

  // Inside the window a chapterless series is eligible, but it must not jump
  // ahead of a row that really is stale: ORDER BY updated_at ASC is what stops a
  // cron from spending its whole visit budget on the series it just inserted.
  const db2 = fresh();
  series(db2, 'novelid-bootstrapping', NOW);
  series(db2, 'novelid-genuinely-old', NOW - 30 * DAY);
  assert.deepEqual(await staleIds(db2), ['novelid-genuinely-old', 'novelid-bootstrapping']);

  // The visit that fills it bumps updated_at and the exemption retires.
  chapter(db2, 'novelid-bootstrapping', 1);
  assert.deepEqual(await staleIds(db2), ['novelid-genuinely-old']);
});

test('an old series with chapters is still stale, and the limit still bounds the pass', async () => {
  const db = fresh();
  series(db, 'novelid-old-with-chapters', NOW - 3 * DAY);
  chapter(db, 'novelid-old-with-chapters', 1);
  assert.deepEqual(await staleIds(db), ['novelid-old-with-chapters']);

  for (const id of ['novelid-a', 'novelid-b', 'novelid-c']) series(db, id, NOW - 5 * DAY);
  assert.deepEqual((await staleIds(db, DAY, 2)).length, 2);
});
