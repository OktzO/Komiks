import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function makeStub() {
  const trace = [];
  const newStmt = (sql) => {
    const s = {
      sql, bound: [],
      bind(...args) { this.bound = args; return this; },
      run() { trace.push({ sql: this.sql, bound: this.bound }); return { success: true, meta: {} }; },
      first() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve(null); },
      all() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve({ results: [] }); },
    };
    return s;
  };
  const client = {
    prepare(sql) { return newStmt(sql); },
  };
  client.batch = (stmts) => { client.batch.callCount++; trace.push(...(stmts ?? []).map((s) => ({ sql: s.sql, bound: s.bound }))); return Promise.resolve([]); };
  client.batch.callCount = 0;
  return { client, trace };
}

const { db } = await import('../index.ts');

describe('storage rename', () => {
  test('markPageB2Uploaded exists and writes ON CONFLICT upsert', async () => {
    const { client, trace } = makeStub();
    const res = await db(client).markPageB2Uploaded({
      chapterId: 'ch-1', pageNumber: 2, imageUrl: 'http://img/u.jpg',
      b2Key: 'komiku/slug/ch-1/2', b2AccountIdx: -1,
    });
    assert.equal(res.success, true);
    assert.match(trace[0].sql, /INSERT INTO chapter_pages/);
    assert.match(trace[0].sql, /ON CONFLICT\(chapter_id, page_number\) DO UPDATE SET r2_key = excluded\.r2_key, r2_account_idx = excluded\.r2_account_idx/);
    assert.deepEqual(trace[0].bound, ['ch-1', 2, 'http://img/u.jpg', 'komiku/slug/ch-1/2', -1]);
  });

  test('touchLastAccess removed from interface', () => {
    assert.equal(db(makeStub().client).touchLastAccess, undefined);
  });

  test('upsertChapters batched idempoten (ON CONFLICT push-update)', async () => {
    const { client, trace } = makeStub();
    const res = await db(client).upsertChapters({
      seriesSlug: 'slug-a',
      chapters: [
        { id: 'slug-a-chapter-1', series_slug: 'slug-a', chapter_number: 1, title: 'Ch 1', language: 'id', pages_count: 12 },
        { id: 'slug-a-chapter-2', series_slug: 'slug-a', chapter_number: 2, title: null, language: 'id', pages_count: 0 },
      ],
    });
    assert.equal(res.inserted, 2);
    assert.equal(client.batch.callCount, 1);
    assert.match(trace[0].sql, /INSERT INTO chapters/);
    assert.match(trace[0].sql, /ON CONFLICT\(id\) DO UPDATE SET/);
    assert.deepEqual(trace[0].bound, ['slug-a-chapter-1', 'slug-a', 1, null, 'Ch 1', 'id', 12, null]);
  });

  test('upsertChapters skip chapter tanpa id', async () => {
    const { client } = makeStub();
    const res = await db(client).upsertChapters({
      seriesSlug: 's',
      chapters: [{ id: '', series_slug: 's', chapter_number: 1 }],
    });
    assert.equal(res.inserted, 0);
  });
});
