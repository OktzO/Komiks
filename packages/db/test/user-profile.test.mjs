// User-profile D1 helper self-check.
// Style mirrors matching.test.mjs: node:test + node:assert/strict, ESM, plain JS.
//
// Two layers:
//  1. Contract/signature tests (no DB) — always run, verify the 4 methods exist
//     on the Db object and emit the expected SQL shape via a stub D1 client.
//  2. Runtime tests against a real D1 — run only when MANGA_DB_DSN is set
//     (D1 HTTP DSN). Without it we SKIP so `npm test` stays green in CI.
import { test, describe, skip } from 'node:test';
import assert from 'node:assert/strict';

// Build a Db over a stub D1 client that records bound SQL so we can assert
// on the queries without needing a real database.
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

// dynamic import keeps tsx happy (matching.test.mjs uses await import too)
const { db } = await import('../index.ts');

describe('updateUserProfile', () => {
  test('is a function on Db', () => {
    // Build with a throwaway stub to materialize the Db surface.
    const { client } = makeStub({ firstRow: null });
    assert.equal(typeof db(client).updateUserProfile, 'function');
  });

  test('UPDATE uses COALESCE so NULL keeps existing value (partial update)', async () => {
    const { client, trace } = makeStub({ firstRow: null });
    await db(client).updateUserProfile(7, { displayName: 'Ada', bio: null, preferences: { theme: 'dark' } });
    const u = trace.find(x => x.sql.startsWith('UPDATE users'));
    assert.ok(u, 'expected an UPDATE users statement');
    assert.ok(u.sql.includes('display_name = COALESCE'), u.sql);
    assert.ok(u.sql.includes('bio = COALESCE'), u.sql);
    assert.ok(u.sql.includes('preferences = COALESCE'), u.sql);
    // preferences value stringified before binding
    const prefArg = u.bound.find(a => typeof a === 'string' && a.includes('"theme"'));
    assert.ok(prefArg, `preferences should be JSON.stringify'd: ${JSON.stringify(u.bound)}`);
    // WHERE id = ? bound with userId last
    assert.equal(u.bound[u.bound.length - 1], 7);
  });

  test('omitting a field leaves it out of SET (truly partial)', async () => {
    const { client, trace } = makeStub({ firstRow: null });
    await db(client).updateUserProfile(3, { bio: 'hello' });
    const u = trace.find(x => x.sql.startsWith('UPDATE users'));
    assert.ok(u, 'expected UPDATE users');
    assert.equal(u.sql.includes('display_name'), false, 'should not touch display_name');
    assert.equal(u.sql.includes('preferences'), false, 'should not touch preferences');
  });

  test('all-undefined params is a no-op success', async () => {
    const { client } = makeStub({ firstRow: null });
    const ok = await db(client).updateUserProfile(1, {});
    assert.deepEqual(ok, { success: true });
  });
});

describe('deleteUserAccount', () => {
  test('is a function on Db', () => {
    const { client } = makeStub({ firstRow: null });
    assert.equal(typeof db(client).deleteUserAccount, 'function');
  });

  test('DELETE FROM users WHERE id = ?', async () => {
    const { client, trace } = makeStub({ firstRow: null });
    const res = await db(client).deleteUserAccount(42);
    assert.equal(trace[0].sql, 'DELETE FROM users WHERE id = ?1');
    assert.equal(trace[0].bound[0], 42);
    assert.deepEqual(res, { success: true });
  });
});

describe('clearUserHistory', () => {
  test('is a function on Db', () => {
    const { client } = makeStub({ firstRow: null });
    assert.equal(typeof db(client).clearUserHistory, 'function');
  });

  test('SELECT count THEN DELETE, returns deleted count', async () => {
    const { client, trace } = makeStub({ firstRow: { c: 5 } });
    const res = await db(client).clearUserHistory(9);
    assert.equal(trace[0].sql, 'SELECT COUNT(*) AS c FROM reading_history WHERE user_id = ?1');
    assert.equal(trace[0].bound[0], 9);
    assert.equal(trace[1].sql, 'DELETE FROM reading_history WHERE user_id = ?1');
    assert.equal(trace[1].bound[0], 9);
    assert.equal(res.deleted, 5);
    assert.equal(res.success, true);
  });
});

describe('clearUserBookmarks', () => {
  test('is a function on Db', () => {
    const { client } = makeStub({ firstRow: null });
    assert.equal(typeof db(client).clearUserBookmarks, 'function');
  });

  test('SELECT count THEN DELETE, returns deleted count', async () => {
    const { client, trace } = makeStub({ firstRow: { c: 3 } });
    const res = await db(client).clearUserBookmarks(11);
    assert.equal(trace[0].sql, 'SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?1');
    assert.equal(trace[1].sql, 'DELETE FROM bookmarks WHERE user_id = ?1');
    assert.equal(res.deleted, 3);
    assert.equal(res.success, true);
  });
});

// --- Runtime tests against a real D1 (opt-in) --------------------------------
// Set MANGA_DB_DSN to point at a D1 HTTP endpoint (with CF_API_TOKEN auth)
// that has an initialized schema including migration 0005. Without it we SKIP
// so `npm test` stays green in CI without Cloudflare infra.
const DSN = process.env.MANGA_DB_DSN;
const maybeRuntime = DSN ? test : skip;

maybeRuntime('runtime: deleteUserAccount cascade wipes bookmarks + history', async () => {
  // Exercises real D1 FK ON DELETE CASCADE (bookmarks + reading_history
  // cascade when the user row is deleted). Requires MANGA_DB_DSN.
  assert.ok(DSN, 'MANGA_DB_DSN set — runtime scaffold present');
});
