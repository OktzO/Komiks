import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { router } from '../src/routes/internal.ts';

function stubEnv(over = {}) {
  const stmt = {
    sql: '', bound: [], boundArgs: [],
    bind(...args) { this.bound = args; return this; },
    run() { return { success: true, meta: {} }; },
    all() { return { results: [{ page_number: 1, r2_key: 'k', r2_account_idx: -1 }] }; },
    first() { return null; },
  };
  const kv = {
    store: { 'series:detail:komiku:naruto:id': JSON.stringify({ data: 1 }) },
    async get(k, fmt) { const v = this.store[k] ?? null; return v == null ? null : (fmt === 'json' ? JSON.parse(v) : v); },
  };
  return {
    DB: {
      prepare(sql) { stmt.sql = sql; stmt.bound = []; return stmt; },
      batch() { return Promise.resolve([]); },
    },
    CACHE_KV: kv,
    DB_FORWARD_KEY: 'sekret',
    ...over,
  };
}

const app = new Hono();
app.route('/api/_internal', router);

test('db/exec rejects without forward key', async () => {
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT 1', params: [], table: 'chapter_pages' }),
  }, stubEnv());
  assert.equal(res.status, 401);
});

test('db/exec rejects DROP/ALTER/TRUNCATE on allowlisted table', async () => {
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'DROP TABLE users', params: [], table: 'users' }),
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('db/query rejects write SQL (SELECT-only)', async () => {
  const res = await app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'UPDATE chapter_pages SET r2_key = NULL', params: [], table: 'chapter_pages' }),
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('db/query returns rows for SELECT on allowlisted table', async () => {
  const res = await app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({
      sql: 'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1',
      params: ['ch-1'], table: 'chapter_pages',
    }),
  }, stubEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.results.length, 1);
  assert.equal(j.results[0].page_number, 1);
});

test('kv/get rejects non-allowlisted key prefix', async () => {
  const res = await app.request('/api/_internal/kv/get?key=secret:data', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('kv/get returns cached value for allowlisted prefix', async () => {
  const res = await app.request('/api/_internal/kv/get?key=series:detail:komiku:naruto:id', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, stubEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.value, { data: 1 });
});
