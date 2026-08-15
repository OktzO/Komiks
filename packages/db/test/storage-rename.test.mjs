import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function makeStub() {
  const trace = [];
  const stmt = {
    sql: '', bound: [],
    bind(...args) { this.bound = args; return this; },
    run() { trace.push({ sql: this.sql, bound: this.bound }); return { success: true, meta: {} }; },
    first() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve(null); },
    all() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve({ results: [] }); },
  };
  const client = {
    prepare(sql) { stmt.sql = sql; stmt.bound = []; return stmt; },
    batch() { return Promise.resolve([]); },
  };
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
});
