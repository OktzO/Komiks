import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AdminInventory,
  InventoryB2Account,
  InventoryRegistration,
  ResourceState,
} from '@manga-platform/shared/types';
import {
  filterInventory,
  coverage,
  formatObservedAt,
  formatSource,
  localFieldLabel,
  formatStatus,
  storageFromInventory,
  lbRowsFromInventory,
  accountOptionsFromConflict,
  topologyRowsFromInventory,
  hashMatches,
  accountCreateOutcome,
  accountSelectionControl,
  canSubmitCredential,
  bannersAfter,
  b2RowKey,
  nonD1SnapshotRows,
  tabIndexFromKey,
  inventoryUrl,
  nextRefreshAfter,
  refreshSettled,
  credentialDraftChanged,
  originDraftFrom,
  PENDING_TOPOLOGY_STEPS,
  EMPTY_BANNERS,
} from '../src/lib/adminInventory';

type Row = AdminInventory['accounts'][number];

const state = (over: Partial<ResourceState> = {}): ResourceState => ({
  status: 'ok',
  source: 'live',
  observedAt: 1000,
  errorCode: null,
  ...over,
});

const counts = (over: Partial<Row['d1']['counts']> = {}): Row['d1']['counts'] => ({
  series: null,
  chapters: null,
  chapterPages: null,
  users: null,
  bookmarks: null,
  ...over,
});

const account = (over: {
  index: number;
  url: string;
  self?: boolean;
  reachable?: boolean;
  accountId?: string | null;
  name?: string | null;
  type?: string | null;
  accountState?: ResourceState;
  worker?: string | null;
  workerState?: ResourceState;
  d1Name?: string | null;
  d1Id?: string | null;
  d1FileBytes?: number | null;
  d1Jurisdiction?: string | null;
  d1Region?: string | null;
  d1Counts?: Row['d1']['counts'];
  d1State?: ResourceState;
  kvTitle?: string | null;
  kvId?: string | null;
  kvJurisdiction?: string | null;
  keyCount?: number | null;
  byteCount?: number | null;
  opBytes?: number | null;
  kvState?: ResourceState;
  lbAccount?: Row['lb']['account'];
  origins?: Row['lb']['origins'];
}): Row => ({
  topologyHash: 'h',
  index: over.index,
  url: over.url,
  self: over.self ?? false,
  reachable: over.reachable ?? true,
  account: {
    id: over.accountId ?? null,
    name: over.name ?? null,
    type: over.type ?? null,
    state: over.accountState ?? state(),
  },
  worker: {
    name: over.worker ?? null,
    createdAt: null,
    modifiedAt: null,
    state: over.workerState ?? state(),
  },
  d1: {
    id: over.d1Id ?? null,
    name: over.d1Name ?? null,
    fileBytes: over.d1FileBytes ?? null,
    jurisdiction: over.d1Jurisdiction ?? null,
    region: over.d1Region ?? null,
    counts: over.d1Counts ?? counts(),
    state: over.d1State ?? state(),
  },
  kv: {
    id: over.kvId ?? null,
    title: over.kvTitle ?? null,
    jurisdiction: over.kvJurisdiction ?? null,
    keyCount: over.keyCount ?? null,
    byteCount: over.byteCount ?? null,
    operationalD1Bytes: over.opBytes ?? null,
    state: over.kvState ?? state(),
  },
  lb: { account: over.lbAccount ?? null, origins: over.origins ?? [] },
});

const b2Account = (over: {
  configuredName: string;
  providerAccountId?: string | null;
  bucketName?: string | null;
  bucketId?: string | null;
  bucketType?: string | null;
  options?: string[];
  trackedBytes?: number | null;
  trackedUpdatedAt?: number | null;
  quotaBytes?: number;
  state?: ResourceState;
}): InventoryB2Account => ({
  configuredName: over.configuredName,
  providerAccountId: over.providerAccountId ?? null,
  bucketId: over.bucketId ?? null,
  bucketName: over.bucketName ?? null,
  bucketType: over.bucketType ?? null,
  options: over.options ?? [],
  trackedBytes: over.trackedBytes ?? null,
  trackedUpdatedAt: over.trackedUpdatedAt ?? null,
  quotaBytes: over.quotaBytes ?? 10_000_000_000,
  state: over.state ?? state(),
});

const registration = (over: {
  id: string;
  label: string;
  accountRef?: string | null;
  status?: 'verified' | 'unverified' | 'failed';
  originUrl?: string | null;
  originId?: string | null;
  topologyStatus?: 'pending_topology';
}): InventoryRegistration => ({
  account: {
    id: over.id,
    provider: 'cloudflare',
    label: over.label,
    account_ref: over.accountRef ?? null,
    status: over.status ?? 'verified',
    last_tested_at: null,
    created_at: 1,
  },
  origin: over.originUrl
    ? {
        id: over.originId ?? `origin-${over.id}`,
        account_id: null,
        origin_url: over.originUrl,
        priority: 0,
        weight: 1,
        enabled: 1,
        last_health_status: null,
        last_checked_at: null,
        created_at: 1,
      }
    : null,
  topologyStatus: over.topologyStatus ?? 'pending_topology',
});

const inventory = (over: Partial<AdminInventory> = {}): AdminInventory => ({
  observedAt: 1000,
  stale: false,
  topology: { source: 'PEER_URLS', count: 4, hash: 'h', consistent: true },
  accounts: [
    account({ index: 0, url: 'https://manga-api.oktz.workers.dev', name: 'Oktz' }),
    account({ index: 1, url: 'https://manga-api-2.tzok5555.workers.dev', name: 'Tzok' }),
    account({ index: 2, url: 'https://manga-api-3.dwikaoktyffan.workers.dev', name: 'Dwika' }),
    account({ index: 3, url: 'https://manga-api-4.oktznih.workers.dev', name: 'Nih' }),
  ],
  registrations: [],
  b2: [],
  warnings: [],
  ...over,
});

const down = state({ status: 'unavailable', source: 'unavailable', observedAt: null, errorCode: 'PEER_UNREACHABLE' });

const payload = (value: unknown): unknown => value;

test('filterInventory matches account name case-insensitively', () => {
  const result = filterInventory(inventory(), 'dwika');
  assert.equal(result.visibleAccounts.length, 1);
  assert.equal(result.visibleAccounts[0]?.account.name, 'Dwika');
  assert.equal(result.visibleAccounts[0]?.index, 2);
});

test('coverage is configured from topology and live counts from actual state', () => {
  assert.deepEqual(coverage(inventory()), {
    configured: 4,
    reachable: 4,
    liveAccounts: 4,
    d1: 4,
    kv: 4,
    b2: 0,
  });
});

test('coverage counts each resource from its own state, not row length', () => {
  const inv = inventory({
    accounts: [
      account({ index: 0, url: 'https://a.test', d1State: state({ source: 'local', status: 'degraded' }), kvState: state({ source: 'live', status: 'degraded' }) }),
      account({ index: 1, url: 'https://b.test', d1State: down, kvState: state({ source: 'tracked' }) }),
    ],
    b2: [
      b2Account({ configuredName: 'b2-a', state: state({ source: 'live' }) }),
      b2Account({ configuredName: 'b2-b', state: state({ source: 'tracked', status: 'degraded' }) }),
      b2Account({ configuredName: 'b2-c', state: down }),
    ],
  });
  assert.deepEqual(coverage(inv), {
    configured: 4,
    reachable: 2,
    liveAccounts: 2,
    d1: 0,
    kv: 1,
    b2: 1,
  });
});

test('coverage uses topology count even when rows are missing', () => {
  const inv = inventory({
    topology: { source: 'PEER_URLS', count: 9, hash: 'h', consistent: false },
    accounts: [account({ index: 0, url: 'https://a.test' })],
  });
  assert.equal(coverage(inv).configured, 9);
  assert.equal(filterInventory(inv, '').totals.accounts, 1);
});

test('N=0 yields empty lists and zero coverage', () => {
  const inv = inventory({
    topology: { source: 'PEER_URLS', count: 0, hash: 'h', consistent: true },
    accounts: [],
  });
  const view = filterInventory(inv, '');
  assert.deepEqual(view.visibleAccounts, []);
  assert.deepEqual(view.visibleD1, []);
  assert.deepEqual(view.visibleKv, []);
  assert.deepEqual(view.visibleB2, []);
  assert.deepEqual(view.visibleRegistrations, []);
  assert.deepEqual(view.totals, { accounts: 0, b2: 0, registrations: 0, warnings: 0 });
  assert.deepEqual(coverage(inv), {
    configured: 0,
    reachable: 0,
    liveAccounts: 0,
    d1: 0,
    kv: 0,
    b2: 0,
  });
});

test('all unavailable reports configured but zero live coverage', () => {
  const inv = inventory({
    accounts: [
      account({ index: 0, url: 'https://a.test', reachable: false, accountState: down, workerState: down, d1State: down, kvState: down }),
      account({ index: 1, url: 'https://b.test', reachable: false, accountState: down, workerState: down, d1State: down, kvState: down }),
    ],
    b2: [b2Account({ configuredName: 'b2-a', state: down })],
  });
  assert.deepEqual(coverage(inv), {
    configured: 4,
    reachable: 0,
    liveAccounts: 0,
    d1: 0,
    kv: 0,
    b2: 0,
  });
  const view = filterInventory(inv, '');
  assert.equal(view.visibleAccounts.length, 2, 'unavailable rows stay visible, not hidden');
});

test('stale inventory is surfaced and does not alter coverage', () => {
  const fresh = coverage(inventory());
  const view = filterInventory(inventory({ stale: true, observedAt: 500 }), '');
  assert.equal(view.stale, true);
  assert.equal(view.observedAt, 500);
  assert.deepEqual(coverage(inventory({ stale: true, observedAt: 500 })), fresh);
});

test('every match is rendered, never a hidden slice', () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    account({ index: i, url: `https://shard-${i}.workers.dev`, name: `Shard ${i}` })
  );
  const inv = inventory({ accounts: many, topology: { source: 'PEER_URLS', count: 14, hash: 'h', consistent: true } });
  assert.equal(filterInventory(inv, '').visibleAccounts.length, 14);
  const matched = filterInventory(inv, 'shard');
  assert.equal(matched.visibleAccounts.length, 14);
  assert.equal(matched.totals.accounts, 14, 'total is preserved independently of matches');
  assert.equal(matched.visibleD1.length, 14);
  assert.equal(matched.visibleKv.length, 14);
});

test('search spans account id, worker and url', () => {
  const inv = inventory({
    accounts: [
      account({ index: 0, url: 'https://a.workers.dev', accountId: 'acct-alpha', worker: 'manga-api-alpha' }),
      account({ index: 1, url: 'https://b.workers.dev' }),
    ],
  });
  assert.equal(filterInventory(inv, 'acct-alpha').visibleAccounts.length, 1);
  assert.equal(filterInventory(inv, 'manga-api-alpha').visibleAccounts[0]?.index, 0);
  assert.equal(filterInventory(inv, 'b.workers.dev').visibleAccounts[0]?.index, 1);
  assert.equal(filterInventory(inv, 'zzz').visibleAccounts.length, 0);
});

test('search spans D1 name and id independently of the account row', () => {
  const inv = inventory({
    accounts: [
      account({ index: 0, url: 'https://a.workers.dev', name: 'Oktz', d1Name: 'manga-core', d1Id: 'd1-uuid-0001' }),
      account({ index: 1, url: 'https://b.workers.dev', name: 'Tzok', d1Name: 'manga-edge', d1Id: 'd1-uuid-0002' }),
    ],
  });
  const byName = filterInventory(inv, 'manga-edge');
  assert.equal(byName.visibleD1.length, 1);
  assert.equal(byName.visibleD1[0]?.index, 1);
  assert.equal(byName.visibleAccounts.length, 0, 'D1 match alone does not imply an account match');
  assert.equal(filterInventory(inv, 'd1-uuid-0001').visibleD1[0]?.index, 0);
  assert.equal(filterInventory(inv, 'd1-uuid').visibleD1.length, 2);
});

test('an account match also surfaces that account D1 and KV rows', () => {
  const inv = inventory({
    accounts: [
      account({ index: 0, url: 'https://a.workers.dev', name: 'Oktz', d1Name: 'core', kvTitle: 'pages' }),
      account({ index: 1, url: 'https://b.workers.dev', name: 'Tzok', d1Name: 'edge', kvTitle: 'cache' }),
    ],
  });
  const view = filterInventory(inv, 'oktz');
  assert.deepEqual(view.visibleD1.map((row) => row.index), [0]);
  assert.deepEqual(view.visibleKv.map((row) => row.index), [0]);
});

test('search spans KV title and id', () => {
  const inv = inventory({
    accounts: [
      account({ index: 0, url: 'https://a.workers.dev', kvTitle: 'manga-pages', kvId: 'kv-0001' }),
      account({ index: 1, url: 'https://b.workers.dev', kvTitle: 'manga-cache', kvId: 'kv-0002' }),
    ],
  });
  assert.equal(filterInventory(inv, 'manga-cache').visibleKv[0]?.index, 1);
  assert.equal(filterInventory(inv, 'kv-0001').visibleKv[0]?.index, 0);
  assert.equal(filterInventory(inv, 'manga-').visibleKv.length, 2);
});

test('search spans B2 alias, bucket and provider account id', () => {
  const inv = inventory({
    b2: [
      b2Account({ configuredName: 'b2-oktz', bucketName: 'manga-pages', providerAccountId: 'prov-1' }),
      b2Account({ configuredName: 'b2-tzok', bucketName: 'manga-archive', providerAccountId: 'prov-2' }),
    ],
  });
  assert.equal(filterInventory(inv, 'b2-tzok').visibleB2.length, 1);
  assert.equal(filterInventory(inv, 'manga-archive').visibleB2[0]?.configuredName, 'b2-tzok');
  assert.equal(filterInventory(inv, 'prov-1').visibleB2[0]?.configuredName, 'b2-oktz');
  assert.equal(filterInventory(inv, 'b2-').visibleB2.length, 2);
  assert.equal(filterInventory(inv, 'manga-pages').visibleB2[0]?.configuredName, 'b2-oktz');
});

test('search spans registration account and origin', () => {
  const inv = inventory({
    registrations: [
      registration({ id: 'lb-1', label: 'Oktz CF', accountRef: 'acct-oktz', originUrl: 'https://manga-api.oktz.workers.dev' }),
      registration({ id: 'lb-2', label: 'Tzok CF', accountRef: null, originUrl: null, topologyStatus: 'pending_topology' }),
    ],
  });
  assert.equal(filterInventory(inv, 'oktz cf').visibleRegistrations[0]?.account.id, 'lb-1');
  assert.equal(filterInventory(inv, 'acct-oktz').visibleRegistrations[0]?.account.id, 'lb-1');
  assert.equal(filterInventory(inv, 'manga-api.oktz').visibleRegistrations[0]?.account.id, 'lb-1');
  assert.equal(filterInventory(inv, 'lb-2').visibleRegistrations.length, 1);
  assert.equal(filterInventory(inv, 'pending_topology').visibleRegistrations.length, 0, 'topologyStatus is not a search field');
});

test('null fields never match and are never replaced with placeholders', () => {
  const inv = inventory({ accounts: [account({ index: 0, url: 'https://a.workers.dev' })] });
  assert.equal(filterInventory(inv, '—').visibleD1.length, 0);
  assert.equal(filterInventory(inv, 'null').visibleAccounts.length, 0);
  assert.equal(filterInventory(inv, 'undefined').visibleAccounts.length, 0);
  assert.equal(filterInventory(inv, '   ').visibleAccounts.length, 1, 'blank query keeps every row');
  const view = filterInventory(inv, '   ');
  assert.equal(view.query, '', 'blank query normalises to inactive');
  assert.equal(view.active, false);
});

test('malformed payloads return conservative results without inventing values', () => {
  const broken = payload({
    topology: { count: '4' },
    accounts: [{ index: 0 }, null, 'nope'],
    registrations: undefined,
    b2: { not: 'an array' },
    warnings: [],
  });
  const view = filterInventory(broken, 'anything');
  assert.equal(view.visibleAccounts.length, 0, 'rows without a usable url are dropped, not guessed');
  assert.equal(view.visibleB2.length, 0);
  assert.deepEqual(view.visibleRegistrations, []);
  assert.deepEqual(view.totals, { accounts: 0, b2: 0, registrations: 0, warnings: 0 });
  assert.deepEqual(coverage(broken), {
    configured: 0,
    reachable: 0,
    liveAccounts: 0,
    d1: 0,
    kv: 0,
    b2: 0,
  });
  assert.equal(view.stale, false);
  assert.equal(view.observedAt, null, 'a missing timestamp stays null, never 0');
  assert.equal(view.topology.source, null, 'an unknown topology source is never hardcoded');
});

test('non-object input is handled without throwing', () => {
  for (const bad of [null, undefined, 42, 'nope', true, []]) {
    const view = filterInventory(bad, '');
    assert.equal(view.totals.accounts, 0);
    assert.equal(view.observedAt, null);
    assert.equal(view.topology.hash, null);
    assert.deepEqual(coverage(bad), {
      configured: 0,
      reachable: 0,
      liveAccounts: 0,
      d1: 0,
      kv: 0,
      b2: 0,
    });
  }
});

test('rows missing url are excluded while rows with url are kept', () => {
  const partial = payload({
    topology: { source: 'PEER_URLS', count: 2, hash: 'h', consistent: true },
    accounts: [account({ index: 0, url: 'https://a.workers.dev' }), { index: 1 }],
  });
  const view = filterInventory(partial, '');
  assert.equal(view.visibleAccounts.length, 1);
  assert.equal(view.visibleD1.length, 1);
  assert.equal(view.visibleKv.length, 1);
  assert.equal(coverage(partial).reachable, 1, 'reachable is not assumed for a row without url');
});

test('a row with an unusable index keeps its url and reports a null index', () => {
  for (const badIndex of [undefined, null, -1, 1.5, 'two', Number.NaN]) {
    const inv = payload({
      topology: { source: 'PEER_URLS', count: 1, hash: 'h', consistent: true },
      accounts: [{ index: badIndex, url: 'https://a.workers.dev', reachable: true }],
    });
    const view = filterInventory(inv, '');
    assert.equal(view.visibleAccounts.length, 1, `row with index ${String(badIndex)} must survive`);
    assert.equal(view.visibleAccounts[0]?.index, null, 'index is normalised to null, never rendered as #undefined');
    assert.equal(view.visibleAccounts[0]?.url, 'https://a.workers.dev');
  }
});

test('a valid index is preserved', () => {
  assert.equal(filterInventory(inventory(), '').visibleAccounts[3]?.index, 3);
  assert.equal(filterInventory(inventory(), '').visibleAccounts[0]?.index, 0);
});

test('observedAt stays null unless it is a usable timestamp', () => {
  assert.equal(filterInventory(inventory({ observedAt: 1234 }), '').observedAt, 1234);
  for (const bad of [undefined, null, -1, 1.5, 'yesterday', Number.NaN, Number.POSITIVE_INFINITY]) {
    const inv = payload({ ...inventory(), observedAt: bad });
    assert.equal(filterInventory(inv, '').observedAt, null, `observedAt ${String(bad)} must stay null`);
  }
});

test('topology source is read from the payload, unknown renders as null', () => {
  assert.equal(filterInventory(inventory(), '').topology.source, 'PEER_URLS');
  for (const bad of [undefined, null, 42, '', '   ']) {
    const inv = payload({ ...inventory(), topology: { source: bad, count: 4, hash: 'h', consistent: true } });
    assert.equal(filterInventory(inv, '').topology.source, null, `source ${String(bad)} must be null`);
  }
  const inv = payload({ ...inventory(), topology: { count: 4, hash: 'h', consistent: true } });
  assert.equal(filterInventory(inv, '').topology.source, null);
});

test('B2 options are normalised to a string array', () => {
  const base = b2Account({ configuredName: 'b2-a' });
  const cases: Array<[unknown, string[]]> = [
    [['sse-csv', '  ', 'bypass', 7, null], ['sse-csv', 'bypass']],
    ['sse-csv', []],
    [undefined, []],
    [null, []],
    [42, []],
    [{}, []],
  ];
  for (const [options, expected] of cases) {
    const inv = payload({ ...inventory(), b2: [{ ...base, options }] });
    const view = filterInventory(inv, '');
    assert.deepEqual(view.visibleB2[0]?.options, expected, `options ${JSON.stringify(options)}`);
  }
});

test('B2 quota and tracked bytes are normalised to number or null', () => {
  const inv = payload({
    ...inventory(),
    b2: [
      { configuredName: 'b2-a', quotaBytes: -5, trackedBytes: 'nope', trackedUpdatedAt: 2.5, state: state() },
      { configuredName: 'b2-b', quotaBytes: 'big', trackedBytes: 12, trackedUpdatedAt: 77, state: state() },
    ],
  });
  const view = filterInventory(inv, '');
  assert.equal(view.visibleB2[0]?.quotaBytes, null);
  assert.equal(view.visibleB2[0]?.trackedBytes, null);
  assert.equal(view.visibleB2[0]?.trackedUpdatedAt, null);
  assert.equal(view.visibleB2[1]?.quotaBytes, null);
  assert.equal(view.visibleB2[1]?.trackedBytes, 12);
  assert.equal(view.visibleB2[1]?.trackedUpdatedAt, 77);
});

test('resource state is normalised: bad enums fall back, errorCode must be text', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        account: { id: null, name: null, type: null, state: { status: 'great', source: 'guess', observedAt: 'soon', errorCode: 42 } },
        worker: { name: null, createdAt: null, modifiedAt: null, state: null },
        d1: { id: null, name: null, fileBytes: null, jurisdiction: null, region: null, counts: null, state: { status: 'ok', source: 'live', observedAt: 5, errorCode: '  CF_X  ' } },
        kv: { id: null, title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: { status: 'ok', source: 'live', observedAt: 5, errorCode: {} } },
        lb: { account: null, origins: [] },
      },
    ],
  });
  const row = filterInventory(inv, '').visibleAccounts[0];
  assert.deepEqual(row?.account.state, { status: 'unavailable', source: 'unavailable', observedAt: null, errorCode: null });
  assert.deepEqual(row?.worker.state, { status: 'unavailable', source: 'unavailable', observedAt: null, errorCode: null });
  assert.deepEqual(row?.d1.state, { status: 'ok', source: 'live', observedAt: 5, errorCode: 'CF_X' });
  assert.deepEqual(row?.kv.state, { status: 'ok', source: 'live', observedAt: 5, errorCode: null });
});

test('d1 counts and numeric resource fields are normalised to number or null', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        account: { id: null, name: null, type: null, state: state() },
        worker: { name: null, createdAt: null, modifiedAt: null, state: state() },
        d1: { id: null, name: null, fileBytes: -1, jurisdiction: null, region: null, counts: { series: 10, chapters: -3, chapterPages: 'x', users: 2.5, bookmarks: null }, state: state() },
        kv: { id: null, title: null, jurisdiction: null, keyCount: -2, byteCount: 99, operationalD1Bytes: 'x', state: state() },
        lb: { account: null, origins: null },
      },
    ],
  });
  const row = filterInventory(inv, '').visibleAccounts[0];
  assert.equal(row?.d1.fileBytes, null);
  assert.deepEqual(row?.d1.counts, { series: 10, chapters: null, chapterPages: null, users: null, bookmarks: null });
  assert.equal(row?.kv.keyCount, null);
  assert.equal(row?.kv.byteCount, 99);
  assert.equal(row?.kv.operationalD1Bytes, null);
  assert.deepEqual(row?.lb.origins, [], 'a non-array origins list normalises to empty');
});

test('registration entries are normalised without inventing an origin', () => {
  const inv = payload({
    ...inventory(),
    registrations: [
      { account: { id: 'lb-1', label: '  Oktz  ', account_ref: 42, status: 'verified' }, origin: null, topologyStatus: 'registered' },
      { account: { id: 'lb-2', label: null, account_ref: null, status: 'weird' }, origin: { id: 'o-2', origin_url: 99 }, topologyStatus: 'invented' },
      { account: { label: 'no id' }, origin: null, topologyStatus: 'registered' },
    ],
  });
  const view = filterInventory(inv, '');
  assert.equal(view.visibleRegistrations.length, 2, 'a registration without an account id is dropped');
  const first = view.visibleRegistrations[0];
  assert.equal(first?.account.id, 'lb-1');
  assert.equal(first?.account.label, 'Oktz', 'labels are trimmed, not padded');
  assert.equal(first?.account.accountRef, null);
  assert.equal(first?.origin, null, 'a null origin is not turned into a placeholder');
  assert.equal(first?.topologyStatus, 'registered');
  const second = view.visibleRegistrations[1];
  assert.equal(second?.origin?.url, null, 'a non-string origin url is rejected');
  assert.equal(second?.origin?.id, 'o-2', 'the origin id survives even when the url is unusable');
  assert.equal(second?.topologyStatus, null, 'an unknown topology status is rejected');
});

test('warnings are normalised and preserved unfiltered', () => {
  const inv = payload({
    ...inventory(),
    warnings: [
      { code: '  PEER_UNREACHABLE  ', peerUrl: null, message: 'Peer unreachable', observedAt: 900 },
      { code: 'BAD', message: 'no timestamp', observedAt: 'soon' },
      { message: 'no code' },
    ],
  });
  const view = filterInventory(inv, 'zzz-no-match');
  assert.equal(view.totals.warnings, 2, 'a warning without a code is dropped');
  assert.equal(view.warnings[0]?.code, 'PEER_UNREACHABLE');
  assert.equal(view.warnings[0]?.observedAt, 900);
  assert.equal(view.warnings[1]?.observedAt, null);
  assert.equal(view.warnings[1]?.peerUrl, null);
  assert.equal(view.visibleAccounts.length, 0);
});

test('formatSource and formatStatus always return visible text', () => {
  assert.equal(formatSource('live'), 'live');
  assert.equal(formatSource('local'), 'lokal');
  assert.equal(formatSource('tracked'), 'terlacak');
  assert.equal(formatSource('derived'), 'diturunkan');
  assert.equal(formatSource('unavailable'), 'tidak tersedia');
  assert.equal(formatStatus('ok'), 'sehat');
  assert.equal(formatStatus('degraded'), 'terganggu');
  assert.equal(formatStatus('unavailable'), 'tidak tersedia');
  for (const source of ['live', 'local', 'tracked', 'derived', 'unavailable'] as const) {
    assert.ok(formatSource(source).length > 0);
  }
  for (const status of ['ok', 'degraded', 'unavailable'] as const) {
    assert.ok(formatStatus(status).length > 0);
  }
});

test('formatSource and formatStatus survive unknown runtime values', () => {
  const bogus = 'not-a-status' as never;
  assert.equal(formatSource(bogus), 'tidak tersedia');
  assert.equal(formatStatus(bogus), 'tidak tersedia');
  assert.equal(formatSource(undefined as never), 'tidak tersedia');
  assert.equal(formatStatus(7 as never), 'tidak tersedia');
});

test('formatObservedAt renders unknown timestamps as an em dash', () => {
  assert.equal(formatObservedAt(null, 1000), '—');
  assert.equal(formatObservedAt(undefined, 1000), '—');
  assert.equal(formatObservedAt(Number.NaN, 1000), '—');
  assert.equal(formatObservedAt('now' as never, 1000), '—');
});

test('formatObservedAt renders relative age against a supplied now', () => {
  const now = 1_000_000_000;
  assert.equal(formatObservedAt(now, now), 'baru saja');
  assert.equal(formatObservedAt(now - 30_000, now), '30 dtk lalu');
  assert.equal(formatObservedAt(now - 5 * 60_000, now), '5 mnt lalu');
  assert.equal(formatObservedAt(now - 3 * 3_600_000, now), '3 jam lalu');
  assert.equal(formatObservedAt(now - 2 * 86_400_000, now), '2 hari lalu');
});

test('worker timestamps survive normalisation', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        account: { id: null, name: null, type: null, state: state() },
        worker: { name: 'manga-api', createdAt: '  2026-01-02T03:04:05Z  ', modifiedAt: null, state: state() },
        d1: null,
        kv: null,
        lb: null,
      },
    ],
  });
  const worker = filterInventory(inv, '').visibleAccounts[0]?.worker;
  assert.equal(worker?.name, 'manga-api');
  assert.equal(worker?.createdAt, '2026-01-02T03:04:05Z', 'a trimmed ISO timestamp is preserved');
  assert.equal(worker?.modifiedAt, null);
});

test('a non-string worker timestamp is rejected', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        worker: { name: null, createdAt: 1767322, modifiedAt: {}, state: state() },
        lb: null,
      },
    ],
  });
  const worker = filterInventory(inv, '').visibleAccounts[0]?.worker;
  assert.equal(worker?.createdAt, null);
  assert.equal(worker?.modifiedAt, null);
});

test('row lb origins keep their full normalised metadata', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        account: { id: 'cf-1', name: 'A', type: 'standard', state: state() },
        worker: { name: null, createdAt: null, modifiedAt: null, state: state() },
        d1: null,
        kv: null,
        lb: {
          account: { id: 'lb-acc-1', provider: 'cloudflare', label: '  Oktz CF  ', account_ref: 'acct-1', status: 'verified', last_tested_at: 4242, created_at: 11 },
          origins: [
            {
              id: 'origin-1',
              account_id: 'lb-acc-1',
              origin_url: 'https://a.workers.dev',
              priority: 10,
              weight: 3,
              enabled: 1,
              last_health_status: 'healthy',
              last_checked_at: 555,
              created_at: 99,
            },
          ],
        },
      },
    ],
  });
  const lb = filterInventory(inv, '').visibleAccounts[0]?.lb;
  assert.equal(lb?.accountId, 'lb-acc-1');
  assert.equal(lb?.accountLabel, 'Oktz CF');
  assert.equal(lb?.accountRef, 'acct-1');
  assert.equal(lb?.accountStatus, 'verified');
  assert.equal(lb?.accountLastTestedAt, 4242);
  assert.equal(lb?.accountCreatedAt, 11);
  assert.equal(lb?.origins.length, 1);
  assert.deepEqual(lb?.origins[0], {
    id: 'origin-1',
    url: 'https://a.workers.dev',
    accountId: 'lb-acc-1',
    priority: 10,
    weight: 3,
    enabled: 1,
    lastHealthStatus: 'healthy',
    lastCheckedAt: 555,
    createdAt: 99,
  });
});

test('origin fields are validated rather than copied through', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        lb: {
          account: null,
          origins: [
            { id: 'o1', origin_url: 'https://a.workers.dev', priority: -1, weight: 0, enabled: 7, last_checked_at: 'x', created_at: 1.5 },
            { id: 'o2', origin_url: 'https://b.workers.dev', priority: 0, weight: 1, enabled: 0, last_checked_at: 5, created_at: 6 },
            { id: '', origin_url: '', priority: 0, weight: 1, enabled: 1 },
            { priority: 0, weight: 1, enabled: 1 },
            'nope',
          ],
        },
      },
    ],
  });
  const origins = filterInventory(inv, '').visibleAccounts[0]?.lb.origins ?? [];
  assert.equal(origins.length, 2, 'origins with neither id nor url are dropped');
  assert.deepEqual(origins[0], {
    id: 'o1',
    url: 'https://a.workers.dev',
    accountId: null,
    priority: null,
    weight: null,
    enabled: null,
    lastHealthStatus: null,
    lastCheckedAt: null,
    createdAt: null,
  });
  assert.deepEqual(origins[1], {
    id: 'o2',
    url: 'https://b.workers.dev',
    accountId: null,
    priority: 0,
    weight: 1,
    enabled: 0,
    lastHealthStatus: null,
    lastCheckedAt: 5,
    createdAt: 6,
  });
});

test('registration account and origin keep their full metadata', () => {
  const inv = payload({
    ...inventory(),
    registrations: [
      {
        account: { id: 'lb-1', provider: 'cloudflare', label: 'Oktz', account_ref: 'acct-1', status: 'verified', last_tested_at: 777, created_at: 12 },
        origin: {
          id: 'origin-9',
          account_id: 'lb-1',
          origin_url: 'https://a.workers.dev',
          priority: 5,
          weight: 2,
          enabled: 1,
          last_health_status: 'degraded',
          last_checked_at: 888,
          created_at: 13,
        },
        topologyStatus: 'pending_topology',
      },
    ],
  });
  const entry = filterInventory(inv, '').visibleRegistrations[0];
  assert.equal(entry?.account.lastTestedAt, 777);
  assert.equal(entry?.account.createdAt, 12);
  assert.deepEqual(entry?.origin, {
    id: 'origin-9',
    url: 'https://a.workers.dev',
    accountId: 'lb-1',
    priority: 5,
    weight: 2,
    enabled: 1,
    lastHealthStatus: 'degraded',
    lastCheckedAt: 888,
    createdAt: 13,
  });
});

test('a registration without an origin keeps the origin null', () => {
  const inv = payload({
    ...inventory(),
    registrations: [
      { account: { id: 'lb-1', label: 'A' }, origin: null, topologyStatus: 'pending_topology' },
      { account: { id: 'lb-2', label: 'B' }, origin: 'bukan objek', topologyStatus: 'pending_topology' },
    ],
  });
  const view = filterInventory(inv, '');
  assert.equal(view.visibleRegistrations[0]?.origin, null);
  assert.equal(view.visibleRegistrations[1]?.origin, null);
});

test('registration account timestamps are validated', () => {
  const inv = payload({
    ...inventory(),
    registrations: [
      { account: { id: 'lb-1', label: 'A', last_tested_at: -1, created_at: 2.5 }, origin: null, topologyStatus: 'pending_topology' },
    ],
  });
  const account = filterInventory(inv, '').visibleRegistrations[0]?.account;
  assert.equal(account?.lastTestedAt, null);
  assert.equal(account?.createdAt, null);
});

test('search reaches registration provider, status and origin id', () => {
  const inv = payload({
    ...inventory(),
    registrations: [
      {
        account: { id: 'lb-1', provider: 'vercel', label: 'A', account_ref: null, status: 'failed' },
        origin: { id: 'origin-77', origin_url: 'https://a.workers.dev' },
        topologyStatus: 'pending_topology',
      },
    ],
  });
  for (const query of ['vercel', 'failed', 'origin-77']) {
    assert.equal(filterInventory(inv, query).visibleRegistrations.length, 1, `query ${query} must match`);
  }
});

test('search reaches the row lb account label and origin url', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://peer-zero.workers.dev',
        reachable: true,
        lb: {
          account: { id: 'lb-acc-1', label: 'Oktz Cloudflare', account_ref: null, status: 'verified' },
          origins: [{ id: 'o1', origin_url: 'https://origin-tunggal.example.dev' }],
        },
      },
      { index: 1, url: 'https://peer-satu.workers.dev', reachable: true, lb: null },
    ],
  });
  assert.equal(filterInventory(inv, 'oktz cloudflare').visibleAccounts[0]?.index, 0);
  assert.equal(filterInventory(inv, 'origin-tunggal').visibleAccounts[0]?.index, 0);
  assert.equal(filterInventory(inv, 'peer-satu').visibleAccounts[0]?.index, 1);
  assert.equal(filterInventory(inv, 'lb-acc-1').visibleAccounts.length, 1);
});

test('strings trims each retained entry', () => {
  const inv = payload({
    ...inventory(),
    b2: [{ configuredName: 'b2-a', options: ['  sse-csv  ', '\tbypass\n', 7, null, '', '   '] }],
  });
  assert.deepEqual(filterInventory(inv, '').visibleB2[0]?.options, ['sse-csv', 'bypass']);
});

test('row lb origin urls are searched in their trimmed form', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://peer.workers.dev',
        reachable: true,
        lb: { account: null, origins: [{ id: 'o1', origin_url: '  https://trimmed.example.dev  ' }] },
      },
    ],
  });
  assert.equal(filterInventory(inv, 'trimmed.example').visibleAccounts.length, 1);
});

test('B2 entries keep enough identity to build a distinct key', () => {
  const inv = payload({
    ...inventory(),
    b2: [
      { configuredName: 'sama', providerAccountId: 'prov-1', bucketId: 'b-1', bucketName: 'x' },
      { configuredName: 'sama', providerAccountId: 'prov-1', bucketId: 'b-2', bucketName: 'x' },
      { configuredName: 'sama', providerAccountId: null, bucketId: null, bucketName: 'x' },
      { configuredName: 'sama', providerAccountId: null, bucketId: null, bucketName: 'x' },
    ],
  });
  const view = filterInventory(inv, '');
  assert.equal(view.visibleB2.length, 4, 'duplicate entries are not collapsed');
  const composite = view.visibleB2.map((e) => `${e.configuredName}|${e.providerAccountId ?? ''}|${e.bucketId ?? ''}`);
  assert.equal(new Set(composite).size, 3, 'only the two fully identical entries share a composite');
  assert.equal(composite[0] !== composite[1], true, 'different bucket ids must not collide');
  assert.equal(composite[2], composite[3], 'truly identical entries share a composite and need the list position');
});

test('token_last4 is never carried into the inventory view', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        lb: {
          account: { id: 'lb-1', label: 'A', token_last4: 'beef', encrypted_token: 'sekret' },
          origins: [{ id: 'o1', origin_url: 'https://a.workers.dev', token_last4: 'cafe' }],
        },
      },
    ],
    registrations: [
      { account: { id: 'lb-1', label: 'A', token_last4: 'beef' }, origin: null, topologyStatus: 'pending_topology' },
    ],
  });
  const serialised = JSON.stringify(filterInventory(inv, ''));
  assert.equal(serialised.includes('beef'), false, 'a token fragment must never reach the frontend model');
  assert.equal(serialised.includes('cafe'), false);
  assert.equal(serialised.includes('sekret'), false);
  assert.equal(serialised.includes('token_last4'), false);
  assert.equal(serialised.includes('encrypted_token'), false);
});

test('lb account provider is normalised and token fields stay excluded', () => {
  const lbAccount = (provider: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'lb-acc-1',
    provider,
    label: 'Oktz',
    account_ref: 'acct-1',
    status: 'verified',
    ...extra,
  });
  const rowWith = (account: unknown) =>
    filterInventory(
      payload({
        ...inventory(),
        accounts: [{ index: 0, url: 'https://a.workers.dev', reachable: true, lb: { account, origins: [] } }],
      }),
      ''
    ).visibleAccounts[0]?.lb;

  for (const provider of ['cloudflare', 'vercel']) {
    assert.equal(rowWith(lbAccount(provider))?.accountProvider, provider, `provider ${provider} must survive`);
  }
  assert.equal(rowWith(lbAccount('  cloudflare  '))?.accountProvider, 'cloudflare', 'a padded provider is trimmed');
  for (const bad of [undefined, null, 7, {}, '', '   ', true]) {
    assert.equal(rowWith(lbAccount(bad))?.accountProvider, null, `provider ${JSON.stringify(bad)} must be null`);
  }
  assert.equal(rowWith(null)?.accountProvider, null, 'a missing lb account has no provider');

  const withTokens = rowWith(
    lbAccount('cloudflare', { token_last4: 'beef', encrypted_token: 'sekret', created_by: 3 })
  );
  assert.equal(withTokens?.accountProvider, 'cloudflare', 'a real provider still survives alongside token fields');
  const serialised = JSON.stringify(withTokens);
  assert.equal(serialised.includes('beef'), false, 'token_last4 must never reach the frontend model');
  assert.equal(serialised.includes('sekret'), false, 'encrypted_token must never reach the frontend model');
  assert.equal(serialised.includes('token_last4'), false);
  assert.equal(serialised.includes('encrypted_token'), false);
  assert.equal(serialised.includes('created_by'), false, 'only declared account fields are carried');
});

/* ═══════════════════════════════════════════════════════════════════════
 * Page-level view models (Settings / Dashboard / Monitoring inputs)
 * ═══════════════════════════════════════════════════════════════════════ */

const lbMeta = (over: {
  id: string;
  provider?: 'cloudflare' | 'vercel';
  label?: string;
  accountRef?: string;
  status?: 'verified' | 'unverified' | 'failed';
  lastTestedAt?: number;
}): NonNullable<Row['lb']['account']> => ({
  id: over.id,
  provider: over.provider ?? 'cloudflare',
  label: over.label ?? 'Akun uji',
  account_ref: over.accountRef ?? null,
  status: over.status ?? 'verified',
  last_tested_at: over.lastTestedAt,
});

const originMeta = (over: { id: string; url: string; accountId?: string; health?: string; checkedAt?: number }): Row['lb']['origins'][number] => ({
  id: over.id,
  origin_url: over.url,
  account_id: over.accountId ?? null,
  priority: 0,
  weight: 1,
  enabled: 1,
  last_health_status: over.health,
  last_checked_at: over.checkedAt,
});

test('four topology accounts survive a two-row D1 seed', () => {
  const inv = inventory({
    registrations: [
      registration({ id: 'lb-1', label: 'Oktz CF', originUrl: 'https://manga-api.oktz.workers.dev' }),
      registration({ id: 'lb-2', label: 'Tzok CF', originUrl: 'https://manga-api-2.tzok5555.workers.dev' }),
    ],
  });
  assert.equal(inv.accounts.length, 4);
  assert.equal(filterInventory(inv, '').visibleAccounts.length, 4);
  assert.equal(coverage({ ...inv, accounts: inv.accounts.slice(0, 2) }).configured, 4);
  assert.equal(coverage({ ...inv, accounts: inv.accounts.slice(0, 2) }).reachable, 2);
});

test('storageFromInventory maps B2 accounts and keeps unknown bytes null', () => {
  const inv = inventory({
    b2: [
      b2Account({ configuredName: 'b2-oktz', bucketName: 'manga-oktz', providerAccountId: 'prov-1', trackedBytes: 1200, quotaBytes: 5000 }),
      b2Account({ configuredName: 'b2-tzok', bucketName: 'manga-tzok', providerAccountId: 'prov-2', trackedBytes: null, quotaBytes: 5000 }),
    ],
  });
  assert.deepEqual(storageFromInventory(inv), {
    accounts: [
      { name: 'b2-oktz', bucket: 'manga-oktz', bytes: 1200, quota: 5000 },
      { name: 'b2-tzok', bucket: 'manga-tzok', bytes: null, quota: 5000 },
    ],
    totalQuota: 10000,
  });
});

test('storageFromInventory never fabricates bytes or quota', () => {
  const inv = payload({
    topology: { source: 'PEER_URLS', count: 4, hash: 'h', consistent: true },
    b2: [{ configuredName: 'b2-a', bucketName: null, trackedBytes: null, quotaBytes: null, state: state() }],
  });
  const result = storageFromInventory(inv);
  assert.deepEqual(result, { accounts: [{ name: 'b2-a', bucket: '', bytes: null, quota: 0 }], totalQuota: 0 });
  assert.equal(result.totalQuota, 0, 'an unknown quota must read as "belum diatur", never as a number');
});

test('storageFromInventory sums only known quotas and preserves configured order', () => {
  const entry = (configuredName: string, quotaBytes: number | null) => ({
    configuredName,
    bucketName: configuredName,
    trackedBytes: null,
    quotaBytes,
    state: state(),
  });
  const inv = payload({
    ...inventory(),
    b2: [entry('b2-c', 100), entry('b2-a', null), entry('b2-b', 200)],
  });
  const result = storageFromInventory(inv);
  assert.deepEqual(result.accounts.map((a) => a.name), ['b2-c', 'b2-a', 'b2-b']);
  assert.equal(result.totalQuota, 300, 'an unknown quota contributes nothing to the total');
});

test('storageFromInventory returns an empty shape for a missing B2 list', () => {
  assert.deepEqual(storageFromInventory(payload({ topology: { count: 4 } })), { accounts: [], totalQuota: 0 });
  for (const bad of [null, undefined, 42, 'nope', []]) {
    assert.deepEqual(storageFromInventory(bad), { accounts: [], totalQuota: 0 });
  }
});

const lbFixture = (over: Partial<AdminInventory> = {}): AdminInventory =>
  inventory({
    accounts: [
      account({
        index: 0,
        url: 'https://a.workers.dev',
        name: 'Oktz',
        lbAccount: lbMeta({ id: 'lb-1', label: 'Oktz CF', accountRef: 'acct-1', lastTestedAt: 900 }),
        origins: [originMeta({ id: 'o1', url: 'https://a.workers.dev', accountId: 'lb-1', health: 'healthy', checkedAt: 50 })],
      }),
      account({ index: 1, url: 'https://b.workers.dev', name: 'Tzok' }),
      account({ index: 2, url: 'https://c.workers.dev', name: 'Dwika' }),
      account({ index: 3, url: 'https://d.workers.dev', name: 'Nih' }),
    ],
    registrations: [
      registration({ id: 'lb-1', label: 'Oktz CF', originUrl: 'https://a.workers.dev' }),
      registration({ id: 'lb-9', label: 'Baru', originUrl: null, topologyStatus: 'pending_topology' }),
    ],
    ...over,
  });

test('lbRowsFromInventory renders four topology rows plus unmatched registrations', () => {
  const rows = lbRowsFromInventory(lbFixture(), [{ origin_url: 'https://a.workers.dev', req_count: 7 }]);
  assert.deepEqual(rows.map((r) => r.topologyUrl), [
    'https://a.workers.dev',
    'https://b.workers.dev',
    'https://c.workers.dev',
    'https://d.workers.dev',
    null,
  ]);
  assert.equal(rows[0]?.label, 'Oktz CF');
  assert.equal(rows[0]?.provider, 'cloudflare');
  assert.equal(rows[0]?.accountRef, 'acct-1');
  assert.deepEqual(rows[0]?.origins.map((o) => o.id), ['o1'], 'every origin of an account is kept, not just the first');
  assert.equal(rows[0]?.origins[0]?.lastHealthStatus, 'healthy');
  assert.equal(rows[0]?.origins[0]?.lastCheckedAt, 50);
  assert.equal(rows[0]?.lastTestedAt, 900, 'a credential row carries its own last-tested time');
  assert.equal(rows[0]?.requestsToday, 7);
  assert.equal(rows[1]?.label, 'Tzok', 'a topology row without LB metadata falls back to the provider account name');
  assert.equal(rows[1]?.accountId, null);
  assert.equal(rows[1]?.requestsToday, 0);
  assert.equal(rows[4]?.label, 'Baru');
  assert.equal(rows[4]?.topologyStatus, 'pending_topology');
  assert.deepEqual(rows[4]?.origins, [], 'a registration with no origin keeps an empty list');
  assert.equal(rows[4]?.requestsToday, 0);
  assert.equal(new Set(rows.map((r) => r.key)).size, 5, 'every row has a distinct React key');
});

test('lbRowsFromInventory never repeats a registration already matched to a topology row', () => {
  const rows = lbRowsFromInventory(lbFixture(), []);
  assert.equal(rows.length, 5, 'four topology rows plus the one registration absent from topology');
  assert.deepEqual(rows.filter((r) => r.accountId === 'lb-1').map((r) => r.topologyUrl), ['https://a.workers.dev']);
  assert.deepEqual(rows.filter((r) => r.topologyStatus === 'pending_topology').map((r) => r.accountId), ['lb-9']);
});

test('lbRowsFromInventory sums usage per origin url and ignores unrelated urls', () => {
  const inv = inventory({
    accounts: [
      account({
        index: 0,
        url: 'https://a.workers.dev',
        lbAccount: lbMeta({ id: 'lb-1' }),
        origins: [originMeta({ id: 'o1', url: 'https://a.workers.dev' }), originMeta({ id: 'o2', url: 'https://z.workers.dev' })],
      }),
    ],
  });
  const rows = lbRowsFromInventory(inv, [
    { origin_url: 'https://a.workers.dev', req_count: 3 },
    { origin_url: 'https://z.workers.dev', req_count: 4 },
    { origin_url: 'https://unrelated.workers.dev', req_count: 99 },
  ]);
  assert.equal(rows[0]?.requestsToday, 7);
});

test('lbRowsFromInventory reports a null last-tested time for a never-tested credential', () => {
  const inv = inventory({
    topology: { source: 'PEER_URLS', count: 0, hash: 'h', consistent: true },
    accounts: [],
    registrations: [registration({ id: 'lb-7', label: 'Baru' })],
  });
  const rows = lbRowsFromInventory(inv, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.lastTestedAt, null);
  assert.equal(rows[0]?.status, 'verified');
});

test('lbRowsFromInventory keeps an unreachable topology row visible and never blank', () => {
  const inv = inventory({ accounts: [account({ index: 0, url: 'https://a.workers.dev', reachable: false, accountState: down })] });
  const rows = lbRowsFromInventory(inv, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.reachable, false);
  assert.equal(rows[0]?.label, 'https://a.workers.dev', 'a row with no name or label still shows its peer url');
});

test('lbRowsFromInventory survives a non-array usage list and an empty payload', () => {
  assert.equal(lbRowsFromInventory(lbFixture(), payload(null) as never).length, 5);
  assert.deepEqual(lbRowsFromInventory(payload(null), []), []);
  assert.deepEqual(lbRowsFromInventory(null, []), []);
});

test('lbRowsFromInventory filters rows with the page search box', () => {
  const rows = lbRowsFromInventory(lbFixture(), [], 'baru');
  assert.deepEqual(rows.map((r) => r.accountId), ['lb-9']);
  assert.deepEqual(lbRowsFromInventory(lbFixture(), [], 'zzz-no-match'), []);
  assert.equal(lbRowsFromInventory(lbFixture(), []).length, 5, 'a blank query keeps every row');
  assert.equal(lbRowsFromInventory(lbFixture(), [], '   ').length, 5, 'a whitespace query keeps every row');
});

test('lbRowsFromInventory falls back through label, provider account name, then peer url', () => {
  const rows = lbRowsFromInventory(
    payload({
      ...inventory(),
      accounts: [
        { index: 0, url: 'https://a.workers.dev', reachable: true, account: { id: 'cf-1', name: null, type: null }, lb: { account: { id: 'lb-1', provider: 'cloudflare', label: null, account_ref: null, status: 'verified' }, origins: [] } },
        { index: 1, url: 'https://b.workers.dev', reachable: true, account: { id: 'cf-2', name: 'Tzok', type: 'standard' }, lb: null },
      ],
      registrations: [],
    }),
    []
  );
  assert.equal(rows[0]?.label, 'https://a.workers.dev', 'no label and no account name falls back to the peer url');
  assert.equal(rows[0]?.provider, 'cloudflare', 'a real provider survives without a label');
  assert.equal(rows[1]?.label, 'Tzok', 'the provider account name is the second fallback');
  assert.equal(rows[1]?.provider, 'standard', 'account.type is used when no LB account is matched');
});

test('accountOptionsFromConflict keeps only usable 409 account choices', () => {
  assert.deepEqual(
    accountOptionsFromConflict([
      { id: 'acc-1', name: 'Oktz', type: 'standard' },
      { id: 'acc-2', name: 'Tzok', type: null },
      { id: '', name: 'kosong' },
      { id: 'no-name' },
      { id: 'no-type', name: 'Tanpa tipe' },
      null,
      'nope',
      { id: 7, name: 8 },
    ]),
    [
      { id: 'acc-1', name: 'Oktz', type: 'standard' },
      { id: 'acc-2', name: 'Tzok', type: null },
      { id: 'no-type', name: 'Tanpa tipe', type: null },
    ]
  );
});

test('accountOptionsFromConflict trims, dedupes, and survives a non-array body', () => {
  assert.deepEqual(
    accountOptionsFromConflict([
      { id: ' acc-1 ', name: ' Oktz ', type: '  standard  ' },
      { id: 'acc-1', name: 'Oktz', type: 'standard' },
    ]),
    [{ id: 'acc-1', name: 'Oktz', type: 'standard' }]
  );
  for (const bad of [undefined, null, 42, 'nope', {}, true]) {
    assert.deepEqual(accountOptionsFromConflict(bad), [], `${JSON.stringify(bad)} must yield no choices`);
  }
});

test('PENDING_TOPOLOGY_STEPS spells out the exact manual activation order', () => {
  assert.deepEqual(PENDING_TOPOLOGY_STEPS, [
    'Tambahkan URL Worker ke PEER_URLS di setiap worker.',
    'Pastikan hash topologi identik di semua worker.',
    'Deploy konfigurasi terkoordinasi ke semua worker.',
    'Aktifkan origin (enabled=1) setelah topologi sinkron.',
  ]);
  assert.equal(new Set(PENDING_TOPOLOGY_STEPS).size, PENDING_TOPOLOGY_STEPS.length, 'no duplicated step');
});

test('storage, lb row, and 409 option models never carry a token fragment', () => {
  const inv = payload({
    ...inventory(),
    b2: [{ configuredName: 'b2-a', trackedBytes: 1, quotaBytes: 2, state: state() }],
    accounts: [
      {
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        lb: { account: { id: 'lb-1', label: 'A', token_last4: 'beef' }, origins: [{ id: 'o1', origin_url: 'https://a.workers.dev' }] },
      },
    ],
    registrations: [
      { account: { id: 'lb-1', label: 'A', token_last4: 'beef', encrypted_token: 'sekret' }, origin: null, topologyStatus: 'pending_topology' },
    ],
  });
  const serialised = JSON.stringify([
    storageFromInventory(inv),
    lbRowsFromInventory(inv, []),
    accountOptionsFromConflict([{ id: 'acc-1', name: 'A', token_last4: 'beef' }]),
  ]);
  for (const fragment of ['beef', 'sekret', 'token_last4', 'encrypted_token']) {
    assert.equal(serialised.includes(fragment), false, `${fragment} must never reach the UI model`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * Fix round 1 — page behaviour helpers
 * ═══════════════════════════════════════════════════════════════════════ */

const seedTwoRowInventory = (over: Record<string, unknown> = {}): unknown =>
  payload({
    topology: { source: 'PEER_URLS', count: 4, hash: 'topo-hash', consistent: true },
    accounts: [
      {
        topologyHash: 'topo-hash',
        index: 0,
        url: 'https://manga-api.oktz.workers.dev',
        self: true,
        reachable: true,
        account: { id: 'cf-0', name: 'Oktz', type: 'standard', state: state() },
        worker: { name: 'manga-api', createdAt: null, modifiedAt: null, state: state() },
        d1: { id: 'd1-0', name: 'manga-core', fileBytes: 10, jurisdiction: null, region: null, counts: { series: 1, chapters: 2, chapterPages: 3, users: 4, bookmarks: 5 }, state: state() },
        kv: { id: 'kv-0', title: 'manga-pages', jurisdiction: null, keyCount: 1, byteCount: 2, operationalD1Bytes: 3, state: state() },
        lb: { account: { id: 'lb-1', provider: 'cloudflare', label: 'Oktz CF', account_ref: 'acct-1', status: 'verified', last_tested_at: 900, created_at: 1 }, origins: [{ id: 'o1', origin_url: 'https://manga-api.oktz.workers.dev', account_id: 'lb-1' }] },
      },
      {
        topologyHash: 'topo-hash',
        index: 1,
        url: 'https://manga-api-2.tzok.workers.dev',
        self: false,
        reachable: true,
        account: { id: 'cf-1', name: 'Tzok', type: 'standard', state: state() },
        worker: { name: 'manga-api-2', createdAt: null, modifiedAt: null, state: state() },
        d1: { id: 'd1-1', name: 'manga-edge', fileBytes: 20, jurisdiction: null, region: null, counts: { series: null, chapters: null, chapterPages: null, users: null, bookmarks: null }, state: state() },
        kv: { id: 'kv-1', title: 'manga-cache', jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: state() },
        lb: { account: { id: 'lb-2', provider: 'cloudflare', label: 'Tzok CF', account_ref: 'acct-2', status: 'verified', last_tested_at: null, created_at: 1 }, origins: [] },
      },
      {
        topologyHash: 'topo-hash',
        index: 2,
        url: 'https://manga-api-3.dwika.workers.dev',
        self: false,
        reachable: true,
        account: { id: 'cf-2', name: 'Dwika', type: 'standard', state: state() },
        worker: { name: 'manga-api-3', createdAt: null, modifiedAt: null, state: state() },
        d1: { id: null, name: null, fileBytes: null, jurisdiction: null, region: null, counts: null, state: state() },
        kv: { id: null, title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: state() },
        lb: { account: null, origins: [] },
      },
      {
        topologyHash: 'topo-hash',
        index: 3,
        url: 'https://manga-api-4.nih.workers.dev',
        self: false,
        reachable: true,
        account: { id: 'cf-3', name: 'Nih', type: 'standard', state: state() },
        worker: { name: 'manga-api-4', createdAt: null, modifiedAt: null, state: state() },
        d1: { id: null, name: null, fileBytes: null, jurisdiction: null, region: null, counts: null, state: state() },
        kv: { id: null, title: null, jurisdiction: null, keyCount: null, byteCount: null, operationalD1Bytes: null, state: state() },
        lb: { account: null, origins: [] },
      },
    ],
    registrations: [],
    b2: [],
    warnings: [],
    ...over,
  });

test('topologyHash is normalised on every row and survives a bad value', () => {
  const inv = seedTwoRowInventory({
    accounts: [
      { topologyHash: '  topo-hash  ', index: 0, url: 'https://a.workers.dev', reachable: true, lb: null },
      { topologyHash: '', index: 1, url: 'https://b.workers.dev', reachable: true, lb: null },
      { topologyHash: 7, index: 2, url: 'https://c.workers.dev', reachable: true, lb: null },
      { index: 3, url: 'https://d.workers.dev', reachable: true, lb: null },
    ],
  });
  const rows = filterInventory(inv, '').visibleAccounts;
  assert.equal(rows[0]?.topologyHash, 'topo-hash', 'a padded hash is trimmed');
  assert.equal(rows[1]?.topologyHash, null, 'a blank hash is null, not an empty string');
  assert.equal(rows[2]?.topologyHash, null, 'a numeric hash is rejected');
  assert.equal(rows[3]?.topologyHash, null, 'a missing hash is null');
});

test('hashMatches compares only when both hashes are usable', () => {
  assert.equal(hashMatches('h', 'h'), true);
  assert.equal(hashMatches(' h ', 'h'), true, 'a padded hash still matches');
  assert.equal(hashMatches('a', 'b'), false);
  for (const pair of [[null, 'h'], ['h', null], [null, null], ['', 'h'], ['h', ''], ['   ', 'h']] as const) {
    assert.equal(hashMatches(pair[0], pair[1]), null, `${JSON.stringify(pair)} must be unknown, not a mismatch`);
  }
});

test('topologyRowsFromInventory renders every topology row from a two-row D1 seed', () => {
  const rows = topologyRowsFromInventory(seedTwoRowInventory());
  assert.equal(rows.length, 4, 'two D1 rows must not hide the other two topology peers');
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.url), [
    'https://manga-api.oktz.workers.dev',
    'https://manga-api-2.tzok.workers.dev',
    'https://manga-api-3.dwika.workers.dev',
    'https://manga-api-4.nih.workers.dev',
  ]);
  assert.deepEqual(rows.map((r) => r.accountName), ['Oktz', 'Tzok', 'Dwika', 'Nih']);
  assert.deepEqual(rows.map((r) => r.accountId), ['cf-0', 'cf-1', 'cf-2', 'cf-3']);
  assert.deepEqual(rows.map((r) => r.workerName), ['manga-api', 'manga-api-2', 'manga-api-3', 'manga-api-4']);
  assert.deepEqual(rows.map((r) => r.hashMatches), [true, true, true, true]);
  assert.deepEqual(rows.map((r) => r.self), [true, false, false, false]);
  assert.deepEqual(rows.map((r) => r.lbAccountId), ['lb-1', 'lb-2', null, null]);
  assert.equal(rows[0]?.originCount, 1);
  assert.equal(rows[1]?.originCount, 0);
  assert.equal(new Set(rows.map((r) => r.key)).size, 4, 'every row has a distinct React key');
  assert.deepEqual(rows.map((r) => r.accountState.status), ['ok', 'ok', 'ok', 'ok']);
});

test('topologyRowsFromInventory flags a peer whose hash disagrees with the coordinator', () => {
  const inv = seedTwoRowInventory({
    accounts: [
      { topologyHash: 'topo-hash', index: 0, url: 'https://a.workers.dev', reachable: true, lb: null },
      { topologyHash: 'stale-hash', index: 1, url: 'https://b.workers.dev', reachable: true, lb: null },
      { index: 2, url: 'https://c.workers.dev', reachable: false, lb: null },
    ],
  });
  const rows = topologyRowsFromInventory(inv);
  assert.deepEqual(rows.map((r) => r.hashMatches), [true, false, null], 'a missing peer hash is unknown, not a mismatch');
  assert.equal(rows[1]?.topologyHash, 'stale-hash');
  assert.equal(rows[2]?.reachable, false, 'an unreachable peer stays visible');
  assert.equal(rows[2]?.accountName, null);
  assert.equal(rows[2]?.workerName, null);
});

test('topologyRowsFromInventory honours the search box and survives junk input', () => {
  assert.equal(topologyRowsFromInventory(seedTwoRowInventory(), 'dwika').length, 1);
  assert.equal(topologyRowsFromInventory(seedTwoRowInventory(), 'zzz').length, 0);
  assert.equal(topologyRowsFromInventory(seedTwoRowInventory()).length, 4);
  for (const bad of [null, undefined, 42, 'nope', []]) {
    assert.deepEqual(topologyRowsFromInventory(bad), []);
  }
});

test('accountCreateOutcome reports a stored-but-failed account from the body, not the status', () => {
  assert.deepEqual(accountCreateOutcome(422, { id: 'lb-9', status: 'failed', err: 'provider said no' }), {
    kind: 'stored',
    id: 'lb-9',
    status: 'failed',
  });
  assert.deepEqual(accountCreateOutcome(200, { id: 'lb-1', status: 'verified', err: null }), {
    kind: 'stored',
    id: 'lb-1',
    status: 'verified',
  });
  assert.deepEqual(accountCreateOutcome(422, { id: 'lb-9', status: 'verified' }), {
    kind: 'stored',
    id: 'lb-9',
    status: 'verified',
  });
});

test('accountCreateOutcome never claims a save for an error body', () => {
  const cases: Array<[number, unknown, string]> = [
    [422, { error: 'no accessible cloudflare accounts' }, 'tidak melihat akun Cloudflare'],
    [422, { error: 'no_cloudflare_accounts' }, 'tidak melihat akun Cloudflare'],
    [422, { error: 'cloudflare_token_rejected' }, 'ditolak Cloudflare'],
    [422, { error: 'cloudflare_account_read_forbidden' }, 'izin membaca akun'],
    [400, { error: 'invalid accountId' }, 'Account ID Cloudflare'],
    [400, { error: 'token required' }, 'Token wajib diisi'],
    [500, { error: 'account create failed' }, 'Gagal menyimpan akun'],
    [502, { error: 'cloudflare_unavailable' }, 'Gagal menambah akun'],
    [500, null, 'Gagal menambah akun'],
    [422, {}, 'Gagal menambah akun'],
    [422, { id: 7, status: 'failed' }, 'Gagal menambah akun'],
    [422, { id: 'lb-9' }, 'Gagal menambah akun'],
    [200, {}, 'Gagal menambah akun'],
    [200, 'not an object', 'Gagal menambah akun'],
  ];
  for (const [status, body, fragment] of cases) {
    const outcome = accountCreateOutcome(status, body);
    assert.equal(outcome.kind, 'failed', `body ${JSON.stringify(body)} must not report a save`);
    assert.ok(
      (outcome as { message: string }).message.includes(fragment),
      `body ${JSON.stringify(body)} expected message containing ${fragment}, got ${(outcome as { message: string }).message}`
    );
  }
});

test('accountCreateOutcome never echoes a provider err string or an unknown error body', () => {
  const stored = accountCreateOutcome(422, { id: 'lb-9', status: 'failed', err: 'raw provider failure text' });
  assert.equal(JSON.stringify(stored).includes('raw provider'), false);
  const failed = accountCreateOutcome(422, { error: 'raw provider failure text', err: 'raw provider failure text' });
  assert.equal(failed.kind, 'failed');
  assert.equal(JSON.stringify(failed).includes('raw provider'), false, 'an unknown error body is not echoed');
});

test('accountSelectionControl shows a picker only after a 409, and a ref field only for vercel', () => {
  const choices = [{ id: 'acc-1', name: 'Oktz', type: 'standard' }];
  assert.deepEqual(accountSelectionControl('cloudflare', []), { kind: 'none' }, 'no picker before a 409');
  assert.deepEqual(accountSelectionControl('cloudflare', choices), { kind: 'picker', choices });
  assert.deepEqual(accountSelectionControl('vercel', []), { kind: 'reference' }, 'vercel keeps a team/account ref');
  assert.deepEqual(accountSelectionControl('vercel', choices), { kind: 'reference' }, 'a 409 picker never replaces the vercel ref');
  for (const bad of [undefined, null, '', 'CLOUDFLARE', 7, {}]) {
    assert.deepEqual(accountSelectionControl(bad, []), { kind: 'none' }, `${JSON.stringify(bad)} must offer no free-text id`);
  }
});

test('canSubmitCredential blocks while busy and while a 409 picker has no selection', () => {
  assert.equal(canSubmitCredential({ busy: false, awaitingSelection: false, selectedAccountId: '' }), true);
  assert.equal(canSubmitCredential({ busy: true, awaitingSelection: false, selectedAccountId: '' }), false);
  assert.equal(canSubmitCredential({ busy: false, awaitingSelection: true, selectedAccountId: '' }), false);
  assert.equal(canSubmitCredential({ busy: false, awaitingSelection: true, selectedAccountId: '   ' }), false);
  assert.equal(canSubmitCredential({ busy: false, awaitingSelection: true, selectedAccountId: 'acc-1' }), true);
  assert.equal(canSubmitCredential({ busy: true, awaitingSelection: true, selectedAccountId: 'acc-1' }), false, 'busy always wins');
});

test('bannersAfter keeps inventory and mutation failures apart', () => {
  const both = { inventory: 'stale inventory', inventoryTone: 'error', mutation: 'token rejected', mutationTone: 'error' } as const;
  assert.deepEqual(bannersAfter(both, { kind: 'mutation', outcome: 'success' }), {
    inventory: 'stale inventory',
    inventoryTone: 'error',
    mutation: null,
    mutationTone: null,
  });
  assert.deepEqual(bannersAfter(both, { kind: 'mutation', outcome: 'failure', message: 'gagal' }), {
    inventory: 'stale inventory',
    inventoryTone: 'error',
    mutation: 'gagal',
    mutationTone: 'error',
  });
  assert.deepEqual(bannersAfter(both, { kind: 'inventory', ok: true }), {
    inventory: null,
    inventoryTone: null,
    mutation: 'token rejected',
    mutationTone: 'error',
  });
  assert.deepEqual(bannersAfter(both, { kind: 'inventory', ok: false, message: 'outage' }), {
    inventory: 'outage',
    inventoryTone: 'error',
    mutation: 'token rejected',
    mutationTone: 'error',
  });
  assert.deepEqual(bannersAfter(EMPTY_BANNERS, { kind: 'mutation', outcome: 'failure' }), {
    inventory: null,
    inventoryTone: null,
    mutation: 'Permintaan gagal.',
    mutationTone: 'error',
  });
  assert.deepEqual(bannersAfter(EMPTY_BANNERS, { kind: 'inventory', ok: false }), {
    inventory: 'Permintaan gagal.',
    inventoryTone: 'error',
    mutation: null,
    mutationTone: null,
  });
});

test('b2RowKey keeps a react key distinct for two fully identical B2 entries', () => {
  const entry = { configuredName: 'sama', providerAccountId: 'p1', bucketId: 'b1', bucketName: 'x' };
  const keys = [0, 1, 2].map((i) => b2RowKey(entry, i));
  assert.equal(new Set(keys).size, 3, 'position disambiguates identical entries');
  assert.equal(b2RowKey(entry, 1), keys[1], 'the same entry at the same position is stable');
  const other = { configuredName: 'sama', providerAccountId: 'p1', bucketId: 'b2', bucketName: 'x' };
  assert.notEqual(b2RowKey(other, 0), b2RowKey(entry, 0), 'a different bucket id must not collide');
});

test('nonD1SnapshotRows drops the D1 row the live D1 section already owns', () => {
  const current = [
    { db_name: 'd1', rows_or_objects: 900, size_bytes: null },
    { db_name: 'd1:123', rows_or_objects: 12, size_bytes: null },
    { db_name: 'b2:b2-oktz', rows_or_objects: null, size_bytes: 1200 },
    { db_name: 'b2:b2-tzok', rows_or_objects: null, size_bytes: null },
  ];
  assert.deepEqual(nonD1SnapshotRows(current), [
    { db_name: 'b2:b2-oktz', rows_or_objects: null, size_bytes: 1200 },
    { db_name: 'b2:b2-tzok', rows_or_objects: null, size_bytes: null },
  ]);
  assert.deepEqual(nonD1SnapshotRows([{ db_name: '  d1  ', rows_or_objects: 1, size_bytes: null }]), [], 'a padded d1 name is still d1');
  for (const bad of [null, undefined, 42, 'nope', {}]) {
    assert.deepEqual(nonD1SnapshotRows(bad), [], `${JSON.stringify(bad)} must yield no rows`);
  }
});

test('tabIndexFromKey implements arrow, home and end tab navigation', () => {
  assert.equal(tabIndexFromKey(0, 'ArrowRight', 5), 1);
  assert.equal(tabIndexFromKey(4, 'ArrowRight', 5), 0, 'right wraps to the first tab');
  assert.equal(tabIndexFromKey(0, 'ArrowLeft', 5), 4, 'left wraps to the last tab');
  assert.equal(tabIndexFromKey(1, 'ArrowDown', 5), 2);
  assert.equal(tabIndexFromKey(1, 'ArrowUp', 5), 0);
  assert.equal(tabIndexFromKey(3, 'Home', 5), 0);
  assert.equal(tabIndexFromKey(3, 'End', 5), 4);
  assert.equal(tabIndexFromKey(0, 'Home', 1), 0);
  for (const key of ['Enter', ' ', 'a', 'Escape', 'PageUp']) {
    assert.equal(tabIndexFromKey(0, key, 5), null, `${key} must not move the tab focus`);
  }
  assert.equal(tabIndexFromKey(0, 'ArrowRight', 0), null, 'no tabs means no movement');
  assert.equal(tabIndexFromKey(0, 'ArrowRight', -1), null);
});

/* ═══════════════════════════════════════════════════════════════════════
 * Fix round 2 — refresh scheduling, banner tone, draft lifecycle
 * ═══════════════════════════════════════════════════════════════════════ */

const IDLE = { inFlight: false, queued: false };
const BUSY = { inFlight: true, queued: false };
const BUSY_QUEUED = { inFlight: true, queued: true };

test('inventoryUrl only bypasses both cache layers for a real force flag', () => {
  assert.equal(inventoryUrl(false), '/api/admin/inventory');
  assert.equal(inventoryUrl(), '/api/admin/inventory');
  assert.equal(inventoryUrl(undefined), '/api/admin/inventory');
  assert.equal(inventoryUrl(null), '/api/admin/inventory');
  assert.equal(inventoryUrl(0), '/api/admin/inventory');
  assert.equal(inventoryUrl(''), '/api/admin/inventory');
  assert.equal(inventoryUrl('yes'), '/api/admin/inventory', 'only a boolean true forces a refresh');
  assert.equal(inventoryUrl(true), '/api/admin/inventory?refresh=1');
  assert.notEqual(inventoryUrl(true), inventoryUrl(false));
});

test('nextRefreshAfter starts a load when idle and drops a redundant poll when busy', () => {
  assert.deepEqual(nextRefreshAfter(IDLE, false), { slot: BUSY, start: true });
  assert.deepEqual(nextRefreshAfter(IDLE, true), { slot: BUSY, start: true });
  assert.deepEqual(nextRefreshAfter(BUSY, false), { slot: BUSY, start: false }, 'a poll during a load is dropped');
});

test('nextRefreshAfter queues exactly one forced refresh during an in-flight load', () => {
  assert.deepEqual(nextRefreshAfter(BUSY, true), { slot: BUSY_QUEUED, start: false });
  assert.deepEqual(nextRefreshAfter(BUSY_QUEUED, true), { slot: BUSY_QUEUED, start: false }, 'a second force does not stack');
  assert.deepEqual(nextRefreshAfter(BUSY_QUEUED, false), { slot: BUSY_QUEUED, start: false }, 'a poll cannot clear a queued force');
});

test('refreshSettled restarts a queued force and otherwise returns to idle', () => {
  assert.deepEqual(refreshSettled(BUSY), { slot: IDLE, start: false });
  assert.deepEqual(refreshSettled(BUSY_QUEUED), { slot: BUSY, start: true });
  assert.deepEqual(refreshSettled(refreshSettled(BUSY_QUEUED).slot), { slot: IDLE, start: false });
});

test('the refresh state machine never loses a forced refresh and never overlaps a load', () => {
  let slot = IDLE;
  let started = 0;
  const push = (force: boolean) => {
    const decision = nextRefreshAfter(slot, force);
    slot = decision.slot;
    if (decision.start) started++;
    return decision;
  };
  const settle = () => {
    const decision = refreshSettled(slot);
    slot = decision.slot;
    if (decision.start) started++;
    return decision;
  };

  push(false);
  assert.equal(started, 1, 'an idle page starts the poll');
  push(true);
  push(true);
  assert.equal(started, 1, 'both forces arrived while busy and were queued, not run');
  assert.deepEqual(slot, BUSY_QUEUED, 'exactly one force is queued');

  assert.equal(settle().start, true, 'a queued force is honoured when the load settles');
  assert.equal(started, 2, 'the queued force ran exactly once and never concurrently');
  assert.deepEqual(slot, BUSY, 'the replacement load is in flight');

  push(false);
  assert.equal(started, 2, 'a poll during the replacement load is dropped, not queued');

  assert.equal(settle().start, false, 'nothing was queued, so the page goes idle');
  assert.equal(started, 2);
  assert.deepEqual(slot, IDLE);
  assert.equal(settle().start, false, 'settling an idle page is a no-op');
});

test('bannersAfter carries a tone so a partial save is not styled as a failure', () => {
  const failed = bannersAfter({ inventory: null, inventoryTone: null, mutation: null, mutationTone: null }, {
    kind: 'mutation',
    outcome: 'failure',
    message: 'Token ditolak Cloudflare.',
  });
  assert.deepEqual(failed, {
    inventory: null,
    inventoryTone: null,
    mutation: 'Token ditolak Cloudflare.',
    mutationTone: 'error',
  });

  const partial = bannersAfter(failed, {
    kind: 'mutation',
    outcome: 'partial',
    message: 'Akun tersimpan dengan status failed.',
  });
  assert.equal(partial.mutationTone, 'warning', 'a stored-but-unverified account is a warning, not an error');
  assert.equal(partial.inventory, null, 'a mutation still cannot touch the inventory banner');

  const cleared = bannersAfter(partial, { kind: 'mutation', outcome: 'success' });
  assert.equal(cleared.mutation, null);
  assert.equal(cleared.mutationTone, null);
});

test('bannersAfter never lets a mutation event change the inventory banner or its tone', () => {
  const outage = { inventory: 'Inventaris gagal dimuat.', inventoryTone: 'error' as const, mutation: null, mutationTone: null };
  for (const outcome of ['success', 'partial', 'failure'] as const) {
    const next = bannersAfter(outage, { kind: 'mutation', outcome, message: 'x' });
    assert.equal(next.inventory, outage.inventory, `${outcome} must not clear the inventory banner`);
    assert.equal(next.inventoryTone, 'error', `${outcome} must not restyle the inventory banner`);
  }
  const recovered = bannersAfter(outage, { kind: 'inventory', ok: true });
  assert.deepEqual(recovered, { inventory: null, inventoryTone: null, mutation: null, mutationTone: null });
  const refailed = bannersAfter(recovered, { kind: 'inventory', ok: false });
  assert.equal(refailed.inventoryTone, 'error');
  assert.equal(refailed.mutationTone, null, 'an inventory failure cannot invent a mutation banner');
});

test('credentialDraftChanged keeps 409 choices only while the token is unchanged', () => {
  const choices = [{ id: 'acc-1', name: 'Oktz', type: 'standard' }];
  const draft = { token: 'tok-1', accountId: 'acc-1', choices };
  assert.equal(credentialDraftChanged(draft, 'tok-1'), draft, 'an identical token keeps the same object');
  assert.equal(credentialDraftChanged(draft, ' tok-1 ').accountId, 'acc-1', 'a padded token is the same token');
  assert.deepEqual(credentialDraftChanged(draft, 'tok-2'), { token: 'tok-2', accountId: '', choices: [] });
  assert.deepEqual(credentialDraftChanged(draft, ''), { token: '', accountId: '', choices: [] });
  const blank = { token: '   ', accountId: 'acc-9', choices };
  assert.equal(credentialDraftChanged(blank, '   '), blank, 'a blank token compared to a blank token is unchanged');
  assert.deepEqual(credentialDraftChanged(blank, 'tok-3'), { token: 'tok-3', accountId: '', choices: [] });
});

test('originDraftFrom reads a plain getter so the form body is testable without a DOM', () => {
  const fields: Record<string, string> = {
    origin_account_id: 'lb-1',
    origin_url: '  https://a.workers.dev  ',
    priority: '7',
    weight: '3',
  };
  assert.deepEqual(originDraftFrom((name) => fields[name] ?? null), {
    accountId: 'lb-1',
    url: 'https://a.workers.dev',
    priority: 7,
    weight: 3,
  });
  assert.deepEqual(originDraftFrom(() => null), { accountId: '', url: '', priority: 0, weight: 1 });
  for (const bad of ['', ' ', 'x', '-2', 'Infinity', 'NaN', null, undefined]) {
    assert.deepEqual(
      originDraftFrom((name) => (name === 'weight' ? bad : null)),
      { accountId: '', url: '', priority: 0, weight: 1 },
      `weight ${JSON.stringify(bad)} must fall back to 1`
    );
    assert.deepEqual(
      originDraftFrom((name) => (name === 'priority' ? bad : null)),
      { accountId: '', url: '', priority: 0, weight: 1 },
      `priority ${JSON.stringify(bad)} must fall back to 0`
    );
  }
  assert.equal(originDraftFrom((name) => (name === 'priority' ? '-5' : null)).priority, 0, 'a negative priority clamps to 0');
  assert.equal(originDraftFrom((name) => (name === 'weight' ? '0' : null)).weight, 1, 'a zero weight clamps to 1');
  assert.equal(originDraftFrom((name) => (name === 'weight' ? '2.9' : null)).weight, 2, 'a fractional weight truncates');
  assert.equal(originDraftFrom((name) => (name === 'origin_account_id' ? '  lb-9  ' : null)).accountId, 'lb-9', 'the account id is trimmed');
  assert.deepEqual(
    originDraftFrom((name) => (name === 'origin_url' ? 'https://only-url.test' : null)),
    { accountId: '', url: 'https://only-url.test', priority: 0, weight: 1 },
    'a url-only body leaves the account id empty and the numbers at their defaults'
  );
});

test('a raw payload carrying registered is tolerated but never synthesised by the frontend', () => {
  const inv = payload({
    ...inventory(),
    accounts: [
      {
        topologyHash: 'h',
        index: 0,
        url: 'https://a.workers.dev',
        reachable: true,
        lb: { account: { id: 'lb-1', provider: 'cloudflare', label: 'A' }, origins: [] },
      },
    ],
    registrations: [{ account: { id: 'lb-2', label: 'B' }, origin: null, topologyStatus: 'registered' }],
  });
  const view = filterInventory(inv, '');
  assert.equal(
    view.visibleRegistrations[0]?.topologyStatus,
    'registered',
    'the parser keeps a schema-valid value so a server regression does not blank the UI'
  );
  assert.equal(
    lbRowsFromInventory(inv)[0]?.topologyStatus,
    null,
    'the frontend never derives registered; only a pending/unmatched registration carries a status'
  );
});

test('registrations are pending only, so a matched topology row has no topology status', () => {
  const rows = lbRowsFromInventory(lbFixture(), []);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.notEqual(row.topologyStatus, 'registered', 'no row may claim registered: registrations[] never carries it');
  }
  assert.deepEqual(rows.map((r) => r.topologyStatus), [null, null, null, null, 'pending_topology']);
  assert.deepEqual(rows.slice(0, 4).map((r) => r.topologyUrl).every((url) => url !== null), true, 'credential rows still render the topology url');
  assert.deepEqual(rows.slice(0, 4).map((r) => r.topologyIndex), [0, 1, 2, 3]);
});

test('lbRowsFromInventory accepts no usage so a page that does not fetch it does not compute it', () => {
  const withoutUsage = lbRowsFromInventory(lbFixture());
  assert.equal(withoutUsage.length, 5);
  assert.deepEqual(withoutUsage.map((r) => r.requestsToday), [0, 0, 0, 0, 0]);
  const withUsage = lbRowsFromInventory(
    lbFixture(),
    [{ origin_url: 'https://a.workers.dev', req_count: 5 }]
  );
  assert.equal(withUsage[0]?.requestsToday, 5, 'Dashboard behaviour is unchanged when usage is supplied');
});

test('InventoryLbRow origins keep lastCheckedAt for the health timestamp', () => {
  const rows = lbRowsFromInventory(
    inventory({
      accounts: [
        account({
          index: 0,
          url: 'https://a.workers.dev',
          lbAccount: lbMeta({ id: 'lb-1' }),
          origins: [originMeta({ id: 'o1', url: 'https://a.workers.dev', health: 'healthy', checkedAt: 4242 })],
        }),
      ],
    }),
    []
  );
  assert.equal(rows[0]?.origins[0]?.lastCheckedAt, 4242);
  assert.equal(rows[0]?.origins[0]?.lastHealthStatus, 'healthy');
});

test('requestsToday falls back to the topology url when the account has no D1 origin', () => {
  const rows = lbRowsFromInventory(
    inventory({
      accounts: [
        account({ index: 0, url: 'https://a.workers.dev', name: 'Oktz', lbAccount: lbMeta({ id: 'lb-1' }) }),
        account({ index: 1, url: 'https://b.workers.dev', name: 'Tzok' }),
      ],
    }),
    [
      { origin_url: 'https://a.workers.dev', req_count: 4 },
      { origin_url: 'https://b.workers.dev', req_count: 2 },
    ]
  );
  assert.equal(rows[0]?.requestsToday, 4, 'a peer without an lb_origin row is counted by its topology url');
  assert.equal(rows[1]?.requestsToday, 2, 'a topology row with no LB metadata is counted too');
});

test('requestsToday sums the D1 origins and never double counts the topology url', () => {
  const rows = lbRowsFromInventory(
    inventory({
      accounts: [
        account({
          index: 0,
          url: 'https://a.workers.dev',
          lbAccount: lbMeta({ id: 'lb-1' }),
          origins: [
            originMeta({ id: 'o1', url: 'https://a.workers.dev' }),
            originMeta({ id: 'o2', url: 'https://z.workers.dev' }),
          ],
        }),
      ],
    }),
    [
      { origin_url: 'https://a.workers.dev', req_count: 7 },
      { origin_url: 'https://z.workers.dev', req_count: 3 },
    ]
  );
  assert.equal(rows[0]?.requestsToday, 10, 'origins are summed once, not added to the topology url again');
});

test('localFieldLabel names the local source in text, not by colour', () => {
  assert.equal(localFieldLabel('Series'), 'Series · lokal');
  assert.equal(localFieldLabel('Halaman'), 'Halaman · lokal');
  assert.equal(localFieldLabel('Byte operasional'), 'Byte operasional · lokal');
  assert.ok(localFieldLabel('Bookmark').includes(formatSource('local')));
  assert.equal(formatSource('local'), 'lokal');
});
