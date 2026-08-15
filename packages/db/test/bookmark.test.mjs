// addBookmark FK-parent guarantee self-check.
// Mirrors user-profile.test.mjs: node:test + node:assert/strict, ESM, plain JS.
//
// Regression: POST /api/user/bookmark 500'd ("FOREIGN KEY constraint failed")
// when the slug wasn't already in this D1's `series` table. On the auth origin
// (akun-2) the series table is sparse, so most slugs failed → the frontend
// BookmarkButton reverted its optimistic state ("mental"). The fix upserts a
// minimal `series` row BEFORE inserting the bookmark so the FK parent exists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function makeStub({ firstRow }) {
  const trace = [];
  const stmt = {
    sql: '',
    bound: [],
    bind(...args) { this.bound = args; return this; },
    run() { trace.push({ sql: this.sql, bound: this.bound }); return { success: true, meta: {} }; },
    first() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve(firstRow); },
    all() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve({ results: [] }); },
  };
  const client = {
    prepare(sql) { stmt.sql = sql; stmt.bound = []; return stmt; },
    batch() { return Promise.resolve([]); },
  };
  return { client, trace };
}

const { db } = await import('../index.ts');

describe('addBookmark', () => {
  test('is a function on Db', () => {
    const { client } = makeStub({ firstRow: null });
    assert.equal(typeof db(client).addBookmark, 'function');
  });

  test('upserts the series FK parent BEFORE the bookmark insert', async () => {
    const { client, trace } = makeStub({ firstRow: null });
    await db(client).addBookmark({
      userId: 5,
      seriesSlug: 'magic-emperor',
      source: 'bacakomik',
      source_url: 'https://bacakomik.co/manga/magic-emperor',
      title: 'Magic Emperor',
      cover_image: 'https://cdn/cover.jpg',
    });
    assert.equal(trace.length, 2, `expected 2 statements, got ${trace.length}: ${JSON.stringify(trace)}`);
    const upsert = trace[0];
    const insert = trace[1];
    assert.ok(upsert.sql.startsWith('INSERT INTO series'), `first stmt should create the series row: ${upsert.sql}`);
    assert.ok(upsert.sql.includes('ON CONFLICT(slug)'), upsert.sql);
    assert.equal(upsert.bound[0], 'magic-emperor');
    assert.equal(upsert.bound[1], 'bacakomik');
    assert.equal(upsert.bound[2], 'Magic Emperor');
    assert.equal(upsert.bound[3], 'https://cdn/cover.jpg');
    assert.ok(insert.sql.startsWith('INSERT OR IGNORE INTO bookmarks'), insert.sql);
    assert.equal(insert.bound[0], 5);
    assert.equal(insert.bound[1], 'magic-emperor');
  });

  test('falls back to slug as title when title not provided', async () => {
    const { client, trace } = makeStub({ firstRow: null });
    await db(client).addBookmark({ userId: 7, seriesSlug: 'eleceed' });
    const upsert = trace[0];
    assert.equal(upsert.bound[2], 'eleceed');
  });
});
