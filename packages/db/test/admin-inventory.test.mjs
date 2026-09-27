import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../index.ts';

const makeStub = ({ first = null, results = [] } = {}) => {
  const trace = [];
  const client = {
    prepare(sql) {
      const stmt = {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { trace.push({ sql, args: this.args, kind: 'first' }); return first; },
        async all() { trace.push({ sql, args: this.args, kind: 'all' }); return { results }; },
        async run() { trace.push({ sql, args: this.args, kind: 'run' }); return { success: true }; },
      };
      return stmt;
    },
    batch() { return Promise.resolve([]); },
  };
  return { client, trace };
};

test('updateAccountCredentialStatus persists status and timestamp', async () => {
  const { client, trace } = makeStub();
  await db(client).updateAccountCredentialStatus('acc-1', 'failed', 1234);
  assert.match(trace[0].sql, /UPDATE lb_accounts SET status = \?1, last_tested_at = \?2/);
  assert.deepEqual(trace[0].args, ['failed', 1234, 'acc-1']);
});

test('getLbAccount returns safe account row with last test timestamp', async () => {
  const account = {
    id: 'acc-1',
    provider: 'cloudflare',
    label: 'Account 1',
    account_ref: 'ref-1',
    token_last4: '1234',
    status: 'verified',
    last_tested_at: 1234,
    created_by: 7,
    created_at: 1000,
  };
  const { client, trace } = makeStub({ first: account });
  assert.deepEqual(await db(client).getLbAccount('acc-1'), account);
  assert.deepEqual(trace[0].args, ['acc-1']);
  assert.match(trace[0].sql, /SELECT id, provider, label, account_ref, token_last4, status, last_tested_at, created_by, created_at FROM lb_accounts/);
  assert.doesNotMatch(trace[0].sql, /encrypted_token/);
});

test('listAccounts exposes last test timestamp', async () => {
  const { client, trace } = makeStub({ results: [] });
  await db(client).listAccounts();
  assert.match(trace[0].sql, /status, last_tested_at, created_by/);
});

test('getLbOriginByUrl normalizes trailing slash', async () => {
  const { client, trace } = makeStub({ first: null });
  await db(client).getLbOriginByUrl('https://w1.test/');
  assert.deepEqual(trace[0].args, ['https://w1.test']);
});

test('getLbOriginByUrl breaks duplicate URL ties the same way listOrigins orders them', async () => {
  const { client, trace } = makeStub({ first: null });
  await db(client).getLbOriginByUrl('https://w1.test');
  assert.match(trace[0].sql, /ORDER BY priority DESC, id LIMIT 1/);
});

// Real SQLite, because the matching semantics live entirely in the SQL text and
// a stub cannot prove them.
const makeSqlite = (rows) => {
  const trace = [];
  const real = new DatabaseSync(':memory:');
  real.exec('CREATE TABLE lb_origins (id TEXT, origin_url TEXT, priority INT, weight INT, enabled INT, last_health_status TEXT)');
  const insert = real.prepare('INSERT INTO lb_origins VALUES (?1, ?2, ?3, ?4, ?5, ?6)');
  for (const row of rows) insert.run(row.id, row.origin_url, row.priority, 1, 1, null);
  const client = {
    prepare(sql) {
      const stmt = real.prepare(sql);
      return {
        sql,
        args: [],
        bind(...a) { this.args = a; return this; },
        async first() { trace.push({ sql, args: this.args }); return stmt.get(...this.args) ?? null; },
        async all() { trace.push({ sql, args: this.args }); return { results: stmt.all(...this.args) }; },
        async run() { trace.push({ sql, args: this.args }); return { success: true }; },
      };
    },
    batch() { return Promise.resolve([]); },
  };
  return { client, trace, real };
};

test('getLbOriginByUrl matches a stored trailing-slash row through a normalized argument', async () => {
  const { client, trace, real } = makeSqlite([{ id: 'o1', origin_url: 'https://w1.test/', priority: 3 }]);
  const row = await db(client).getLbOriginByUrl('https://w1.test');
  assert.equal(row.origin_url, 'https://w1.test/', 'the stored value is returned verbatim, never normalized');
  assert.equal(row.priority, 3);
  assert.deepEqual(trace[0].args, ['https://w1.test'], 'the bound argument is the normalized URL');
  assert.match(trace[0].sql, /WHERE rtrim\(origin_url, '\/'\)\s*=\s*\?1/);
});

test('getLbOriginByUrl matches a stored non-slash row and both forms in one table', async () => {
  const { client, real } = makeSqlite([
    { id: 'a-plain', origin_url: 'https://w1.test', priority: 1 },
    { id: 'b-slash', origin_url: 'https://w2.test/', priority: 2 },
  ]);
  assert.equal((await db(client).getLbOriginByUrl('https://w1.test')).id, 'a-plain');
  assert.equal((await db(client).getLbOriginByUrl('https://w2.test/')).id, 'b-slash');
  assert.equal(await db(client).getLbOriginByUrl('https://w3.test'), null);
  const stored = real.prepare('SELECT origin_url FROM lb_origins ORDER BY id').all();
  assert.deepEqual(stored.map((r) => r.origin_url), ['https://w1.test', 'https://w2.test/'], 'the read must not rewrite stored data');
});

test('getLbOriginByUrl picks the highest-priority row when a URL is stored twice', async () => {
  const { client } = makeSqlite([
    { id: 'low', origin_url: 'https://w1.test', priority: 2 },
    { id: 'high-slash', origin_url: 'https://w1.test/', priority: 9 },
  ]);
  assert.equal((await db(client).getLbOriginByUrl('https://w1.test')).id, 'high-slash');
});

test('getInventoryCounts uses one fixed SELECT', async () => {
  const { client, trace } = makeStub({ first: { series: 1, chapters: 2, chapter_pages: 3, users: 4, bookmarks: 5 } });
  const counts = await db(client).getInventoryCounts();
  assert.equal(trace.length, 1);
  assert.match(trace[0].sql, /SELECT\s+\(SELECT COUNT\(\*\) FROM series\)/);
  assert.deepEqual(counts, { series: 1, chapters: 2, chapterPages: 3, users: 4, bookmarks: 5 });
});

test('getInventoryCounts maps a missing row to nulls, never to fabricated zeros', async () => {
  const { client } = makeStub({ first: null });
  assert.deepEqual(await db(client).getInventoryCounts(), {
    series: null, chapters: null, chapterPages: null, users: null, bookmarks: null,
  });
});

test('getInventoryCounts keeps a null or unreadable column as null', async () => {
  const { client } = makeStub({ first: { series: 0, chapters: null, chapter_pages: 3, users: undefined, bookmarks: 'many' } });
  assert.deepEqual(await db(client).getInventoryCounts(), {
    series: 0, chapters: null, chapterPages: 3, users: null, bookmarks: null,
  });
});
