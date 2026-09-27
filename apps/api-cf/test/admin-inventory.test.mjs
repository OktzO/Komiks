import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPeerInventory, collectB2Inventory, getB2UsageSnapshot } from '../src/lib/adminInventory.ts';
import { getTopology } from '../src/lib/peers.ts';

const stubKv = (entries = {}) => ({
  async get(key, options) {
    const value = entries[key];
    if (value === undefined || value === null) return null;
    return options?.type === 'json' && typeof value === 'string' ? JSON.parse(value) : value;
  },
});

const stubDb = (over = {}) => ({
  getInventoryCounts: async () => ({ series: 2, chapters: 3, chapterPages: 4, users: 5, bookmarks: 6 }),
  listAccounts: async () => [{
    id: 'lb-1',
    provider: 'cloudflare',
    label: 'Primary',
    account_ref: 'acct-1',
    status: 'verified',
    last_tested_at: 900,
    created_at: 800,
  }],
  listOrigins: async () => [{
    id: 'origin-1',
    account_id: 'lb-1',
    origin_url: 'https://manga-api-x.acme.workers.dev',
    priority: 4,
    weight: 2,
    enabled: 1,
    last_health_status: 'healthy',
    last_checked_at: 900,
    created_at: 700,
  }],
  ...over,
});

const baseEnv = (over = {}) => ({
  DB: stubDb(),
  CACHE_KV: stubKv({ 'd1:usage': { bytes: 321, updatedAt: 900 } }),
  PEER_URLS: 'https://manga-api-x.acme.workers.dev',
  PEER_INDEX: '0',
  CF_WORKER_NAME: 'manga-api',
  CF_D1_ID: 'd1-1',
  CF_KV_ID: 'kv-1',
  ...over,
});

const envWithCfToken = (over = {}) => baseEnv({
  CF_INVENTORY_TOKEN: 'inventory-secret',
  CF_ACCOUNT_ID: 'acct-1',
  ...over,
});

const envWithB2 = (over = {}) => ({
  ...baseEnv(),
  B2_ACCOUNTS: JSON.stringify([{
    name: 'b2-primary',
    bucket: 'manga-assets',
    keyId: 'fake-key',
    appKey: 'fake-app',
    region: 'us-east-005',
  }]),
  ...over,
});

async function withFetch(handler, run) {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = handler;
    return await run();
  } finally {
    if (previous === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous;
  }
}

test('peer collector returns local fallback without CF token', async () => {
  const env = baseEnv();
  const result = await collectPeerInventory(env, stubDb());
  assert.equal(result.account.name, 'acme');
  assert.equal(result.account.state.source, 'derived');
  assert.equal(result.worker.name, 'manga-api');
  assert.equal(result.d1.id, 'd1-1');
  assert.equal(result.d1.counts.series, 2);
  assert.equal(result.kv.operationalD1Bytes, 321);
  assert.equal(result.self, true);
  assert.equal(result.topologyHash, getTopology(env).hash);
  assert.doesNotMatch(JSON.stringify(result), /CF_INVENTORY_TOKEN|encrypted_token|keyId|appKey/);
});

test('peer collector keeps local helper failures isolated', async () => {
  const db = stubDb({
    getInventoryCounts() { throw new Error('local secret body'); },
  });
  const result = await collectPeerInventory(baseEnv(), db);
  assert.equal(result.d1.counts.series, null);
  assert.equal(result.d1.state.errorCode, 'DB_ERROR');
  assert.doesNotMatch(JSON.stringify(result), /local secret body/);
});

test('peer collector leaves LB account empty when self origin has no matching row', async () => {
  const db = stubDb({
    listAccounts: async () => [
      { id: 'other', provider: 'cloudflare', label: 'Other', account_ref: 'other-ref', status: 'verified' },
      { id: 'lb-1', provider: 'cloudflare', label: 'Primary', account_ref: 'acct-1', status: 'verified' },
    ],
    listOrigins: async () => [{ id: 'origin-1', account_id: 'missing', origin_url: 'https://manga-api-x.acme.workers.dev' }],
  });
  const result = await collectPeerInventory(baseEnv(), db);
  assert.equal(result.lb.account, null);
});

test('peer collector returns provider metadata when token is configured', async () => {
  const requests = [];
  const result = await withFetch(async (url, init) => {
    requests.push({ url: String(url), init });
    const value = String(url);
    if (value.endsWith('/client/v4/graphql')) {
      return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [] }] } } });
    }
    if (value.endsWith('/workers/scripts')) {
      return Response.json({ success: true, result: [{ id: 'manga-api', created_on: '2026-01-01T00:00:00Z', modified_on: '2026-09-25T00:00:00Z' }] });
    }
    if (value.includes('/storage/kv/namespaces')) {
      return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV', jurisdiction: 'us' }] });
    }
    if (value.includes('/d1/database/d1-1')) {
      return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1', file_size: 42, jurisdiction: 'us', running_in_region: 'wnam' } });
    }
    if (value.endsWith('/accounts/acct-1')) {
      return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    }
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));

  assert.equal(result.account.id, 'acct-1');
  assert.equal(result.account.name, 'Real Cloudflare Name');
  assert.equal(result.account.type, 'standard');
  assert.equal(result.account.state.source, 'live');
  assert.equal(result.worker.name, 'manga-api');
  assert.equal(result.worker.createdAt, '2026-01-01T00:00:00Z');
  assert.equal(result.worker.modifiedAt, '2026-09-25T00:00:00Z');
  assert.equal(result.d1.name, 'Real D1');
  assert.equal(result.d1.fileBytes, 42);
  assert.equal(result.d1.jurisdiction, 'us');
  assert.equal(result.d1.region, 'wnam');
  assert.equal(result.kv.title, 'Real KV');
  assert.equal(result.kv.jurisdiction, 'us');
  assert.equal(result.kv.keyCount, null);
  assert.equal(result.kv.byteCount, null);
  assert.equal(requests.length, 5);
  const accountRequest = requests.find((request) => String(request.url).endsWith('/accounts/acct-1'));
  const workerRequest = requests.find((request) => String(request.url).endsWith('/workers/scripts'));
  const d1Request = requests.find((request) => String(request.url).endsWith('/d1/database/d1-1'));
  const kvRequest = requests.find((request) => String(request.url).endsWith('/storage/kv/namespaces'));
  const graphRequest = requests.find((request) => String(request.url).endsWith('/client/v4/graphql'));
  for (const request of [accountRequest, workerRequest, d1Request, kvRequest]) {
    assert.equal(new URL(request.url).origin, 'https://api.cloudflare.com');
    assert.equal(request.init.method, 'GET');
    assert.equal(typeof request.init.headers.Authorization, 'string');
    assert.equal(request.init.headers['Content-Type'], 'application/json');
  }
  assert.equal(new URL(graphRequest.url).pathname, '/client/v4/graphql');
  assert.equal(graphRequest.init.method, 'POST');
  assert.equal(typeof graphRequest.init.headers.Authorization, 'string');
  assert.doesNotMatch(JSON.stringify(result), /inventory-secret/);
});

test('peer collector keeps stable provider error code and derived fallback', async () => {
  const result = await withFetch(async () => new Response('provider body must not escape', { status: 401 }), () =>
    collectPeerInventory(envWithCfToken(), stubDb())
  );
  assert.equal(result.account.name, 'acme');
  assert.equal(result.account.state.source, 'derived');
  assert.equal(result.account.state.errorCode, 'CF_HTTP_401');
  assert.equal(result.d1.counts.bookmarks, 6);
  assert.doesNotMatch(JSON.stringify(result), /provider body must not escape|inventory-secret/);
});

test('peer collector uses first GraphQL metric date for KV freshness', async () => {
  const result = await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/client/v4/graphql')) {
      return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [{ max: { keyCount: 3, byteCount: 4 }, dimensions: [{ date: '2026-09-25' }] }] }] } } });
    }
    if (value.endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (value.includes('/storage/kv/namespaces')) return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV' }] });
    if (value.includes('/d1/database/d1-1')) return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1' } });
    if (value.endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));

  assert.equal(result.kv.keyCount, 3);
  assert.equal(result.kv.byteCount, 4);
  assert.equal(result.kv.state.observedAt, Date.parse('2026-09-25'));
});

test('peer collector rejects malformed GraphQL metric groups', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [{ dimensions: [{ date: '2026-09-25' }] }] }] } } });
    if (String(url).endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (String(url).includes('/storage/kv/namespaces')) return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV' }] });
    if (String(url).includes('/d1/database/d1-1')) return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1' } });
    if (String(url).endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));
  assert.equal(result.kv.state.status, 'degraded');
  assert.equal(result.kv.keyCount, null);
  assert.equal(result.kv.byteCount, null);
});

test('peer collector treats empty GraphQL metrics as live null data', async () => {
  const result = await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/client/v4/graphql')) {
      return Response.json({ data: { viewer: { accounts: [] } } });
    }
    if (value.endsWith('/workers/scripts')) {
      return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    }
    if (value.includes('/storage/kv/namespaces')) {
      return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV', jurisdiction: 'us' }] });
    }
    if (value.includes('/d1/database/d1-1')) {
      return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1' } });
    }
    if (value.endsWith('/accounts/acct-1')) {
      return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    }
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));

  assert.equal(result.kv.keyCount, null);
  assert.equal(result.kv.byteCount, null);
  assert.equal(result.kv.state.source, 'live');
  assert.equal(result.kv.state.status, 'ok');
});

test('B2 failure preserves tracked bytes and null provider ID', async () => {
  const result = await withFetch(
    async () => new Response('denied', { status: 401 }),
    () => collectB2Inventory(
      envWithB2(),
      async () => ({ bytes: 1234, updatedAt: 900 }),
      1000,
    ),
  );
  assert.equal(result.accounts[0].providerAccountId, null);
  assert.equal(result.accounts[0].bucketId, null);
  assert.equal(result.accounts[0].trackedBytes, 1234);
  assert.equal(result.accounts[0].trackedUpdatedAt, 900);
  assert.equal(result.accounts[0].state.source, 'tracked');
  assert.equal(result.accounts[0].state.status, 'degraded');
  assert.doesNotMatch(JSON.stringify(result), /denied|fake-key|fake-app/);
});

test('B2 success exposes allowlisted provider metadata and keeps bytes tracked', async () => {
  const result = await withFetch(async (url, init) => {
    const value = String(url);
    if (value.endsWith('/b2_authorize_account')) {
      return Response.json({ accountId: 'b2-acct-1', apiUrl: 'https://api001.backblazeb2.com', authorizationToken: 'temporary-auth' });
    }
    if (value.endsWith('/b2_list_buckets')) {
      assert.equal(init.headers.Authorization, 'temporary-auth');
      assert.deepEqual(JSON.parse(init.body), { accountId: 'b2-acct-1', bucketName: 'manga-assets' });
      return Response.json({ buckets: [{ bucketId: 'bucket-1', bucketName: 'manga-assets', bucketType: 'allPrivate', options: ['s3'] }] });
    }
    return new Response('', { status: 404 });
  }, () => collectB2Inventory(
    envWithB2(),
    async (name, index) => {
      assert.equal(name, 'b2-primary');
      assert.equal(index, 0);
      return { bytes: 2222, updatedAt: 900 };
    },
    1000,
  ));

  assert.equal(result.accounts[0].providerAccountId, 'b2-acct-1');
  assert.equal(result.accounts[0].bucketId, 'bucket-1');
  assert.equal(result.accounts[0].bucketName, 'manga-assets');
  assert.equal(result.accounts[0].bucketType, 'allPrivate');
  assert.deepEqual(result.accounts[0].options, ['s3']);
  assert.equal(result.accounts[0].state.source, 'live');
  assert.equal(result.accounts[0].state.status, 'ok');
  assert.equal(result.accounts[0].trackedBytes, 2222);
  assert.doesNotMatch(JSON.stringify(result), /temporary-auth|fake-key|fake-app/);
});

test('B2 authorization rejects non-B2 API URL', async () => {
  let listCalls = 0;
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/b2_authorize_account')) {
      return Response.json({ accountId: 'b2-acct-3', apiUrl: 'https://evil.example', authorizationToken: 'temporary-auth' });
    }
    listCalls += 1;
    return Response.json({ buckets: [{ bucketId: 'bucket-3', bucketName: 'manga-assets' }] });
  }, () => collectB2Inventory(envWithB2(), async () => ({ bytes: 1, updatedAt: 1 }), 1000));

  assert.equal(result.accounts[0].providerAccountId, null);
  assert.equal(result.accounts[0].state.source, 'tracked');
  assert.equal(listCalls, 0);
});

test('B2 inventory keeps quota positive for invalid environment values', async () => {
  const result = await withFetch(async () => new Response('', { status: 401 }), () =>
    collectB2Inventory(
      envWithB2({ B2_QUOTA_BYTES: '-1' }),
      async () => ({ bytes: null, updatedAt: null }),
      1000,
    )
  );
  assert.equal(result.accounts[0].quotaBytes, 10 * 1024 * 1024 * 1024);
});

test('B2 authorization accepts nested storage API URL', async () => {
  const result = await withFetch(async (url) => {
    const value = String(url);
    if (value.endsWith('/b2_authorize_account')) {
      return Response.json({ accountId: 'b2-acct-2', apiInfo: { storageApi: { apiUrl: 'https://api002.backblazeb2.com' } }, authorizationToken: 'temporary-auth' });
    }
    if (value.endsWith('/b2_list_buckets')) {
      return Response.json({ buckets: [{ bucketId: 'bucket-2', bucketName: 'manga-assets', bucketType: 'allPublic', options: [] }] });
    }
    return new Response('', { status: 404 });
  }, () => collectB2Inventory(envWithB2(), async () => ({ bytes: 0, updatedAt: null }), 1000));

  assert.equal(result.accounts[0].providerAccountId, 'b2-acct-2');
  assert.equal(result.accounts[0].bucketId, 'bucket-2');
  assert.equal(result.accounts[0].trackedBytes, 0);
  assert.equal(result.accounts[0].state.source, 'live');
  assert.equal(result.accounts[0].state.status, 'ok');
});

test('B2 usage snapshot reads tracked bytes and timestamp from KV', async () => {
  const result = await getB2UsageSnapshot({
    CACHE_KV: stubKv({ 'b2:usage:3': { bytes: 77, updatedAt: 1234 } }),
  }, 'b2-primary', 3);
  assert.deepEqual(result, { bytes: 77, updatedAt: 1234 });
});

test('B2 usage snapshot keeps missing timestamp null', async () => {
  const result = await getB2UsageSnapshot({
    CACHE_KV: stubKv({ 'b2:usage:4': { bytes: 0 } }),
  }, 'b2-secondary', 4);
  assert.deepEqual(result, { bytes: 0, updatedAt: null });
});

test('peer collector marks missing Cloudflare account configuration degraded', async () => {
  const result = await withFetch(async () => {
    throw new Error('must not call provider');
  }, () => collectPeerInventory(baseEnv({ CF_INVENTORY_TOKEN: 'inventory-secret', CF_ACCOUNT_ID: undefined }), stubDb()));
  assert.equal(result.account.state.status, 'degraded');
  assert.equal(result.account.state.errorCode, 'CF_CONFIG_MISSING');
  assert.equal(result.account.state.source, 'derived');
  assert.doesNotMatch(JSON.stringify(result), /inventory-secret/);
});

test('peer collector rejects GraphQL errors without exposing messages', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) {
      return Response.json({ errors: [{ message: 'provider-secret-message' }], data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [{ max: { keyCount: 8, byteCount: 9 }, dimensions: [{ date: '2026-09-25' }] }] }] } } });
    }
    if (String(url).endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (String(url).includes('/storage/kv/namespaces')) return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV' }] });
    if (String(url).includes('/d1/database/d1-1')) return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1' } });
    if (String(url).endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));
  assert.equal(result.kv.state.errorCode, 'CF_PROVIDER_ERROR');
  assert.equal(result.kv.keyCount, null);
  assert.equal(result.kv.byteCount, null);
  assert.doesNotMatch(JSON.stringify(result), /provider-secret-message/);
});

test('peer collector validates returned account, D1, and KV identity and display fields', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [] }] } } });
    if (String(url).endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (String(url).includes('/storage/kv/namespaces')) return Response.json({ success: true, result: [{ id: 'kv-1' }] });
    if (String(url).includes('/d1/database/d1-1')) return Response.json({ success: true, result: { uuid: 'd1-1' } });
    if (String(url).endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'wrong-account', name: 'Wrong', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));
  assert.equal(result.account.state.status, 'degraded');
  assert.equal(result.account.state.errorCode, 'CF_ACCOUNT_INVALID');
  assert.equal(result.d1.state.source, 'local');
  assert.equal(result.d1.name, null);
  assert.equal(result.kv.title, null);
  assert.equal(result.kv.keyCount, null);
  assert.equal(result.kv.byteCount, null);
});

test('peer collector isolates a single D1 provider failure', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [] }] } } });
    if (String(url).endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (String(url).includes('/storage/kv/namespaces')) return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV' }] });
    if (String(url).includes('/d1/database/d1-1')) return new Response('', { status: 503 });
    if (String(url).endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));
  assert.equal(result.account.state.source, 'live');
  assert.equal(result.d1.state.status, 'degraded');
  assert.equal(result.kv.state.source, 'live');
  assert.equal(result.kv.keyCount, null);
});

test('peer collector keeps provider namespaces and metrics unavailable when namespace lookup fails', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [{ max: { keyCount: 8, byteCount: 9 }, dimensions: [{ date: '2026-09-25' }] }] }] } } });
    if (String(url).endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (String(url).includes('/storage/kv/namespaces')) return new Response('', { status: 503 });
    if (String(url).includes('/d1/database/d1-1')) return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1' } });
    if (String(url).endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(envWithCfToken(), stubDb()));
  assert.equal(result.kv.title, null);
  assert.equal(result.kv.keyCount, null);
  assert.equal(result.kv.byteCount, null);
  assert.equal(result.kv.state.status, 'unavailable');
  assert.equal(result.kv.state.source, 'unavailable');
});

test('peer collector degrades live KV state when operational counter fails', async () => {
  const env = envWithCfToken({
    CACHE_KV: {
      async get() { throw new Error('counter body must not escape'); },
    },
  });
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [] }] } } });
    if (String(url).endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'manga-api' }] });
    if (String(url).includes('/storage/kv/namespaces')) return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV' }] });
    if (String(url).includes('/d1/database/d1-1')) return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1' } });
    if (String(url).endsWith('/accounts/acct-1')) return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    return new Response('', { status: 404 });
  }, () => collectPeerInventory(env, stubDb()));
  assert.equal(result.kv.operationalD1Bytes, null);
  assert.equal(result.kv.state.status, 'degraded');
  assert.notEqual(result.kv.state.status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /counter body must not escape/);
});

test('peer collector rejects malformed safe origin rows', async () => {
  const db = stubDb({
    listOrigins: async () => [
      { id: 'ftp', origin_url: 'ftp://manga-api-x.acme.workers.dev', priority: 0, weight: 1, enabled: 1 },
      { id: 'fractional', origin_url: 'https://manga-api-x.acme.workers.dev', priority: 1.5, weight: 1, enabled: 1 },
      { id: 'enabled', origin_url: 'https://manga-api-x.acme.workers.dev', priority: 0, weight: 1, enabled: 2 },
      { id: 'valid', origin_url: 'https://manga-api-x.acme.workers.dev', priority: 0, weight: 1, enabled: 1 },
    ],
  });
  const result = await collectPeerInventory(baseEnv(), db);
  assert.deepEqual(result.lb.origins.map((origin) => origin.id), ['valid']);
});

test('B2 collector returns a sanitized warning for invalid configuration', async () => {
  const result = await collectB2Inventory(
    baseEnv({ B2_ACCOUNTS: 'not-json', B2_CONFIG: undefined }),
    async () => ({ bytes: 0, updatedAt: 0 }),
    1000,
  );
  assert.deepEqual(result.accounts, []);
  assert.equal(result.warnings[0].code, 'B2_CONFIG_INVALID');
  assert.equal(result.warnings[0].peerUrl, null);
  assert.doesNotMatch(JSON.stringify(result), /not-json/);
});

test('B2 collector warns when configuration is missing', async () => {
  const result = await collectB2Inventory(
    baseEnv({ B2_ACCOUNTS: undefined, B2_CONFIG: undefined }),
    async () => ({ bytes: 0, updatedAt: 0 }),
    1000,
  );
  assert.deepEqual(result.accounts, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'B2_CONFIG_INVALID');
});

test('B2 collector uses a safe configured-name fallback', async () => {
  const env = envWithB2({
    B2_ACCOUNTS: JSON.stringify([{ name: '', bucket: 'manga-assets', keyId: 'fake-key', appKey: 'fake-app' }]),
  });
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/b2_authorize_account')) return Response.json({ accountId: 'b2-acct-1', apiUrl: 'https://api001.backblazeb2.com', authorizationToken: 'temporary-auth' });
    if (String(url).endsWith('/b2_list_buckets')) return Response.json({ buckets: [{ bucketId: 'bucket-1', bucketName: 'manga-assets', bucketType: 'allPrivate', options: [] }] });
    return new Response('', { status: 404 });
  }, () => collectB2Inventory(env, async (name) => {
    assert.equal(name, 'b2-1');
    return { bytes: 0, updatedAt: 0 };
  }, 1000));
  assert.equal(result.accounts[0].configuredName, 'b2-1');
  assert.equal(result.accounts[0].trackedBytes, 0);
  assert.equal(result.warnings.length, 0);
});

test('B2 usage failure is distinct from provider success', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/b2_authorize_account')) return Response.json({ accountId: 'b2-acct-1', apiUrl: 'https://api001.backblazeb2.com', authorizationToken: 'temporary-auth' });
    if (String(url).endsWith('/b2_list_buckets')) return Response.json({ buckets: [{ bucketId: 'bucket-1', bucketName: 'manga-assets', bucketType: 'allPrivate', options: ['s3'] }] });
    return new Response('', { status: 404 });
  }, () => collectB2Inventory(envWithB2(), async () => { throw new Error('usage body'); }, 1000));
  assert.equal(result.accounts[0].state.source, 'live');
  assert.equal(result.accounts[0].state.status, 'degraded');
  assert.equal(result.accounts[0].state.errorCode, 'B2_USAGE_ERROR');
  assert.equal(result.accounts[0].trackedBytes, null);
});

test('B2 provider failure without usage is unavailable', async () => {
  const result = await withFetch(async () => new Response('', { status: 401 }), () =>
    collectB2Inventory(envWithB2(), async () => ({ bytes: null, updatedAt: null }), 1000)
  );
  assert.equal(result.accounts[0].state.status, 'unavailable');
  assert.equal(result.accounts[0].state.source, 'unavailable');
  assert.equal(result.accounts[0].trackedBytes, null);
});

test('B2 bucket type and options must be provider-valid', async () => {
  const result = await withFetch(async (url) => {
    if (String(url).endsWith('/b2_authorize_account')) return Response.json({ accountId: 'b2-acct-1', apiUrl: 'https://api001.backblazeb2.com', authorizationToken: 'temporary-auth' });
    if (String(url).endsWith('/b2_list_buckets')) return Response.json({ buckets: [{ bucketId: 'bucket-1', bucketName: 'manga-assets' }] });
    return new Response('', { status: 404 });
  }, () => collectB2Inventory(envWithB2(), async () => ({ bytes: 7, updatedAt: 8 }), 1000));
  assert.equal(result.accounts[0].providerAccountId, null);
  assert.equal(result.accounts[0].bucketType, null);
  assert.deepEqual(result.accounts[0].options, []);
  assert.equal(result.accounts[0].state.status, 'degraded');
  assert.equal(result.accounts[0].state.source, 'tracked');
});

test('B2 provider concurrency is bounded without limiting account count', async () => {
  const count = 6;
  let active = 0;
  let maxActive = 0;
  const accounts = Array.from({ length: count }, (_, index) => ({
    name: `b2-${index + 1}`,
    bucket: `bucket-${index + 1}`,
    keyId: `key-${index + 1}`,
    appKey: `app-${index + 1}`,
  }));
  const result = await withFetch(async (url, init) => {
    if (String(url).endsWith('/b2_authorize_account')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const key = atob(String(init.headers.Authorization).replace(/^Basic /, '')).split(':')[0];
      const index = Number(key.split('-')[1]) - 1;
      return Response.json({ accountId: `b2-acct-${index + 1}`, apiUrl: 'https://api001.backblazeb2.com', authorizationToken: 'temporary-auth' });
    }
    if (String(url).endsWith('/b2_list_buckets')) {
      const body = JSON.parse(init.body);
      const index = Number(body.accountId.split('-').pop()) - 1;
      return Response.json({ buckets: [{ bucketId: `bucket-id-${index + 1}`, bucketName: body.bucketName, bucketType: 'allPrivate', options: [] }] });
    }
    return new Response('', { status: 404 });
  }, () => collectB2Inventory({ ...baseEnv(), B2_ACCOUNTS: JSON.stringify(accounts) }, async () => ({ bytes: 0, updatedAt: 0 }), 1000));
  assert.equal(result.accounts.length, count);
  assert.equal(result.warnings.length, 0);
  assert.ok(maxActive <= 4);
  assert.ok(maxActive > 1);
  assert.deepEqual(result.accounts.map((account) => account.configuredName), accounts.map((account) => account.name));
});

test('B2 usage snapshot normalizes D1 seconds and preserves KV milliseconds', async () => {
  const d1 = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { bytes: 55, updated_at: 1234 }; },
      };
    },
  };
  const result = await getB2UsageSnapshot({
    DB: d1,
    CACHE_KV: stubKv({ 'b2:usage:5': { bytes: 66, updatedAt: 5678 } }),
  }, 'b2-primary', 5);
  assert.deepEqual(result, { bytes: 55, updatedAt: 1234000 });
});
