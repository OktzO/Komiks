// The operator trigger for the novel catalogue crawl. Three things can go wrong
// here and none of them show up in a log the operator is watching: the auth
// gate silently opening, the crawl running on three of four workers at once, or
// the 12h guard eating the trigger the operator just asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { router, runCatalogSync } from '../src/routes/admin/novel.ts';
import { CATALOG_CRAWL_KEY } from '../src/lib/novelIngest.ts';
import { ownerFor } from '../src/lib/peers.ts';

const PEER_URLS = 'https://w0.test,https://w1.test,https://w2.test,https://w3.test';

const kvStub = () => {
  const kv = new Map();
  return {
    kv,
    async get(key) { return kv.has(key) ? kv.get(key) : null; },
    async put(key, value) { kv.set(key, value); },
    async delete(key) { kv.delete(key); },
  };
};

// The crawler is elected by hash over the shared peer list, so which index it is
// has to be derived rather than assumed — the test asks the same helper the
// route asks, and asserts the other three decline.
const crawlerIndex = () => {
  for (let i = 0; i < 4; i++) {
    if (ownerFor({ PEER_URLS, PEER_INDEX: String(i) }, CATALOG_CRAWL_KEY).self) return i;
  }
  throw new Error('no crawler elected');
};

// The handler is mounted bare so the behaviour is exercised for real, and the
// gate is asserted separately against the real router — a test that has to forge
// an ECDSA session to reach the body proves nothing about the body.
const bareApp = () => {
  const app = new Hono();
  app.post('/sync', runCatalogSync);
  return app;
};

const crawlEnv = () => ({
  PEER_URLS,
  PEER_INDEX: String(crawlerIndex()),
  CACHE_KV: kvStub(),
  DB: dbStub(),
});

// Every series the fixture lists is genuinely absent, so the pass really inserts.
// Without a D1 the handler throws and the route looks broken when it is only
// un-fed. No B2 accounts, so uploadNovelCover returns null before any fetch.
const dbStub = () => ({
  prepare: () => {
    const stmt = {
      bind: () => stmt,
      async first() { return null; },
      async all() { return { results: [] }; },
      async run() { return { success: true, meta: { changes: 1, rows_written: 1 } }; },
    };
    return stmt;
  },
  async batch(stmts) { return stmts.map(() => ({ success: true, meta: { changes: 1 } })); },
});

const post = (app, env, query = '') =>
  app.fetch(new Request(`https://w.test/sync${query}`, { method: 'POST' }), env);

// The listing is stubbed at the adapter boundary, so a pass is countable and
// touches no network. Everything below the route is the real syncCatalog.
const withStubbedListing = async (fn) => {
  const offsets = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input?.url ?? input);
    if (url.endsWith('/robots.txt')) {
      return Promise.resolve(new Response('User-agent: *\nDisallow: /includes/\n', { status: 200 }));
    }
    if (url.includes('/genre/')) {
      const page = Number(/\/page\/(\d+)\//.exec(url)?.[1] ?? 1);
      offsets.push(page);
      // A short page is the end of the listing, so one pass completes.
      return Promise.resolve(new Response(page === 1 ? searchFixture : '', { status: 200 }));
    }
    return Promise.reject(new Error(`network disabled: ${url}`));
  };
  try {
    return await fn(offsets);
  } finally {
    globalThis.fetch = original;
  }
};

let searchFixture = '';
test('setup: the real novelid listing fixture', async () => {
  const { readFileSync } = await import('node:fs');
  searchFixture = readFileSync(
    new URL('../../../packages/sources/test/fixtures/novelid-search.html', import.meta.url),
    'utf8',
  );
  assert.ok(searchFixture.includes('genre-item-box'), 'the fixture is the 18-card listing page');
});

test('the real router refuses the call without an admin session', async () => {
  const app = new Hono();
  app.route('/api/admin', router);
  await withStubbedListing(async (offsets) => {
    const env = crawlEnv();
    env.DB = new Proxy({}, { get() { throw new Error('the DB must not be reached without a session'); } });
    const res = await app.fetch(
      new Request('https://w.test/api/admin/novel/catalog/sync?force=1', { method: 'POST' }),
      env,
    );
    assert.equal(res.status, 403, 'the session gate runs before the handler');
    assert.equal((await res.json()).error, 'admin required');
    assert.deepEqual(offsets, [], 'and nothing upstream was touched');
  });
});

test('the crawl is elected to exactly one worker; the rest decline by name', async () => {
  await withStubbedListing(async () => {
    const app = bareApp();
    const results = [];
    for (let i = 0; i < 4; i++) {
      const res = await post(app, { ...crawlEnv(), PEER_INDEX: String(i) });
      results.push({ i, status: res.status, body: await res.json() });
    }
    assert.equal(results.filter((r) => r.body.ran === true).length, 1, 'one worker pays the upstream cost, same as the cron');
    const declined = results.filter((r) => r.body.ran === false);
    assert.equal(declined.length, 3);
    for (const d of declined) {
      assert.equal(d.status, 409, 'a decline is a 409, not a 200 that silently synced nothing');
      assert.equal(d.body.reason, 'not-catalog-crawler');
      assert.match(d.body.crawler, /^https:\/\/w\d\.test$/, 'and it names the worker to aim at instead');
    }
  });
});

test('a pass runs the listing and reports the counts an operator reads', async () => {
  await withStubbedListing(async (offsets) => {
    const res = await post(bareApp(), crawlEnv());
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ran, true);
    assert.equal(body.forced, false, 'the guard is untouched unless force asks for it');
    assert.deepEqual(offsets, [1], 'the listing page 1 was walked, and the fixture holds 18 real cards');
    for (const key of ['inserted', 'filled', 'skipped', 'pages', 'cursor', 'complete']) {
      assert.ok(key in body, `the reply reports ${key}`);
    }
    assert.equal(body.pages, 1);
    // 18 new series at 3 subrequests each does not fit one invocation, so the
    // pass stops inside page 1 and says where the next one starts. The point of
    // reporting the cursor is that the operator can see the walk is partial.
    assert.equal(body.complete, false);
    assert.equal(body.cursor, 18, 'so the next pass re-walks the page it did not finish');
    assert.ok(body.inserted > 0 && body.inserted < 18, 'it really inserted some, but not all 18');
  });
});

test('force=1 overrides the 12h guard and re-stamps it so the cron does not double-crawl', async () => {
  await withStubbedListing(async () => {
    const LAST_SYNC = 'novel:catalog:last_sync';
    const env = crawlEnv();
    const stale = String(Date.now() - 11 * 3600 * 1000);
    await env.CACHE_KV.put(LAST_SYNC, stale);

    const plain = await (await post(bareApp(), env)).json();
    assert.equal(plain.ran, true);
    assert.equal(plain.forced, false);
    assert.equal(await env.CACHE_KV.get(LAST_SYNC), stale, 'without force the guard is left exactly as it was');

    const forced = await (await post(bareApp(), env, '?force=1')).json();
    assert.equal(forced.ran, true);
    assert.equal(forced.forced, true);
    const after = Number(await env.CACHE_KV.get(LAST_SYNC));
    assert.ok(Number.isFinite(after) && after > Number(stale), 'force=1 re-stamps the guard');
    assert.ok(Date.now() - after < 60_000, 'so the next cron tick waits instead of re-crawling');
  });
});
