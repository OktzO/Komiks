# Dynamic Admin Resource Inventory Design

**Date:** 2026-09-25  
**Status:** Approved in chat; awaiting written-spec review  
**Scope:** `/admin/settings` and shared admin resource widgets

## Problem

Admin UI already renders account and origin arrays dynamically, but its only inventory source is one Worker's local D1 rows. Migration `0005_user_profile.sql` seeds two `lb_accounts` rows and two `lb_origins` rows. Production topology contains four Workers in `PEER_URLS`; Workers 3 and 4 were added without corresponding LB metadata rows.

Result:

- Settings shows two accounts although runtime topology has four.
- Arbitrary labels such as `Akun 1 (main)` appear instead of live Cloudflare account names.
- B2 usage, D1 size, and KV data mix provider truth with application counters without exposing source or freshness.
- Public `/api/origins` also reads only local D1, so two-row metadata limits actual load-balancer pool to two origins.
- Adding or provisioning an account writes local D1 but does not update runtime topology, creating silent drift.

Existing uncommitted dynamic-peer work must be preserved.

## Goals

1. Display every account in active `PEER_URLS` topology, regardless of local D1 row count.
2. Show real provider names and safe resource metadata for Cloudflare accounts, Workers, D1, KV, and B2.
3. Label every value by source and freshness: live provider data, application-tracked data, local data, derived identity, or unavailable.
4. Keep UI functional for 0, 1, 2, 4, or N accounts.
5. Make public origin routing follow topology, not stale D1 membership.
6. Preserve safe account actions without automatically changing shard topology.
7. Show partial results when one peer or provider fails.

## Non-goals

- No automatic insertion of a new Worker into `PEER_URLS` on every Worker.
- No secret, raw token, KV value, B2 credential, or arbitrary database row exposed to browser. `CF_INVENTORY_TOKEN` is optional; without it, local metadata and clearly labeled derived names remain available.
- No exact B2 bucket byte total. B2 list APIs do not provide aggregate stored bytes; current application counter remains explicitly labeled `tracked`.
- No full KV key/value dump or arbitrary B2 object scan.
- No unrelated redesign of admin users, logs, merge, scrape, or saved-content workflows.

## Chosen Architecture

Use peer fan-out.

Each API Worker exposes one authenticated internal inventory endpoint. Admin coordinator calls all peers from `getPeers(env)`, including self, in parallel. Every peer reports its own local resources and optional live provider metadata. Coordinator merges topology membership with safe D1 metadata and returns one partial result.

This is preferred over centralizing every provider token in one Worker and over replicating snapshots into D1:

- Provider credentials remain near their account.
- Runtime topology stays authoritative.
- One failed peer does not blank the page.
- D1 becomes optional metadata rather than account-count source.

## Runtime Topology

`PEER_URLS` defines topology membership. Its array length is N; no expected count exists.

For each normalized peer URL:

- `index` is position in topology.
- `self` marks current Worker.
- D1 `lb_origins` row matching URL supplies optional `priority`, `weight`, `enabled`, and last health status.
- Missing D1 origin row uses defaults: enabled, never-checked, weight 1.
- D1 origin not present in `PEER_URLS` is metadata-only and never enters public traffic.
- D1 `lb_accounts` row matching `account_ref` supplies credential test metadata and operator label.
- Missing D1 account row does not hide topology peer.

Each peer reports topology hash and self index. Coordinator marks `consistent=false` when peers disagree, while still returning all readable data.

## Internal Peer Inventory

Add `POST /api/_internal/admin/inventory`, authenticated with existing `x-db-forward-key` or `x-db-mirror-key` behavior. It performs no user-controlled query and returns fixed, allowlisted fields.

Local data available without provider credentials:

- Peer index, URL, self flag, topology hash.
- Cloudflare account ID from new non-secret `CF_ACCOUNT_ID` runtime var.
- Worker name from new non-secret `CF_WORKER_NAME` runtime var; fallback derived from Worker hostname.
- D1 ID from new non-secret `CF_D1_ID` runtime var.
- KV namespace ID from new non-secret `CF_KV_ID` runtime var.
- D1 liveness and fixed application counts: series, chapters, chapter pages, users, bookmarks.
- Known operational KV counters used by the app, such as `d1:usage`; these are not presented as total KV storage.
- Safe D1 `lb_accounts` and `lb_origins` metadata without encrypted tokens.

If `CF_INVENTORY_TOKEN` secret exists, peer also queries Cloudflare:

- `GET /accounts/{CF_ACCOUNT_ID}` for actual account name and type.
- Workers scripts list for actual Worker name, created time, and modified time.
- D1 database detail for actual database name, UUID, file size, jurisdiction, and region.
- KV namespace list, matched to `CF_KV_ID`, for actual title, ID, and jurisdiction.
- GraphQL `kvStorageAdaptiveGroups` for latest available namespace `keyCount` and `byteCount`.

Required token permissions: Account Settings Read, Workers Scripts Read, D1 Read, Workers KV Storage Read, and GraphQL Analytics Read for storage metrics. Missing any permission or token produces local fallback plus warning; it does not fail peer response.

Without live account details, display name falls back to Workers.dev account subdomain parsed from peer URL. Source is labeled `derived`, not presented as provider-confirmed.

## B2 Inventory

B2 configuration is already dynamic through `B2_CONFIG` and `B2_ACCOUNTS`. Coordinator validates each configured account once using B2 Native API:

1. `b2_authorize_account` with account ID and application key.
2. `b2_list_buckets` for configured bucket.

Return configured alias, actual B2 account ID, bucket ID, bucket name, bucket type, and available options. B2 Native API does not return aggregate bucket bytes; existing D1/KV counter is returned as `tracked_bytes` with update time. Missing provider data never becomes numeric zero unless a real zero is known.

## Admin Inventory Contract

Add `GET /api/admin/inventory`, protected by `requireAdminSession` and `Cache-Control: no-store`.

Top-level response:

```ts
type AdminInventory = {
  observedAt: number;
  topology: {
    source: 'PEER_URLS';
    count: number;
    hash: string;
    consistent: boolean;
  };
  accounts: InventoryAccount[];
  registrations: InventoryRegistration[];
  b2: InventoryB2Account[];
  warnings: InventoryWarning[];
};
```

Each resource carries explicit state:

```ts
type ResourceState = {
  status: 'ok' | 'degraded' | 'unavailable';
  source: 'live' | 'local' | 'tracked' | 'derived' | 'unavailable';
  observedAt: number | null;
  errorCode: string | null;
};
```

`InventoryAccount` includes topology index, URL, reachability, account name/ID, Worker metadata, D1 metadata and counts, KV metadata, and per-resource states. `InventoryRegistration` contains credential/origin rows not matched to a topology peer, including `topologyStatus=registered|pending_topology`. Raw error bodies and provider messages are not returned; warning codes are stable and admin-readable.

Coordinator behavior:

- Fetch all peers with `Promise.allSettled`.
- Use short per-peer timeout.
- Always return rows for configured topology URLs.
- Mark unreachable peers `degraded` or `unavailable`.
- Use local fallback values when provider call fails.
- Cache successful aggregate snapshots in coordinator KV for one hour, keyed by topology hash; treat snapshots younger than five minutes as fresh and older snapshots as stale fallback. Each peer also caches its own fixed inventory for five minutes; manual admin refresh bypasses both cache layers.
- Return stale successful snapshot when current refresh fails, with stale warning.
- Manual refresh sends `?refresh=1`; it bypasses coordinator and peer inventory caches.
- Never return HTTP 500 merely because one source fails.

## Settings UI

Replace current account-count cards with resource-oriented bento sections.

### Summary

- Configured topology count.
- Reachable peer count.
- Live provider metadata count.
- D1/KV/B2 coverage.
- Last refresh and partial-failure banner.

### Topology

Render every topology row. Columns or detail fields:

- Actual Cloudflare account name when live; derived hostname fallback otherwise.
- Account ID.
- Worker name and shard index.
- Reachability and last check.
- D1 LB registration status.
- Origin enable/priority/weight metadata.
- Credential metadata state, never token value.

No `.slice(0, 6)` hiding. Search filters all rows and shows `visible/total`.

### D1

One dynamic card per peer:

- Name, UUID, region, provider file size.
- Local series, chapter, page, user, and bookmark counts.
- Live/local/estimated source label.
- Coverage summary across all topology shards.

### KV

One dynamic card per peer:

- Namespace title and ID.
- Jurisdiction.
- Latest provider key count and byte count when GraphQL has data.
- Safe operational counters separately labeled.
- No raw keys or values.

### B2

One dynamic card per resolved B2 config entry:

- Configured alias.
- Actual B2 account ID.
- Bucket ID and name.
- Live bucket type/options.
- Tracked bytes, quota, and counter update time.
- Provider validation status.

### Runtime state

Runtime state is derived from topology: `active` when at least one peer is configured, `single` when N=1, and `unavailable` when N=0. Existing `lb_settings` rows remain stored for backward compatibility but no field is shown or treated as runtime truth until it has an effective consumer. The current `mode`, `native_cf`, steering, and health-timing controls leave the primary settings UI.

## Public Origin Routing

Change `GET /api/origins` to derive membership from `PEER_URLS`, not local D1.

Algorithm:

1. Start with every unique normalized URL in current `PEER_URLS`.
2. Apply matching D1 origin override for priority, weight, enabled, and health.
3. Exclude explicitly disabled or known unhealthy peers.
4. Ignore D1-only origins.
5. If all topology peers are excluded, return no origins so client fallback remains unchanged.
6. Cache payload under topology-hash version so topology changes invalidate old pool immediately.

Existing client round-robin and retry behavior remains. No fixed retry count or account count is introduced. `lb_settings` does not gate routing because it is local per shard and currently has no effective runtime consumer.

## Mutations

### Add credential

- Keep manual add and test actions.
- Token input uses `type="password"` and never returns token.
- Backend verifies token, discovers accessible account metadata when unambiguous, encrypts token, and stores `account_ref`.
- If token reaches multiple accounts and no account was selected, return safe account choices; never silently choose first account.
- Provider credential status stays separate from topology status: `credentialStatus` describes token verification, while `topologyStatus` is `active`, `registered`, or `pending_topology`.
- Account appears as `registered / pending topology` until its Worker URL exists in `PEER_URLS`.

### Test credential

- Decrypt server-side.
- Revalidate provider token.
- Update `lb_accounts.status` and `last tested` metadata.
- Return sanitized result.
- Placeholder seed rows without usable encrypted token become `unavailable`, not falsely `verified`.

### Provision

- Keep Worker/D1/KV provisioning.
- Select requested Cloudflare account explicitly when token has multiple accounts.
- Store actual `account_ref` and actual Worker metadata.
- Set new origin `enabled=0`; expose `topologyStatus=pending_topology` from inventory merge rather than adding a routing state to `lb_origins`.
- Never update `PEER_URLS` automatically.
- UI shows exact manual activation steps: add URL to every Worker topology, verify identical hash, deploy coordinated config, then enable origin.

### Delete

Do not expose account deletion in inventory UI. Existing delete route remains admin-authenticated but is not linked from topology inventory; FK-safe deletion semantics are outside this change.

## Other Admin Resource Widgets

`AdminDashboard` and `AdminMonitoring` resource cards consume same inventory contract. They must not independently assume local B2/D1/KV state. `AdminSaved` remains content inventory and is not changed unless it displays account/resource counts.

## Security

- Internal inventory endpoint requires constant-time internal key validation.
- Response schema is fixed and allowlisted.
- No arbitrary SQL, KV key, D1 row, token, authorization header, or provider response body.
- `CF_INVENTORY_TOKEN` remains Worker secret.
- Provider errors map to stable warning codes.
- Admin responses remain `no-store`.
- Inputs validate URLs, enum values, numeric ranges, and body size.
- Cloudflare/B2 credentials never enter frontend state.

## Testing

Add runnable tests before implementation:

1. Topology and inventory merge for N=0, 1, 2, 4, and 5.
2. Missing self index, duplicate peers, and topology hash mismatch.
3. One peer timeout/unreachable while others succeed.
4. Provider auth failure with local fallback.
5. D1 row count 2 with topology count 4.
6. D1 origin present but absent from topology stays excluded.
7. Topology origin missing D1 row remains visible and routable.
8. Explicit D1 disable/health exclusion works.
9. Empty `PEER_URLS` returns an empty pool; one peer returns one origin; local `lb_settings` does not change topology membership.
10. Public origin cache changes when topology hash changes.
11. B2 zero, one, and multiple configs; provider failure returns tracked fallback.
12. Internal and admin responses contain no known secret fields.
13. Provision creates disabled pending-topology origin and never edits `PEER_URLS`.
14. Account test persists new status.
15. UI pure reducers handle empty, partial, stale, and all-warning states.

Verification commands:

```bash
npx tsx --test apps/api-cf/test/*.test.mjs
npm run build --prefix apps/api-cf
npm test --prefix apps/web
npm run lint --prefix apps/web
npm run build --prefix apps/web
npx tsx --test packages/db/test/*.test.mjs
npx tsx --test packages/lb/test/*.test.mjs
```

Use current uncommitted dynamic-N tests as baseline; do not overwrite unrelated worktree changes.

## Files Expected to Change

- `apps/api-cf/src/lib/context.ts`
- `apps/api-cf/src/lib/adminInventory.ts` (new, if extraction keeps routes small)
- `apps/api-cf/src/routes/internal.ts`
- `apps/api-cf/src/routes/admin/inventory.ts` (new)
- `apps/api-cf/src/index.ts` for admin route mount
- `apps/api-cf/src/routes/admin/lb.ts`
- `apps/api-cf/src/routes/origins.ts`
- `packages/db/index.ts`
- `packages/db/schema.sql` and one new migration for `lb_accounts.last_tested_at` plus registered/pending state
- `packages/lb/accounts.ts`
- `packages/lb/provision.ts`
- `packages/shared/types.ts`
- `apps/web/src/components/pages/AdminSettings.tsx`
- `apps/web/src/components/pages/AdminDashboard.tsx`
- `apps/web/src/components/pages/AdminMonitoring.tsx`
- `apps/web/src/components/admin/*` or one focused inventory component file
- `apps/api-cf/wrangler.toml`
- `apps/api-cf/wrangler.origin.toml`
- `apps/api-cf/wrangler.origin3.toml`
- `apps/api-cf/wrangler.origin4.toml`
- relevant tests and deployment documentation

## Acceptance Criteria

- Four configured Workers display as four topology accounts even when local D1 contains two rows.
- Actual Cloudflare account names appear when live credentials are configured; fallback is clearly labeled.
- D1 file size, Cloudflare account/Worker identity, KV storage metrics, and B2 bucket validation come from provider APIs when read credentials are configured.
- B2 tracked bytes and local D1/KV operational counters are never labeled as provider-live.
- Removing or adding a peer changes UI and public origin pool dynamically without code changes.
- A failed peer/provider produces partial data plus warning, not page failure.
- New provisioned account cannot receive traffic until topology is manually synchronized.
- No secret appears in API response, UI, logs, tests, or committed configuration.
- All listed tests, builds, and type checks pass.
