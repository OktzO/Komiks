import { Hono } from 'hono';
import type { Db } from '@manga-platform/db';
import {
  AdminInventorySchema,
  InventoryRegistrationSchema,
  PeerInventorySchema,
  type AdminInventory,
  type InventoryB2Account,
  type InventoryRegistration,
  type InventoryWarning,
  type PeerInventory,
  type ResourceState,
} from '@manga-platform/shared/types';
import type { Context, Env } from '../../lib/context';
import { json, getDb } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';
import { rateLimitAdmin } from '../../lib/rateLimit';
import { collectB2Inventory, collectPeerInventory, getB2UsageSnapshot } from '../../lib/adminInventory';
import { fetchPeerInventory, getTopology, peerUrlOrigin, type PeerFetchResult, type PeerInfo, type TopologySnapshot } from '../../lib/peers';

const CACHE_FRESH_MS = 300_000;
const CACHE_TTL_SECONDS = 3600;
const PEER_FANOUT_CONCURRENCY = 4;
const UNREACHABLE_MESSAGE = 'Peer inventory unavailable';
const SELF_ERROR_CODE = 'SELF_COLLECT_FAILED';
const SELF_SCHEMA_CODE = 'SELF_SCHEMA_INVALID';
const PEER_SCHEMA_CODE = 'PEER_SCHEMA_INVALID';
const SCHEMA_INVALID_MESSAGE = 'Peer inventory payload invalid';
const SELF_NOT_CONFIGURED_CODE = 'SELF_NOT_CONFIGURED';
const SELF_NOT_CONFIGURED_MESSAGE = 'Topology has no self peer';
const FALLBACK_PEER_ERROR_CODE = 'PEER_UNREACHABLE';
const SELF_FLAG_MISMATCH_CODE = 'SELF_FLAG_MISMATCH';
const SELF_FLAG_MISMATCH_MESSAGE = 'Peer self flag mismatch';
const B2_ERROR_CODE = 'B2_INVENTORY_UNAVAILABLE';
const B2_ERROR_MESSAGE = 'B2 inventory unavailable';
const LB_ERROR_CODE = 'LB_REGISTRY_UNAVAILABLE';
const LB_ERROR_MESSAGE = 'Load balancing registry unavailable';

type InventoryRow = AdminInventory['accounts'][number];

export interface InventoryDeps {
  fetchPeer?: (env: Env, peer: PeerInfo, refresh: boolean) => Promise<PeerFetchResult>;
  collectSelf?: () => Promise<PeerInventory>;
  collectB2?: () => Promise<{ accounts: InventoryB2Account[]; warnings: InventoryWarning[] }>;
  readCache?: (key: string) => Promise<unknown>;
  writeCache?: (key: string, snapshot: AdminInventory) => Promise<void>;
}

const settle = async <T>(operation: () => Promise<T>): Promise<PromiseSettledResult<T>> => {
  try {
    return { status: 'fulfilled', value: await operation() };
  } catch (reason: unknown) {
    return { status: 'rejected', reason };
  }
};

const mapConcurrent = async <T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

const envText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

const emptyCounts = (): InventoryRow['d1']['counts'] => ({
  series: null,
  chapters: null,
  chapterPages: null,
  users: null,
  bookmarks: null,
});

const unavailableState = (code: string, now: number): ResourceState => ({
  status: 'unavailable',
  source: 'unavailable',
  observedAt: now,
  errorCode: code,
});

const rowFromPeer = (peer: PeerInfo, data: PeerInventory): InventoryRow => ({
  topologyHash: data.topologyHash,
  index: peer.index,
  url: peer.url,
  self: peer.self,
  reachable: true,
  account: data.account,
  worker: data.worker,
  d1: data.d1,
  kv: data.kv,
  lb: data.lb,
});

const unreachableRow = (
  peer: PeerInfo,
  env: Env,
  topologyHash: string,
  code: string,
  now: number
): InventoryRow => {
  return {
    topologyHash,
    index: peer.index,
    url: peer.url,
    self: peer.self,
    reachable: false,
    account: { id: null, name: null, type: null, state: unavailableState(code, now) },
    worker: {
      name: peer.self ? envText(env.CF_WORKER_NAME) : null,
      createdAt: null,
      modifiedAt: null,
      state: unavailableState(code, now),
    },
    d1: {
      id: peer.self ? envText(env.CF_D1_ID) : null,
      name: null,
      fileBytes: null,
      jurisdiction: null,
      region: null,
      counts: emptyCounts(),
      state: unavailableState(code, now),
    },
    kv: {
      id: peer.self ? envText(env.CF_KV_ID) : null,
      title: null,
      jurisdiction: null,
      keyCount: null,
      byteCount: null,
      operationalD1Bytes: null,
      state: unavailableState(code, now),
    },
    lb: { account: null, origins: [] },
  };
};

const dedupeWarnings = (warnings: InventoryWarning[]): InventoryWarning[] => {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = JSON.stringify([warning.code, warning.peerUrl]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const cacheMatchesTopology = (cached: AdminInventory, topology: TopologySnapshot): boolean => {
  if (cached.topology.source !== 'PEER_URLS') return false;
  if (cached.topology.hash !== topology.hash) return false;
  if (cached.topology.count !== topology.count) return false;
  if (cached.accounts.length !== topology.peers.length) return false;
  return cached.accounts.every((row, position) => {
    const peer = topology.peers[position];
    return row.index === peer.index && row.url === peer.url && row.self === peer.self;
  });
};

export const buildRegistrations = (
  rows: InventoryRow[],
  localAccounts: unknown[],
  localOrigins: unknown[]
): InventoryRegistration[] => {
  const accountSchema = InventoryRegistrationSchema.shape.account;
  const originSchema = InventoryRegistrationSchema.shape.origin;
  const topologyAccountIds = new Set<string>();
  const topologyOrigins = new Set<string>();
  const unreachableTopologyOrigins = new Set<string>();
  const accounts = new Map<string, InventoryRegistration['account']>();
  const originByAccount = new Map<string, NonNullable<InventoryRegistration['origin']>>();

  const rememberOrigin = (value: unknown): void => {
    const parsed = originSchema.safeParse(value);
    if (!parsed.success || !parsed.data) return;
    const accountId = parsed.data.account_id;
    if (accountId === null || accountId === undefined) return;
    if (originByAccount.has(accountId)) return;
    originByAccount.set(accountId, parsed.data);
  };
  const rememberAccount = (value: unknown): void => {
    const parsed = accountSchema.safeParse(value);
    if (parsed.success) accounts.set(parsed.data.id, parsed.data);
  };

  for (const row of rows) {
    const origin = peerUrlOrigin(row.url);
    if (origin !== null) topologyOrigins.add(origin);
    if (row.account.id !== null) topologyAccountIds.add(row.account.id);
    if (!row.reachable) {
      if (origin !== null) unreachableTopologyOrigins.add(origin);
      continue;
    }
    for (const rowOrigin of row.lb.origins) rememberOrigin(rowOrigin);
    rememberAccount(row.lb.account);
  }
  for (const localOrigin of localOrigins) rememberOrigin(localOrigin);
  for (const localAccount of localAccounts) rememberAccount(localAccount);

  const registrations: InventoryRegistration[] = [];
  for (const account of accounts.values()) {
    const origin = originByAccount.get(account.id) ?? null;
    const matchedAccount = account.account_ref != null && topologyAccountIds.has(account.account_ref);
    const originTarget = origin === null ? null : peerUrlOrigin(origin.origin_url);
    const matchedOrigin = originTarget !== null && topologyOrigins.has(originTarget);
    const ownerUnreachable = originTarget !== null && unreachableTopologyOrigins.has(originTarget);
    const topologyStatus: InventoryRegistration['topologyStatus'] =
      matchedOrigin && (matchedAccount || ownerUnreachable) ? 'registered' : 'pending_topology';
    if (topologyStatus === 'registered') continue;
    registrations.push({ account, origin, topologyStatus });
  }
  return registrations;
};

export const buildAdminInventory = async (
  env: Env,
  db: Db,
  refresh: boolean,
  deps: InventoryDeps = {}
): Promise<AdminInventory> => {
  const topology = getTopology(env);
  const now = Date.now();
  const cacheKey = `admin:inventory:v2:${topology.hash}`;

  const readCache = deps.readCache ?? (async (key: string): Promise<unknown> => {
    try {
      return await env.CACHE_KV.get(key, 'json');
    } catch {
      return null;
    }
  });
  const writeCache = deps.writeCache ?? (async (key: string, snapshot: AdminInventory): Promise<void> => {
    try {
      await env.CACHE_KV.put(key, JSON.stringify(snapshot), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {}
  });
  const collectSelf = deps.collectSelf ?? (() => collectPeerInventory(env, db));
  const collectB2 = deps.collectB2 ?? (() => collectB2Inventory(env, (name, index) => getB2UsageSnapshot(env, name, index), now));
  const fetchPeer = deps.fetchPeer ?? ((target, peer, bypass) => fetchPeerInventory(target, peer, bypass));

  const cachedRaw = await settle(() => readCache(cacheKey));
  const cachedValue = cachedRaw.status === 'fulfilled' ? cachedRaw.value : null;
  const cachedParse = cachedValue === null ? null : AdminInventorySchema.safeParse(cachedValue);
  const cached: AdminInventory | null = cachedParse !== null && cachedParse.success &&
    cacheMatchesTopology(cachedParse.data, topology) ? cachedParse.data : null;
  if (!refresh && cached !== null && now - cached.observedAt < CACHE_FRESH_MS) return cached;

  const selfPeer = topology.peers.find((peer) => peer.self) ?? null;
  const remotePeers = topology.peers.filter((peer) => !peer.self);

  const [selfResult, peerResults, b2Result, accountsResult, originsResult] = await Promise.all([
    selfPeer === null ? Promise.resolve(null) : settle(() => collectSelf()),
    mapConcurrent(remotePeers, PEER_FANOUT_CONCURRENCY, (peer) => settle(() => fetchPeer(env, peer, refresh))),
    settle(() => collectB2()),
    settle(() => db.listAccounts()),
    settle(() => db.listOrigins()),
  ]);

  const rowByIndex = new Map<number, InventoryRow>();
  const warnings: InventoryWarning[] = [];
  let selfFlagMismatch = false;

  const fail = (peer: PeerInfo, code: string, message = UNREACHABLE_MESSAGE): void => {
    rowByIndex.set(peer.index, unreachableRow(peer, env, topology.hash, code, now));
    warnings.push({ code, peerUrl: peer.url, message, observedAt: now });
  };
  const accept = (peer: PeerInfo, data: unknown, schemaCode: string): void => {
    const parsed = PeerInventorySchema.safeParse(data);
    if (!parsed.success) {
      fail(peer, schemaCode, SCHEMA_INVALID_MESSAGE);
      return;
    }
    rowByIndex.set(peer.index, rowFromPeer(peer, parsed.data));
    if (!parsed.data.self) {
      selfFlagMismatch = true;
      warnings.push({ code: SELF_FLAG_MISMATCH_CODE, peerUrl: peer.url, message: SELF_FLAG_MISMATCH_MESSAGE, observedAt: now });
    }
  };

  if (selfPeer !== null) {
    if (selfResult !== null && selfResult.status === 'fulfilled') {
      accept(selfPeer, selfResult.value, SELF_SCHEMA_CODE);
    } else {
      fail(selfPeer, SELF_ERROR_CODE);
    }
  }
  peerResults.forEach((result, position) => {
    const peer = remotePeers[position];
    if (result.status === 'rejected') fail(peer, FALLBACK_PEER_ERROR_CODE);
    else if (result.value.ok) accept(peer, result.value.data, PEER_SCHEMA_CODE);
    else fail(peer, result.value.errorCode);
  });

  const missingSelf = topology.count > 0 && selfPeer === null;
  if (missingSelf) {
    warnings.push({ code: SELF_NOT_CONFIGURED_CODE, peerUrl: null, message: SELF_NOT_CONFIGURED_MESSAGE, observedAt: now });
  }

  const rows = topology.peers.map((peer) => rowByIndex.get(peer.index) as InventoryRow);
  const reachable = rows.filter((row) => row.reachable);
  const hashMismatch = reachable.some((row) => row.topologyHash !== topology.hash);

  let b2: InventoryB2Account[] = [];
  if (b2Result.status === 'fulfilled') {
    b2 = b2Result.value.accounts;
    warnings.push(...b2Result.value.warnings);
  } else {
    warnings.push({ code: B2_ERROR_CODE, peerUrl: null, message: B2_ERROR_MESSAGE, observedAt: now });
  }

  const lbUnavailable = accountsResult.status === 'rejected' || originsResult.status === 'rejected';
  if (lbUnavailable) {
    warnings.push({ code: LB_ERROR_CODE, peerUrl: null, message: LB_ERROR_MESSAGE, observedAt: now });
  }

  const incomplete = reachable.length < topology.count || b2Result.status === 'rejected' || lbUnavailable;
  const inconsistent = selfFlagMismatch || missingSelf || hashMismatch;
  if (incomplete && !inconsistent && cached !== null) {
    return { ...cached, stale: true, warnings: dedupeWarnings([...cached.warnings, ...warnings]) };
  }

  const snapshot: AdminInventory = {
    observedAt: now,
    stale: false,
    topology: {
      source: 'PEER_URLS',
      count: topology.count,
      hash: topology.hash,
      consistent: !inconsistent,
    },
    accounts: rows,
    registrations: buildRegistrations(
      rows,
      accountsResult.status === 'fulfilled' ? accountsResult.value : [],
      originsResult.status === 'fulfilled' ? originsResult.value : []
    ),
    b2,
    warnings: dedupeWarnings(warnings),
  };
  if (!incomplete && !inconsistent) await writeCache(cacheKey, snapshot);
  return snapshot;
};

export const router = new Hono<{ Bindings: Env }>();

router.use('/inventory', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});
router.use('/inventory', rateLimitAdmin);
router.use('/inventory', requireAdminSession);
router.use('/inventory', async (c, next) => {
  const entries: [string, string][] = [];
  new URL(c.req.url).searchParams.forEach((value, key) => entries.push([key, value]));
  if (entries.length > 1 || entries.some(([key, value]) => key !== 'refresh' || value !== '1')) {
    return json(c, { error: 'invalid query' }, 400);
  }
  return next();
});

router.get('/inventory', async (c: Context) => {
  const refresh = new URL(c.req.url).searchParams.get('refresh') === '1';
  const data = await buildAdminInventory(c.env, getDb(c), refresh);
  return json(c, { data });
});
