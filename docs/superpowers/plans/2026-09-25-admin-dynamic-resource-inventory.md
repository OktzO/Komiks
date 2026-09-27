# Dynamic Admin Resource Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace local, two-row LB metadata with dynamic topology inventory that safely reports live Cloudflare, D1, KV, B2, origin, and credential state for any peer count.

**Architecture:** Each Worker exposes fixed allowlisted local/provider inventory through an authenticated internal endpoint. Admin coordinator fans out across dynamic `PEER_URLS`, preserves rows for failed peers, caches bounded snapshots, and returns one shared contract consumed by Settings, Dashboard, and Monitoring. `PEER_URLS` controls public origin membership; D1 supplies optional per-origin overrides and credential metadata.

**Tech Stack:** Cloudflare Workers/Hono, D1, KV, TypeScript 5.9, Zod 3, React 19, Astro 7, Tailwind CSS 3, Bun tests, `node:test` through `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-25-admin-dynamic-resource-inventory-design.md`

## Global Constraints

- No fixed account count anywhere in runtime or UI; support N=0, N=1, N=2, N=4, and N arbitrary.
- `PEER_URLS` is canonical topology and shard order; identical ordered list required on every Worker.
- Provider/live, application/tracked, local, derived, and unavailable values remain distinguishable; bytes tracked by app are never live.
- Never expose Cloudflare/B2 credentials, raw tokens, KV values, arbitrary D1 rows, or raw provider error bodies to frontend.
- B2 aggregate bytes remain `tracked`; never label application counter as provider-live.
- New provision remains disabled and `pending_topology`; never auto-edit `PEER_URLS`.
- Preserve all current uncommitted worktree changes; inspect diffs before editing overlapping files.
- No new runtime dependency; use native `fetch`, `crypto`, Web Crypto, Hono, React, and existing Zod.
- Do not commit unless user explicitly requests; plan commit checkpoints are optional review boundaries only.

## Review Focus

- Empty or inconsistent topology: page and origin pool degrade without division by zero or fabricated accounts.
- Partial provider failure: one account’s token/API failure never erases healthy peer inventory.
- Topology drift: identical hash expected, but mismatches remain visible and do not crash coordinator.
- Secret boundary: known token/key/header strings never appear in internal/admin responses or UI state.
- New-account activation: provision-created Worker cannot receive traffic before explicit topology synchronization.

---

## File Map

- `packages/shared/types.ts`: shared Zod schemas and TypeScript contracts for internal peer inventory, admin inventory, registration state, B2 inventory, resource state.
- `packages/db/schema.sql`: canonical `lb_accounts` shape including `last_tested_at`.
- `packages/db/migrations/0020_admin_inventory.sql`: additive `last_tested_at` migration.
- `packages/db/index.ts`: safe account listing, credential status persistence, fixed inventory counts, origin/account lookup helpers.
- `packages/lb/accounts.ts`: provider identity discovery, token verification, account creation from discovered identity, persistent test status.
- `packages/lb/provision.ts`: explicit account choice, actual `account_ref`, disabled origin, inventory metadata vars/secrets.
- `apps/api-cf/src/lib/context.ts`: new non-secret inventory env fields and provider token secret field.
- `apps/api-cf/src/lib/peers.ts`: topology hash, peer inventory fetch helper, normalized topology utilities.
- `apps/api-cf/src/lib/adminInventory.ts`: local resource collection, Cloudflare provider collector, B2 validator, coordinator merge/cache/fallback.
- `apps/api-cf/src/routes/internal.ts`: authenticated fixed-shape peer inventory endpoint.
- `apps/api-cf/src/routes/admin/inventory.ts`: admin-only coordinator endpoint.
- `apps/api-cf/src/routes/admin/lb.ts`: runtime validation and safe account/provision responses.
- `apps/api-cf/src/routes/origins.ts`: topology-derived public origin pool with D1 overrides.
- `apps/api-cf/src/index.ts`: mount admin inventory router.
- `apps/api-cf/wrangler*.toml`: non-secret self/resource identifiers; secret documented, never committed.
- `apps/web/src/lib/adminInventory.ts`: frontend types, normalization, filtering, coverage summaries.
- `apps/web/src/components/admin/InventorySections.tsx`: reusable topology/D1/KV/B2 resource sections.
- `apps/web/src/components/pages/AdminSettings.tsx`: inventory-driven settings and safe actions.
- `apps/web/src/components/pages/AdminDashboard.tsx`: shared inventory for LB/storage widgets.
- `apps/web/src/components/pages/AdminMonitoring.tsx`: shared D1/KV inventory instead of local `db_usage` assumption.
- `docs/DEPLOY.md`: `CF_INVENTORY_TOKEN`, metadata vars, topology synchronization, migration/deploy order.

---

### Task 1: Shared Inventory Contracts and Topology Semantics

**Files:**
- Modify: `packages/shared/types.ts:87-130`
- Modify: `apps/api-cf/src/lib/peers.ts:1-46`
- Modify: `apps/api-cf/test/peers.test.mjs:1-121`
- Create: `apps/api-cf/test/helpers/inventory-fixture.mjs`
- Test: `apps/api-cf/test/peers.test.mjs`

**Interfaces:**
- Consumes: `getPeers(env): PeerInfo[]`; `LbSettings`, `LbAccountSafe`, `LbOrigin`.
- Produces:
  - `ResourceStatus = 'ok' | 'degraded' | 'unavailable'`
  - `ResourceSource = 'live' | 'local' | 'tracked' | 'derived' | 'unavailable'`
  - `ResourceStateSchema`, `ResourceState`
  - `PeerInventorySchema`, `PeerInventory`
  - `AdminInventorySchema`, `AdminInventory`
  - `InventoryRegistrationSchema`, `InventoryRegistration`
  - `InventoryB2AccountSchema`, `InventoryB2Account`
  - `InventoryWarningSchema`, `InventoryWarning`
  - `TopologySnapshot = { peers: PeerInfo[]; count: number; hash: string }`
  - `getTopology(env): TopologySnapshot`
  - `PeerFetchResult = { ok: true; data: PeerInventory } | { ok: false; errorCode: string }`
  - `fetchPeerInventory(env, peer, refresh?: boolean, signal?: AbortSignal): Promise<PeerFetchResult>`

- [ ] **Step 0: Capture overlapping pre-existing diffs**

Run:

```bash
git diff -- apps/api-cf/src/lib/peers.ts apps/api-cf/test/peers.test.mjs packages/shared/types.ts
```

Expected: existing Dynamic-N edits may be present. Save output outside task diff mentally; do not revert or rewrite them.

- [ ] **Step 1: Write failing topology/hash and N-proof tests**

Create shared helper `apps/api-cf/test/helpers/inventory-fixture.mjs`:

```js
const state = { status: 'ok', source: 'local', observedAt: 1000, errorCode: null };

export const peerInventoryFixture = (over = {}) => ({
  topologyHash: 'abc',
  self: false,
  account: { id: 'acct-1', name: 'Oktz', type: 'standard', state },
  worker: { name: 'manga-api', createdAt: null, modifiedAt: null, state },
  d1: {
    id: 'd1-1', name: 'manga-db', fileBytes: null, jurisdiction: null, region: null,
    counts: { series: 1, chapters: 2, chapterPages: 3, users: 4, bookmarks: 5 }, state,
  },
  kv: {
    id: 'kv-1', title: 'CACHE_KV', jurisdiction: null,
    keyCount: null, byteCount: null, operationalD1Bytes: null, state,
  },
  lb: { account: null, origins: [] },
  ...over,
});
```

Import it in peer and route tests:

```js
import { peerInventoryFixture } from './helpers/inventory-fixture.mjs';
```

Append tests importing `getTopology` and `fetchPeerInventory`:

```ts
import {
  getTopology,
  fetchPeerInventory,
} from '../src/lib/peers.ts';

for (const count of [0, 1, 2, 4, 5]) {
  test(`topology N=${count} is ordered and hash is deterministic`, () => {
    const urls = Array.from({ length: count }, (_, i) => `https://w${i}.example.com`);
    const a = getTopology(env({ PEER_URLS: urls.join(','), PEER_INDEX: count ? '0' : '' }));
    const b = getTopology(env({ PEER_URLS: urls.join(','), PEER_INDEX: count ? '0' : '' }));
    assert.equal(a.count, count);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.peers.map((p) => p.url), urls);
  });
}

test('topology hash changes when order changes', () => {
  const a = getTopology(env({ PEER_URLS: 'https://a.test,https://b.test', PEER_INDEX: '0' }));
  const b = getTopology(env({ PEER_URLS: 'https://b.test,https://a.test', PEER_INDEX: '1' }));
  assert.notEqual(a.hash, b.hash);
});

test('fetchPeerInventory uses internal key and fixed endpoint', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://b.example.com/api/_internal/admin/inventory');
    assert.equal(init.headers['x-db-forward-key'], 'sekret');
    return new Response(JSON.stringify({ data: peerInventoryFixture({ topologyHash: 'abc', self: false }) }), { status: 200 });
  };
  const result = await fetchPeerInventory(env(), { url: 'https://b.example.com', index: 1, self: false });
  assert.equal(result.ok, true);
});
```

- [ ] **Step 2: Run tests and verify expected failure**

Run from `apps/api-cf`:

```bash
npx tsx --test test/peers.test.mjs
```

Expected: FAIL because `getTopology` and `fetchPeerInventory` are not exported.

- [ ] **Step 3: Add shared schemas and types**

Append to `packages/shared/types.ts`; first add `last_tested_at: z.number().int().nullable().optional()` to existing `LbAccountSchema`, then append:

```ts
export const ResourceStateSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable']),
  source: z.enum(['live', 'local', 'tracked', 'derived', 'unavailable']),
  observedAt: z.number().int().nullable(),
  errorCode: z.string().nullable(),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;

export const PeerInventorySchema = z.object({
  topologyHash: z.string().min(1),
  self: z.boolean(),
  account: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    type: z.string().nullable(),
    state: ResourceStateSchema,
  }),
  worker: z.object({
    name: z.string().nullable(),
    createdAt: z.string().nullable(),
    modifiedAt: z.string().nullable(),
    state: ResourceStateSchema,
  }),
  d1: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    fileBytes: z.number().int().nonnegative().nullable(),
    jurisdiction: z.string().nullable(),
    region: z.string().nullable(),
    counts: z.object({
      series: z.number().int().nonnegative().nullable(),
      chapters: z.number().int().nonnegative().nullable(),
      chapterPages: z.number().int().nonnegative().nullable(),
      users: z.number().int().nonnegative().nullable(),
      bookmarks: z.number().int().nonnegative().nullable(),
    }),
    state: ResourceStateSchema,
  }),
  kv: z.object({
    id: z.string().nullable(),
    title: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    keyCount: z.number().int().nonnegative().nullable(),
    byteCount: z.number().int().nonnegative().nullable(),
    operationalD1Bytes: z.number().int().nonnegative().nullable(),
    state: ResourceStateSchema,
  }),
  lb: z.object({
    account: LbAccountSafeSchema.pick({
      id: true,
      provider: true,
      label: true,
      account_ref: true,
      status: true,
      last_tested_at: true,
      created_at: true,
    }).nullable(),
    origins: z.array(LbOriginSchema),
  }),
});
export type PeerInventory = z.infer<typeof PeerInventorySchema>;

export const InventoryWarningSchema = z.object({
  code: z.string().min(1),
  peerUrl: z.string().url().nullable(),
  message: z.string().min(1),
  observedAt: z.number().int(),
});
export type InventoryWarning = z.infer<typeof InventoryWarningSchema>;

export const InventoryB2AccountSchema = z.object({
  configuredName: z.string().min(1),
  providerAccountId: z.string().nullable(),
  bucketId: z.string().nullable(),
  bucketName: z.string().nullable(),
  bucketType: z.string().nullable(),
  options: z.array(z.string()),
  trackedBytes: z.number().int().nonnegative().nullable(),
  trackedUpdatedAt: z.number().int().nullable(),
  quotaBytes: z.number().int().positive(),
  state: ResourceStateSchema,
});
export type InventoryB2Account = z.infer<typeof InventoryB2AccountSchema>;

export const InventoryRegistrationSchema = z.object({
  account: LbAccountSafeSchema.pick({
    id: true,
    provider: true,
    label: true,
    account_ref: true,
    status: true,
    last_tested_at: true,
    created_at: true,
  }),
  origin: LbOriginSchema.nullable(),
  topologyStatus: z.enum(['registered', 'pending_topology']),
});
export type InventoryRegistration = z.infer<typeof InventoryRegistrationSchema>;

export const AdminInventorySchema = z.object({
  observedAt: z.number().int(),
  stale: z.boolean(),
  topology: z.object({
    source: z.literal('PEER_URLS'),
    count: z.number().int().nonnegative(),
    hash: z.string().min(1),
    consistent: z.boolean(),
  }),
  accounts: z.array(z.object({
    topologyHash: z.string().min(1),
    index: z.number().int().nonnegative(),
    url: z.string().url(),
    self: z.boolean(),
    reachable: z.boolean(),
    account: PeerInventorySchema.shape.account,
    worker: PeerInventorySchema.shape.worker,
    d1: PeerInventorySchema.shape.d1,
    kv: PeerInventorySchema.shape.kv,
    lb: PeerInventorySchema.shape.lb,
  })),
  registrations: z.array(InventoryRegistrationSchema),
  b2: z.array(InventoryB2AccountSchema),
  warnings: z.array(InventoryWarningSchema),
});
export type AdminInventory = z.infer<typeof AdminInventorySchema>;
```

- [ ] **Step 4: Implement topology helpers in `peers.ts`**

Add synchronous stable topology hashing with native `TextEncoder` and 64-bit FNV-1a; no `async`, dependency, or secret input:

```ts
export interface TopologySnapshot {
  peers: PeerInfo[];
  count: number;
  hash: string;
}

const topologyHash = (peers: PeerInfo[]): string => {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(peers.map((p) => p.url).join('\n'))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
};

export const getTopology = (env: Env): TopologySnapshot => {
  const peers = getPeers(env);
  return { peers, count: peers.length, hash: topologyHash(peers) };
};

export type PeerFetchResult =
  | { ok: true; data: PeerInventory }
  | { ok: false; errorCode: string };

export const fetchPeerInventory = async (
  env: Env,
  peer: PeerInfo,
  refresh = false,
  signal?: AbortSignal
): Promise<PeerFetchResult> => {
  const key = forwardKey(env);
  if (!key) return { ok: false, errorCode: 'INTERNAL_KEY_MISSING' };
  try {
    const res = await fetch(`${peer.url}/api/_internal/admin/inventory${refresh ? '?refresh=1' : ''}`, {
      method: 'POST',
      headers: { 'x-db-forward-key': key },
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, errorCode: `PEER_HTTP_${res.status}` };
    const parsed = PeerInventorySchema.safeParse((await res.json() as { data: unknown }).data);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, errorCode: 'PEER_SCHEMA_INVALID' };
  } catch {
    return { ok: false, errorCode: 'PEER_UNREACHABLE' };
  }
};
```

Import `PeerInventorySchema` from shared package. Keep existing `getPeers`, `ownerFor`, and backup behavior unchanged.

- [ ] **Step 5: Run focused tests and shared typecheck**

```bash
npx tsx --test test/peers.test.mjs
npx tsc --noEmit -p ../../packages/shared
npm run build
```

Expected: all PASS; API TypeScript build exits 0.

- [ ] **Step 6: Review checkpoint**

Do not commit unless user explicitly requests. Review only Task 1 files; preserve pre-existing peer changes.

---

### Task 2: D1 Inventory Metadata and Credential Test Persistence

**Files:**
- Create: `packages/db/migrations/0020_admin_inventory.sql`
- Modify: `packages/db/schema.sql:254-264`
- Modify: `packages/db/index.ts:23-58,391-408`
- Create: `packages/db/test/admin-inventory.test.mjs`

**Interfaces:**
- Consumes: `LbAccountSafe`, `LbOrigin`, existing `Db` factory.
- Produces:
  - `Db.updateAccountCredentialStatus(id, status, testedAt): Promise<{ success: boolean }>`
  - `Db.getLbAccount(id): Promise<LbAccountSafe | null>`
  - `Db.getLbOriginByUrl(url): Promise<LbOrigin | null>`
  - `InventoryCounts = { series: number; chapters: number; chapterPages: number; users: number; bookmarks: number }`
  - `Db.getInventoryCounts(): Promise<InventoryCounts>`

- [ ] **Step 0: Capture overlapping pre-existing diff**

Run:

```bash
git diff -- packages/db/index.ts packages/db/schema.sql packages/db/migrations
```

Expected: preserve unrelated schema/data work; this task adds only `last_tested_at` and fixed read helpers.

- [ ] **Step 1: Write failing DB contract tests**

Create `packages/db/test/admin-inventory.test.mjs` using stub D1 pattern from `user-profile.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('getLbOriginByUrl normalizes trailing slash', async () => {
  const { client, trace } = makeStub({ first: null });
  await db(client).getLbOriginByUrl('https://w1.test/');
  assert.deepEqual(trace[0].args, ['https://w1.test']);
});

test('getInventoryCounts uses one fixed SELECT', async () => {
  const { client, trace } = makeStub({ first: { series: 1, chapters: 2, chapter_pages: 3, users: 4, bookmarks: 5 } });
  const counts = await db(client).getInventoryCounts();
  assert.equal(trace.length, 1);
  assert.match(trace[0].sql, /SELECT\s+\(SELECT COUNT\(\*\) FROM series\)/);
  assert.deepEqual(counts, { series: 1, chapters: 2, chapterPages: 3, users: 4, bookmarks: 5 });
});
```

- [ ] **Step 2: Run test and verify failure**

```bash
npx tsx --test packages/db/test/admin-inventory.test.mjs
```

Expected: FAIL because new methods/column are missing. After implementation, rerun same test and require PASS.

- [ ] **Step 3: Add migration and schema column**

`packages/db/migrations/0020_admin_inventory.sql`:

```sql
ALTER TABLE lb_accounts ADD COLUMN last_tested_at INTEGER;
```

Add after `status` in `schema.sql`:

```sql
last_tested_at INTEGER,
```

- [ ] **Step 4: Extend `Db` interface and implementation**

Add:

```ts
getLbAccount: (id: string) => Promise<Result<LbAccountSafe>>;
getLbOriginByUrl: (url: string) => Promise<Result<LbOrigin>>;
getInventoryCounts: () => Promise<{
  series: number;
  chapters: number;
  chapterPages: number;
  users: number;
  bookmarks: number;
}>;
updateAccountCredentialStatus: (
  id: string,
  status: 'verified' | 'unverified' | 'failed',
  testedAt: number
) => Promise<{ success: boolean }>;
```

Update `listAccounts` SELECT to include `last_tested_at`. Implement helpers with bound SQL. `getInventoryCounts` uses one query:

```sql
SELECT
  (SELECT COUNT(*) FROM series) AS series,
  (SELECT COUNT(*) FROM chapters) AS chapters,
  (SELECT COUNT(*) FROM chapter_pages) AS chapter_pages,
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM bookmarks) AS bookmarks
```

Normalize URL with:

```ts
const normalizeOriginUrl = (url: string): string => url.trim().replace(/\/+$/, '');
```

- [ ] **Step 5: Run DB tests and typecheck**

```bash
npx tsx --test packages/db/test/admin-inventory.test.mjs packages/db/test/user-profile.test.mjs
npx tsc --noEmit -p packages/db
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Do not commit. Confirm migration is additive/idempotency policy matches existing migration runner before deployment.

---

### Task 3: Peer Collector and B2 Live Validation

**Files:**
- Create: `apps/api-cf/src/lib/adminInventory.ts`
- Create: `apps/api-cf/test/admin-inventory.test.mjs`
- Modify: `apps/api-cf/src/lib/context.ts:6-43`
- Modify: `apps/api-cf/src/lib/b2Usage.ts:123-158`

**Interfaces:**
- Consumes: `Env`, `getTopology`, `getDb`, `resolveB2Accounts`, B2 credentials, D1 helpers.
- Produces:
  - `collectPeerInventory(env: Env, db: Db): Promise<PeerInventory>`; no provider token appears in return
  - `collectB2Inventory(env: Env, usageReader: B2UsageReader, now: number): Promise<InventoryB2Account[]>`
  - `getB2UsageSnapshot(env, accountName, index): Promise<{ bytes: number | null; updatedAt: number | null }>`
  - `B2UsageReader = (name: string, index: number) => Promise<{ bytes: number | null; updatedAt: number | null }>`

- [ ] **Step 0: Capture overlapping pre-existing diffs**

```bash
git diff -- apps/api-cf/src/lib/context.ts apps/api-cf/src/lib/b2Usage.ts packages/lb/accounts.ts packages/lb/provision.ts
```

Expected: unrelated service/security/storage changes may exist. Preserve them.

- [ ] **Step 1: Write failing collector tests**

Test local fallback, provider success, provider failure, and B2 validation with stubbed fetch/D1/KV:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPeerInventory, collectB2Inventory } from '../src/lib/adminInventory.ts';
import { getTopology } from '../src/lib/peers.ts';

const resource = (over = {}) => ({
  status: 'ok', source: 'live', observedAt: 1000, errorCode: null, ...over,
});

test('peer collector returns local fallback without CF token', async () => {
  const env = {
    DB: stubDb(), CACHE_KV: stubKv(), PEER_URLS: 'https://manga-api-x.acme.workers.dev',
    PEER_INDEX: '0', CF_WORKER_NAME: 'manga-api', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
  };
  const result = await collectPeerInventory(env, stubDb());
  assert.equal(result.account.name, 'acme');
  assert.equal(result.account.state.source, 'derived');
  assert.equal(result.worker.name, 'manga-api');
  assert.equal(result.d1.id, 'd1-1');
  assert.equal(result.self, true);
  assert.equal(result.topologyHash, getTopology(env).hash);
});

test('peer collector returns provider account name when token is configured', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/client/v4/graphql')) {
      return Response.json({ data: { viewer: { accounts: [{ kvStorageAdaptiveGroups: [] }] } } });
    }
    if (String(url).endsWith('/workers/scripts')) {
      return Response.json({ success: true, result: [{ id: 'manga-api', created_on: '2026-01-01T00:00:00Z', modified_on: '2026-09-25T00:00:00Z' }] });
    }
    if (String(url).includes('/storage/kv/namespaces')) {
      return Response.json({ success: true, result: [{ id: 'kv-1', title: 'Real KV', jurisdiction: 'us' }] });
    }
    if (String(url).includes('/d1/database/d1-1')) {
      return Response.json({ success: true, result: { uuid: 'd1-1', name: 'Real D1', file_size: 42, jurisdiction: 'us', running_in_region: 'wnam' } });
    }
    if (String(url).endsWith('/accounts/acct-1')) {
      return Response.json({ success: true, result: { id: 'acct-1', name: 'Real Cloudflare Name', type: 'standard' } });
    }
    return new Response('', { status: 404 });
  };
  const result = await collectPeerInventory(envWithCfToken(), stubDb());
  assert.equal(result.account.name, 'Real Cloudflare Name');
  assert.equal(result.account.state.source, 'live');
  assert.equal(result.d1.fileBytes, 42);
  assert.equal(result.kv.title, 'Real KV');
  assert.doesNotMatch(JSON.stringify(result), /inventory-secret/);
});

test('B2 failure preserves tracked bytes and null provider ID', async () => {
  globalThis.fetch = async () => new Response('denied', { status: 401 });
  const result = await collectB2Inventory(
    envWithB2(),
    async () => ({ bytes: 1234, updatedAt: 900 }),
    1000,
  );
  assert.equal(result[0].providerAccountId, null);
  assert.equal(result[0].trackedBytes, 1234);
  assert.equal(result[0].state.source, 'tracked');
  assert.doesNotMatch(JSON.stringify(result), /fake-key|fake-app/);
});

test('B2 success exposes allowlisted provider metadata and keeps bytes tracked', async () => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/b2_authorize_account')) {
      return Response.json({ accountId: 'b2-acct-1', apiUrl: 'https://api001.backblazeb2.com', authorizationToken: 'temporary-auth' });
    }
    if (u.endsWith('/b2_list_buckets')) {
      assert.equal(init.headers.Authorization, 'temporary-auth');
      return Response.json({ buckets: [{ bucketId: 'bucket-1', bucketName: 'manga-assets', bucketType: 'allPrivate', options: ['s3'] }] });
    }
    return new Response('', { status: 404 });
  };
  const result = await collectB2Inventory(
    envWithB2(),
    async () => ({ bytes: 2222, updatedAt: 900 }),
    1000,
  );
  assert.equal(result[0].providerAccountId, 'b2-acct-1');
  assert.equal(result[0].bucketId, 'bucket-1');
  assert.equal(result[0].state.source, 'live');
  assert.equal(result[0].trackedBytes, 2222);
  assert.doesNotMatch(JSON.stringify(result), /temporary-auth|fake-key|fake-app/);
});
```

Define `stubDb()` and `stubKv()` in test file with these exact methods used by collector: `getInventoryCounts()`, `listAccounts()`, `listOrigins()`, and KV `get()`. Return only allowlisted fixture rows; never put token fields in test input or expected output. `envWithCfToken()` sets fake `CF_INVENTORY_TOKEN='inventory-secret'`, `CF_ACCOUNT_ID='acct-1'`, `CF_D1_ID='d1-1'`, and `CF_KV_ID='kv-1'`; assert serialized output omits `inventory-secret`. `envWithB2()` returns one `B2_ACCOUNTS` entry with fake `keyId`/`appKey` strings used only to verify those fields never serialize. `collectB2Inventory` receives a `usageReader(name, index)` callback so unit test does not need Hono `Context`; production adapter wraps `getB2UsageSnapshot(env, ...)`. Restore `globalThis.fetch` after each test with `try/finally` or Node test `afterEach`.

- [ ] **Step 2: Run focused test and verify failure**

```bash
npx tsx --test apps/api-cf/test/admin-inventory.test.mjs
```

Expected: FAIL because collector module is missing.

- [ ] **Step 3: Extend `Env` with non-secret metadata and optional secret**

```ts
CF_ACCOUNT_ID?: string;
CF_WORKER_NAME?: string;
CF_D1_ID?: string;
CF_KV_ID?: string;
CF_INVENTORY_TOKEN?: string;
```

Do not add token to `[vars]`; document it as secret only.

- [ ] **Step 4: Implement safe local/provider collector**

Create helpers with fixed endpoints and 5-second timeout:

```ts
const CF_API = 'https://api.cloudflare.com/client/v4';

const cfJson = async <T>(token: string, path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`CF_HTTP_${res.status}`);
  const body = await res.json() as { success: boolean; result: T };
  if (!body.success) throw new Error('CF_PROVIDER_ERROR');
  return body.result;
};
```

`collectPeerInventory` must:

1. Build `getTopology(env)` and copy `topologyHash` into response.
2. Derive account subdomain from self Worker hostname as fallback.
3. Query fixed D1 counts and safe LB metadata independently with `Promise.allSettled`.
4. Read only `d1:usage` from KV.
5. If `CF_INVENTORY_TOKEN` and required IDs exist, query account, Worker list, D1 detail, KV namespace list, and one GraphQL storage query independently.
6. Return stable error codes, never caught provider bodies.
7. Ensure object contains no `CF_INVENTORY_TOKEN`, B2 `keyId`, or `appKey`.

GraphQL request body is fixed to:

```ts
const end = new Date(now);
const start = new Date(end.getTime() - 31 * 86400_000);
const body = {
  query: `query KvInventory($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      kvStorageAdaptiveGroups(
        filter: { namespaceId: $namespaceId, date_geq: $start, date_leq: $end }
        limit: 1
        orderBy: [date_DESC]
      ) { max { keyCount byteCount } dimensions { date } }
    } }
  }`,
  variables: {
    accountTag: env.CF_ACCOUNT_ID,
    namespaceId: env.CF_KV_ID,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  },
};
```

POST to `${CF_API}/graphql` with bearer token. Parse only first group `max` and `dimensions[0].date`; return null metrics when result is empty.

- [ ] **Step 5: Implement B2 authorization/list with tracked fallback**

Use native B2 endpoints documented by Backblaze (`b2_authorize_account` plus `b2_list_buckets`):

```ts
const auth = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
  method: 'GET',
  headers: {
    Authorization: `Basic ${btoa(`${account.keyId}:${account.appKey}`)}`,
  },
  signal: AbortSignal.timeout(5000),
});
```

Parse only `accountId`, `apiUrl`, `authorizationToken`. Support both B2 response shapes:

```ts
const apiUrl = typeof authBody.apiUrl === 'string'
  ? authBody.apiUrl
  : authBody.apiInfo?.storageApi?.apiUrl;
```

Reject response unless `accountId`, `apiUrl`, and `authorizationToken` are non-empty strings. POST `${apiUrl}/b2_list_buckets` with `accountId` and configured `bucketName`; require returned `bucketName === account.bucket`. Return bucket ID/name/type/options only. Fetch tracked bytes/timestamp through injected `usageReader(account.configuredName, index)`; production passes `(name, i) => getB2UsageSnapshot(env, name, i)`. Source becomes `tracked` on provider failure, `live` only for provider metadata fields, never for bytes.

- [ ] **Step 6: Run focused tests and API build**

```bash
npx tsx --test apps/api-cf/test/admin-inventory.test.mjs apps/api-cf/test/b2usage.test.mjs
npm run build --prefix apps/api-cf
```

Expected: PASS and TypeScript exit 0.

- [ ] **Step 7: Review checkpoint**

Do not commit. Review no-secret response shape and error-code sanitization before route exposure.

---

### Task 4: Internal Peer Inventory Endpoint

**Files:**
- Create: `apps/api-cf/test/helpers/inventory-fixture.mjs`
- Modify: `apps/api-cf/src/routes/internal.ts:19-72,176-293`
- Modify: `apps/api-cf/test/internal-route.test.mjs:1-99`

**Interfaces:**
- Consumes: `collectPeerInventory(env, db)`, existing internal auth rules, `getDb(env)`.
- Produces: `POST /api/_internal/admin/inventory?refresh=1` returning `{ data: PeerInventory }`.

- [ ] **Step 0: Capture overlapping pre-existing diff**

```bash
git diff -- apps/api-cf/src/routes/internal.ts apps/api-cf/test/internal-route.test.mjs
```

Expected: existing allowlist/security edits remain untouched.

- [ ] **Step 1: Add failing auth and response tests**

Extend existing test imports:

```js
import { getTopology } from '../src/lib/peers.ts';
import { peerInventoryFixture } from './helpers/inventory-fixture.mjs';
```

Then add:

```js
test('admin inventory rejects missing/wrong internal key', async () => {
  const missing = await app.request('/api/_internal/admin/inventory', { method: 'POST' }, stubEnv());
  assert.equal(missing.status, 403);
  const wrong = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-forward-key': 'wrong' },
  }, stubEnv());
  assert.equal(wrong.status, 403);
});

test('admin inventory returns fixed safe peer shape', async () => {
  const env = stubEnv({
    PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
    CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
  });
  const res = await app.request('/api/_internal/admin/inventory?refresh=1', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /CF_INVENTORY_TOKEN|keyId|appKey|encrypted_token/);
  const { data } = await JSON.parse(text);
  assert.equal(data.account.id, 'acct-1');
});

test('admin inventory rejects non-empty body', async () => {
  const res = await app.request('/api/_internal/admin/inventory', {
    method: 'POST',
    headers: { 'x-db-forward-key': 'sekret', 'content-type': 'application/json' },
    body: JSON.stringify({ resource: 'other-account' }),
  }, stubEnv());
  assert.equal(res.status, 400);
});

test('admin inventory caches fresh peer snapshot unless refresh=1', async () => {
  const env = stubEnv({
    PEER_URLS: 'https://manga-api.oktz.workers.dev', PEER_INDEX: '0',
    CF_WORKER_NAME: 'manga-api', CF_ACCOUNT_ID: 'acct-1', CF_D1_ID: 'd1-1', CF_KV_ID: 'kv-1',
  });
  const hash = getTopology(env).hash;
  env.CACHE_KV.store[`peer:inventory:v2:${hash}`] = JSON.stringify({ data: peerInventoryFixture({ topologyHash: hash, self: true }) });
  const cached = await app.request('/api/_internal/admin/inventory', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal((await cached.json()).data.account.name, 'Oktz');
  const refreshed = await app.request('/api/_internal/admin/inventory?refresh=1', {
    method: 'POST', headers: { 'x-db-forward-key': 'sekret' },
  }, env);
  assert.equal(refreshed.status, 200);
});
```

- [ ] **Step 2: Run test and verify route failure**

```bash
npx tsx --test apps/api-cf/test/internal-route.test.mjs
```

Expected: FAIL with 404.

- [ ] **Step 3: Add authenticated route**

Reuse constant-time forward/mirror validation. Accept only optional query flag `refresh=1`; ignore any request body and reject non-empty body with 400. Do not accept user-controlled resource names. Read `peer:inventory:v2:{hash}` from local `CACHE_KV`; return it when fresh unless `refresh=1`. On collection, write it for 300 seconds. Return `Cache-Control: no-store`, `Vary: Authorization, Cookie`, and `{ data }`. Provider subfailures remain embedded resource states; total local collection failure returns 500.

- [ ] **Step 4: Run route tests and build**

```bash
npx tsx --test apps/api-cf/test/internal-route.test.mjs
npm run build --prefix apps/api-cf
```

Expected: PASS/build exit 0.

- [ ] **Step 5: Review checkpoint**

Do not commit. Confirm POST body size remains zero/unused and endpoint cannot enumerate arbitrary resources.

---

### Task 5: Admin Inventory Coordinator, Cache, and Registration Merge

**Files:**
- Create: `apps/api-cf/src/routes/admin/inventory.ts`
- Create: `apps/api-cf/test/admin-inventory-route.test.mjs`
- Reuse: `apps/api-cf/test/helpers/inventory-fixture.mjs`
- Modify: `apps/api-cf/src/index.ts:14-18,112-119`

**Interfaces:**
- Consumes: `getTopology`, `fetchPeerInventory`, `collectPeerInventory`, `collectB2Inventory`, `Db.listAccounts`, `Db.listOrigins`, `AdminInventorySchema`.
- Produces:
  - `GET /api/admin/inventory` → `{ data: AdminInventory }`
  - `buildRegistrations(accounts, localAccounts, localOrigins): InventoryRegistration[]`
  - `buildAdminInventory(env, db, refresh, deps?)`; `deps = { fetchPeer?, collectSelf?, collectB2?, readCache?, writeCache? }`, production defaults to real collectors/cache

- [ ] **Step 0: Capture overlapping pre-existing diff**

```bash
git diff -- apps/api-cf/src/index.ts apps/api-cf/src/routes/origins.ts
```

Expected: service-gate/security work remains intact; mount only new router and origin-pool logic.

- [ ] **Step 1: Write failing coordinator tests**

Define complete `peerInventoryFor(url, refresh=false, topologyHash='peer-hash')`, `adminInventoryFixture`, `account(index, name)`, `origin(url, overrides)`, `envForCount(count)`, `fourPeerEnv`, `onePeerEnv`, and KV cache stub before tests. For N=0, `collectSelf` is not called; `buildAdminInventory` returns only empty topology/B2/registration data. `peerInventoryFor` wraps shared `peerInventoryFixture` and changes `account.id`, `account.name`, `worker.name`, and `topologyHash` deterministically from URL/hash. Every fixture must satisfy shared schemas; no test uses partial `{ topologyHash, self }` data. Cover N=0/1/2/4/5, four topology with two D1 accounts, partial failure, stale cache, topology mismatch, registrations:

```js
test('four topology peers remain visible with only two D1 accounts', async () => {
  const result = await buildAdminInventory(fourPeerEnv(refreshStub), stubDb({
    accounts: twoAccounts,
    origins: twoOrigins,
  }), false, {
    fetchPeer: async (_env, peer, refresh) => ({ ok: true, data: peerInventoryFor(peer.url, refresh) }),
    collectSelf: async () => peerInventoryFor('https://w0.test', false),
    collectB2: async () => [],
    readCache: async () => null,
  });
  assert.equal(result.topology.count, 4);
  assert.equal(result.accounts.length, 4);
  assert.equal(result.registrations.length, 0);
});

test('unreachable peer yields row plus warning', async () => {
  globalThis.fetch = async (url) => String(url).includes('w2')
    ? new Response('', { status: 503 })
    : Response.json({ data: peerInventoryFor(String(url)) });
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => String(peer.url).includes('w2')
      ? { ok: false, errorCode: 'PEER_HTTP_503' }
      : { ok: true, data: peerInventoryFor(peer.url) },
    collectSelf: async () => peerInventoryFor('https://w0.test'),
    collectB2: async () => [],
    readCache: async () => null,
  });
  assert.equal(result.accounts.length, 4);
  assert.equal(result.accounts[2].reachable, false);
  assert.ok(result.warnings.some((w) => w.code === 'PEER_HTTP_503'));
});

test('D1 account not in topology becomes pending registration', async () => {
  const result = await buildAdminInventory(onePeerEnv, stubDb({ accounts: [otherAccount] }), true, {
    fetchPeer: async () => ({ ok: false, errorCode: 'NOT_USED' }),
    collectSelf: async () => peerInventoryFor('https://w0.test'),
    collectB2: async () => [],
    readCache: async () => null,
  });
  assert.equal(result.registrations[0].topologyStatus, 'pending_topology');
});

test('N=0, 1, 2, 4, and 5 return exact account row count', async () => {
  for (const count of [0, 1, 2, 4, 5]) {
    const env = envForCount(count);
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => ({ ok: true, data: peerInventoryFor(peer.url) }),
    collectSelf: async () => peerInventoryFor('https://w0.test', false, getTopology(env).hash),
    collectB2: async () => [],
    readCache: async () => null,
  });
    assert.equal(result.accounts.length, count);
  }
});

test('stale cache is returned when refresh fan-out is all-failed', async () => {
  const env = fourPeerEnv();
  const cached = adminInventoryFixture({ observedAt: Date.now() - 600_000, stale: true });
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async () => ({ ok: false, errorCode: 'PEER_UNREACHABLE' }),
    collectSelf: async () => { throw new Error('self unavailable'); },
    collectB2: async () => [],
    readCache: async () => cached,
  });
  assert.equal(result.stale, true);
  assert.equal(result.accounts.length, 4);
  assert.ok(result.warnings.length > 0);
});

test('reachable peer with mismatched hash sets topology.consistent=false', async () => {
  const env = fourPeerEnv();
  const result = await buildAdminInventory(env, stubDb(), true, {
    fetchPeer: async (_env, peer) => ({
      ok: true,
      data: peerInventoryFor(peer.url, false, peer.url.includes('w2') ? 'different-hash' : getTopology(env).hash),
    }),
    collectSelf: async () => peerInventoryFor('https://w0.test', false, getTopology(env).hash),
    collectB2: async () => [],
    readCache: async () => null,
  });
  assert.equal(result.topology.consistent, false);
});
```

Also assert JSON text excludes `CF_INVENTORY_TOKEN`, `keyId`, `appKey`, `encrypted_token`.

- [ ] **Step 2: Run coordinator tests and verify failure**

```bash
npx tsx --test apps/api-cf/test/admin-inventory-route.test.mjs
```

Expected: FAIL because route/coordinator does not exist.

- [ ] **Step 3: Implement pure account registration builder**

Extract and test `buildRegistrations(accounts, localAccounts, localOrigins)` before coordinator fan-out. It returns one `InventoryRegistration` per unmatched local account. Attach first matching origin by `account_id`; if none, use `origin=null`. If either account or origin is unmatched, use `topologyStatus='pending_topology'`. Shared registration schema uses explicit `LbAccountSafeSchema.pick(...)`, so `token_last4` and `encrypted_token` cannot serialize.

- [ ] **Step 4: Implement deterministic topology-row merge**

For every topology peer:

- Self: call collector directly, avoiding self HTTP.
- Other peers: `fetchPeerInventory(env, peer, refresh)` in parallel.
- Failure: synthesize row with local/derived fallback values, `reachable=false`, and stable warning. Use peer index and normalized URL; set `account.id/name=null`, D1/KV identifiers from non-secret `Env` only for self, otherwise null.
- Peer `lb.account` and `lb.origins` remain safe metadata inside each topology row. Do not remove them.
- `buildRegistrations` uses topology rows' `account.id` and origins plus coordinator local D1 rows. Unmatched local account becomes registration; matched account with no matching origin becomes `pending_topology` registration using matching origin by `account_id` when available.
- `consistent=false` if any reachable peer hash differs from coordinator hash.
- Deduplicate registrations by `account.id`; never collapse topology rows.

- [ ] **Step 5: Implement coordinator cache and stale fallback**

Cache key:

```ts
const cacheKey = `admin:inventory:v2:${topology.hash}`;
```

- Normal request: read cached snapshot; if `Date.now() - observedAt < 300_000`, return it immediately.
- `?refresh=1`: bypass coordinator cache.
- Peer endpoint stores `peer:inventory:v2:{topologyHash}` in its local KV for 300 seconds. Normal internal call returns fresh peer cache; query `?refresh=1` bypasses it.
- Coordinator sends `?refresh=1` only when admin request bypasses coordinator cache; normal 30-second UI polling can use both cache layers.
- If refresh fan-out has failures but cached snapshot exists, merge warnings into stale snapshot and return `stale=true`.
- Never replace a good stale snapshot with an all-failed empty refresh.
- Write successful snapshots with 3600-second KV TTL; fresh threshold remains 300 seconds.

- [ ] **Step 6: Add admin route and mount**

`routes/admin/inventory.ts` uses `requireAdminSession`, `Cache-Control: no-store`, and:

```ts
router.get('/inventory', async (c) => {
  const refresh = c.req.query('refresh') === '1';
  const data = await buildAdminInventory(c.env, getDb(c), refresh);
  return json(c, { data });
});
```

Mount before monitoring router:

```ts
app.route('/api/admin', inventoryAdminRouter);
```

- [ ] **Step 7: Run coordinator, internal, and auth-related tests/build**

```bash
npx tsx --test apps/api-cf/test/admin-inventory-route.test.mjs apps/api-cf/test/internal-route.test.mjs apps/api-cf/test/peers.test.mjs
npm run build --prefix apps/api-cf
```

Expected: PASS/build exit 0.

- [ ] **Step 8: Review checkpoint**

Do not commit. Verify all four topology rows survive one failed peer and response has no secret field.

---

### Task 6: Topology-Derived Public Origin Pool

**Files:**
- Create: `apps/api-cf/src/lib/originPool.ts`
- Create: `apps/api-cf/test/origin-pool.test.mjs`
- Modify: `apps/api-cf/src/routes/origins.ts:7-52`

**Interfaces:**
- Consumes: `TopologySnapshot`, `LbOrigin[]`, topology hash.
- Produces:
  - `PublicOrigin = { url: string; priority: number; weight: number; healthy: boolean }`
  - `buildOriginPool(topology: TopologySnapshot, origins: LbOrigin[]): PublicOrigin[]`
  - `originCacheKey(hash: string): string`
  - Updated `GET /api/origins`.

- [ ] **Step 0: Capture overlapping pre-existing diff**

```bash
git diff -- apps/api-cf/src/routes/origins.ts apps/web/test/round-robin.test.ts apps/web/src/lib/api.ts
```

Expected: preserve current Dynamic-N test and failover behavior.

- [ ] **Step 1: Write failing origin-pool tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOriginPool, originCacheKey } from '../src/lib/originPool.ts';

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
```

- [ ] **Step 2: Run test and verify failure**

```bash
npx tsx --test apps/api-cf/test/origin-pool.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement pure origin merge**

Default per topology peer: priority=`index`, weight=1, healthy=true. Matching D1 origin overrides all fields. D1-only rows are ignored. Normalize URLs by trimming trailing slash. Return topology order.

- [ ] **Step 4: Rewire `/api/origins` cache**

Use `origins:v2:${topology.hash}`. D1 override changes within same topology should still reflect after 300 seconds; topology deploy changes key immediately. Keep five-minute SWR headers and usage increment behavior. Do not read `lb_settings.mode`.

- [ ] **Step 5: Run origin tests, peers, and web N-proof**

```bash
npx tsx --test apps/api-cf/test/origin-pool.test.mjs apps/api-cf/test/peers.test.mjs
TEST_ORIGINS=1 bun apps/web/test/round-robin.test.ts
TEST_ORIGINS=2 bun apps/web/test/round-robin.test.ts
TEST_ORIGINS=4 bun apps/web/test/round-robin.test.ts
TEST_ORIGINS=5 bun apps/web/test/round-robin.test.ts
```

For N=1/2 current test self-skips by design; command must exit 0, while pure origin pool tests assert N=1/2.

- [ ] **Step 6: Review checkpoint**

Do not commit. Confirm D1 seed of two no longer limits real pool to two.

---

### Task 7: Safe Account Add/Test and Pending-Topology Provision

**Files:**
- Modify: `packages/lb/accounts.ts:19-115`
- Modify: `packages/lb/provision.ts:15-220`
- Modify: `apps/api-cf/src/routes/admin/lb.ts:24-78,144-166`
- Modify: `packages/lb/test/accounts.test.mjs`
- Modify: `packages/lb/test/provision.test.mjs`

**Interfaces:**
- Consumes: provider APIs, `Db.addAccount`, `Db.updateAccountCredentialStatus`, `Db.createOrigin`.
- Produces:
  - `discoverCloudflareAccounts(token): Promise<CloudflareAccount[]>`
  - `CloudflareAccount = { id: string; name: string; type: string | null }`
  - `resolveCloudflareAccount(token, requestedId?): Promise<CloudflareAccount>`
  - `AccountSelectionRequiredError extends Error` with safe `accounts: CloudflareAccount[]`
  - `createAccount` input accepts `label?: string`; Cloudflare path stores discovered account name when label blank
  - `createAccount` persists discovered `account_ref`
  - `testAccount` updates DB status and `last_tested_at`
  - provision request accepts `accountId`; origin stores `enabled=0` and `account_ref`.

- [ ] **Step 0: Capture overlapping pre-existing diff**

```bash
git diff -- packages/lb/accounts.ts packages/lb/provision.ts apps/api-cf/src/routes/admin/lb.ts
```

Expected: preserve existing auth, audit, and provision behavior; this task changes identity selection/status/topology state only.

- [ ] **Step 1: Extend failing account tests**

Test one-account auto-select, multi-account explicit select, ambiguous error, persisted test status, and no token in errors:

```js
route('/client/v4/accounts', 200, { success: true, result: [
  { id: 'acct-1', name: 'Oktz' },
  { id: 'acct-2', name: 'Account Two' },
] });

await assert.rejects(
  resolveCloudflareAccount('multi-token'),
  /account selection required/
);
const selected = await resolveCloudflareAccount('multi-token', 'acct-2');
assert.equal(selected.id, 'acct-2');
```

Add DB stub assertion:

```js
assert.deepEqual(statusWrites[0], ['failed', 1234, 'acc-1']);
```

- [ ] **Step 2: Run LB tests and verify failure**

```bash
npx tsx --test packages/lb/test/accounts.test.mjs packages/lb/test/provision.test.mjs
```

Expected: FAIL because discovery/persistence interfaces are missing.

- [ ] **Step 3: Implement Cloudflare account discovery**

Call `/accounts?per_page=50`, return allowlisted `{ id, name, type }`. Sanitize errors to stable codes. If requested ID exists, select it. If exactly one account exists, select it. Otherwise throw:

```ts
export class AccountSelectionRequiredError extends Error {
  constructor(readonly accounts: CloudflareAccount[]) {
    super('account selection required');
  }
}
```

Route catches only this class and returns HTTP 409; other errors remain sanitized HTTP failure. In `createAccount`, use `input.label?.trim() || selected.name` as stored label.

- [ ] **Step 4: Persist credential test result**

`testAccount` reads provider plus encrypted token, verifies, then calls `updateAccountCredentialStatus(id, status, now)`. Empty encrypted seed returns `unavailable` and persists `unverified`; no decrypt exception body reaches frontend.

- [ ] **Step 5: Make provision explicit and pending**

Add `accountId?: string` to input. Resolve account identity. Persist `account_ref`. Deploy child metadata with non-secret `CF_ACCOUNT_ID`, `CF_WORKER_NAME`, `CF_D1_ID`, `CF_KV_ID`; set `CF_INVENTORY_TOKEN` secret only when `ProvisionEnv` includes explicit `CF_INVENTORY_TOKEN` supplied by operator, never reuse mutable DB token automatically. Insert origin with `enabled=0`. Do not read or modify `PEER_URLS`.

- [ ] **Step 6: Add route runtime validation**

- Restrict `accountId` to 32-char hex for Cloudflare.
- Require token and worker name; allow blank label so server uses discovered real name. Cap label at 100 chars and worker name at 63 chars.
- Use admin identity for `created_by`.
- Return 409 `{ error: 'account selection required', accounts: [...] }` for ambiguity.
- Return sanitized provision job state.

- [ ] **Step 7: Run LB tests and builds**

```bash
npx tsx --test packages/lb/test/accounts.test.mjs packages/lb/test/provision.test.mjs packages/lb/test/crypto.test.mjs
npx tsc --noEmit -p packages/lb
npm run build --prefix apps/api-cf
```

Expected: PASS/build exit 0.

- [ ] **Step 8: Review checkpoint**

Do not commit. Verify new origin is disabled and no code path writes topology vars.

---

### Task 8: Frontend Inventory Model and Reusable Resource Sections

**Files:**
- Create: `apps/web/src/lib/adminInventory.ts`
- Create: `apps/web/test/admin-inventory.test.ts`
- Create: `apps/web/src/components/admin/InventorySections.tsx`
- Modify: `apps/web/package.json:10-13`
- Modify: `apps/web/src/components/admin/charts.tsx:233-353`

**Interfaces:**
- Consumes: `AdminInventory` shared schema/type.
- Produces:
  - `filterInventory(inventory, query): AdminInventoryView`
  - `coverage(inventory): InventoryCoverage`
  - `AdminInventoryView = ReturnType<typeof filterInventory>` with `visibleAccounts`, `visibleD1`, `visibleKv`, `visibleB2`, `visibleRegistrations`
  - `InventoryCoverage = { configured: number; reachable: number; liveAccounts: number; d1: number; kv: number; b2: number }`
  - `InventorySections`, `TopologySection`, `D1Section`, `KVSection`, `B2Section`, `InventoryWarningBanner`
  - `formatSource`, `formatStatus`, `formatObservedAt`.

- [ ] **Step 0: Capture overlapping pre-existing diff**

```bash
git diff -- apps/web/src/components/pages/AdminSettings.tsx apps/web/src/components/pages/AdminDashboard.tsx apps/web/src/components/pages/AdminMonitoring.tsx apps/web/src/components/admin/charts.tsx
```

Expected: Settings may be clean; other files may contain unrelated admin changes. Preserve all.

- [ ] **Step 1: Write failing pure frontend tests**

```ts
import assert from 'node:assert/strict';
import { filterInventory, coverage } from '../src/lib/adminInventory';

const inventory = {
  observedAt: 1000,
  stale: false,
  topology: { source: 'PEER_URLS', count: 4, hash: 'h', consistent: true },
  accounts: [
    account({ index: 0, url: 'https://manga-api.oktz.workers.dev', name: 'Oktz' }),
    account({ index: 1, url: 'https://manga-api-2.tzok5555.workers.dev', name: 'Tzok' }),
    account({ index: 2, url: 'https://manga-api-3.dwikaoktyffan.workers.dev', name: 'Dwika' }),
    account({ index: 3, url: 'https://manga-api-4.oktznih.workers.dev', name: 'Nih' }),
  ],
  registrations: [], b2: [], warnings: [],
};

const result = filterInventory(inventory, 'dwika');
assert.equal(result.visibleAccounts, 1);
assert.equal(result.visibleAccounts[0].account.name, 'Dwika');

const c = coverage(inventory);
assert.deepEqual(c, { configured: 4, reachable: 4, liveAccounts: 4, d1: 4, kv: 4, b2: 0 });
```

Add cases for N=0, all unavailable, stale, and no slice.

- [ ] **Step 2: Run test and verify failure**

```bash
bun test apps/web/test/admin-inventory.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement pure frontend model**

Normalize unknown/missing fields defensively without silently inventing values. Search across account name, ID, Worker, URL, D1 name/ID, KV title/ID, B2 alias/bucket. Preserve original `accounts.length` in coverage. Return `visibleAccounts`, `visibleD1`, `visibleKv`, `visibleB2`, and `visibleRegistrations`.

- [ ] **Step 4: Add script and build reusable sections**

Update web test script:

```json
"test": "bun test test/canonical-url.test.ts test/round-robin.test.ts test/admin-inventory.test.ts"
```

Build accessible cards using existing `Card`, `CardHead`, `EmptyState`, `fmtBytes`, `fmtNum`. Every source/status badge has visible text; no color-only meaning. Render all rows, not `.slice(0, 6)`. B2 card always labels bytes `tracked`.

- [ ] **Step 5: Replace `StorageDonut` misleading zero semantics**

Change `StorageDonut` input so unknown bytes remain `null` and displays coverage. Preserve tracked B2 donut only when values exist; do not render provider-live label for B2 bytes. Avoid new chart dependency.

- [ ] **Step 6: Run frontend tests/build**

```bash
npm test --prefix apps/web
npm run lint --prefix apps/web
npm run build --prefix apps/web
```

Expected: tests PASS, `astro check` exits 0, build exits 0.

- [ ] **Step 7: Review checkpoint**

Do not commit. Check 0/1/4/N rendering, long URLs, mobile overflow, and accessible source labels.

---

### Task 9: Integrate Settings, Dashboard, and Monitoring

**Files:**
- Modify: `apps/web/src/components/pages/AdminSettings.tsx:23-1087`
- Modify: `apps/web/src/components/pages/AdminDashboard.tsx:10-622`
- Modify: `apps/web/src/components/pages/AdminMonitoring.tsx:6-228`

**Interfaces:**
- Consumes: `InventorySections`, `filterInventory`, `coverage`, `GET /api/admin/inventory`.
- Produces: inventory-driven Settings tabs/cards and shared resource widgets.

- [ ] **Step 0: Re-check component diffs after reusable section lands**

```bash
git diff -- apps/web/src/components/pages/AdminSettings.tsx apps/web/src/components/pages/AdminDashboard.tsx apps/web/src/components/pages/AdminMonitoring.tsx
```

Expected: only inventory-owned hunks from this plan should be added; unrelated user hunks remain.

- [ ] **Step 1: Add pure UI tests before component edits**

Extend `admin-inventory.test.ts` with model assertions for:

```ts
assert.equal(inventory.accounts.length, 4);
assert.equal(filterInventory(inventory, '').visibleAccounts, 4);
assert.equal(coverage({ ...inventory, accounts: inventory.accounts.slice(0, 2) }).configured, 4);
assert.equal(coverage({ ...inventory, accounts: inventory.accounts.slice(0, 2) }).reachable, 2);
```

- [ ] **Step 2: Run and verify expected failure**

```bash
bun test apps/web/test/admin-inventory.test.ts
```

Expected: FAIL until coverage semantics are implemented.

- [ ] **Step 3: Refactor Settings data load**

Replace nine mixed storage/LB calls with:

```ts
const inventory = await apiGet<{ data: AdminInventory }>(
  `/api/admin/inventory${forceRefresh ? '?refresh=1' : ''}`
);
```

Keep overview/source/request metrics separate. Initial 30-second refresh remains; manual refresh uses `refresh=1`. Each failed inventory response preserves prior inventory and shows stale/error banner.

- [ ] **Step 4: Build Settings resource tabs**

Tabs:

```ts
const TABS = [
  { key: 'topology', label: 'Topology' },
  { key: 'd1', label: 'D1' },
  { key: 'kv', label: 'KV' },
  { key: 'b2', label: 'B2' },
  { key: 'credentials', label: 'Kredensial' },
] as const;
```

Use `InventorySections`. Search filters all resources. Remove inert Mode/native CF/steering/health timing controls from primary UI. Keep add/test/provision forms. Make account label optional (`placeholder="Nama akun (opsional)"`), change manual token inputs to `type="password"`, `autoComplete="new-password"`. For provision, include optional `accountId`; show pending-topology steps. On 409 `account selection required`, populate account select from response `accounts`, keep token only in component state until resubmission, and never write it to localStorage/sessionStorage.

- [ ] **Step 5: Update Dashboard**

Replace local `LbAccount[]`, `LbOrigin[]`, and storage account assumptions with inventory data. LB table rows come from `inventory.accounts`; B2 cards come from `inventory.b2`; coverage sublabels use `reachable/configured`. Keep existing source/request/user panels. Fix existing bare-array `/lb/origins` mismatch by no longer calling that endpoint for resource identity.

- [ ] **Step 6: Update Monitoring**

Replace local `dbUsage.current` resource cards with D1/KV sections from inventory. Keep source health and scrape log calls. Preserve `db_usage_snapshot` only in a card titled `Snapshot lokal`; never present it as provider-live.

- [ ] **Step 7: Run web tests, lint, build**

```bash
npm test --prefix apps/web
npm run lint --prefix apps/web
npm run build --prefix apps/web
```

Expected: all PASS/exit 0. If `astro check` reports pre-existing error, record exact baseline and ensure no new errors; target is zero new diagnostics.

- [ ] **Step 8: Review checkpoint**

Do not commit. Verify Settings, Dashboard, and Monitoring all show same four topology accounts and same source labels.

---

### Task 10: Deployment Configuration and Operational Documentation

**Files:**
- Modify: `apps/api-cf/wrangler.toml:30-34`
- Modify: `apps/api-cf/wrangler.origin.toml:21-25`
- Modify: `apps/api-cf/wrangler.origin3.toml:21-25`
- Modify: `apps/api-cf/wrangler.origin4.toml:21-25`
- Modify: `apps/api-cf/.dev.vars.example:1-13`
- Modify: `docs/DEPLOY.md:110-122`
- Test: `apps/api-cf/test/wrangler-inventory-config.test.mjs` (create first)

**Interfaces:**
- Consumes: each Wrangler file's existing `name`, `account_id`, D1 ID, KV ID.
- Produces: non-secret metadata vars and exact secret/deploy procedure.

- [ ] **Step 0: Capture existing Wrangler diffs**

```bash
git diff -- apps/api-cf/wrangler.toml apps/api-cf/wrangler.origin.toml apps/api-cf/wrangler.origin3.toml apps/api-cf/wrangler.origin4.toml docs/DEPLOY.md
```

Expected: preserve unrelated vars/auth-key/peer changes.

- [ ] **Step 1: Add config parity self-check**

Create `apps/api-cf/test/wrangler-inventory-config.test.mjs` first using `node:test`, `node:assert/strict`, and `node:fs`. Test parses all four TOML files without a TOML dependency. It asserts each file has exactly one `CF_ACCOUNT_ID`, `CF_WORKER_NAME`, `CF_D1_ID`, and `CF_KV_ID`, and each value equals that same file's `account_id`, `name`, `database_id`, and namespace `id`. It also asserts no `CF_INVENTORY_TOKEN =` assignment exists.

Run:

```bash
npx tsx --test apps/api-cf/test/wrangler-inventory-config.test.mjs
```

Expected before implementation: FAIL because metadata vars are absent. After adding vars, rerun same test and require PASS. Then use read-only shell parity check as second verification:

```bash
for f in apps/api-cf/wrangler.toml apps/api-cf/wrangler.origin.toml apps/api-cf/wrangler.origin3.toml apps/api-cf/wrangler.origin4.toml; do
  printf '%s ' "$f"
  rg -c '^(CF_ACCOUNT_ID|CF_WORKER_NAME|CF_D1_ID|CF_KV_ID) = ' "$f"
done
```

Expected before implementation: count `0`; after: count `4` for each file.

- [ ] **Step 2: Add metadata vars without duplicating resource IDs incorrectly**

Each file gets exact values from its own top-level config. Implementer copies values already present in that same file; no value is guessed. Expected mapping:

```text
wrangler.toml:          manga-api, account 1, D1 1, KV 1
wrangler.origin.toml:   manga-api-2, account 2, D1 2, KV 2
wrangler.origin3.toml:  manga-api-3, account 3, D1 3, KV 3
wrangler.origin4.toml:  manga-api-4, account 4, D1 4, KV 4
```

Resulting shape in every file:

```toml
CF_ACCOUNT_ID = "<same-file account_id>"
CF_WORKER_NAME = "<same-file name>"
CF_D1_ID = "<same-file database_id>"
CF_KV_ID = "<same-file namespace id>"
```

Before writing, run `rg -n '^(name|account_id|database_id|id) = ' <same-file>` and copy exact adjacent values.

Do not paste one account's IDs into another file. Do not commit `CF_INVENTORY_TOKEN`. Add blank `CF_INVENTORY_TOKEN=` plus blank `CF_ACCOUNT_ID=`, `CF_WORKER_NAME=`, `CF_D1_ID=`, and `CF_KV_ID=` entries to `.dev.vars.example` for local fallback testing.

Rerun:

```bash
npx tsx --test apps/api-cf/test/wrangler-inventory-config.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Document secret and activation order**

Add exact operator commands. Each command prompts for token; do not put token value in command or file:

```bash
npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.toml
npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.origin.toml
npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.origin3.toml
npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.origin4.toml
```

Document token permissions and migration order:

1. Apply `0020_admin_inventory.sql` to every D1.
2. Deploy API Workers with metadata vars.
3. Set `CF_INVENTORY_TOKEN` per Worker/account.
4. Verify `/api/admin/inventory` reports same topology hash and live names.
5. Only then manually update every `PEER_URLS` when adding/removing Worker.

- [ ] **Step 4: Run config parity and secret leak scans**

```bash
for f in apps/api-cf/wrangler*.toml; do
  test "$(rg -c '^(CF_ACCOUNT_ID|CF_WORKER_NAME|CF_D1_ID|CF_KV_ID) = ' "$f")" = 4 || exit 1
done
! rg -n 'CF_INVENTORY_TOKEN\s*=\s*"[^"[:space:]]+' apps/api-cf/wrangler*.toml
```

Expected: both exit 0.

- [ ] **Step 5: Review checkpoint**

Do not deploy or set secrets without explicit user request. Review only non-secret config/documentation changes.

---

### Task 11: Full Verification and Adversarial Review

**Files:**
- Review all changed files from Tasks 1-10.
- Do not edit unrelated dirty files.

**Interfaces:**
- Consumes: complete implementation.
- Produces: command evidence, no-secret evidence, final review verdict.

- [ ] **Step 1: Run focused backend tests**

```bash
npx tsx --test \
  apps/api-cf/test/peers.test.mjs \
  apps/api-cf/test/internal-route.test.mjs \
  apps/api-cf/test/admin-inventory.test.mjs \
  apps/api-cf/test/admin-inventory-route.test.mjs \
  apps/api-cf/test/origin-pool.test.mjs \
  apps/api-cf/test/b2usage.test.mjs \
  apps/api-cf/test/wrangler-inventory-config.test.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run LB and DB tests**

```bash
npx tsx --test packages/lb/test/accounts.test.mjs packages/lb/test/provision.test.mjs packages/lb/test/crypto.test.mjs
npx tsx --test packages/db/test/admin-inventory.test.mjs packages/db/test/user-profile.test.mjs packages/db/test/matching.test.mjs
```

Expected: all PASS.

- [ ] **Step 3: Run web tests and dynamic-N proof**

```bash
npm test --prefix apps/web
TEST_ORIGINS=1 bun apps/web/test/round-robin.test.ts
TEST_ORIGINS=2 bun apps/web/test/round-robin.test.ts
TEST_ORIGINS=4 bun apps/web/test/round-robin.test.ts
TEST_ORIGINS=5 bun apps/web/test/round-robin.test.ts
```

Expected: PASS. N=1 and N=2 report existing self-check skip; command exits 0, while pure origin-pool tests prove N=1/2.

- [ ] **Step 4: Run API test suite, typechecks/build/lint**

```bash
npx tsx --test apps/api-cf/test/*.test.mjs
npm run build --prefix apps/api-cf
npm run lint --prefix apps/web
npm run build --prefix apps/web
npx tsc --noEmit -p packages/shared
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p packages/lb
```

Expected: all exit 0.

- [ ] **Step 5: Run no-secret and diff checks**

```bash
git diff --check
! git diff | rg -n '(CF_INVENTORY_TOKEN\s*=|"appKey"\s*:|"keyId"\s*:|Bearer [A-Za-z0-9_-]{20,})'
git status --short
```

Expected: `diff --check` exit 0, secret scan finds nothing, status lists only intended files plus pre-existing user changes.

- [ ] **Step 6: Run adversarial review**

Provide reviewer complete `git diff` plus test output. Require explicit checks for:

- topology row preservation under partial failure;
- no secret leakage;
- D1 two-row vs topology four-row behavior;
- N=0/1/2/4/5 behavior;
- cache invalidation by topology hash;
- disabled provision origin;
- no automatic `PEER_URLS` edit.

Fix every real finding and rerun affected tests.

- [ ] **Step 7: Final review checkpoint**

Do not commit, deploy, apply remote migrations, or set secrets without explicit user request. Report changed files, skipped external actions, and exact verification results.
