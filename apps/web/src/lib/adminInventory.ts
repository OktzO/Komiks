import type { ResourceSource, ResourceStatus } from '@manga-platform/shared/types';

export type InventoryCoverage = {
  configured: number;
  reachable: number;
  liveAccounts: number;
  d1: number;
  kv: number;
  b2: number;
};

export type InventoryTotals = {
  accounts: number;
  b2: number;
  registrations: number;
  warnings: number;
};

export type InventoryTopology = {
  source: string | null;
  count: number;
  hash: string | null;
  consistent: boolean;
};

export type InventoryState = {
  status: ResourceStatus;
  source: ResourceSource;
  observedAt: number | null;
  errorCode: string | null;
};

export type InventoryCounts = {
  series: number | null;
  chapters: number | null;
  chapterPages: number | null;
  users: number | null;
  bookmarks: number | null;
};

export type InventoryOrigin = {
  id: string | null;
  url: string | null;
  accountId: string | null;
  priority: number | null;
  weight: number | null;
  enabled: number | null;
  lastHealthStatus: string | null;
  lastCheckedAt: number | null;
  createdAt: number | null;
};

export type InventoryRow = {
  topologyHash: string | null;
  index: number | null;
  url: string;
  self: boolean;
  reachable: boolean;
  account: { id: string | null; name: string | null; type: string | null; state: InventoryState };
  worker: { name: string | null; createdAt: string | null; modifiedAt: string | null; state: InventoryState };
  d1: {
    id: string | null;
    name: string | null;
    fileBytes: number | null;
    jurisdiction: string | null;
    region: string | null;
    counts: InventoryCounts;
    state: InventoryState;
  };
  kv: {
    id: string | null;
    title: string | null;
    jurisdiction: string | null;
    keyCount: number | null;
    byteCount: number | null;
    operationalD1Bytes: number | null;
    state: InventoryState;
  };
  lb: {
    accountId: string | null;
    accountProvider: string | null;
    accountLabel: string | null;
    accountRef: string | null;
    accountStatus: string | null;
    accountLastTestedAt: number | null;
    accountCreatedAt: number | null;
    origins: InventoryOrigin[];
  };
};

export type InventoryB2Entry = {
  configuredName: string;
  providerAccountId: string | null;
  bucketId: string | null;
  bucketName: string | null;
  bucketType: string | null;
  options: string[];
  trackedBytes: number | null;
  trackedUpdatedAt: number | null;
  quotaBytes: number | null;
  state: InventoryState;
};

export type InventoryRegistrationEntry = {
  account: {
    id: string;
    label: string | null;
    provider: string | null;
    accountRef: string | null;
    status: string | null;
    lastTestedAt: number | null;
    createdAt: number | null;
  };
  origin: InventoryOrigin | null;
  topologyStatus: 'registered' | 'pending_topology' | null;
};

export type InventoryWarningEntry = {
  code: string;
  peerUrl: string | null;
  message: string | null;
  observedAt: number | null;
};

export type AdminInventoryView = {
  query: string;
  active: boolean;
  observedAt: number | null;
  stale: boolean;
  topology: InventoryTopology;
  warnings: InventoryWarningEntry[];
  coverage: InventoryCoverage;
  totals: InventoryTotals;
  visibleAccounts: InventoryRow[];
  visibleD1: InventoryRow[];
  visibleKv: InventoryRow[];
  visibleB2: InventoryB2Entry[];
  visibleRegistrations: InventoryRegistrationEntry[];
};

const SOURCES: readonly ResourceSource[] = ['live', 'local', 'tracked', 'derived', 'unavailable'];
const STATUSES: readonly ResourceStatus[] = ['ok', 'degraded', 'unavailable'];
const TOPOLOGY_STATUSES = ['registered', 'pending_topology'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const obj = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const count = (value: unknown): number => (isCount(value) ? value : 0);

const nullableCount = (value: unknown): number | null => (isCount(value) ? value : null);

const nullableFlag = (value: unknown): number | null => (value === 0 || value === 1 ? value : null);

const nullablePositive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

const strings = (value: unknown): string[] =>
  list(value)
    .map((item) => text(item))
    .filter((item): item is string => item !== null);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const optionalOneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

const state = (value: unknown): InventoryState => {
  const raw = obj(value);
  return {
    status: oneOf(raw.status, STATUSES, 'unavailable'),
    source: oneOf(raw.source, SOURCES, 'unavailable'),
    observedAt: nullableCount(raw.observedAt),
    errorCode: text(raw.errorCode),
  };
};

const isLive = (value: InventoryState): boolean => value.source === 'live';

const origin = (value: unknown): InventoryOrigin | null => {
  const raw = obj(value);
  const result: InventoryOrigin = {
    id: text(raw.id),
    url: text(raw.origin_url),
    accountId: text(raw.account_id),
    priority: nullableCount(raw.priority),
    weight: nullablePositive(raw.weight),
    enabled: nullableFlag(raw.enabled),
    lastHealthStatus: text(raw.last_health_status),
    lastCheckedAt: nullableCount(raw.last_checked_at),
    createdAt: nullableCount(raw.created_at),
  };
  return result.id === null && result.url === null ? null : result;
};

const counts = (value: unknown): InventoryCounts => {
  const raw = obj(value);
  return {
    series: nullableCount(raw.series),
    chapters: nullableCount(raw.chapters),
    chapterPages: nullableCount(raw.chapterPages),
    users: nullableCount(raw.users),
    bookmarks: nullableCount(raw.bookmarks),
  };
};

const row = (value: unknown): InventoryRow | null => {
  const raw = obj(value);
  const url = text(raw.url);
  if (url === null) return null;
  const account = obj(raw.account);
  const worker = obj(raw.worker);
  const d1 = obj(raw.d1);
  const kv = obj(raw.kv);
  const lb = obj(raw.lb);
  const lbAccount = obj(lb.account);
  return {
    topologyHash: text(raw.topologyHash),
    index: nullableCount(raw.index),
    url,
    self: raw.self === true,
    reachable: raw.reachable === true,
    account: {
      id: text(account.id),
      name: text(account.name),
      type: text(account.type),
      state: state(account.state),
    },
    worker: {
      name: text(worker.name),
      createdAt: text(worker.createdAt),
      modifiedAt: text(worker.modifiedAt),
      state: state(worker.state),
    },
    d1: {
      id: text(d1.id),
      name: text(d1.name),
      fileBytes: nullableCount(d1.fileBytes),
      jurisdiction: text(d1.jurisdiction),
      region: text(d1.region),
      counts: counts(d1.counts),
      state: state(d1.state),
    },
    kv: {
      id: text(kv.id),
      title: text(kv.title),
      jurisdiction: text(kv.jurisdiction),
      keyCount: nullableCount(kv.keyCount),
      byteCount: nullableCount(kv.byteCount),
      operationalD1Bytes: nullableCount(kv.operationalD1Bytes),
      state: state(kv.state),
    },
    lb: {
      accountId: text(lbAccount.id),
      accountProvider: text(lbAccount.provider),
      accountLabel: text(lbAccount.label),
      accountRef: text(lbAccount.account_ref),
      accountStatus: text(lbAccount.status),
      accountLastTestedAt: nullableCount(lbAccount.last_tested_at),
      accountCreatedAt: nullableCount(lbAccount.created_at),
      origins: take(lb.origins, origin),
    },
  };
};

const b2Entry = (value: unknown): InventoryB2Entry | null => {
  const raw = obj(value);
  const configuredName = text(raw.configuredName);
  if (configuredName === null) return null;
  return {
    configuredName,
    providerAccountId: text(raw.providerAccountId),
    bucketId: text(raw.bucketId),
    bucketName: text(raw.bucketName),
    bucketType: text(raw.bucketType),
    options: strings(raw.options),
    trackedBytes: nullableCount(raw.trackedBytes),
    trackedUpdatedAt: nullableCount(raw.trackedUpdatedAt),
    quotaBytes: nullableCount(raw.quotaBytes),
    state: state(raw.state),
  };
};

const registrationEntry = (value: unknown): InventoryRegistrationEntry | null => {
  const raw = obj(value);
  const account = obj(raw.account);
  const id = text(account.id);
  if (id === null) return null;
  return {
    account: {
      id,
      label: text(account.label),
      provider: text(account.provider),
      accountRef: text(account.account_ref),
      status: text(account.status),
      lastTestedAt: nullableCount(account.last_tested_at),
      createdAt: nullableCount(account.created_at),
    },
    origin: origin(raw.origin),
    topologyStatus: optionalOneOf(raw.topologyStatus, TOPOLOGY_STATUSES),
  };
};

const warningEntry = (value: unknown): InventoryWarningEntry | null => {
  const raw = obj(value);
  const code = text(raw.code);
  if (code === null) return null;
  return {
    code,
    peerUrl: text(raw.peerUrl),
    message: text(raw.message),
    observedAt: nullableCount(raw.observedAt),
  };
};

const take = <T>(value: unknown, parse: (item: unknown) => T | null): T[] =>
  list(value)
    .map(parse)
    .filter((item): item is T => item !== null);

const matches = (query: string, ...values: Array<string | null>): boolean => {
  if (query === '') return true;
  return values.some((value) => value !== null && value.toLowerCase().includes(query));
};

const accountFields = (item: InventoryRow): Array<string | null> => [
  item.account.name,
  item.account.id,
  item.worker.name,
  item.url,
  item.lb.accountLabel,
  item.lb.accountId,
  ...item.lb.origins.map((entry) => entry.url),
];

const d1Fields = (item: InventoryRow): Array<string | null> => [item.d1.name, item.d1.id, ...accountFields(item)];

const kvFields = (item: InventoryRow): Array<string | null> => [item.kv.title, item.kv.id, ...accountFields(item)];

const b2Fields = (item: InventoryB2Entry): Array<string | null> => [
  item.configuredName,
  item.bucketName,
  item.bucketId,
  item.providerAccountId,
];

const registrationFields = (item: InventoryRegistrationEntry): Array<string | null> => [
  item.account.label,
  item.account.id,
  item.account.accountRef,
  item.account.provider,
  item.account.status,
  item.origin?.url ?? null,
  item.origin?.id ?? null,
];

const topologyOf = (value: unknown): InventoryTopology => {
  const raw = obj(value);
  return {
    source: text(raw.source),
    count: count(raw.count),
    hash: text(raw.hash),
    consistent: raw.consistent === true,
  };
};

export const filterInventory = (input: unknown, rawQuery: string): AdminInventoryView => {
  const source = obj(input);
  const query = (text(rawQuery) ?? '').toLowerCase();

  const accounts = take(source.accounts, row);
  const b2 = take(source.b2, b2Entry);
  const registrations = take(source.registrations, registrationEntry);
  const warnings = take(source.warnings, warningEntry);
  const topology = topologyOf(source.topology);

  return {
    query,
    active: query !== '',
    observedAt: nullableCount(source.observedAt),
    stale: source.stale === true,
    topology,
    warnings,
    coverage: {
      configured: topology.count,
      reachable: accounts.filter((item) => item.reachable).length,
      liveAccounts: accounts.filter((item) => isLive(item.account.state)).length,
      d1: accounts.filter((item) => isLive(item.d1.state)).length,
      kv: accounts.filter((item) => isLive(item.kv.state)).length,
      b2: b2.filter((item) => isLive(item.state)).length,
    },
    totals: {
      accounts: accounts.length,
      b2: b2.length,
      registrations: registrations.length,
      warnings: warnings.length,
    },
    visibleAccounts: accounts.filter((item) => matches(query, ...accountFields(item))),
    visibleD1: accounts.filter((item) => matches(query, ...d1Fields(item))),
    visibleKv: accounts.filter((item) => matches(query, ...kvFields(item))),
    visibleB2: b2.filter((item) => matches(query, ...b2Fields(item))),
    visibleRegistrations: registrations.filter((item) => matches(query, ...registrationFields(item))),
  };
};

export const coverage = (input: unknown): InventoryCoverage => filterInventory(input, '').coverage;

/* ═══════════════════════════════════════════════════════════════════════
 * Page view models
 *
 * These are the exact shapes the three admin pages hand to shared widgets.
 * Unknown values stay null/0 so `StorageDonut` and the tables render
 * "belum terukur" instead of a fabricated zero.
 * ═══════════════════════════════════════════════════════════════════════ */

export type InventoryStorageAccount = { name: string; bucket: string; bytes: number | null; quota: number };

export type InventoryStorage = { accounts: InventoryStorageAccount[]; totalQuota: number };

export const storageFromInventory = (input: unknown): InventoryStorage => {
  const accounts = filterInventory(input, '').visibleB2.map((entry) => ({
    name: entry.configuredName,
    bucket: entry.bucketName ?? '',
    bytes: entry.trackedBytes,
    quota: entry.quotaBytes ?? 0,
  }));
  return { accounts, totalQuota: accounts.reduce((sum, account) => sum + account.quota, 0) };
};

export type InventoryLbRow = {
  key: string;
  topologyUrl: string | null;
  topologyIndex: number | null;
  reachable: boolean | null;
  accountId: string | null;
  label: string;
  provider: string | null;
  accountRef: string | null;
  status: string | null;
  lastTestedAt: number | null;
  topologyStatus: 'registered' | 'pending_topology' | null;
  origins: InventoryOrigin[];
  requestsToday: number;
};

const usageTotals = (usage: unknown): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const entry of list(usage)) {
    const record = obj(entry);
    const url = text(record.origin_url);
    const count = nullableCount(record.req_count);
    if (url === null || count === null) continue;
    totals.set(url, (totals.get(url) ?? 0) + count);
  }
  return totals;
};

/**
 * One row per configured topology peer, then every credential registration
 * that has no topology peer yet. `registrations[]` only ever carries
 * pending/unmatched rows, so `topologyStatus` stays `null` for a topology row
 * and is never inferred as `registered`. `label` always resolves to something
 * real — an operator label, the provider account name, or the peer URL — so a
 * row is never blank. `usage` is optional: a page that does not read
 * `lb_usage` omits it and every `requestsToday` is 0.
 */
export const lbRowsFromInventory = (
  input: unknown,
  usage?: unknown,
  query = ''
): InventoryLbRow[] => {
  const view = filterInventory(input, query);
  const totals = usage === undefined ? null : usageTotals(usage);
  const sumFor = (urls: Array<string | null>): number =>
    totals === null
      ? 0
      : urls.reduce((sum, url) => (url === null ? sum : sum + (totals.get(url) ?? 0)), 0);

  const matched = new Set<string>();
  const rows: InventoryLbRow[] = view.visibleAccounts.map((item) => {
    if (item.lb.accountId !== null) matched.add(item.lb.accountId);
    return {
      key: `topology:${item.index ?? item.url}:${item.url}`,
      topologyUrl: item.url,
      topologyIndex: item.index,
      reachable: item.reachable,
      accountId: item.lb.accountId,
      label: item.lb.accountLabel ?? item.account.name ?? item.url,
      provider: item.lb.accountProvider ?? item.account.type,
      accountRef: item.lb.accountRef,
      status: item.lb.accountStatus,
      lastTestedAt: item.lb.accountLastTestedAt,
      topologyStatus: null,
      origins: item.lb.origins,
      requestsToday: sumFor(
        item.lb.origins.length > 0 ? item.lb.origins.map((origin) => origin.url) : [item.url]
      ),
    };
  });

  for (const entry of view.visibleRegistrations) {
    if (matched.has(entry.account.id)) continue;
    rows.push({
      key: `registration:${entry.account.id}`,
      topologyUrl: null,
      topologyIndex: null,
      reachable: null,
      accountId: entry.account.id,
      label: entry.account.label ?? entry.account.accountRef ?? entry.account.id,
      provider: entry.account.provider,
      accountRef: entry.account.accountRef,
      status: entry.account.status,
      lastTestedAt: entry.account.lastTestedAt,
      topologyStatus: entry.topologyStatus,
      origins: entry.origin === null ? [] : [entry.origin],
      requestsToday: sumFor([entry.origin?.url ?? null]),
    });
  }
  return rows;
};

export type InventoryAccountOption = { id: string; name: string; type: string | null };

/** 409 `account selection required` choices, trimmed and deduped by id. */
export const accountOptionsFromConflict = (input: unknown): InventoryAccountOption[] => {
  const seen = new Set<string>();
  const options: InventoryAccountOption[] = [];
  for (const entry of list(input)) {
    const record = obj(entry);
    const id = text(record.id);
    const name = text(record.name);
    if (id === null || name === null || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, name, type: text(record.type) });
  }
  return options;
};

export const PENDING_TOPOLOGY_STEPS: readonly string[] = [
  'Tambahkan URL Worker ke PEER_URLS di setiap worker.',
  'Pastikan hash topologi identik di semua worker.',
  'Deploy konfigurasi terkoordinasi ke semua worker.',
  'Aktifkan origin (enabled=1) setelah topologi sinkron.',
];

/* ── Topology rows ──────────────────────────────────────────────────── */

export type InventoryTopologyRow = {
  key: string;
  index: number | null;
  url: string;
  self: boolean;
  reachable: boolean;
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  accountState: InventoryState;
  workerName: string | null;
  workerState: InventoryState;
  topologyHash: string | null;
  hashMatches: boolean | null;
  lbAccountId: string | null;
  lbAccountLabel: string | null;
  originCount: number;
};

/** `true` when both hashes are usable and equal, `null` when either is unknown. */
export const hashMatches = (rowHash: string | null, topologyHash: string | null): boolean | null => {
  if (typeof rowHash !== 'string' || rowHash.trim() === '') return null;
  if (typeof topologyHash !== 'string' || topologyHash.trim() === '') return null;
  return rowHash.trim() === topologyHash.trim();
};

export const topologyRowsFromView = (view: AdminInventoryView): InventoryTopologyRow[] =>
  view.visibleAccounts.map((item) => ({
    key: `topology:${item.index ?? item.url}:${item.url}`,
    index: item.index,
    url: item.url,
    self: item.self,
    reachable: item.reachable,
    accountId: item.account.id,
    accountName: item.account.name,
    accountType: item.account.type,
    accountState: item.account.state,
    workerName: item.worker.name,
    workerState: item.worker.state,
    topologyHash: item.topologyHash,
    hashMatches: hashMatches(item.topologyHash, view.topology.hash),
    lbAccountId: item.lb.accountId,
    lbAccountLabel: item.lb.accountLabel,
    originCount: item.lb.origins.length,
  }));

export const topologyRowsFromInventory = (input: unknown, query = ''): InventoryTopologyRow[] =>
  topologyRowsFromView(filterInventory(input, query));

/* ── Credential form state ───────────────────────────────────────────── */

const ACCOUNT_ERROR_MESSAGES: Record<string, string> = {
  'no accessible cloudflare accounts': 'Token ini tidak melihat akun Cloudflare yang bisa diakses.',
  no_cloudflare_accounts: 'Token ini tidak melihat akun Cloudflare yang bisa diakses.',
  cloudflare_token_rejected: 'Token ditolak Cloudflare.',
  cloudflare_account_read_forbidden: 'Token tidak punya izin membaca akun Cloudflare.',
  'account not accessible': 'Akun Cloudflare yang dipilih tidak bisa diakses token ini.',
  'invalid accountId': 'Account ID Cloudflare harus 32 karakter heksadesimal.',
  'token required': 'Token wajib diisi.',
  'token too long': 'Token terlalu panjang.',
  'invalid provider': 'Provider tidak dikenal.',
  'invalid label': 'Label akun tidak valid.',
  'label too long': 'Label akun terlalu panjang.',
  'account create failed': 'Gagal menyimpan akun.',
};

const GENERIC_ACCOUNT_ERROR = 'Gagal menambah akun.';

export type AccountCreateOutcome =
  | { kind: 'stored'; id: string; status: string }
  | { kind: 'failed'; message: string };

/**
 * The body decides whether the account exists, never the HTTP status. A 422
 * carries either a created-but-unverified account (`id` + `status`) or an
 * `error` string; conflating them made the form claim a save that never
 * happened and cleared the token the operator still needed.
 */
export const accountCreateOutcome = (httpStatus: unknown, body: unknown): AccountCreateOutcome => {
  const record = obj(body);
  const id = text(record.id);
  const status = text(record.status);
  if (id !== null && status !== null) return { kind: 'stored', id, status };
  const code = text(record.error);
  return {
    kind: 'failed',
    message: (code !== null ? ACCOUNT_ERROR_MESSAGES[code] : undefined) ?? `${GENERIC_ACCOUNT_ERROR} (${typeof httpStatus === 'number' ? httpStatus : '?'})`,
  };
};

export type AccountSelectionControl =
  | { kind: 'picker'; choices: InventoryAccountOption[] }
  | { kind: 'reference' }
  | { kind: 'none' };

/**
 * A free-text Cloudflare account id is never offered: the only safe value is
 * one the server discovered for this token. Vercel has no such discovery, so
 * its bounded team/account ref stays.
 */
export const accountSelectionControl = (
  provider: unknown,
  choices: InventoryAccountOption[]
): AccountSelectionControl => {
  if (text(provider) === 'vercel') return { kind: 'reference' };
  return choices.length > 0 ? { kind: 'picker', choices } : { kind: 'none' };
};

export type CredentialFormGuard = {
  busy: boolean;
  awaitingSelection: boolean;
  selectedAccountId: string;
};

export const canSubmitCredential = (form: CredentialFormGuard): boolean =>
  !form.busy && (!form.awaitingSelection || form.selectedAccountId.trim().length > 0);

/* ── Banner state ────────────────────────────────────────────────────── */

export type AdminBanners = {
  inventory: string | null;
  inventoryTone: BannerTone | null;
  mutation: string | null;
  mutationTone: BannerTone | null;
};

export type BannerTone = 'error' | 'warning';

export type AdminBannerEvent =
  | { kind: 'inventory'; ok: boolean; message?: string }
  | { kind: 'mutation'; outcome: 'success' | 'partial' | 'failure'; message?: string };

const GENERIC_BANNER = 'Permintaan gagal.';

const MUTATION_TONE: Record<Exclude<AdminBannerEvent, { kind: 'inventory' }>['outcome'], BannerTone | null> = {
  success: null,
  partial: 'warning',
  failure: 'error',
};

/** A mutation result can never clear or overwrite the inventory outage banner. */
export const bannersAfter = (current: AdminBanners, event: AdminBannerEvent): AdminBanners => {
  if (event.kind === 'inventory') {
    return event.ok
      ? { ...current, inventory: null, inventoryTone: null }
      : { ...current, inventory: event.message ?? GENERIC_BANNER, inventoryTone: 'error' };
  }
  return {
    ...current,
    mutation: event.outcome === 'success' ? null : event.message ?? GENERIC_BANNER,
    mutationTone: MUTATION_TONE[event.outcome],
  };
};

export const EMPTY_BANNERS: AdminBanners = {
  inventory: null,
  inventoryTone: null,
  mutation: null,
  mutationTone: null,
};

/* ── Draft lifecycle ────────────────────────────────────────────────── */

export type CredentialDraft = { token: string; accountId: string; choices: InventoryAccountOption[] };

/** 409 choices belong to one token; editing the token must drop them. */
export const credentialDraftChanged = (current: CredentialDraft, nextToken: string): CredentialDraft =>
  current.token.trim() === nextToken.trim() ? current : { token: nextToken, accountId: '', choices: [] };

export type OriginDraft = { accountId: string; url: string; priority: number; weight: number };

const draftInt = (raw: unknown, fallback: number, min: number): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
};

/** Reads a form body through a getter so it is testable without a DOM. */
export const originDraftFrom = (get: (name: string) => unknown): OriginDraft => ({
  accountId: text(get('origin_account_id')) ?? '',
  url: text(get('origin_url')) ?? '',
  priority: draftInt(get('priority'), 0, 0),
  weight: draftInt(get('weight'), 1, 1),
});

/* ── Refresh scheduling ─────────────────────────────────────────────── */

export type RefreshSlot = { inFlight: boolean; queued: boolean };

export type RefreshDecision = { slot: RefreshSlot; start: boolean };

/** An idle page starts; a busy page queues at most one forced refresh. */
export const nextRefreshAfter = (current: RefreshSlot, requested: boolean): RefreshDecision => {
  if (!current.inFlight) return { slot: { inFlight: true, queued: false }, start: true };
  if (requested && !current.queued) return { slot: { inFlight: true, queued: true }, start: false };
  return { slot: current, start: false };
};

/** A settled load restarts a queued force, otherwise the page goes idle. */
export const refreshSettled = (current: RefreshSlot): RefreshDecision =>
  current.queued
    ? { slot: { inFlight: true, queued: false }, start: true }
    : { slot: { inFlight: false, queued: false }, start: false };

/* ── Small render helpers ────────────────────────────────────────────── */

export const inventoryUrl = (forceRefresh?: unknown): string =>
  forceRefresh === true ? '/api/admin/inventory?refresh=1' : '/api/admin/inventory';

export const b2RowKey = (
  entry: Pick<InventoryB2Entry, 'configuredName' | 'providerAccountId' | 'bucketId'>,
  position: number
): string => `${entry.configuredName}|${entry.providerAccountId ?? ''}|${entry.bucketId ?? ''}|${position}`;

export type LocalSnapshotRow = { db_name: string; rows_or_objects: number | null; size_bytes: number | null };

/** `db_usage_snapshot` still holds a D1 row; the live D1 section owns that number. */
export const nonD1SnapshotRows = (current: unknown): LocalSnapshotRow[] =>
  list(current).flatMap((entry) => {
    const record = obj(entry);
    const name = text(record.db_name);
    if (name === null || name === 'd1' || name.startsWith('d1:')) return [];
    return [{ db_name: name, rows_or_objects: nullableCount(record.rows_or_objects), size_bytes: nullableCount(record.size_bytes) }];
  });

export const tabIndexFromKey = (current: number, key: string, count: number): number | null => {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
};

const SOURCE_LABELS: Record<ResourceSource, string> = {
  live: 'live',
  local: 'lokal',
  tracked: 'terlacak',
  derived: 'diturunkan',
  unavailable: 'tidak tersedia',
};

const STATUS_LABELS: Record<ResourceStatus, string> = {
  ok: 'sehat',
  degraded: 'terganggu',
  unavailable: 'tidak tersedia',
};

export const formatSource = (source: ResourceSource): string => SOURCE_LABELS[source] ?? 'tidak tersedia';

/**
 * D1 content counts and the KV operational-byte total are read from this
 * Worker's own database, not from the provider API that the row's `live`
 * badge describes. Their field label therefore always names the local source
 * in text, so the source is legible without relying on colour.
 */
export const localFieldLabel = (label: string): string => `${label} · ${formatSource('local')}`;

export const formatStatus = (status: ResourceStatus): string => STATUS_LABELS[status] ?? 'tidak tersedia';

export const formatObservedAt = (
  observedAtMs: number | null | undefined,
  now: number = Date.now()
): string => {
  if (typeof observedAtMs !== 'number' || !Number.isFinite(observedAtMs)) return '—';
  const age = Math.max(0, now - observedAtMs) / 1000;
  if (age < 5) return 'baru saja';
  if (age < 60) return `${Math.floor(age)} dtk lalu`;
  if (age < 3600) return `${Math.floor(age / 60)} mnt lalu`;
  if (age < 86400) return `${Math.floor(age / 3600)} jam lalu`;
  return `${Math.floor(age / 86400)} hari lalu`;
};
