import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { buildOriginPool, isPublicOrigin, originCacheKey } from '../src/lib/originPool.ts';
import { getTopology } from '../src/lib/peers.ts';
import { router } from '../src/routes/origins.ts';

const topology = {
  count: 4,
  hash: 'hash-4',
  peers: [
    { url: 'https://w0.test', index: 0, self: true },
    { url: 'https://w1.test', index: 1, self: false },
    { url: 'https://w2.test', index: 2, self: false },
    { url: 'https://w3.test', index: 3, self: false },
  ],
};

const origin = (origin_url, over = {}) => ({
  id: origin_url,
  account_id: null,
  origin_url,
  priority: 0,
  weight: 1,
  enabled: 1,
  last_health_status: null,
  ...over,
});

test('topology four survives D1 with only two origins', () => {
  const pool = buildOriginPool(topology, [
    origin('https://w0.test', { priority: 0 }),
    origin('https://w1.test', { priority: 1 }),
  ]);
  assert.deepEqual(pool.map((o) => o.url), topology.peers.map((p) => p.url));
});

test('D1-only, disabled, and unhealthy origins are excluded', () => {
  const pool = buildOriginPool(topology, [
    origin('https://other.test'),
    origin('https://w1.test', { enabled: 0 }),
    origin('https://w2.test', { last_health_status: 'unhealthy' }),
    origin('https://w3.test', { priority: 5, weight: 3 }),
  ]);
  assert.deepEqual(pool.map((o) => o.url), ['https://w0.test', 'https://w3.test']);
  assert.equal(pool[1].priority, 5);
  assert.equal(pool[1].weight, 3);
});

test('N=0 returns empty without throwing', () => {
  assert.deepEqual(buildOriginPool({ count: 0, hash: 'empty', peers: [] }, []), []);
});

test('N=1 and N=2 return every configured peer', () => {
  for (const count of [1, 2]) {
    const peers = Array.from({ length: count }, (_, i) => ({ url: `https://w${i}.test`, index: i, self: i === 0 }));
    assert.deepEqual(
      buildOriginPool({ count, hash: `h${count}`, peers }, []).map((o) => o.url),
      peers.map((p) => p.url),
    );
  }
});

test('cache key changes with topology hash', () => {
  assert.notEqual(originCacheKey('a'), originCacheKey('b'));
});

test('isPublicOrigin accepts any finite number the D1 writer can produce', () => {
  for (const value of [0, -3, 2, 0.5, 1.25, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isPublicOrigin({ url: 'https://w0.test', priority: value, weight: 1, healthy: true }), true, `priority ${value}`);
    assert.equal(isPublicOrigin({ url: 'https://w0.test', priority: 1, weight: value, healthy: true }), true, `weight ${value}`);
  }
});

test('isPublicOrigin rejects non-finite and non-numeric numbers', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(isPublicOrigin({ url: 'https://w0.test', priority: value, weight: 1, healthy: true }), false, `priority ${value}`);
    assert.equal(isPublicOrigin({ url: 'https://w0.test', priority: 1, weight: value, healthy: true }), false, `weight ${value}`);
  }
  for (const value of ['3', null, undefined, true, {}, []]) {
    assert.equal(isPublicOrigin({ url: 'https://w0.test', priority: value, weight: 1, healthy: true }), false, `priority ${value}`);
    assert.equal(isPublicOrigin({ url: 'https://w0.test', priority: 1, weight: value, healthy: true }), false, `weight ${value}`);
  }
});

test('peer without a D1 row is visible, healthy, and keeps topology priority', () => {
  const pool = buildOriginPool(topology, []);
  assert.deepEqual(pool, [
    { url: 'https://w0.test', priority: 0, weight: 1, healthy: true },
    { url: 'https://w1.test', priority: 1, weight: 1, healthy: true },
    { url: 'https://w2.test', priority: 2, weight: 1, healthy: true },
    { url: 'https://w3.test', priority: 3, weight: 1, healthy: true },
  ]);
});

test('a real zero priority override is preserved instead of falling back to the peer index', () => {
  const pool = buildOriginPool(topology, [origin('https://w3.test', { priority: 0 })]);
  assert.equal(pool.find((o) => o.url === 'https://w3.test').priority, 0);
});

test('D1 override matches a topology peer regardless of trailing slash', () => {
  const pool = buildOriginPool(topology, [origin('https://w2.test/', { weight: 7 })]);
  const w2 = pool.find((o) => o.url === 'https://w2.test');
  assert.equal(w2.weight, 7);
});

test('excluding every topology peer yields an empty pool, not a D1 leftover', () => {
  const pool = buildOriginPool(topology, [
    origin('https://other.test'),
    origin('https://w0.test', { enabled: 0 }),
    origin('https://w1.test', { enabled: 0 }),
    origin('https://w2.test', { enabled: 0 }),
    origin('https://w3.test', { enabled: 0 }),
  ]);
  assert.deepEqual(pool, []);
});

test('last_health_status healthy is reported as healthy', () => {
  const pool = buildOriginPool(topology, [origin('https://w1.test', { last_health_status: 'healthy' })]);
  assert.equal(pool.find((o) => o.url === 'https://w1.test').healthy, true);
});

test('only a null or exactly healthy status is served; unknown free text is excluded', () => {
  const pool = buildOriginPool(topology, [
    origin('https://w0.test', { last_health_status: 'degraded' }),
    origin('https://w1.test', { last_health_status: 'HEALTHY' }),
    origin('https://w2.test', { last_health_status: '' }),
    origin('https://w3.test', { last_health_status: 'unknown' }),
  ]);
  assert.deepEqual(pool, [], 'no unknown status may produce a served entry');
});

test('a peer is eligible only when enabled is exactly 1', () => {
  const pool = buildOriginPool(topology, [
    origin('https://w0.test', { enabled: 0 }),
    origin('https://w1.test', { enabled: 2 }),
    origin('https://w2.test', { enabled: null }),
    origin('https://w3.test', { enabled: 1 }),
  ]);
  assert.deepEqual(pool.map((o) => o.url), ['https://w3.test']);
});

test('duplicate D1 rows resolve to the first row, so the highest priority wins', () => {
  const pool = buildOriginPool(topology, [
    origin('https://w1.test', { priority: 9, weight: 5 }),
    origin('https://w1.test', { priority: 2, weight: 7 }),
  ]);
  const w1 = pool.find((o) => o.url === 'https://w1.test');
  assert.equal(w1.priority, 9);
  assert.equal(w1.weight, 5);
});

test('N=5 returns every configured peer in topology order', () => {
  const peers = Array.from({ length: 5 }, (_, i) => ({ url: `https://w${i}.test`, index: i, self: i === 0 }));
  const pool = buildOriginPool({ count: 5, hash: 'h5', peers }, []);
  assert.deepEqual(pool.map((o) => o.url), peers.map((p) => p.url));
  assert.deepEqual(pool.map((o) => o.priority), [0, 1, 2, 3, 4]);
});

test('every served entry is healthy, so no unknown status leaks a healthy:false row', () => {
  const pool = buildOriginPool(topology, [
    origin('https://w0.test', { last_health_status: 'degraded' }),
    origin('https://w1.test'),
    origin('https://w2.test', { last_health_status: 'healthy' }),
  ]);
  assert.deepEqual(pool.map((o) => o.url), ['https://w1.test', 'https://w2.test', 'https://w3.test']);
  assert.deepEqual(pool.map((o) => o.healthy), [true, true, true]);
});

const FOUR = 'https://w0.test,https://w1.test,https://w2.test,https://w3.test';

const stubDb = (over = {}) => {
  const executed = [];
  const client = {
    prepare(sql) {
      let args = [];
      return {
        bind(...a) { args = a; return this; },
        async all() {
          executed.push({ sql, args });
          if (over.throwOn && sql.includes(over.throwOn)) throw new Error('D1 exploded');
          if (over.rejectOn && sql.includes(over.rejectOn)) throw new Error('D1 rejected asynchronously');
          return { results: over.all ? over.all() : [] };
        },
        async first() { executed.push({ sql, args }); return null; },
        async run() { executed.push({ sql, args }); return { success: true, meta: {} }; },
      };
    },
    batch() { return Promise.resolve([]); },
  };
  client.executed = executed;
  return client;
};

const stubKv = () => {
  const store = {};
  return {
    store,
    puts: [],
    async get(key, fmt) {
      const raw = store[key] ?? null;
      return raw == null ? null : fmt?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value, options) {
      store[key] = value;
      this.puts.push({ key, value, options });
    },
  };
};

const envFor = (over = {}) => {
  const CACHE_KV = over.CACHE_KV ?? stubKv();
  const DB = over.DB ?? stubDb();
  return {
    CACHE_KV,
    DB,
    PEER_URLS: over.PEER_URLS ?? FOUR,
    PEER_INDEX: '0',
    ...over,
  };
};

const app = new Hono();
app.route('/api', router);

const pending = [];
const ctx = { waitUntil: (promise) => { pending.push(promise); } };

const get = async (env) => {
  pending.length = 0;
  const res = await app.request('/api/origins', {}, env, ctx);
  const settled = await Promise.allSettled(pending);
  const body = await res.json();
  assert.ok(settled.every((s) => s.status === 'fulfilled'), `no waitUntil promise may reject: ${JSON.stringify(settled.map((s) => s.reason?.message ?? null))}`);
  return { res, body };
};

test('route returns the whole topology pool even when D1 holds only two origins', async () => {
  const DB = stubDb({
    all: () => [origin('https://w0.test'), origin('https://w1.test')],
  });
  const { res, body } = await get(envFor({ DB }));
  assert.equal(res.status, 200);
  assert.deepEqual(body.data.map((o) => o.url), ['https://w0.test', 'https://w1.test', 'https://w2.test', 'https://w3.test']);
});

test('route caches under origins:v2:<topology hash> with the existing 300s TTL', async () => {
  const CACHE_KV = stubKv();
  const env = envFor({ CACHE_KV });
  const { res } = await get(env);
  assert.equal(res.headers.get('cache-control'), 'public, s-maxage=300, stale-while-revalidate=600');
  const puts = CACHE_KV.puts.filter((p) => p.key.startsWith('origins:'));
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, `origins:v2:${getTopology(env).hash}`);
  assert.equal(puts[0].options.expirationTtl, 300);
});

test('topology change serves the new pool immediately instead of the cached one', async () => {
  const CACHE_KV = stubKv();
  await get(envFor({ CACHE_KV }));
  const shrunk = envFor({ CACHE_KV, PEER_URLS: 'https://w0.test,https://w1.test' });
  const { body } = await get(shrunk);
  assert.deepEqual(body.data.map((o) => o.url), ['https://w0.test', 'https://w1.test']);
});

const collectLogs = async (fn) => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = originalError;
  }
};

const originPuts = (kv) => kv.puts.filter((p) => p.key.startsWith('origins:'));
const usageRows = (DB) => DB.executed.filter((e) => e.sql.includes('INSERT INTO lb_usage'));
const seedCache = (kv, env, value) => {
  kv.store[`origins:v2:${getTopology(env).hash}`] = JSON.stringify(value);
};

test('a failing D1 read serves an empty pool and writes no origins cache', async () => {
  const CACHE_KV = stubKv();
  const { result, logged } = await collectLogs(() =>
    get(envFor({ CACHE_KV, DB: stubDb({ throwOn: 'lb_origins' }) })));
  assert.equal(result.res.status, 200);
  assert.deepEqual(result.body.data, [], 'a D1 outage must not invent an all-enabled topology pool');
  assert.equal(originPuts(CACHE_KV).length, 0, 'a degraded D1 fallback must never be cached');
  assert.ok(
    logged.some((line) => line.includes('ORIGIN_D1_READ_FAILED') && line.includes('Error: D1 exploded')),
    `expected stable code plus sanitized error detail, got ${JSON.stringify(logged)}`,
  );
});

test('a D1 outage never re-admits a peer that was left disabled', async () => {
  const CACHE_KV = stubKv();
  const armed = await get(envFor({
    CACHE_KV,
    DB: stubDb({ all: () => [origin('https://w0.test', { enabled: 0 })] }),
  }));
  assert.deepEqual(armed.body.data.map((o) => o.url),
    ['https://w1.test', 'https://w2.test', 'https://w3.test'],
    'w0 is armed off and must not be served while D1 answers');

  const down = envFor({ CACHE_KV: stubKv(), DB: stubDb({ throwOn: 'lb_origins' }) });
  const { result } = await collectLogs(() => get(down));
  assert.deepEqual(result.body.data, [], 'without D1 there is no evidence any peer is enabled');
  assert.equal(originPuts(down.CACHE_KV).length, 0);
  assert.equal(usageRows(down.DB).length, 0, 'an empty pool books no usage');
});

test('an async D1 rejection is isolated exactly like a sync throw', async () => {
  const CACHE_KV = stubKv();
  const { result } = await collectLogs(() =>
    get(envFor({ CACHE_KV, DB: stubDb({ rejectOn: 'lb_origins' }) })));
  assert.equal(result.res.status, 200);
  assert.deepEqual(result.body.data, []);
  assert.equal(originPuts(CACHE_KV).length, 0);
});

test('malformed PEER_URLS serves the routable peers instead of a 500', async () => {
  const DB = stubDb({ all: () => [origin('https://w0.test', { priority: 4 })] });
  const { result, logged } = await collectLogs(() =>
    get(envFor({ DB, PEER_URLS: 'https://w0.test,not-a-url' })));
  assert.equal(result.res.status, 200);
  assert.deepEqual(result.body.data.map((o) => o.url), ['https://w0.test']);
  assert.equal(result.body.data[0].priority, 4);
  assert.ok(
    logged.some((line) => line.includes('INVALID_PEER_URLS')),
    `expected the stable config code, got ${JSON.stringify(logged)}`,
  );
  assert.equal(usageRows(DB).length, 1, 'only routable peers are counted');
});

test('a fully unusable PEER_URLS answers 200 with an empty pool, never a 500', async () => {
  const CACHE_KV = stubKv();
  const { result } = await collectLogs(() => get(envFor({ CACHE_KV, PEER_URLS: 'not-a-url,also-bad' })));
  assert.equal(result.res.status, 200);
  assert.deepEqual(result.body.data, []);
  assert.equal(originPuts(CACHE_KV).length, 0);
});

test('a malformed-derived pool is never cached, so a config fix is picked up at once', async () => {
  const CACHE_KV = stubKv();
  await get(envFor({ CACHE_KV, PEER_URLS: 'https://w0.test,not-a-url' }));
  assert.equal(originPuts(CACHE_KV).length, 0);

  const fixed = await get(envFor({ CACHE_KV, PEER_URLS: 'https://w0.test,https://w1.test' }));
  assert.deepEqual(fixed.body.data.map((o) => o.url), ['https://w0.test', 'https://w1.test']);
  assert.equal(originPuts(CACHE_KV).length, 1, 'only a well-formed topology may be cached');
});

test('a malformed request never overwrites the cache of a well-formed topology', async () => {
  const CACHE_KV = stubKv();
  const good = envFor({ CACHE_KV });
  await get(good);
  const validKey = `origins:v2:${getTopology(good).hash}`;

  const broken = await get(envFor({ CACHE_KV, PEER_URLS: 'https://w0.test,not-a-url' }));
  assert.deepEqual(broken.body.data.map((o) => o.url), ['https://w0.test']);
  assert.equal(originPuts(CACHE_KV).filter((p) => p.key === validKey).length, 1,
    'the healthy pool must survive a config typo');

  const after = await get(envFor({ CACHE_KV }));
  assert.equal(after.body.data.length, 4, 'a repaired config is served from its own cache entry');
});

test('a successful D1 read is cached even when it returns no rows', async () => {
  const CACHE_KV = stubKv();
  await get(envFor({ CACHE_KV, DB: stubDb() }));
  assert.equal(originPuts(CACHE_KV).length, 1);
});

test('usage is counted once for every returned origin', async () => {
  const DB = stubDb();
  await get(envFor({ DB }));
  assert.equal(usageRows(DB).length, 4);
});

test('usage uses the literal D1 origin_url when a row matched, else the topology URL', async () => {
  const DB = stubDb({ all: () => [origin('https://w2.test/', { priority: 4 })] });
  const { body } = await get(envFor({ DB }));
  assert.deepEqual(usageRows(DB).map((row) => row.args[0]), [
    'https://w0.test',
    'https://w1.test',
    'https://w2.test/',
    'https://w3.test',
  ]);
  assert.deepEqual(body.data.map((o) => o.url),
    ['https://w0.test', 'https://w1.test', 'https://w2.test', 'https://w3.test']);
  assert.equal(body.data[2].priority, 4);
});

test('a failing usage write does not break the response', async () => {
  const { result } = await collectLogs(() => get(envFor({ DB: stubDb({ throwOn: 'lb_usage' }) })));
  assert.equal(result.res.status, 200);
  assert.equal(result.body.data.length, 4);
});

test('the route never reads lb_settings', async () => {
  const DB = stubDb();
  await get(envFor({ DB }));
  assert.ok(!DB.executed.some((e) => e.sql.includes('lb_settings')),
    `lb_settings must not be read: ${DB.executed.map((e) => e.sql)}`);
});

test('a cache hit prepares no D1 statement at all', async () => {
  const CACHE_KV = stubKv();
  await get(envFor({ CACHE_KV }));
  const DB = stubDb();
  const { res, body } = await get(envFor({ CACHE_KV, DB }));
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 4);
  assert.deepEqual(DB.executed, [], 'a cache hit must not touch D1');
});

test('a malformed cached payload is discarded and recollected from D1', async () => {
  const CACHE_KV = stubKv();
  const first = envFor({ CACHE_KV });
  await get(first);
  const DB = stubDb({ all: () => [origin('https://w0.test', { priority: 7 })] });
  seedCache(CACHE_KV, first, { data: [{ url: 'https://evil.test', priority: 'x', weight: null, healthy: 'yes' }] });
  const { body } = await get(envFor({ CACHE_KV, DB }));
  assert.deepEqual(body.data.map((o) => o.url),
    ['https://w0.test', 'https://w1.test', 'https://w2.test', 'https://w3.test']);
  assert.equal(body.data[0].priority, 7);
  assert.ok(DB.executed.some((e) => e.sql.includes('lb_origins')), 'malformed cache must trigger a recollect');
});

test('a cached payload carrying unknown keys is discarded instead of passed through', async () => {
  const CACHE_KV = stubKv();
  const first = envFor({ CACHE_KV });
  await get(first);
  const DB = stubDb();
  seedCache(CACHE_KV, first, {
    data: [{ url: 'https://w0.test', priority: 0, weight: 1, healthy: true, secret_token: 'sk-live' }],
  });
  const { body } = await get(envFor({ CACHE_KV, DB }));
  assert.deepEqual(Object.keys(body.data[0]).sort(), ['healthy', 'priority', 'url', 'weight']);
  assert.ok(!JSON.stringify(body).includes('sk-live'));
});

test('a cached pool with finite fractional numbers is served without recollecting', async () => {
  const CACHE_KV = stubKv();
  const first = envFor({ CACHE_KV });
  await get(first);
  const DB = stubDb();
  seedCache(CACHE_KV, first, {
    data: [
      { url: 'https://w0.test', priority: 0.5, weight: 1.5, healthy: true },
      { url: 'https://w1.test', priority: -3, weight: 2, healthy: true },
    ],
  });
  const { res, body } = await get(envFor({ CACHE_KV, DB }));
  assert.equal(res.status, 200);
  assert.deepEqual(body.data.map((o) => o.url), ['https://w0.test', 'https://w1.test']);
  assert.equal(body.data[0].weight, 1.5);
  assert.deepEqual(DB.executed, [], 'a valid fractional pool must not invalidate its own cache entry');
});

test('a cached value that is not a data envelope is discarded', async () => {
  const CACHE_KV = stubKv();
  const first = envFor({ CACHE_KV });
  await get(first);
  const DB = stubDb();
  seedCache(CACHE_KV, first, ['not', 'an', 'envelope']);
  const { body } = await get(envFor({ CACHE_KV, DB }));
  assert.equal(body.data.length, 4);
  assert.ok(DB.executed.some((e) => e.sql.includes('lb_origins')));
});

test('an empty cached pool is served as-is without touching D1', async () => {
  const CACHE_KV = stubKv();
  await get(envFor({ CACHE_KV, PEER_URLS: '' }));
  const DB = stubDb();
  const { res, body } = await get(envFor({ CACHE_KV, DB, PEER_URLS: '' }));
  assert.equal(res.status, 200);
  assert.deepEqual(body.data, []);
  assert.deepEqual(DB.executed, []);
});
