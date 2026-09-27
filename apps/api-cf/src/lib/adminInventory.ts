import type { Db } from '@manga-platform/db';
import type {
  InventoryB2Account,
  InventoryWarning,
  LbOrigin,
  PeerInventory,
  ResourceState,
} from '@manga-platform/shared/types';
import { getTopology } from './peers';
import { resolveB2Accounts, type B2Account } from './b2Config';
import { DEFAULT_QUOTA_BYTES, getB2UsageSnapshot, quotaBytes } from './b2Usage';
import type { Env } from './context';

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_TIMEOUT_MS = 5000;
const B2_PROVIDER_CONCURRENCY = 4;
const B2_AUTH_URL = 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account';
const KV_QUERY = `query KvInventory($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      kvStorageAdaptiveGroups(
        filter: { namespaceId: $namespaceId, date_geq: $start, date_leq: $end }
        limit: 1
        orderBy: [date_DESC]
      ) { max { keyCount byteCount } dimensions { date } }
    } }
  }`;

type RecordValue = Record<string, unknown>;
type ProviderResult = PromiseSettledResult<unknown>;
export type B2UsageReader = (
  name: string,
  index: number
) => Promise<{ bytes: number | null; updatedAt: number | null }>;

class ProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;

const strictInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

const optionalText = (value: unknown): string | null | undefined =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const optionalInteger = (value: unknown): number | null | undefined =>
  value === undefined || value === null
    ? null
    : typeof value === 'number' && Number.isInteger(value) ? value : undefined;

const errorCode = (error: unknown, prefix: string): string => {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return `${prefix}_TIMEOUT`;
  if (error instanceof TypeError) return `${prefix}_NETWORK_ERROR`;
  return `${prefix}_ERROR`;
};

const request = async (
  url: string,
  init: RequestInit,
  prefix: string
): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(CF_TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderError(errorCode(error, prefix));
  }
};

const parseJson = async (res: Response, prefix: string): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    throw new ProviderError(`${prefix}_INVALID_RESPONSE`);
  }
};

const cfJson = async <T>(token: string, path: string, init: RequestInit = {}): Promise<T> => {
  const res = await request(`${CF_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, 'CF');
  if (!res.ok) throw new ProviderError(`CF_HTTP_${res.status}`);
  const body = await parseJson(res, 'CF');
  if (!isRecord(body) || body.success !== true || !('result' in body)) {
    throw new ProviderError('CF_PROVIDER_ERROR');
  }
  return body.result as T;
};

const cfGraphql = async (token: string, body: RecordValue): Promise<unknown> => {
  const res = await request(`${CF_API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'CF');
  if (!res.ok) throw new ProviderError(`CF_HTTP_${res.status}`);
  const parsed = await parseJson(res, 'CF');
  const hasErrors = isRecord(parsed)
    && parsed.errors !== undefined
    && parsed.errors !== null
    && (!Array.isArray(parsed.errors) || parsed.errors.length > 0);
  if (!isRecord(parsed) || hasErrors || !('data' in parsed)) {
    throw new ProviderError('CF_PROVIDER_ERROR');
  }
  return parsed.data;
};

const derivedName = (url: string, kind: 'account' | 'worker'): string | null => {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.').filter(Boolean);
    if (labels.length < 2) return null;
    if (kind === 'worker') return labels[0] ?? null;
    if (labels.length >= 3 && labels.slice(-2).join('.') === 'workers.dev') {
      return labels[labels.length - 3] ?? null;
    }
    return labels[labels.length - 2] ?? labels[0] ?? null;
  } catch {
    return null;
  }
};

const resourceState = (
  status: ResourceState['status'],
  source: ResourceState['source'],
  observedAt: number,
  error: string | null = null
): ResourceState => ({ status, source, observedAt, errorCode: error });

const safeAccount = (value: unknown): NonNullable<PeerInventory['lb']['account']> | null => {
  if (!isRecord(value) || text(value.id) === null || text(value.provider) === null) return null;
  if (value.provider !== 'cloudflare' && value.provider !== 'vercel') return null;
  if (text(value.label) === null) return null;
  const status = value.status;
  if (status !== 'verified' && status !== 'unverified' && status !== 'failed') return null;
  return {
    id: value.id as string,
    provider: value.provider,
    label: value.label as string,
    account_ref: text(value.account_ref),
    status,
    last_tested_at: integer(value.last_tested_at),
    created_at: integer(value.created_at) ?? undefined,
  };
};

const safeOrigin = (value: unknown): LbOrigin | null => {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const originUrl = text(value.origin_url);
  const priority = strictInteger(value.priority);
  const weight = strictInteger(value.weight);
  const enabled = strictInteger(value.enabled);
  if (!id || !originUrl || priority === null || weight === null || weight <= 0 || enabled === null || (enabled !== 0 && enabled !== 1)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const accountId = optionalText(value.account_id);
  const healthStatus = optionalText(value.last_health_status);
  const lastCheckedAt = optionalInteger(value.last_checked_at);
  const createdAt = optionalInteger(value.created_at);
  if (accountId === undefined || healthStatus === undefined || lastCheckedAt === undefined || createdAt === undefined) return null;
  return {
    id,
    account_id: accountId,
    origin_url: originUrl,
    priority,
    weight,
    enabled,
    last_health_status: healthStatus,
    last_checked_at: lastCheckedAt,
    created_at: createdAt ?? undefined,
  };
};

const countsValue = (value: unknown): PeerInventory['d1']['counts'] => {
  if (!isRecord(value)) return {
    series: null,
    chapters: null,
    chapterPages: null,
    users: null,
    bookmarks: null,
  };
  return {
    series: integer(value.series),
    chapters: integer(value.chapters),
    chapterPages: integer(value.chapterPages),
    users: integer(value.users),
    bookmarks: integer(value.bookmarks),
  };
};

const kvUsage = (value: unknown): number | null => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isRecord(value) ? integer(value.bytes) : null;
};

const settle = <T>(operation: () => Promise<T>): Promise<T> => Promise.resolve().then(operation);

const settledError = (result: ProviderResult, prefix: string): string | null =>
  result.status === 'rejected' ? errorCode(result.reason, prefix) : null;

const providerAccount = (value: unknown, id: string): RecordValue | null => {
  if (!isRecord(value) || text(value.id) !== id) return null;
  return text(value.name) !== null && text(value.type) !== null ? value : null;
};

const providerWorker = (value: unknown, name: string): RecordValue | null => {
  if (!Array.isArray(value)) return null;
  const row = value.find((item) => isRecord(item) && text(item.id) === name);
  return isRecord(row) ? row : null;
};

const providerDatabase = (value: unknown, id: string): RecordValue | null => {
  if (!isRecord(value) || text(value.uuid) !== id || text(value.name) === null) return null;
  return value;
};

const providerNamespace = (value: unknown, id: string): RecordValue | null => {
  if (!Array.isArray(value)) return null;
  const row = value.find((item) => isRecord(item) && text(item.id) === id && text(item.title) !== null);
  return isRecord(row) ? row : null;
};

type KvMetrics = { keyCount: number | null; byteCount: number | null; observedAt: number | null };

const providerMetrics = (value: unknown): KvMetrics | null => {
  if (!isRecord(value) || !isRecord(value.viewer)) return null;
  const accounts = value.viewer.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return { keyCount: null, byteCount: null, observedAt: null };
  const account = accounts.find(isRecord);
  if (!account) return { keyCount: null, byteCount: null, observedAt: null };
  if (!Array.isArray(account.kvStorageAdaptiveGroups) || account.kvStorageAdaptiveGroups.length === 0) {
    return { keyCount: null, byteCount: null, observedAt: null };
  }
  const group = account.kvStorageAdaptiveGroups[0];
  if (group === undefined) return { keyCount: null, byteCount: null, observedAt: null };
  if (!isRecord(group) || !isRecord(group.max)) return null;
  const max = group.max;
  const dimension = Array.isArray(group.dimensions) ? group.dimensions[0] : undefined;
  const date = isRecord(dimension) ? text(dimension.date) : null;
  const parsedDate = date ? Date.parse(date) : NaN;
  return {
    keyCount: integer(max.keyCount),
    byteCount: integer(max.byteCount),
    observedAt: Number.isFinite(parsedDate) ? parsedDate : null,
  };
};

const providerState = (
  result: ProviderResult,
  fallbackSource: ResourceState['source'],
  fallbackStatus: ResourceState['status'],
  now: number,
  prefix: string,
  invalidCode: string,
  valid: boolean
): ResourceState => {
  if (result.status === 'fulfilled' && valid) return resourceState('ok', 'live', now);
  const code = result.status === 'rejected'
    ? errorCode(result.reason, prefix)
    : invalidCode;
  return resourceState(fallbackStatus, fallbackSource, now, code);
};

export const collectPeerInventory = async (env: Env, db: Db): Promise<PeerInventory> => {
  const now = Math.floor(Date.now());
  const topology = getTopology(env);
  const selfPeer = topology.peers.find((peer) => peer.self) ?? null;
  const selfUrl = selfPeer?.url ?? '';
  const fallbackAccountName = derivedName(selfUrl, 'account');
  const fallbackWorkerName = text(env.CF_WORKER_NAME) ?? derivedName(selfUrl, 'worker');
  const accountId = text(env.CF_ACCOUNT_ID);
  const d1Id = text(env.CF_D1_ID);
  const kvId = text(env.CF_KV_ID);
  const token = text(env.CF_INVENTORY_TOKEN);

  const local = await Promise.allSettled([
    settle(() => db.getInventoryCounts()),
    settle(() => db.listAccounts()),
    settle(() => db.listOrigins()),
    settle(() => env.CACHE_KV.get('d1:usage', 'json')),
  ]);
  const countsResult = local[0] as PromiseSettledResult<unknown>;
  const accountsResult = local[1] as PromiseSettledResult<unknown>;
  const originsResult = local[2] as PromiseSettledResult<unknown>;
  const usageResult = local[3] as PromiseSettledResult<unknown>;
  const counts = countsResult.status === 'fulfilled' ? countsValue(countsResult.value) : countsValue(null);
  const localAccounts = accountsResult.status === 'fulfilled' && Array.isArray(accountsResult.value)
    ? accountsResult.value.map(safeAccount).filter((row): row is NonNullable<typeof row> => row !== null)
    : [];
  const origins = originsResult.status === 'fulfilled' && Array.isArray(originsResult.value)
    ? originsResult.value.map(safeOrigin).filter((row): row is LbOrigin => row !== null)
    : [];
  const operationalD1Bytes = usageResult.status === 'fulfilled' ? kvUsage(usageResult.value) : null;

  const selfOrigin = origins.find((origin) => {
    try {
      return new URL(origin.origin_url).origin === new URL(selfUrl).origin;
    } catch {
      return false;
    }
  });
  const localAccount = localAccounts.find((account) =>
    (selfOrigin?.account_id && account.id === selfOrigin.account_id) ||
    (accountId !== null && account.account_ref === accountId)
  ) ?? null;

  let accountResult: ProviderResult = { status: 'rejected', reason: new ProviderError('CF_CONFIG_MISSING') };
  let workerResult: ProviderResult = { status: 'rejected', reason: new ProviderError('CF_CONFIG_MISSING') };
  let d1Result: ProviderResult = { status: 'rejected', reason: new ProviderError('CF_CONFIG_MISSING') };
  let kvResult: ProviderResult = { status: 'rejected', reason: new ProviderError('CF_CONFIG_MISSING') };
  let metricsResult: ProviderResult = { status: 'rejected', reason: new ProviderError('CF_CONFIG_MISSING') };

  if (token && accountId) {
    const end = new Date(now);
    const start = new Date(end.getTime() - 31 * 86400_000);
    const graphqlBody = {
      query: KV_QUERY,
      variables: {
        accountTag: accountId,
        namespaceId: kvId,
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      },
    };
    const accountPromise = cfJson(token, `/accounts/${encodeURIComponent(accountId)}`, { method: 'GET' });
    const workerPromise = fallbackWorkerName
      ? cfJson(token, `/accounts/${encodeURIComponent(accountId)}/workers/scripts`, { method: 'GET' })
      : Promise.reject(new ProviderError('CF_CONFIG_MISSING'));
    const databasePromise = d1Id
      ? cfJson(token, `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(d1Id)}`, { method: 'GET' })
      : Promise.reject(new ProviderError('CF_CONFIG_MISSING'));
    const namespacePromise = kvId
      ? cfJson(token, `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`, { method: 'GET' })
      : Promise.reject(new ProviderError('CF_CONFIG_MISSING'));
    const metricsPromise = kvId
      ? cfGraphql(token, graphqlBody)
      : Promise.reject(new ProviderError('CF_CONFIG_MISSING'));
    [accountResult, workerResult, d1Result, kvResult, metricsResult] = await Promise.allSettled([
      accountPromise,
      workerPromise,
      databasePromise,
      namespacePromise,
      metricsPromise,
    ]);
  }

  const accountData = accountResult.status === 'fulfilled' ? providerAccount(accountResult.value, accountId ?? '') : null;
  const accountValid = accountData !== null;
  const workerData = workerResult.status === 'fulfilled' ? providerWorker(workerResult.value, fallbackWorkerName ?? '') : null;
  const workerValid = workerData !== null;
  const d1Data = d1Result.status === 'fulfilled' ? providerDatabase(d1Result.value, d1Id ?? '') : null;
  const d1Valid = d1Data !== null;
  const kvData = kvResult.status === 'fulfilled' ? providerNamespace(kvResult.value, kvId ?? '') : null;
  const kvValid = kvData !== null;
  const metricsData = metricsResult.status === 'fulfilled' ? providerMetrics(metricsResult.value) : null;
  const metricsValid = metricsData !== null;

  const accountState = providerState(
    accountResult,
    'derived',
    'degraded',
    now,
    'CF',
    'CF_ACCOUNT_INVALID',
    accountValid,
  );
  const workerState = providerState(
    workerResult,
    'derived',
    'degraded',
    now,
    'CF',
    'CF_WORKER_INVALID',
    workerValid,
  );
  const providerRequested = token !== null;
  const providerMissingConfig = providerRequested && accountId === null;
  const hasProviderConfig = providerRequested && accountId !== null;
  const d1LocalCode = settledError(countsResult, 'DB');
  const d1ProviderCode = hasProviderConfig
    ? d1Result.status === 'rejected' ? settledError(d1Result, 'CF') : d1Valid ? null : 'CF_D1_INVALID'
    : providerMissingConfig ? 'CF_CONFIG_MISSING' : null;
  const d1State = providerMissingConfig
    ? countsResult.status === 'fulfilled'
      ? resourceState('degraded', 'local', now, d1ProviderCode)
      : resourceState('unavailable', 'unavailable', now, d1LocalCode ?? 'DB_INVENTORY_COUNTS')
    : d1Valid
      ? resourceState(d1LocalCode ? 'degraded' : 'ok', 'live', now, d1LocalCode)
      : countsResult.status === 'fulfilled'
        ? resourceState(hasProviderConfig ? 'degraded' : 'ok', 'local', now, d1ProviderCode)
        : resourceState('unavailable', 'unavailable', now, d1LocalCode ?? 'DB_INVENTORY_COUNTS');
  const kvUsageAvailable = usageResult.status === 'fulfilled' && operationalD1Bytes !== null;
  const kvUsageCode = kvUsageAvailable ? null : settledError(usageResult, 'KV') ?? 'KV_USAGE_UNAVAILABLE';
  const kvObservedAt = metricsData?.observedAt ?? now;
  const kvProviderCode = hasProviderConfig
    ? kvResult.status === 'rejected' ? settledError(kvResult, 'CF') : kvValid ? null : 'CF_KV_INVALID'
    : providerMissingConfig ? 'CF_CONFIG_MISSING' : null;
  const kvState = providerMissingConfig
    ? kvUsageAvailable
      ? resourceState('degraded', 'local', now, kvProviderCode)
      : resourceState('unavailable', 'unavailable', now, kvUsageCode)
    : !hasProviderConfig
      ? resourceState(kvUsageAvailable ? 'ok' : 'degraded', 'local', now, kvUsageCode)
      : !kvValid
        ? resourceState('unavailable', 'unavailable', now, kvProviderCode ?? 'CF_KV_UNAVAILABLE')
        : !metricsValid
          ? resourceState('degraded', 'live', kvObservedAt, settledError(metricsResult, 'CF') ?? 'CF_KV_METRICS_INVALID')
          : kvUsageAvailable
            ? resourceState('ok', 'live', kvObservedAt, null)
            : resourceState('degraded', 'live', kvObservedAt, kvUsageCode);
  const liveMetrics = kvValid && metricsValid ? metricsData : null;

  return {
    topologyHash: topology.hash,
    self: selfPeer !== null,
    account: {
      id: accountId,
      name: accountValid ? text(accountData?.name) : fallbackAccountName,
      type: accountValid ? text(accountData?.type) : null,
      state: token && accountId
        ? accountState
        : token
          ? resourceState('degraded', 'derived', now, 'CF_CONFIG_MISSING')
          : resourceState('ok', 'derived', now),
    },
    worker: {
      name: fallbackWorkerName,
      createdAt: workerValid ? text(workerData?.created_on) : null,
      modifiedAt: workerValid ? text(workerData?.modified_on) : null,
      state: token && accountId
        ? workerState
        : token
          ? resourceState('degraded', 'derived', now, 'CF_CONFIG_MISSING')
          : resourceState('ok', 'derived', now),
    },
    d1: {
      id: d1Id,
      name: d1Valid ? text(d1Data?.name) : null,
      fileBytes: d1Valid ? integer(d1Data?.file_size) : null,
      jurisdiction: d1Valid ? text(d1Data?.jurisdiction) : null,
      region: d1Valid ? text(d1Data?.running_in_region) : null,
      counts,
      state: d1State,
    },
    kv: {
      id: kvId,
      title: kvValid ? text(kvData?.title) : null,
      jurisdiction: kvValid ? text(kvData?.jurisdiction) : null,
      keyCount: liveMetrics?.keyCount ?? null,
      byteCount: liveMetrics?.byteCount ?? null,
      operationalD1Bytes,
      state: kvState,
    },
    lb: {
      account: localAccount,
      origins,
    },
  };
};

const b2Response = async (res: Response, prefix: string): Promise<RecordValue> => {
  if (!res.ok) throw new ProviderError(`${prefix}_HTTP_${res.status}`);
  const body = await parseJson(res, prefix);
  if (!isRecord(body)) throw new ProviderError(`${prefix}_PROVIDER_ERROR`);
  return body;
};

const b2Auth = async (account: B2Account): Promise<{ accountId: string; apiUrl: string; token: string }> => {
  let encoded: string;
  try {
    encoded = btoa(`${account.keyId}:${account.appKey}`);
  } catch {
    throw new ProviderError('B2_AUTH_ERROR');
  }
  const res = await request(B2_AUTH_URL, {
    method: 'GET',
    headers: { Authorization: `Basic ${encoded}` },
  }, 'B2');
  const body = await b2Response(res, 'B2');
  const accountId = text(body.accountId);
  const authorizationToken = text(body.authorizationToken);
  const apiUrl = text(body.apiUrl) ?? (
    isRecord(body.apiInfo) && isRecord(body.apiInfo.storageApi) ? text(body.apiInfo.storageApi.apiUrl) : null
  );
  if (!accountId || !authorizationToken || !apiUrl) throw new ProviderError('B2_AUTH_INVALID');
  try {
    const parsed = new URL(apiUrl);
    const hostname = parsed.hostname.toLowerCase();
    const b2Host = hostname === 'backblazeb2.com' || hostname.endsWith('.backblazeb2.com');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !b2Host) {
      throw new Error('invalid api url');
    }
  } catch {
    throw new ProviderError('B2_AUTH_INVALID');
  }
  return { accountId, apiUrl: apiUrl.replace(/\/+$/, ''), token: authorizationToken };
};

const inventoryQuota = (env: Env): number => {
  const value = quotaBytes(env);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_QUOTA_BYTES;
};

const usageValue = (value: unknown): { bytes: number | null; updatedAt: number | null } => {
  if (!isRecord(value)) return { bytes: null, updatedAt: null };
  return {
    bytes: integer(value.bytes),
    updatedAt: integer(value.updatedAt),
  };
};

const collectOneB2 = async (
  env: Env,
  account: B2Account,
  index: number,
  usageReader: B2UsageReader,
  now: number
): Promise<InventoryB2Account> => {
  let usage: { bytes: number | null; updatedAt: number | null } = { bytes: null, updatedAt: null };
  let usageError: string | null = null;
  try {
    usage = usageValue(await usageReader(account.name, index));
  } catch (error) {
    usageError = errorCode(error, 'B2_USAGE');
  }
  let providerAccountId: string | null = null;
  let bucketId: string | null = null;
  let bucketType: string | null = null;
  let options: string[] = [];
  let providerError: string | null = null;
  try {
    const auth = await b2Auth(account);
    providerAccountId = auth.accountId;
    const res = await request(`${auth.apiUrl}/b2_list_buckets`, {
      method: 'POST',
      headers: { Authorization: auth.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: auth.accountId, bucketName: account.bucket }),
    }, 'B2');
    const body = await b2Response(res, 'B2');
    if (!Array.isArray(body.buckets)) throw new ProviderError('B2_BUCKET_INVALID');
    const bucket = body.buckets.find((item) => isRecord(item) && text(item.bucketName) === account.bucket);
    if (!isRecord(bucket) || text(bucket.bucketId) === null) {
      throw new ProviderError('B2_BUCKET_NOT_FOUND');
    }
    const validType = text(bucket.bucketType);
    const validOptions = Array.isArray(bucket.options)
      && bucket.options.every((item): item is string => text(item) !== null);
    if (validType === null || !validOptions) {
      throw new ProviderError('B2_BUCKET_INVALID');
    }
    bucketId = bucket.bucketId as string;
    bucketType = validType;
    options = bucket.options as string[];
  } catch (error) {
    providerAccountId = null;
    bucketId = null;
    bucketType = null;
    options = [];
    providerError = errorCode(error, 'B2');
  }
  const usageAvailable = usage.bytes !== null;
  const usageStateError = usageError ?? (usageAvailable ? null : 'B2_USAGE_UNAVAILABLE');
  const bothUnavailable = providerError !== null && !usageAvailable;
  const status: ResourceState['status'] = bothUnavailable ? 'unavailable' : providerError || usageStateError ? 'degraded' : 'ok';
  const source: ResourceState['source'] = bothUnavailable
    ? 'unavailable'
    : providerError ? 'tracked' : 'live';
  const stateError = providerError ?? usageStateError;
  return {
    configuredName: account.name,
    providerAccountId,
    bucketId,
    bucketName: account.bucket,
    bucketType,
    options,
    trackedBytes: usage.bytes,
    trackedUpdatedAt: usage.updatedAt,
    quotaBytes: inventoryQuota(env),
    state: resourceState(status, source, now, stateError),
  };
};

const mapConcurrent = async <T, R>(
  items: T[],
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
  await Promise.all(Array.from({ length: Math.min(B2_PROVIDER_CONCURRENCY, items.length) }, worker));
  return results;
};

export const collectB2Inventory = async (
  env: Env,
  usageReader: B2UsageReader,
  now: number
): Promise<{ accounts: InventoryB2Account[]; warnings: InventoryWarning[] }> => {
  const observedAt = Number.isFinite(now) ? Math.floor(now) : Math.floor(Date.now());
  const configWarning: InventoryWarning = {
    code: 'B2_CONFIG_INVALID',
    peerUrl: null,
    message: 'B2 configuration invalid',
    observedAt,
  };
  let accounts: B2Account[] = [];
  try {
    accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
  } catch {
    return { accounts: [], warnings: [configWarning] };
  }
  if (accounts.length === 0) return { accounts: [], warnings: [configWarning] };
  const normalized = accounts.map((account, index) => ({
    ...account,
    name: account.name.trim() || `b2-${index + 1}`,
  }));
  return {
    accounts: await mapConcurrent(normalized, (account, index) => collectOneB2(env, account, index, usageReader, observedAt)),
    warnings: [],
  };
};

export { getB2UsageSnapshot };
