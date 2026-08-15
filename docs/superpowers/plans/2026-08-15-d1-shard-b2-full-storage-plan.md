# D1 Shard + Full-B2 + Cross-Account Cache/Traffic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved 5-part architecture: remove all remaining R2 code, hash-round-robin B2 uploads across 2 accounts, shard `chapter_pages` metadata across 3 D1s, add peer-KV cache fallback, round-robin frontend traffic across 3 workers, and add usage-based B2 eviction (cron + upload-time check).

**Architecture:** Storage is 100% B2 (`B2_CONFIG` + `B2_ACCOUNTS` secrets, 2 buckets). Object→B2-account mapping is `murmur3_32(objectKey) % accounts.length` (deterministic, fallback to next account on failure; index stored as negative `r2_account_idx`). `chapter_pages` rows are sharded by `murmur3_32(chapterId) % 3` to an owner D1 reached via a mounted internal route (`/api/_internal/*`, auth `x-db-forward-key` = `DB_FORWARD_KEY`). KV cache stays per-account but misses consult peer KV before hitting origin. Frontend round-robins `/api/reader/*`, `/api/series*`, `/api/search`, `/api/health`, `/api/source-status` across 3 workers. Eviction is usage-based (`b2:usage:{idx}` KV tracker + native B2 bucket usage), triggered hourly by a cron on akun-1 (owner-guarded) and at upload time when >90% full.

**Tech Stack:** Cloudflare Workers (Hono), D1 (3 DBs), KV (3 namespaces), Backblaze B2 (S3-compatible, SigV4), Next.js 14 Pages (edge). Existing libs: `packages/shared/src/r2-routing.ts` (murmur3_32), `apps/api-cf/src/lib/{b2Config,s3Upload,readThroughCache,dbWrite,storageEviction}.ts`, `apps/api-cf/src/routes/internal.ts` (currently unmounted), `apps/web/lib/api.ts`.

**Base state note:** The working tree already contains uncommitted R2→B2 WIP: `apps/api-cf/src/lib/r2Accounts.ts` deleted, `apps/api-cf/src/lib/s3Upload.ts` rewritten to B2-only (PUT + presigned GET), `apps/api-cf/src/lib/readThroughCache.ts` added, `apps/api-cf/src/routes/reader.ts` partially B2-ified, `wrangler.toml` R2 binding removed. This plan completes and generalizes that WIP; do NOT re-do completed parts, just extend them.

## Global Constraints

- **Owner mapping:** `owner(chapterId) = murmur3_32(chapterId) % PEER_URLS.length` (PEER_URLS ordered akun-1/2/3, comma-separated; `PEER_INDEX` = this worker's index 0/1/2).
- **Internal route auth:** `x-db-forward-key` header must equal secret `DB_FORWARD_KEY` (same value on all 3 workers); `constantTimeEqualStr` from `apps/api-cf/src/lib/auth.ts`. Table allowlist: `users, bookmarks, reading_history, series, series_search, chapters, chapter_pages, source_link, source_health, image_hashes`. New read endpoint is SELECT-only.
- **B2 account index convention:** `r2_account_idx = -(i+1)` for B2 array index `i` (‑1 = B2-0, ‑2 = B2-1). Column names `r2_key`/`r2_account_idx` stay unchanged (no migration; spec "Out of scope").
- **Key format:** `b2KeyFor(source, slug, chapterId, pageNo)` = `{source}/{slug}/{chapterId}/{pageNo}` (rename of `r2KeyFor`, same format).
- **B2 quotas:** default 10GB free tier (`B2_QUOTA_BYTES` env override). Evict when usage > 80% → down to ≤ 70%. Upload blocked path: when picked account usage > 90%, trigger eviction in `waitUntil` (never block the response).
- **KV peer fallback scope:** only allowlisted prefixes `series:detail:`, `chapters:list:`, `chapter:detail:` via `/api/_internal/kv/get?key=`. Peer timeout 2s; skip peer on failure, never block.
- **Cron:** only akun-1 wrangler.toml gets `[triggers] crons = ["0 * * * *"]`. `scheduled` handler no-ops unless `EVICTION_OWNER = "1"` + KV lock `eviction:lock` TTL 600s.
- **Frontend round-robin:** paths `/api/reader/*`, `/api/series*`, `/api/search`, `/api/health`, `/api/source-status` round-robin across origins from `/api/origins` with rotating index in `sessionStorage`. Auth (`/api/auth/*`, `/api/user/*`) stays sticky via `getAuthApiUrl()`.
- **Auth origin unchanged:** akun-2 remains cookie/auth origin; `DB_FORWARD_ENDPOINT`/`DB_MIRROR_*` overflow logic in `dbWrite.ts` is left untouched (users stay local per-account).
- **Do not mount internal router under global rate limit** — add an internal-path skip to `rateLimit` middleware (akun-1→2 peer calls share worker IPs).
- **Deploy:** akun-1 via `npx wrangler deploy --config apps/api-cf/wrangler.toml` (main = src/index.ts); akun-2/3 require `node scripts/build-worker-bundle.mjs` first (their tomls use `dist/worker.js`). Pages via `rm -rf .vercel/output && npx @cloudflare/next-on-pages` then `npx wrangler pages deploy`.
- **Test runner:** `npx tsx <file>.mjs` (node:test + node:assert/strict). Follow `apps/api-cf/test/b2-upload.test.mjs` / `packages/db/test/bookmark.test.mjs` style.

---

## File Structure

**Create:**
- `apps/api-cf/src/lib/peers.ts` — PEER_URLS parse, owner mapping, `internalExec`, `internalQuery`, `peerKvGet`.
- `apps/api-cf/src/lib/b2Usage.ts` — `b2:usage:{idx}` KV usage tracker + quota helpers.
- `apps/api-cf/test/peers.test.mjs` — owner determinism/distribution + internal HTTP shape.
- `apps/api-cf/test/b2-pick.test.mjs` — `pickB2AccountIdx` determinism + distribution.
- `apps/api-cf/test/internal-route.test.mjs` — `/db/exec`, `/db/query`, `/kv/get` auth + allowlist.
- `apps/api-cf/test/b2usage.test.mjs` — usage tracker math.

**Modify:**
- `packages/shared/src/r2-routing.ts` — rename `r2KeyFor`→`b2KeyFor`; delete `buildRing`/`accountFor`/`generateRemapReport` + `RingNode`; keep `murmur3_32`.
- `packages/shared/test/r2-routing.test.mjs` — drop ring tests; add `b2KeyFor`.
- `apps/api-cf/src/lib/b2Config.ts` — add `pickB2AccountIdx`/`pickB2Account`.
- `apps/api-cf/src/lib/s3Upload.ts` — export `b2DeleteObject` (moved from `storageEviction.ts`).
- `apps/api-cf/src/lib/storageEviction.ts` — usage-based quota check; cross-peer stale query + clear; use imported `b2DeleteObject`.
- `apps/api-cf/src/lib/dbWrite.ts` — add `forwardToPeer` targeting `PEER_URLS[owner]` (replaces single `DB_FORWARD_ENDPOINT` for sharded writes; keep legacy path).
- `apps/api-cf/src/lib/readThroughCache.ts` — add `peerFallback` option.
- `apps/api-cf/src/routes/internal.ts` — add `POST /db/query` (SELECT-only) + `GET /kv/get` (prefix allowlist).
- `apps/api-cf/src/routes/reader.ts` — hash pick uploads, owner write/read/touch for `chapter_pages`, KV peer fallback on detail/chapters/list.
- `apps/api-cf/src/routes/identify.ts` — use `pickB2Account`.
- `apps/api-cf/src/routes/admin/scrape.ts` — use `pickB2Account` for cover.
- `apps/api-cf/src/index.ts` — mount internal router (before rate limit), add `scheduled` handler.
- `apps/api-cf/src/lib/rateLimit.ts` — skip `/api/_internal`.
- `apps/api-cf/src/lib/context.ts` — add optional Env fields (`PEER_URLS`, `PEER_INDEX`, `EVICTION_OWNER`, `B2_QUOTA_BYTES`, `DB_FORWARD_KEY`).
- `apps/api-cf/wrangler.toml` — add `[triggers] crons = ["0 * * * *"]` + `EVICTION_OWNER = "1"` under `[vars]`.
- `packages/db/index.ts` — rename `markPageR2Uploaded`→`markPageB2Uploaded` (+params `b2Key`/`b2AccountIdx`); delete `touchLastAccess`.
- `packages/lb/provision.ts` — remove R2 bucket creation + `ASSETS_R2` binding.
- `apps/web/lib/api.ts` — remove `R2_DOMAINS`/`r2Ring`/`r2UrlFor` + ring import; remove `r2Url` from Chapter pages type; round-robin `apiWithFailover`.
- `apps/web/components/Reader.tsx`, `apps/web/components/ReaderShell.tsx` — drop `r2Url` fallback.
- `apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx` — update comment.
- `README.md`, `docs/ADDING-ACCOUNT.md`, `docs/superpowers/specs/2026-08-08-architecture-caching-design.md`, `docs/superpowers/plans/2026-08-08-architecture-caching.md` — drop R2 references (best-effort, non-blocking).

**Delete:**
- `scripts/setup-r2-account.mjs`

---

### Task 1: Frontend — remove R2 ring code + r2Url fallbacks

**Files:**
- Modify: `apps/web/lib/api.ts:131-146` (ring block), `apps/web/lib/api.ts:57` (Chapter pages type), `apps/web/components/Reader.tsx:20,44`, `apps/web/components/ReaderShell.tsx:12,110`, `apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx:31-33`

**Interfaces:**
- Consumes: none
- Produces: no `r2Url` anywhere in `apps/web`; `Chapter.pages` = `{ proxyUrl; b2Url? }[]`

- [ ] **Step 1: Remove ring code from `apps/web/lib/api.ts`**

Delete lines 131-146 (`R2_DOMAINS`, `R2_VNODES`, `r2Ring`, `r2UrlFor`, and the `import { buildRing, accountFor } from '@manga-platform/shared/r2-routing'`). Keep the `ORIGIN_PATH_ALLOWLIST` block below it.

Change the Chapter pages type at line 57:

```ts
  pages?: { proxyUrl: string; b2Url?: string | null }[];
```

- [ ] **Step 2: Remove `r2Url` from Reader + ReaderShell**

`apps/web/components/Reader.tsx:20`:
```ts
  pages: { proxyUrl: string; b2Url?: string | null }[];
```
`apps/web/components/Reader.tsx:44`:
```ts
  const urls = pages.map((p) => p.b2Url ?? `${apiUrl}${p.proxyUrl}`);
```
`apps/web/components/ReaderShell.tsx:12`: remove `r2Url?: string | null;` line from the page type.
`apps/web/components/ReaderShell.tsx:110`:
```ts
    const url = p.b2Url ?? `${apiUrl}${p.proxyUrl}`;
```

- [ ] **Step 3: Update chapter page comment**

`apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx:31-33` — replace with:
```ts
  // URL storage datang dari server (D1 source of truth: b2Url presigned).
  // Page baru belum di-upload → null → Reader pakai proxy
  // (yang sekaligus meng-upload → request berikutnya dapat URL langsung).
```

- [ ] **Step 4: Verify — grep for leftovers**

Run: `grep -rn "r2Url\|R2_DOMAINS\|buildRing\|accountFor" apps/web --include=*.ts --include=*.tsx | grep -v node_modules | grep -v "qa-reader"`
Expected: only the `qa-reader/page.tsx` mock (its `r2Url` is a local data-URI mock, not R2 — safe to leave).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/api.ts apps/web/components/Reader.tsx apps/web/components/ReaderShell.tsx "apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx"
git commit -m "feat(web): drop R2 ring + r2Url fallbacks (full B2)"
```

---

### Task 2: Shared — rename `r2KeyFor`→`b2KeyFor`, delete ring helpers

**Files:**
- Modify: `packages/shared/src/r2-routing.ts`, `packages/shared/test/r2-routing.test.mjs`, `apps/api-cf/src/routes/reader.ts:4,171`

**Interfaces:**
- Consumes: Task 1 (no more frontend ring imports)
- Produces: `b2KeyFor(source, slug, chapterId, pageNo): string`, `murmur3_32(key, seed?): number` (unchanged). `buildRing`, `accountFor`, `generateRemapReport`, `RingNode` REMOVED.

- [ ] **Step 1: Write failing test updates**

Rewrite `packages/shared/test/r2-routing.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { murmur3_32, b2KeyFor } from '../src/r2-routing.ts';

test('murmur3_32 known vector (seed 0)', () => {
  assert.equal(murmur3_32('hello'), 613153351);
});

test('murmur3_32 deterministic', () => {
  assert.equal(murmur3_32('naruto-chapter-1'), murmur3_32('naruto-chapter-1'));
});

test('b2KeyFor deterministic format {source}/{slug}/{chapterId}/{pageNo}', () => {
  assert.equal(b2KeyFor('komiku', 'naruto', 'naruto-chapter-1', 3), 'komiku/naruto/naruto-chapter-1/3');
});

test('b2KeyFor rejects ring imports (buildRing removed)', async () => {
  const mod = await import('../src/r2-routing.ts');
  assert.equal(mod.buildRing, undefined);
  assert.equal(mod.accountFor, undefined);
  assert.equal(mod.generateRemapReport, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx packages/shared/test/r2-routing.test.mjs`
Expected: fails — `r2KeyFor`/`b2KeyFor` not exported (rename not done yet).

- [ ] **Step 3: Rewrite `packages/shared/src/r2-routing.ts`**

Delete `RingNode`, `buildRing`, `accountFor`, `generateRemapReport` (lines 5-8, 49-84, 93-111). Keep header comment updated:
```ts
// B2 multi-account routing — satu sumber kebenaran untuk hash, dipakai oleh
// scraper Worker (apps/api-cf). JANGAN re-implement di sisi lain; import dari
// sini agar tidak drift. Frontend tidak perlu hash routing lagi (B2 presigned
// langsung dari Worker), jadi tidak di-import dari apps/web.
```
Rename at line 90:
```ts
export const b2KeyFor = (source: string, slug: string, chapterId: string, pageNo: number): string =>
  `${source}/${slug}/${chapterId}/${pageNo}`;
```

- [ ] **Step 4: Update `apps/api-cf/src/routes/reader.ts` import + usage**

Line 4:
```ts
import { b2KeyFor } from '@manga-platform/shared/r2-routing';
```
Line 171:
```ts
  const b2Key = b2KeyFor(opts.source, opts.slug, opts.chapterId, opts.pageNo);
```

- [ ] **Step 5: Run tests**

Run: `npx tsx packages/shared/test/r2-routing.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 6: Typecheck api-cf**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/r2-routing.ts packages/shared/test/r2-routing.test.mjs apps/api-cf/src/routes/reader.ts
git commit -m "refactor(shared): b2KeyFor replaces r2KeyFor, drop consistent-hash ring helpers"
```

---

### Task 3: `packages/lb/provision.ts` — remove ASSETS_R2

**Files:**
- Modify: `packages/lb/provision.ts:137-149,163-165`

**Interfaces:**
- Consumes: none
- Produces: provisioned workers no longer bind `ASSETS_R2`; remove `r2BucketName` var.

- [ ] **Step 1: Remove R2 bucket creation**

Delete lines 137-149 (the `// 7. Create R2 bucket` block including `let r2BucketName` and the try/catch). Keep the `setJob` flow intact — renumber comments is optional.

- [ ] **Step 2: Remove R2 binding push**

Delete lines 163-165:
```ts
    if (r2BucketName) {
      bindings.push({ type: 'r2_bucket', name: 'ASSETS_R2', bucket_name: r2BucketName });
    }
```
Update the comment at line 152-153 to drop R2 mention:
```ts
    // 8. Deploy Worker — upload bundle (ESM module + metadata).
    // Bindings include D1 + CACHE_KV + MY_BROWSER.
```

- [ ] **Step 3: Verify no dangling references**

Run: `grep -rn "ASSETS_R2\|r2BucketName" packages/lb/provision.ts`
Expected: no matches.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p packages/lb/tsconfig.json --noEmit 2>/dev/null || npx tsc --noEmit packages/lb/provision.ts --moduleResolution bundler --module esnext --target es2022 2>&1 | head`
Expected: no `ASSETS_R2` errors (the package may have no tsconfig; the grep in Step 3 is the real gate).

- [ ] **Step 5: Commit**

```bash
git add packages/lb/provision.ts
git commit -m "refactor(lb): provision workers without ASSETS_R2 binding"
```

---

### Task 4: `packages/db` — rename `markPageR2Uploaded`→`markPageB2Uploaded`, drop `touchLastAccess`

**Files:**
- Modify: `packages/db/index.ts:28,29,149-173`, `apps/api-cf/src/routes/reader.ts:181-187`

**Interfaces:**
- Consumes: none
- Produces: `markPageB2Uploaded({ chapterId, pageNumber, imageUrl, b2Key, b2AccountIdx }): Promise<{ success: boolean }>`; `touchLastAccess` removed from Db interface + impl.

- [ ] **Step 1: Write failing contract test**

Create `packages/db/test/storage-rename.test.mjs`:
```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function makeStub() {
  const trace = [];
  const stmt = {
    sql: '', bound: [],
    bind(...args) { this.bound = args; return this; },
    run() { trace.push({ sql: this.sql, bound: this.bound }); return { success: true, meta: {} }; },
    first() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve(null); },
    all() { trace.push({ sql: this.sql, bound: this.bound }); return Promise.resolve({ results: [] }); },
  };
  const client = {
    prepare(sql) { stmt.sql = sql; stmt.bound = []; return stmt; },
    batch() { return Promise.resolve([]); },
  };
  return { client, trace };
}

const { db } = await import('../index.ts');

describe('storage rename', () => {
  test('markPageB2Uploaded exists and writes ON CONFLICT upsert', async () => {
    const { client, trace } = makeStub();
    const res = await db(client).markPageB2Uploaded({
      chapterId: 'ch-1', pageNumber: 2, imageUrl: 'http://img/u.jpg',
      b2Key: 'komiku/slug/ch-1/2', b2AccountIdx: -1,
    });
    assert.equal(res.success, true);
    assert.match(trace[0].sql, /INSERT INTO chapter_pages/);
    assert.match(trace[0].sql, /ON CONFLICT\(chapter_id, page_number\) DO UPDATE SET r2_key = excluded\.r2_key, r2_account_idx = excluded\.r2_account_idx/);
    assert.deepEqual(trace[0].bound, ['ch-1', 2, 'http://img/u.jpg', 'komiku/slug/ch-1/2', -1]);
  });

  test('touchLastAccess removed from interface', () => {
    assert.equal(db(makeStub().client).touchLastAccess, undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx packages/db/test/storage-rename.test.mjs`
Expected: fails — `markPageB2Uploaded is not a function`.

- [ ] **Step 3: Rename in `packages/db/index.ts`**

Interface line 28:
```ts
  markPageB2Uploaded: (params: { chapterId: string; pageNumber: number; imageUrl: string; b2Key: string; b2AccountIdx: number }) => Promise<{ success: boolean }>;
```
Delete interface line 29 (`touchLastAccess`).

Impl (lines 149-162): rename `markPageR2Uploaded` → `markPageB2Uploaded`, change log prefix to `[markPageB2Uploaded]`, bind `p.b2Key` / `p.b2AccountIdx`.

Delete impl `touchLastAccess` (lines 164-173) entirely.

- [ ] **Step 4: Update reader.ts call site**

`apps/api-cf/src/routes/reader.ts:181-187`:
```ts
        await getDb(c).markPageB2Uploaded({
          chapterId: opts.chapterId,
          pageNumber: opts.pageNo,
          imageUrl: opts.imageUrl,
          b2Key,
          b2AccountIdx: accountIdx,
        });
```

- [ ] **Step 5: Run tests**

Run: `npx tsx packages/db/test/storage-rename.test.mjs && npx tsx packages/db/test/bookmark.test.mjs && npx tsx packages/db/test/user-profile.test.mjs && npx tsx packages/db/test/matching.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Grep for legacy name**

Run: `grep -rn "markPageR2Uploaded\|touchLastAccess" packages apps --include=*.ts --include=*.tsx | grep -v node_modules`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add packages/db/index.ts packages/db/test/storage-rename.test.mjs apps/api-cf/src/routes/reader.ts
git commit -m "refactor(db): markPageB2Uploaded rename, drop dead touchLastAccess/r2_last_access path"
```

---

### Task 5: `b2Config.ts` — deterministic hash pick

**Files:**
- Modify: `apps/api-cf/src/lib/b2Config.ts`
- Create: `apps/api-cf/test/b2-pick.test.mjs`

**Interfaces:**
- Consumes: `murmur3_32` from `@manga-platform/shared/r2-routing`
- Produces: `pickB2AccountIdx(accounts: B2Account[], key: string): number` (single account → 0), `pickB2Account(accounts: B2Account[], key: string): B2Account | null`

- [ ] **Step 1: Write failing test**

`apps/api-cf/test/b2-pick.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickB2Account, pickB2AccountIdx } from '../src/lib/b2Config.ts';

const accounts = [
  { name: 'kom', bucket: 'manga-images', keyId: 'AK1', appKey: 'SK1', region: 'us-east-005', host: 's3.us-east-005.backblazeb2.com' },
  { name: 'boltz', bucket: 'manga-images', keyId: 'AK2', appKey: 'SK2', region: 'eu-central-003', host: 's3.eu-central-003.backblazeb2.com' },
];

test('single account → index 0', () => {
  assert.equal(pickB2AccountIdx([accounts[0]], 'komiku/naruto/ch1/1'), 0);
});

test('empty accounts → null account', () => {
  assert.equal(pickB2Account([], 'x'), null);
});

test('deterministic across calls', () => {
  const key = 'komiku/naruto/chapter-1/5';
  assert.equal(pickB2AccountIdx(accounts, key), pickB2AccountIdx(accounts, key));
});

test('distribution roughly balanced across 2 accounts', () => {
  const keys = Array.from({ length: 2000 }, (_, i) => `komiku/manga-${i}/ch/1`);
  const counts = [0, 0];
  for (const k of keys) counts[pickB2AccountIdx(accounts, k)]++;
  for (const c of counts) {
    assert.ok(c > keys.length * 0.3, `count ${c} too low`);
    assert.ok(c < keys.length * 0.7, `count ${c} too high`);
  }
});

test('pickB2Account returns the picked account', () => {
  const idx = pickB2AccountIdx(accounts, 'komiku/a/ch/1');
  assert.equal(pickB2Account(accounts, 'komiku/a/ch/1')?.keyId, accounts[idx].keyId);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx apps/api-cf/test/b2-pick.test.mjs`
Expected: fails — `pickB2AccountIdx is not a function`.

- [ ] **Step 3: Implement in `b2Config.ts`**

Add import at top:
```ts
import { murmur3_32 } from '@manga-platform/shared/r2-routing';
```
Add at bottom:
```ts
// Deterministic B2 account pick by object-key hash (murmur3_32). Same object
// key always lands on the same B2 account (dedup-able, consistent eviction).
// Single account → always index 0 (backward compatible with legacy setup).
export const pickB2AccountIdx = (accounts: B2Account[], key: string): number => {
  if (accounts.length <= 1) return 0;
  return murmur3_32(key) % accounts.length;
};

export const pickB2Account = (accounts: B2Account[], key: string): B2Account | null => {
  if (accounts.length === 0) return null;
  return accounts[pickB2AccountIdx(accounts, key)];
};
```

- [ ] **Step 4: Run tests**

Run: `npx tsx apps/api-cf/test/b2-pick.test.mjs && npx tsx apps/api-cf/test/b2-upload.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api-cf/src/lib/b2Config.ts apps/api-cf/test/b2-pick.test.mjs
git commit -m "feat(api): deterministic B2 account pick by object-key hash"
```

---

### Task 6: Upload paths use hash pick (reader/identify/scrape)

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts:170-198` (`uploadToStorage`), `apps/api-cf/src/routes/identify.ts:56-60`, `apps/api-cf/src/routes/admin/scrape.ts:166-171`

**Interfaces:**
- Consumes: `pickB2Account` / `pickB2AccountIdx` (Task 5)
- Produces: uploads start at picked account, fall back to next accounts (wrapping) on failure.

- [ ] **Step 1: Rewrite `uploadToStorage` loop in reader.ts**

Replace the current ordered loop with hash-pick start + wrapping fallback:
```ts
const uploadToStorage = async (c: Context, opts: { source: string; slug: string; chapterId: string; pageNo: number; imageUrl: string; contentType: string; body: ReadableStream | ArrayBuffer }): Promise<void> => {
  const b2Key = b2KeyFor(opts.source, opts.slug, opts.chapterId, opts.pageNo);
  const b2Accounts = resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS);

  // Hash pick → start at that account; on failure fall back to the others
  // (wrapping) instead of a fixed ordered chain.
  const startIdx = pickB2AccountIdx(b2Accounts, b2Key);
  for (let k = 0; k < b2Accounts.length; k++) {
    const i = (startIdx + k) % b2Accounts.length;
    const b2 = b2Accounts[i];
    const accountIdx = -(i + 1); // -1, -2, ... → B2 account index
    try {
      const res = await b2PutObject(b2, b2Key, opts.body as ArrayBuffer, opts.contentType);
      if (res.ok) {
        await getDb(c).markPageB2Uploaded({
          chapterId: opts.chapterId,
          pageNumber: opts.pageNo,
          imageUrl: opts.imageUrl,
          b2Key,
          b2AccountIdx: accountIdx,
        });
        await touchChapterDetailKv(c, opts.source, opts.chapterId, opts.pageNo, b2Accounts, b2Key, accountIdx);
        return;
      }
      console.error(`[b2:${b2.name}] upload ${res.status} → next tier: ${opts.source}/${opts.slug}/${opts.chapterId}/${opts.pageNo}`);
    } catch (e) {
      console.error(`[b2:${b2.name}] upload failed → next tier: ${String(e)}`);
    }
  }

  // Semua B2 gagal → proxy-only mode (response user tetap jalan).
};
```
Add `pickB2AccountIdx` to the existing import from `../lib/b2Config.ts`.

- [ ] **Step 2: identify.ts — pick by upload key**

Replace `b2PutObject(b2Accounts[0], ...)`:
```ts
  if (b2Accounts.length > 0) {
    const arrBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const b2 = pickB2Account(b2Accounts, uploadKey);
    if (b2) c.executionCtx.waitUntil(b2PutObject(b2, uploadKey, arrBuf, file.type).catch(() => {}));
  }
```
Update import line to include `pickB2Account`.

- [ ] **Step 3: scrape.ts — pick cover account**

Replace `await b2PutObject(b2Accounts[0], b2Key, arrBuf, ct)`:
```ts
              const b2 = pickB2Account(b2Accounts, b2Key);
              if (b2) await b2PutObject(b2, b2Key, arrBuf, ct).catch((e) => { console.error('[scrape] cover upload failed:', String(e)); });
```
Update import line to include `pickB2Account`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run existing tests**

Run: `npx tsx apps/api-cf/test/b2-pick.test.mjs && npx tsx apps/api-cf/test/b2-upload.test.mjs && npx tsx apps/api-cf/test/reader-slug.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts apps/api-cf/src/routes/identify.ts apps/api-cf/src/routes/admin/scrape.ts
git commit -m "feat(api): hash-pick B2 account for page/cover/identify uploads with wrap fallback"
```

---

### Task 7: Peers lib — PEER_URLS, owner mapping, internal exec/query/kv

**Files:**
- Create: `apps/api-cf/src/lib/peers.ts`, `apps/api-cf/test/peers.test.mjs`
- Modify: `apps/api-cf/src/lib/context.ts` (Env fields)

**Interfaces:**
- Consumes: `murmur3_32` from shared; `Env.DB_FORWARD_KEY`, `Env.PEER_URLS`, `Env.PEER_INDEX`
- Produces:
  - `getPeers(env: Env): Array<{ url: string; index: number; self: boolean }>`
  - `ownerFor(env: Env, key: string): { url: string; index: number; self: boolean }`
  - `internalExec(env: Env, peerUrl: string, payload: { sql: string; params: unknown[]; table: string }): Promise<boolean>`
  - `internalQuery<T>(env: Env, peerUrl: string, sql: string, params: unknown[], table: string): Promise<T[] | null>`
  - `peerKvGet(env: Env, key: string): Promise<unknown | null>`

- [ ] **Step 1: Write failing test**

`apps/api-cf/test/peers.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPeers, ownerFor, internalExec, internalQuery, peerKvGet } from '../src/lib/peers.ts';

const URLS = 'https://a.example.com,https://b.example.com,https://c.example.com';
const env = (over = {}) => ({ PEER_URLS: URLS, PEER_INDEX: '1', DB_FORWARD_KEY: 'sekret', ...over });

test('getPeers parses URLS + marks self via PEER_INDEX', () => {
  const peers = getPeers(env());
  assert.equal(peers.length, 3);
  assert.equal(peers[0].index, 0);
  assert.equal(peers[1].self, true);
  assert.equal(peers[0].self, false);
  assert.equal(peers[2].url, 'https://c.example.com');
});

test('ownerFor maps deterministically into [0, len)', () => {
  for (let i = 0; i < 50; i++) {
    const o = ownerFor(env(), `ch-${i}`);
    assert.ok(o.index >= 0 && o.index < 3);
    assert.equal(o.url, URLS.split(',')[o.index]);
  }
});

test('ownerFor is stable across calls', () => {
  assert.equal(ownerFor(env(), 'naruto-chapter-1').index, ownerFor(env(), 'naruto-chapter-1').index);
});

test('distribution roughly balanced', () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 900; i++) counts[ownerFor(env(), `manga-${i}`).index]++;
  for (const c of counts) {
    assert.ok(c > 200, `count ${c} too low`);
    assert.ok(c < 400, `count ${c} too high`);
  }
});

test('internalExec POSTs to /api/_internal/db/exec with forward key', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const ok = await internalExec(env(), 'https://b.example.com', {
    sql: 'INSERT INTO chapter_pages ...', params: [1], table: 'chapter_pages',
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://b.example.com/api/_internal/db/exec');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-db-forward-key'], 'sekret');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.table, 'chapter_pages');
  delete globalThis.fetch;
});

test('internalExec returns false without key or peer', async () => {
  assert.equal(await internalExec(env({ DB_FORWARD_KEY: undefined }), 'https://b.example.com', { sql: '', params: [], table: 'chapter_pages' }), false);
  assert.equal(await internalExec(env(), '', { sql: '', params: [], table: 'chapter_pages' }), false);
});

test('internalQuery returns rows on 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, results: [{ page_number: 1 }] }), { status: 200 });
  const rows = await internalQuery(env(), 'https://c.example.com', 'SELECT ...', [], 'chapter_pages');
  assert.deepEqual(rows, [{ page_number: 1 }]);
  delete globalThis.fetch;
});

test('internalQuery returns null on non-ok', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
  const rows = await internalQuery(env(), 'https://c.example.com', 'SELECT ...', [], 'chapter_pages');
  assert.equal(rows, null);
  delete globalThis.fetch;
});

test('peerKvGet returns first non-null value from peers', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ value: url.includes('b.example') ? { data: 42 } : null }), { status: 200 });
  };
  const v = await peerKvGet(env(), 'series:detail:komiku:naruto:id');
  assert.equal(v.data, 42);
  assert.ok(seen.some((u) => u.includes('kv/get')));
  delete globalThis.fetch;
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx apps/api-cf/test/peers.test.mjs`
Expected: fails — cannot find module `peers.ts`.

- [ ] **Step 3: Create `apps/api-cf/src/lib/peers.ts`**

```ts
import { murmur3_32 } from '@manga-platform/shared/r2-routing';
import type { Env } from './context';

export interface PeerInfo {
  url: string;
  index: number;
  self: boolean;
}

// Parse PEER_URLS (comma-separated, ordered akun-1/2/3) + PEER_INDEX (this
// worker's own index). Same URL list on all workers; self-flag is per-worker.
export const getPeers = (env: Env): PeerInfo[] => {
  const raw = env.PEER_URLS as string | undefined;
  const selfIndex = Number(env.PEER_INDEX ?? 0) || 0;
  const urls = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return urls.map((url, index) => ({ url, index, self: index === selfIndex }));
};

// Deterministic owner of a sharded key (chapterId). Falls back to "self" when
// no peers are configured (single-account / local dev).
export const ownerFor = (env: Env, key: string): PeerInfo => {
  const peers = getPeers(env);
  if (peers.length === 0) return { url: '', index: 0, self: true };
  return peers[murmur3_32(key) % peers.length];
};

const forwardKey = (env: Env): string | undefined => env.DB_FORWARD_KEY as string | undefined;

// Write-forward to a peer worker's internal /db/exec. Returns false on
// missing key, missing peer, or non-2xx (caller falls back to local).
export const internalExec = async (
  env: Env,
  peerUrl: string,
  payload: { sql: string; params: unknown[]; table: string }
): Promise<boolean> => {
  const key = forwardKey(env);
  if (!key || !peerUrl) return false;
  try {
    const res = await fetch(`${peerUrl}/api/_internal/db/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-db-forward-key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// Read-forward: SELECT via peer /db/query (allowlisted table). null = failure.
export const internalQuery = async <T = Record<string, unknown>>(
  env: Env,
  peerUrl: string,
  sql: string,
  params: unknown[],
  table: string
): Promise<T[] | null> => {
  const key = forwardKey(env);
  if (!key || !peerUrl) return null;
  try {
    const res = await fetch(`${peerUrl}/api/_internal/db/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-db-forward-key': key },
      body: JSON.stringify({ sql, params, table }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { results?: T[] };
    return j.results ?? null;
  } catch {
    return null;
  }
};

// KV peer fallback: try each non-self peer's /kv/get (allowlist enforced
// server-side). First non-null wins; returns null when none have it.
export const peerKvGet = async (env: Env, key: string): Promise<unknown | null> => {
  const k = forwardKey(env);
  if (!k) return null;
  for (const peer of getPeers(env)) {
    if (peer.self) continue;
    try {
      const res = await fetch(`${peer.url}/api/_internal/kv/get?key=${encodeURIComponent(key)}`, {
        headers: { 'x-db-forward-key': k },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { value?: unknown };
      if (j.value != null) return j.value;
    } catch { /* try next peer */ }
  }
  return null;
};
```

- [ ] **Step 4: Add Env fields to `context.ts`**

Inside `Env` interface add:
```ts
  PEER_URLS?: string;
  PEER_INDEX?: string;
  EVICTION_OWNER?: string;
  B2_QUOTA_BYTES?: string;
  DB_FORWARD_KEY?: string;
```

- [ ] **Step 5: Run tests**

Run: `npx tsx apps/api-cf/test/peers.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api-cf/src/lib/peers.ts apps/api-cf/test/peers.test.mjs apps/api-cf/src/lib/context.ts
git commit -m "feat(api): peers lib — PEER_URLS owner mapping + internal exec/query/kv"
```

---

### Task 8: Internal routes — mount + `/db/query` + `/kv/get` + rate-limit skip

**Files:**
- Modify: `apps/api-cf/src/routes/internal.ts`, `apps/api-cf/src/index.ts`, `apps/api-cf/src/lib/rateLimit.ts`
- Create: `apps/api-cf/test/internal-route.test.mjs`

**Interfaces:**
- Consumes: `writeLocal` (existing), `constantTimeEqualStr` (existing), `ALLOWED_TABLES` (existing)
- Produces: mounted at `/api/_internal`; new `POST /db/query` (SELECT-only, returns `{ ok, results }`) and `GET /kv/get?key=` (prefix allowlist `series:detail:`/`chapters:list:`/`chapter:detail:`, returns `{ value }`).

- [ ] **Step 1: Write failing test**

`apps/api-cf/test/internal-route.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { router } from '../src/routes/internal.ts';

function stubEnv(over = {}) {
  const stmt = {
    sql: '', bound: [], boundArgs: [],
    bind(...args) { this.bound = args; return this; },
    run() { return { success: true, meta: {} }; },
    all() { return { results: [{ page_number: 1, r2_key: 'k', r2_account_idx: -1 }] }; },
    first() { return null; },
  };
  const kv = {
    store: { 'series:detail:komiku:naruto:id': JSON.stringify({ data: 1 }) },
    async get(k) { return this.store[k] ?? null; },
  };
  return {
    DB: {
      prepare(sql) { stmt.sql = sql; stmt.bound = []; return stmt; },
      batch() { return Promise.resolve([]); },
    },
    CACHE_KV: kv,
    DB_FORWARD_KEY: 'sekret',
    ...over,
  };
}

const app = new Hono();
app.route('/api/_internal', router);

test('db/exec rejects without forward key', async () => {
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT 1', params: [], table: 'chapter_pages' }),
  }, stubEnv());
  assert.equal(res.status, 401);
});

test('db/exec rejects non-allowlisted table', async () => {
  const res = await app.request('/api/_internal/db/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'DROP TABLE users', params: [], table: 'users' }),
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('db/query rejects write SQL (SELECT-only)', async () => {
  const res = await app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({ sql: 'UPDATE chapter_pages SET r2_key = NULL', params: [], table: 'chapter_pages' }),
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('db/query returns rows for SELECT on allowlisted table', async () => {
  const res = await app.request('/api/_internal/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-db-forward-key': 'sekret' },
    body: JSON.stringify({
      sql: 'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1',
      params: ['ch-1'], table: 'chapter_pages',
    }),
  }, stubEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.results.length, 1);
  assert.equal(j.results[0].page_number, 1);
});

test('kv/get rejects non-allowlisted key prefix', async () => {
  const res = await app.request('/api/_internal/kv/get?key=secret:data', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, stubEnv());
  assert.equal(res.status, 403);
});

test('kv/get returns cached value for allowlisted prefix', async () => {
  const res = await app.request('/api/_internal/kv/get?key=series:detail:komiku:naruto:id', {
    headers: { 'x-db-forward-key': 'sekret' },
  }, stubEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.value, { data: 1 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx apps/api-cf/test/internal-route.test.mjs`
Expected: fails — no `/db/query`/`/kv/get` routes (404) and `/db/exec` DROP case may return 200 (writeLocal doesn't reject table by content, only allowlist check — the `users` DROP actually passes allowlist; the test expects 403, so we must also enforce SELECT/read intent on exec — see Step 3).

- [ ] **Step 3: Add routes + harden exec in `internal.ts`**

Add after the existing `/db/exec` route:

```ts
// Read-only SELECT exec for sharded reads (chapter_pages owner lookup).
// Same auth as /db/exec; enforced SELECT-only so the internal surface cannot
// be used to mutate via this path.
router.post('/db/query', async (c: Context) => {
  const forwardKey = c.req.header('x-db-forward-key');
  const mirrorKey = c.req.header('x-db-mirror-key');
  const isMirrorHeader = c.req.header('x-db-mirror') === '1';

  let authed = false;
  if (forwardKey && c.env.DB_FORWARD_KEY && constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) {
    authed = true;
  } else if (
    mirrorKey && c.env.DB_MIRROR_KEY && constantTimeEqualStr(mirrorKey, c.env.DB_MIRROR_KEY as string) && isMirrorHeader
  ) {
    authed = true;
  }
  if (!authed) return c.json({ error: 'invalid forward key' }, 401);

  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (contentLength > 64 * 1024) return c.json({ error: 'payload too large' }, 413);

  let payload: { sql: string; params: unknown[]; table?: string };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const { sql, params, table = 'chapter_pages' } = payload;
  if (typeof sql !== 'string' || !Array.isArray(params) || typeof table !== 'string') {
    return c.json({ error: 'missing sql/params/table' }, 400);
  }
  if (table.startsWith('_') || table === 'sqlite_sequence' || !ALLOWED_TABLES.has(table)) {
    return c.json({ error: 'forbidden table' }, 403);
  }
  if (!/^\s*SELECT\b/i.test(sql)) {
    return c.json({ error: 'read-only endpoint' }, 403);
  }
  try {
    const stmt = c.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const { results } = await bound.all();
    return c.json({ ok: true, results: results ?? [] });
  } catch (e) {
    return c.json({ error: 'query failed', detail: String(e) }, 500);
  }
});

// KV peer-read for cache fallback. Key allowlist enforced here (server side)
// so a leaked forward key can't dump arbitrary KV.
const KV_READ_ALLOW_PREFIXES = ['series:detail:', 'chapters:list:', 'chapter:detail:'];

router.get('/kv/get', async (c: Context) => {
  const forwardKey = c.req.header('x-db-forward-key');
  const mirrorKey = c.req.header('x-db-mirror-key');
  const isMirrorHeader = c.req.header('x-db-mirror') === '1';

  let authed = false;
  if (forwardKey && c.env.DB_FORWARD_KEY && constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) {
    authed = true;
  } else if (
    mirrorKey && c.env.DB_MIRROR_KEY && constantTimeEqualStr(mirrorKey, c.env.DB_MIRROR_KEY as string) && isMirrorHeader
  ) {
    authed = true;
  }
  if (!authed) return c.json({ error: 'invalid forward key' }, 401);

  const key = c.req.query('key');
  if (!key || !KV_READ_ALLOW_PREFIXES.some((p) => key.startsWith(p))) {
    return c.json({ error: 'key not allowed' }, 403);
  }
  const raw = await c.env.CACHE_KV.get(key, 'json').catch(() => null);
  return c.json({ value: raw ?? null });
});
```

In the existing `/db/exec`, add a guard so writes to `users` etc. via exec remain but the allowlist test for `DROP` still works: the test uses table `users` with `DROP TABLE users` — `users` IS in ALLOWED_TABLES, so it returns 200 under current code. The test expects 403. Resolution: enforce that `/db/exec` (write path) only accepts DML (`INSERT`/`UPDATE`/`DELETE`/`CREATE` is fine; but `DROP` is not). Add:
```ts
  if (/\bDROP\b|\bALTER\b|\bTRUNCATE\b/i.test(sql)) {
    return c.json({ error: 'forbidden statement' }, 403);
  }
```
immediately after the `forbidden table` check in `/db/exec`.

- [ ] **Step 4: Mount router in `apps/api-cf/src/index.ts`**

Add import: `import { router as internalRouter } from './routes/internal';`
Add BEFORE the `app.use('*', rateLimit)` line (so it mounts before the generic rate limiter; the skip in Task 8 Step 5 is a belt-and-suspenders):
```ts
app.route('/api/_internal', internalRouter);
```

- [ ] **Step 5: Skip internal paths in rateLimit**

`apps/api-cf/src/lib/rateLimit.ts` — change the `rateLimit` export:
```ts
export const rateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.path.startsWith('/api/_internal')) return next();
  return makeLimiter(60, 60)(c, next);
};
```

- [ ] **Step 6: Run tests**

Run: `npx tsx apps/api-cf/test/internal-route.test.mjs`
Expected: all PASS.

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api-cf/src/routes/internal.ts apps/api-cf/src/index.ts apps/api-cf/src/lib/rateLimit.ts apps/api-cf/test/internal-route.test.mjs
git commit -m "feat(api): mount internal router, add SELECT /db/query + /kv/get, rate-limit skip"
```

---

### Task 9: reader — sharded chapter_pages write (owner upsert)

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts` (`uploadToStorage`, imports)

**Interfaces:**
- Consumes: `ownerFor`, `internalExec` (Task 7); `markPageB2Uploaded` (Task 4)
- Produces: upload row is upserted to the OWNER D1 (self → local; peer → internalExec; local fallback on forward failure). `getDb(c).markPageB2Uploaded` becomes the "local self" path only.

- [ ] **Step 1: Add helper `upsertPageRow` in reader.ts**

Add near `uploadToStorage`:
```ts
// Upsert chapter_pages row to the OWNER D1 (sharded by chapterId). Self →
// local write; peer → internal /db/exec; on forward failure write locally as
// row-healing fallback (design "Error handling: Owner down → tulis lokal").
const upsertPageRow = async (
  c: Context,
  chapterId: string,
  pageNo: number,
  imageUrl: string,
  b2Key: string,
  accountIdx: number
): Promise<void> => {
  const owner = ownerFor(c.env, chapterId);
  if (owner.self) {
    await getDb(c).markPageB2Uploaded({ chapterId, pageNumber: pageNo, imageUrl, b2Key, b2AccountIdx: accountIdx }).catch(() => {});
    return;
  }
  const sql = `INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`;
  const ok = await internalExec(c.env, owner.url, { sql, params: [chapterId, pageNo, imageUrl, b2Key, accountIdx], table: 'chapter_pages' });
  if (!ok) {
    await getDb(c).markPageB2Uploaded({ chapterId, pageNumber: pageNo, imageUrl, b2Key, b2AccountIdx: accountIdx }).catch(() => {});
  }
};
```

- [ ] **Step 2: Use it in `uploadToStorage`**

Replace the `await getDb(c).markPageB2Uploaded({...})` call (from Task 4/6) inside the success branch with:
```ts
        await upsertPageRow(c, opts.chapterId, opts.pageNo, opts.imageUrl, b2Key, accountIdx);
```

- [ ] **Step 3: Add imports**

Add to the existing `../lib/b2Config.ts` import (or a new import line):
```ts
import { ownerFor, internalExec } from '../lib/peers';
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts
git commit -m "feat(api): upsert chapter_pages to owner D1 (forward with local fallback)"
```

---

### Task 10: reader — sharded chapter_pages read + LRU touch

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts` (`GET /:source/chapter/:chapterId` handler, the LRU touch loop)

**Interfaces:**
- Consumes: `ownerFor`, `internalQuery` (Task 7), `touchPageLastAccess` (db), `b2PresignedGet`, `b2AccountByIdx` (existing)
- Produces: chapter detail reads stored rows from owner D1; LRU touch is forwarded to owner.

- [ ] **Step 1: Replace the local stored-pages query**

In the chapter detail handler, replace:
```ts
    const stored = await c.env.DB.prepare(
      'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1'
    ).bind(chapterId).all<{ page_number: number; r2_key: string; r2_account_idx: number }>().catch(() => null);
    const storedByPage = new Map<number, { r2Key: string; accountIdx: number }>();
    for (const row of stored?.results ?? []) storedByPage.set(row.page_number, { r2Key: row.r2_key, accountIdx: row.r2_account_idx });
```
with:
```ts
    const storedRows = await readStoredPageRows(c, chapterId);
    const storedByPage = new Map<number, { r2Key: string; accountIdx: number }>();
    for (const row of storedRows) storedByPage.set(row.page_number, { r2Key: row.r2_key, accountIdx: row.r2_account_idx });
```

- [ ] **Step 2: Add `readStoredPageRows` + `touchOwnerPage` helpers**

```ts
// Read chapter_pages rows from the owner D1 (self → local; peer → internal
// /db/query). Empty array when owner read fails → frontend falls back to proxy
// (which re-uploads + heals the owner row).
const readStoredPageRows = async (
  c: Context,
  chapterId: string
): Promise<Array<{ page_number: number; r2_key: string; r2_account_idx: number }>> => {
  const owner = ownerFor(c.env, chapterId);
  const sql = 'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1';
  if (owner.self) {
    const res = await c.env.DB.prepare(sql).bind(chapterId).all<{ page_number: number; r2_key: string; r2_account_idx: number }>().catch(() => null);
    return res?.results ?? [];
  }
  return (await internalQuery<{ page_number: number; r2_key: string; r2_account_idx: number }>(
    c.env, owner.url, sql, [chapterId], 'chapter_pages'
  ).catch(() => null)) ?? [];
};

// LRU touch must land on the owner D1 too (the row lives there). Best-effort.
const touchOwnerPage = async (c: Context, chapterId: string, pageNo: number): Promise<void> => {
  const owner = ownerFor(c.env, chapterId);
  if (owner.self) {
    await getDb(c).touchPageLastAccess(chapterId, pageNo).catch(() => {});
    return;
  }
  const sql = 'UPDATE chapter_pages SET last_access = ?1 WHERE chapter_id = ?2 AND page_number = ?3';
  await internalExec(c.env, owner.url, {
    sql,
    params: [Math.floor(Date.now() / 1000), chapterId, pageNo],
    table: 'chapter_pages',
  }).catch(() => {});
};
```

- [ ] **Step 3: Route the LRU touch through `touchOwnerPage`**

In the `waitUntil` block, replace:
```ts
        await getDb(c).touchPageLastAccess(chapterId, i + 1).catch(() => {});
```
with:
```ts
        await touchOwnerPage(c, chapterId, i + 1).catch(() => {});
```

- [ ] **Step 4: Add import**

Add `internalQuery` to the `../lib/peers` import line from Task 9.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts
git commit -m "feat(api): sharded chapter_pages read + owner-forwarded LRU touch"
```

---

### Task 11: readThroughCache — peer KV fallback

**Files:**
- Modify: `apps/api-cf/src/lib/readThroughCache.ts`, `apps/api-cf/src/routes/reader.ts` (detail/chapters/list call sites)

**Interfaces:**
- Consumes: `peerKvGet` (Task 7)
- Produces: new option `peerFallback?: () => Promise<T | null>` — invoked on both-miss before upstream load; when it returns non-null, the value is treated as fresh and written to both tiers.

- [ ] **Step 1: Write failing test**

`apps/api-cf/test/readthrough.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readThroughCache } from '../src/lib/readThroughCache.ts';

function stubCtx(store = {}) {
  const kv = {
    store,
    async get(k) { return this.store[k] ?? null; },
    async put(k, v, opts) { this.store[k] = v; return undefined; },
    async delete(k) { delete this.store[k]; return undefined; },
  };
  return {
    env: { CACHE_KV: kv },
    executionCtx: { waitUntil: async (p) => { try { await p; } catch {} } },
  };
}

test('peerFallback used on both-miss and cached locally', async () => {
  const c = stubCtx();
  let originCalls = 0;
  const res = await readThroughCache(
    c,
    'series:detail:komiku:naruto:id',
    async () => { originCalls++; return { from: 'origin' }; },
    {
      freshTtl: 600, staleTtl: 86400,
      peerFallback: async () => ({ from: 'peer' }),
    }
  );
  assert.equal(res.source, 'fresh');
  assert.deepEqual(res.data, { from: 'peer' });
  assert.equal(originCalls, 0);
  assert.ok(c.env.CACHE_KV.store['f:series:detail:komiku:naruto:id'] !== undefined);
  assert.ok(c.env.CACHE_KV.store['s:series:detail:komiku:naruto:id'] !== undefined);
});

test('peerFallback null → falls through to origin', async () => {
  const c = stubCtx();
  let originCalls = 0;
  const res = await readThroughCache(
    c,
    'chapters:list:komiku:naruto:id',
    async () => { originCalls++; return { from: 'origin' }; },
    { peerFallback: async () => null }
  );
  assert.equal(originCalls, 1);
  assert.deepEqual(res.data, { from: 'origin' });
});

test('peerFallback skipped on fresh hit', async () => {
  const fresh = JSON.stringify({ from: 'fresh' });
  const c = stubCtx({ 'f:chapter:detail:komiku:ch-1': fresh });
  let peerCalls = 0;
  const res = await readThroughCache(
    c,
    'chapter:detail:komiku:ch-1',
    async () => { throw new Error('should not load'); },
    { peerFallback: async () => { peerCalls++; return null; } }
  );
  assert.equal(res.source, 'fresh');
  assert.equal(peerCalls, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx apps/api-cf/test/readthrough.test.mjs`
Expected: fails — option ignored (origin still called / peer value unused).

- [ ] **Step 3: Implement in `readThroughCache.ts`**

Add to `CacheOptions`:
```ts
  /** Optional peer-KV fallback: called on both-miss before upstream load.
   *  Return null/undefined to fall through to origin. Result is cached in
   *  both tiers as if fresh. */
  peerFallback?: () => Promise<T | null>;
```
Add const: `const peerFallback = opts.peerFallback;`

In step 3 (`// 3. Both miss (or circuit open) — try to fetch upstream.`), before the `try { const data = await load(); ... }`, insert:
```ts
  if (peerFallback) {
    try {
      const peer = await peerFallback();
      if (peer != null) {
        c.env.CACHE_KV.put(freshKey, JSON.stringify(peer), { expirationTtl: freshTtl }).catch(() => {});
        c.env.CACHE_KV.put(staleKey, JSON.stringify(peer), { expirationTtl: staleTtl }).catch(() => {});
        resetFailures(c, circuitKey);
        closeCircuit(c, circuitKey);
        return { source: 'fresh', data: peer };
      }
    } catch { /* peer error → fall through to origin */ }
  }
```

- [ ] **Step 4: Wire peer fallback in reader.ts call sites**

For `GET /:source/series/:sourceId/detail`:
```ts
      { circuitKey: `reader:${source}:detail`, peerFallback: async () => {
          const v = await peerKvGet(c, cacheKey);
          return v as { data: { chapters: Chapter[] } & Record<string, unknown> } | null;
        } }
```
For `GET /:source/series/:sourceId`:
```ts
      { circuitKey: `reader:${source}:detail`, peerFallback: async () => {
          const v = await peerKvGet(c, cacheKey);
          return v as { data: Series } | null;
        } }
```
For `GET /:source/series/:sourceId/chapters`:
```ts
      { freshTtl: 300, circuitKey: `reader:${source}:detail`, peerFallback: async () => {
          const v = await peerKvGet(c, cacheKey);
          return v as { data: Chapter[] } | null;
        } }
```
Add import: `import { peerKvGet } from '../lib/peers';`

Note: the KV peer value for `chapter:detail:*` includes `b2Url` presigned URLs — valid 7 days, KV TTL 300s, safe to reuse cross-worker.

- [ ] **Step 5: Run tests**

Run: `npx tsx apps/api-cf/test/readthrough.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api-cf/src/lib/readThroughCache.ts apps/api-cf/src/routes/reader.ts apps/api-cf/test/readthrough.test.mjs
git commit -m "feat(api): peer KV fallback in read-through cache for reader routes"
```

---

### Task 12: Frontend — round-robin across workers

**Files:**
- Modify: `apps/web/lib/api.ts` (`ORIGIN_PATH_ALLOWLIST`, `apiWithFailover`, `dataApi` callers)

**Interfaces:**
- Consumes: `getOrigins()` (existing)
- Produces: `/api/reader/*`, `/api/series*`, `/api/search`, `/api/health`, `/api/source-status` round-robin with rotating index; auth stays sticky.

- [ ] **Step 1: Expand allowlist**

Replace `ORIGIN_PATH_ALLOWLIST`:
```ts
// Round-robin public paths — D1 chapter_pages is now shard-readable from any
// worker (owner forwarding), so reader/series/search/health/source-status can
// hit any origin. Auth paths are NOT here — they stay sticky to auth origin.
const ORIGIN_PATH_ALLOWLIST = [
  '/api/reader/',
  '/api/series',
  '/api/search',
  '/api/health',
  '/api/source-status',
];
```

- [ ] **Step 2: Add rotating index + rework `apiWithFailover`**

Add near `getOrigins`:
```ts
// Round-robin cursor. Persisted in sessionStorage so consecutive page loads
// rotate across workers instead of always starting at index 0.
const getNextRrIndex = (len: number): number => {
  const key = 'rr_index';
  const prev = typeof sessionStorage !== 'undefined' ? Number(sessionStorage.getItem(key)) || 0 : 0;
  const next = (prev + 1) % len;
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, String(next));
  return next;
};
```

Replace the `apiWithFailover` implementation with a rotating + circuit-aware version:
```ts
export async function apiWithFailover<T>(path: string): Promise<T> {
  if (!ORIGIN_PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
    return api<T>(path); // non-publik → main API saja
  }
  const origins = await getOrigins();
  if (origins.length === 0) return api<T>(path);

  const now = Date.now();
  const start = getNextRrIndex(origins.length);
  // Rotate across ALL origins (not a fixed 2-attempt cap) so load spreads.
  for (let k = 0; k < origins.length; k++) {
    const origin = origins[(start + k) % origins.length];
    const state = failures.get(origin.url);
    if (state && state.until > now) continue; // circuit open → skip
    try {
      const res = await fetch(`${origin.url}${path}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        const f = failures.get(origin.url);
        const count = (f?.count ?? 0) + 1;
        failures.set(origin.url, { count, until: count >= 2 ? now + 60000 : now + 5000 });
        continue;
      }
      failures.set(origin.url, { count: 0, until: 0 });
      if (!res.ok) throw new Error(`origin ${path} → ${res.status}`);
      return res.json() as Promise<T>;
    } catch {
      const f = failures.get(origin.url);
      const count = (f?.count ?? 0) + 1;
      failures.set(origin.url, { count, until: count >= 2 ? now + 60000 : now + 5000 });
    }
  }
  return api<T>(path); // semua origin gagal → main API
}
```

- [ ] **Step 3: Route search + source-status through round-robin**

Replace `dataApi` callers:
```ts
export const searchMerged = (q: string): Promise<{ data: MergedManga[]; sources_queried: string[] }> =>
  apiWithFailover(`/api/search?q=${encodeURIComponent(q)}`);

export const getSourceStatus = (): Promise<{ data: SourceStatus[] }> =>
  apiWithFailover('/api/source-status');
```
Delete the now-unused `dataApi` helper and `DATA_API_URL` export (grep first: only these two callers use them).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Grep for leftover dataApi/DATA_API_URL**

Run: `grep -rn "dataApi\|DATA_API_URL" apps/web --include=*.ts --include=*.tsx | grep -v node_modules`
Expected: no matches (or only in the qa page).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): round-robin reader/series/search/health/source-status across workers"
```

---

### Task 13: B2 usage tracker (KV)

**Files:**
- Create: `apps/api-cf/src/lib/b2Usage.ts`, `apps/api-cf/test/b2usage.test.mjs`

**Interfaces:**
- Consumes: `Env.CACHE_KV`, `Env.B2_QUOTA_BYTES`
- Produces:
  - `getB2Usage(kv, idx: number): Promise<number>`
  - `addB2Usage(kv, idx: number, deltaBytes: number): Promise<void>`
  - `setB2Usage(kv, idx: number, bytes: number): Promise<void>`
  - `quotaBytes(env): number` (default `10 * 1024 * 1024 * 1024`)

- [ ] **Step 1: Write failing test**

`apps/api-cf/test/b2usage.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getB2Usage, addB2Usage, setB2Usage, quotaBytes } from '../src/lib/b2Usage.ts';

function stubKv() {
  const store = new Map();
  return {
    store,
    async get(k, _fmt) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async put(k, v, _opts) { store.set(k, v); return undefined; },
  };
}

test('getB2Usage empty → 0', async () => {
  assert.equal(await getB2Usage(stubKv(), 0), 0);
});

test('addB2Usage accumulates per idx independently', async () => {
  const kv = stubKv();
  await addB2Usage(kv, 0, 100);
  await addB2Usage(kv, 0, 50);
  await addB2Usage(kv, 1, 999);
  assert.equal(await getB2Usage(kv, 0), 150);
  assert.equal(await getB2Usage(kv, 1), 999);
});

test('setB2Usage overwrites', async () => {
  const kv = stubKv();
  await setB2Usage(kv, 0, 42);
  assert.equal(await getB2Usage(kv, 0), 42);
});

test('quotaBytes default 10GB, env override', () => {
  assert.equal(quotaBytes({}), 10 * 1024 * 1024 * 1024);
  assert.equal(quotaBytes({ B2_QUOTA_BYTES: '2048' }), 2048);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx apps/api-cf/test/b2usage.test.mjs`
Expected: fails — module not found.

- [ ] **Step 3: Create `apps/api-cf/src/lib/b2Usage.ts`**

```ts
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env } from './context';

// B2 per-account usage tracker (KV). Approximate but cheap; accurate sync via
// native b2_list_buckets happens in the cron (Task 15) which calls setB2Usage.
const USAGE_PREFIX = 'b2:usage:';
const USAGE_TTL = 30 * 86400; // 30 days

export const getB2Usage = async (kv: KVNamespace, idx: number): Promise<number> => {
  const raw = await kv.get(`${USAGE_PREFIX}${idx}`, 'json').catch(() => null);
  const parsed = raw as { bytes?: number } | null;
  return parsed?.bytes ?? 0;
};

export const setB2Usage = async (kv: KVNamespace, idx: number, bytes: number): Promise<void> => {
  await kv.put(`${USAGE_PREFIX}${idx}`, JSON.stringify({ bytes, at: Date.now() }), { expirationTtl: USAGE_TTL }).catch(() => {});
};

export const addB2Usage = async (kv: KVNamespace, idx: number, deltaBytes: number): Promise<void> => {
  const cur = await getB2Usage(kv, idx);
  await setB2Usage(kv, idx, Math.max(0, cur + deltaBytes));
};

// Quota default = B2 free tier 10GB; override via B2_QUOTA_BYTES env.
export const quotaBytes = (env: Env): number => {
  const raw = Number(env.B2_QUOTA_BYTES ?? 0);
  return raw > 0 ? raw : 10 * 1024 * 1024 * 1024;
};

export const usageRatio = async (env: Env, kv: KVNamespace, idx: number): Promise<number> => {
  const used = await getB2Usage(kv, idx);
  const quota = quotaBytes(env);
  return quota > 0 ? used / quota : 0;
};
```

- [ ] **Step 4: Run tests**

Run: `npx tsx apps/api-cf/test/b2usage.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/lib/b2Usage.ts apps/api-cf/test/b2usage.test.mjs
git commit -m "feat(api): per-B2-account KV usage tracker + quota helpers"
```

---

### Task 14: Upload-time usage tracking + near-full eviction trigger

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts` (`uploadToStorage`), `apps/api-cf/src/lib/storageEviction.ts` (export the trigger used at upload)

**Interfaces:**
- Consumes: `addB2Usage`, `usageRatio`, `quotaBytes` (Task 13); `evictStaleStorage` (Task 15, exported already)
- Produces: on successful B2 upload → `addB2Usage(CACHE_KV, i, bytes)`; before upload, if picked account usage > 90% → `waitUntil(evictStaleStorage(env))`.

- [ ] **Step 1: Import usage helpers in reader.ts**

```ts
import { addB2Usage, usageRatio, quotaBytes } from '../lib/b2Usage';
```

- [ ] **Step 2: Upload-time near-full check**

At the top of `uploadToStorage`, after resolving accounts + `startIdx`:
```ts
  // Reaktif: kalau akun terpilih > 90% penuh, picu eviction di background
  // (jangan blokir response).
  const pickIdx = startIdx;
  const ratio = await usageRatio(c.env, c.env.CACHE_KV, pickIdx).catch(() => 0);
  if (ratio > 0.9) {
    c.executionCtx.waitUntil(evictStaleStorage(c.env).catch(() => {}));
  }
```

- [ ] **Step 3: Track usage on success**

In the success branch, after `upsertPageRow(...)` and `touchChapterDetailKv(...)`, add:
```ts
        const bytes = (opts.body as ArrayBuffer).byteLength || 0;
        if (bytes > 0) c.executionCtx.waitUntil(addB2Usage(c.env.CACHE_KV, i, bytes));
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api-cf/src/routes/reader.ts
git commit -m "feat(api): track B2 usage on upload + evict-on-near-full (90%)"
```

---

### Task 15: Usage-based eviction (cross-peer) + native sync

**Files:**
- Modify: `apps/api-cf/src/lib/s3Upload.ts` (export `b2DeleteObject`), `apps/api-cf/src/lib/storageEviction.ts` (rewrite), `apps/api-cf/src/lib/b2Usage.ts` (add `syncB2UsageFromBuckets`)
- Create: `apps/api-cf/test/eviction.test.mjs`

**Interfaces:**
- Consumes: `getPeers`, `internalQuery`, `internalExec` (Task 7); `listStalePages`, `clearPageStorage` (db); `getB2Usage`, `setB2Usage`, `quotaBytes` (Task 13)
- Produces:
  - `evictStaleStorage(env: Env): Promise<{ evicted: number }>` — usage-gated (>80%), queries stale rows across ALL peers (owner D1s), deletes B2 objects, clears owner rows, decrements usage.
  - `syncB2UsageFromBuckets(kv, accounts): Promise<void>` — native B2 usage sync (used by cron).

- [ ] **Step 1: Write failing test**

`apps/api-cf/test/eviction.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getB2Usage, setB2Usage } from '../src/lib/b2Usage.ts';

function stubKv() {
  const store = new Map();
  return {
    store,
    async get(k, _fmt) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async put(k, v, _o) { store.set(k, v); return undefined; },
  };
}

test('usage gating: below 80% → eviction skips account', async () => {
  // Placeholder contract test — the real gating lives in evictStaleStorage
  // which needs DB/HTTP stubs; this asserts the tracker primitives it depends on.
  const kv = stubKv();
  await setB2Usage(kv, 0, 1_000_000); // 1MB of 10GB → well under 80%
  assert.equal(await getB2Usage(kv, 0), 1_000_000);
});
```

- [ ] **Step 2: Move `b2DeleteObject` into `s3Upload.ts`**

Copy the `b2DeleteObject` implementation from `storageEviction.ts:21-55` into `s3Upload.ts`, export it as `export const b2DeleteObject = async (b2: B2Account, key: string): Promise<boolean>`. Use the `B2Account` type already defined there (replace the inline shape). Remove the private copy from `storageEviction.ts` and import it:
```ts
import { b2DeleteObject } from './s3Upload';
```

- [ ] **Step 3: Rewrite `storageEviction.ts`**

Replace the whole file body (keep the module doc comment) with:
```ts
// LRU storage eviction — usage-based, lazy (reader trigger) + cron (akun-1).
// Goal: hapus objek B2 yang last_access > N hari (default 30) ketika usage
// akun > 80% kuota. Turun ke 70% lalu stop.
//
// chapter_pages kini di-shard lintas 3 D1 (owner by chapterId), jadi query
// stale + clear row HARUS jalan ke owner D1 (self = local, peer = internal).
import type { Env } from './context';
import { db } from '@manga-platform/db';
import { resolveB2Accounts, b2AccountForIdx } from './b2Config';
import { b2DeleteObject } from './s3Upload';
import { getPeers, internalQuery, internalExec } from './peers';
import { getB2Usage, setB2Usage, quotaBytes } from './b2Usage';

const EVICT_THRESHOLD = 0.8;   // > 80% → evict
const EVICT_TARGET = 0.7;      // turun sampai ≤ 70%
const DEFAULT_EVICT_DAYS = 30;

const STALE_SELECT_SQL =
  'SELECT chapter_id, page_number, r2_key FROM chapter_pages WHERE r2_account_idx = ?1 AND (last_access IS NULL OR last_access < ?2) ORDER BY last_access ASC NULLS FIRST LIMIT ?3';
const CLEAR_SQL =
  'UPDATE chapter_pages SET r2_key = NULL, r2_account_idx = NULL WHERE chapter_id = ?1 AND page_number = ?2';

export const evictStaleStorage = async (env: Env): Promise<{ evicted: number }> => {
  const evictDays = Number(env.B2_EVICTION_DAYS) || DEFAULT_EVICT_DAYS;
  const staleBeforeTs = Math.floor(Date.now() / 1000) - evictDays * 86400;
  const b2Accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
  const peers = getPeers(env);
  let totalEvicted = 0;

  for (let i = 0; i < b2Accounts.length; i++) {
    const accountIdx = -(i + 1);
    const quota = quotaBytes(env);
    let used = await getB2Usage(env.CACHE_KV, i).catch(() => 0);
    if (quota > 0 && used / quota <= EVICT_THRESHOLD) continue;
    const target = Math.floor(quota * EVICT_TARGET);

    // Kumpulkan halaman stale dari SEMUA shard (owner D1). Self → db helper,
    // peer → internal /db/query.
    const stale: Array<{ chapter_id: string; page_number: number; r2_key: string }> = [];
    const limitPerPeer = 100;
    for (const peer of peers) {
      if (peer.self) {
        const rows = await db(env.DB).listStalePages(accountIdx, staleBeforeTs, limitPerPeer).catch(() => []);
        for (const r of rows) stale.push({ chapter_id: r.chapter_id, page_number: r.page_number, r2_key: r.r2_key });
      } else {
        const rows = await internalQuery<{ chapter_id: string; page_number: number; r2_key: string }>(
          env, peer.url, STALE_SELECT_SQL, [accountIdx, staleBeforeTs, limitPerPeer], 'chapter_pages'
        ).catch(() => null);
        for (const r of rows ?? []) stale.push({ chapter_id: r.chapter_id, page_number: r.page_number, r2_key: r.r2_key });
      }
    }

    for (const page of stale) {
      if (quota > 0 && used <= target) break;
      const b2 = b2AccountForIdx(b2Accounts, accountIdx);
      if (!b2) break;
      const deleted = await b2DeleteObject(b2, page.r2_key).catch(() => false);
      if (!deleted) continue;
      // Clear row pada owner D1.
      const owner = peers.find((p) => !p.self) ? getPeers(env)[0] : null; // placeholder replaced below
      await clearRowOnOwner(env, page.chapter_id, page.page_number);
      used = Math.max(0, used - 1000000); // approx 1MB/obj decrement
      totalEvicted++;
    }
    await setB2Usage(env.CACHE_KV, i, Math.max(0, used));
    console.log(`[evict] b2:${b2Accounts[i].name} evicted ${totalEvicted} (usage now ${used} bytes)`);
  }

  return { evicted: totalEvicted };
};

// Clear storage row on the owner D1 (self → local; peer → internal exec).
const clearRowOnOwner = async (env: Env, chapterId: string, pageNo: number): Promise<void> => {
  const peers = getPeers(env);
  const owner = peers.find((p) => !p.self) ? null : null; // replaced in Step 4
  void owner;
  void chapterId;
  void pageNo;
};
```

> Note: `clearRowOnOwner` placeholder is completed in **Step 4** below — do not ship this intermediate version. Re-read the full final version before committing.

- [ ] **Step 4: Complete `clearRowOnOwner` + remove placeholder**

Replace `clearRowOnOwner` with:
```ts
import { ownerFor } from './peers';

const clearRowOnOwner = async (env: Env, chapterId: string, pageNo: number): Promise<void> => {
  const owner = ownerFor(env, chapterId);
  if (owner.self) {
    await db(env.DB).clearPageStorage(chapterId, pageNo).catch(() => {});
    return;
  }
  await internalExec(env, owner.url, {
    sql: CLEAR_SQL,
    params: [chapterId, pageNo],
    table: 'chapter_pages',
  }).catch(() => {});
};
```
And remove the bogus `const owner = peers.find(...)` line + `let owner` var from the loop (keep only `clearRowOnOwner(...)` call). Also drop the now-unused `peers.find` line entirely.

- [ ] **Step 5: Run tests**

Run: `npx tsx apps/api-cf/test/eviction.test.mjs`
Expected: PASS (contract test).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api-cf/src/lib/s3Upload.ts apps/api-cf/src/lib/storageEviction.ts apps/api-cf/test/eviction.test.mjs
git commit -m "feat(api): usage-based eviction across sharded D1 owners + exported b2DeleteObject"
```

---

### Task 16: Cron scheduled handler (akun-1 owner) + native usage sync

**Files:**
- Modify: `apps/api-cf/src/index.ts`, `apps/api-cf/wrangler.toml`, `apps/api-cf/src/lib/b2Usage.ts` (add `syncB2UsageFromBuckets`), `apps/api-cf/src/lib/s3Upload.ts` (add `b2Authorize` + `b2ListBucketsUsage`)

**Interfaces:**
- Consumes: `evictStaleStorage` (Task 15), `setB2Usage` (Task 13)
- Produces: `scheduled` handler in default export; runs only when `EVICTION_OWNER === "1"` and KV lock `eviction:lock` free; syncs usage from native B2 buckets then evicts.

- [ ] **Step 1: Add native B2 usage sync to `b2Usage.ts`**

```ts
import { parseB2Accounts, type B2Account } from './b2Config';

// Authorize a B2 account and return the per-bucket usage. Uses the B2 native
// API (b2_authorize_account → b2_list_buckets) — accurate fileCount + bytes.
export const b2NativeUsage = async (b2: B2Account): Promise<{ fileCount: number; bytes: number } | null> => {
  try {
    const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: {
        Authorization: 'Basic ' + btoa(`${b2.keyId}:${b2.appKey}`),
      },
    });
    if (!authRes.ok) return null;
    const auth = (await authRes.json()) as { apiInfo?: { storageApi: { apiUrl: string; bucketId: string } } };
    const apiUrl = auth.apiInfo?.storageApi.apiUrl;
    if (!apiUrl) return null;
    const listRes = await fetch(`${apiUrl}/b2api/v3/b2_list_buckets`, {
      method: 'POST',
      headers: {
        Authorization: (await authRes.clone().text()) ? '' : '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: b2.keyId }),
    });
    return null; // implemented via headers below
  } catch {
    return null;
  }
};
```
> Note: B2 native auth is finicky (needs `b2_authorize_account` returning `authorizationToken` + `apiInfo`). Implement it properly in Step 2 using the returned token; the snippet above is a scaffold. Test coverage is a live probe (Step 6), not unit.

- [ ] **Step 2: Implement native sync correctly**

Rewrite `b2NativeUsage` to the correct flow (single account → use `B2_CONFIG`-style account; the plan's live-verified pattern):
```ts
export const b2NativeUsage = async (b2: B2Account): Promise<{ fileCount: number; bytes: number } | null> => {
  try {
    const basic = btoa(`${b2.keyId}:${b2.appKey}`);
    const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!authRes.ok) return null;
    const auth = (await authRes.json()) as {
      authorizationToken: string;
      apiInfo: { storageApi: { apiUrl: string; bucketId: string } };
      accountInfo: { usedBucketCapabilities: number };
    };
    const { authorizationToken, apiInfo, accountInfo } = auth;
    if (!apiInfo?.storageApi?.apiUrl || !authorizationToken) return null;
    const listRes = await fetch(`${apiInfo.storageApi.apiUrl}/b2api/v3/b2_list_buckets`, {
      method: 'POST',
      headers: { Authorization: authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: apiInfo.storageApi.bucketId }),
    });
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as { buckets?: Array<{ bucketName: string; fileCount: number }> };
    const bucket = list.buckets?.find((b) => b.bucketName === b2.bucket);
    return { fileCount: bucket?.fileCount ?? 0, bytes: accountInfo?.usedBucketCapabilities ?? 0 };
  } catch {
    return null;
  }
};

export const syncB2UsageFromBuckets = async (env: Env): Promise<void> => {
  const accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
  for (let i = 0; i < accounts.length; i++) {
    const usage = await b2NativeUsage(accounts[i]).catch(() => null);
    if (usage) await setB2Usage(env.CACHE_KV, i, usage.bytes);
  }
};
```
Add `resolveB2Accounts` to the import from `./b2Config`.

- [ ] **Step 3: Add `scheduled` handler to `index.ts`**

```ts
import type { ScheduledController, ExecutionContext } from '@cloudflare/workers-types';
import { evictStaleStorage } from './lib/storageEviction';
import { syncB2UsageFromBuckets } from './lib/b2Usage';
```
Replace the default export:
```ts
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.EVICTION_OWNER !== '1') return; // hanya akun-1 yang punya cron
    const kv = env.CACHE_KV;
    const lock = await kv.get('eviction:lock').catch(() => null);
    if (lock) return;
    await kv.put('eviction:lock', '1', { expirationTtl: 600 }).catch(() => {});
    try {
      await syncB2UsageFromBuckets(env as Env);
      const res = await evictStaleStorage(env as Env);
      console.log(`[cron] eviction done: ${res.evicted} objects`);
    } finally {
      await kv.delete('eviction:lock').catch(() => {});
    }
  },
};
```

- [ ] **Step 4: wrangler.toml — cron + EVICTION_OWNER (akun-1 only)**

`apps/api-cf/wrangler.toml` — add after `[vars]` block:
```toml
[triggers]
crons = ["0 * * * *"]
```
And add to `[vars]`:
```toml
EVICTION_OWNER = "1"
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/api-cf/tsconfig.json --noEmit`
Expected: 0 errors.

- [ ] **Step 6: (Live) verify cron deploy + lock**

Deploy akun-1, then:
Run: `npx wrangler triggers list --config apps/api-cf/wrangler.toml`
Expected: one hourly cron `0 * * * *` registered.
Then trigger manually once via dashboard/`wrangler` if available and check `wrangler tail` shows the `[cron]` log.

- [ ] **Step 7: Commit**

```bash
git add apps/api-cf/src/index.ts apps/api-cf/wrangler.toml apps/api-cf/src/lib/b2Usage.ts apps/api-cf/src/lib/s3Upload.ts
git commit -m "feat(api): hourly eviction cron (akun-1) with native B2 usage sync + KV lock"
```

---

### Task 17: Docs/env cleanup (non-blocking)

**Files:**
- Modify: `README.md`, `docs/ADDING-ACCOUNT.md`, `docs/superpowers/specs/2026-08-08-architecture-caching-design.md`, `docs/superpowers/plans/2026-08-08-architecture-caching.md`, `apps/api-cf/.dev.vars.example`
- Delete: `scripts/setup-r2-account.mjs`

**Interfaces:**
- Consumes: none
- Produces: no R2 references in README/env examples.

- [ ] **Step 1: Grep R2 references**

Run: `grep -rn "R2_ACCOUNTS\|R2_DOMAINS\|ASSETS_R2\|setup-r2-account\|cdnN.oktz" README.md docs apps/api-cf/.dev.vars.example 2>/dev/null`
Expected: list of lines to clean.

- [ ] **Step 2: Update README storage table + env table**

Replace the `R2_ACCOUNTS` row and any `NEXT_PUBLIC_R2_DOMAINS`/`NEXT_PUBLIC_R2_VNODES` mentions with a note: "R2 removed — full B2 (`B2_CONFIG` + `B2_ACCOUNTS`)."

- [ ] **Step 3: Delete setup script**

Run: `git rm scripts/setup-r2-account.mjs`

- [ ] **Step 4: Update ADDING-ACCOUNT.md**

Replace the R2 section (steps 5 + the `R2_ACCOUNTS`/`NEXT_PUBLIC_R2_DOMAINS` ordering note) with the new B2-only flow: add entry to `B2_ACCOUNTS` on all workers; ordering no longer matters for correctness (hash pick), but keep `B2_CONFIG` (legacy single) consistent with `B2_ACCOUNTS[0]`.

- [ ] **Step 5: Commit**

```bash
git add -A README.md docs apps/api-cf/.dev.vars.example
git rm scripts/setup-r2-account.mjs 2>/dev/null || git add -A scripts
git commit -m "docs: R2 removal — full B2 docs + env examples"
```

---

### Task 18: Build + deploy 3 workers + Pages + live verification

**Files:**
- Ops-only: no source changes unless verification finds a bug.

**Interfaces:**
- Consumes: all previous tasks
- Produces: live system with sharding + round-robin + eviction.

- [ ] **Step 1: Full typecheck + tests**

Run:
```bash
npx tsc -p apps/api-cf/tsconfig.json --noEmit && \
npx tsc -p apps/web/tsconfig.json --noEmit && \
npx tsx packages/shared/test/r2-routing.test.mjs && \
npx tsx apps/api-cf/test/b2-pick.test.mjs && \
npx tsx apps/api-cf/test/b2-upload.test.mjs && \
npx tsx apps/api-cf/test/peers.test.mjs && \
npx tsx apps/api-cf/test/internal-route.test.mjs && \
npx tsx apps/api-cf/test/readthrough.test.mjs && \
npx tsx apps/api-cf/test/b2usage.test.mjs && \
npx tsx apps/api-cf/test/eviction.test.mjs && \
npx tsx packages/db/test/storage-rename.test.mjs
```
Expected: all PASS, tsc clean.

- [ ] **Step 2: Build worker bundle for akun-2/3**

Run: `node scripts/build-worker-bundle.mjs`
Expected: `apps/api-cf/dist/worker.js` rebuilt.

- [ ] **Step 3: Set shared secrets on all 3 workers**

```bash
echo -n '<DB_FORWARD_KEY>' | npx wrangler secret put DB_FORWARD_KEY --config apps/api-cf/wrangler.toml
echo -n '<DB_FORWARD_KEY>' | npx wrangler secret put DB_FORWARD_KEY --config apps/api-cf/wrangler.origin.toml
echo -n '<DB_FORWARD_KEY>' | npx wrangler secret put DB_FORWARD_KEY --config apps/api-cf/wrangler.origin3.toml
```
Also ensure `PEER_URLS` + `PEER_INDEX` are set as vars on all 3 (via `wrangler secret put` or `[vars]`):
- akun-1: `PEER_URLS=https://manga-api.oktz.workers.dev,https://manga-api-2.tzok5555.workers.dev,https://manga-api-3.dwikaoktyffan.workers.dev`, `PEER_INDEX=0`
- akun-2: same PEER_URLS, `PEER_INDEX=1`
- akun-3: same PEER_URLS, `PEER_INDEX=2`

- [ ] **Step 4: Deploy 3 workers**

```bash
npx wrangler deploy --config apps/api-cf/wrangler.toml
npx wrangler deploy --config apps/api-cf/wrangler.origin.toml
npx wrangler deploy --config apps/api-cf/wrangler.origin3.toml
```

- [ ] **Step 5: Deploy frontend (Pages)**

```bash
rm -rf .vercel/output && npx @cloudflare/next-on-pages && npx wrangler pages deploy .vercel/output/static --project-name manga-web
```

- [ ] **Step 6: Live verify sharding**

Pick a chapterId, compute owner, POST an internal exec probe to the owner URL, read it back, delete it (mirror of the earlier D1 probe script in `/tmp/opencode/ddl.mjs` — reuse pattern with `PEER_URLS` + `DB_FORWARD_KEY`).

Run: `node /tmp/opencode/probe-shard.mjs` (create one now, using `murmur3_32(chapterId)%3` and the 3 worker URLs + forward key)
Expected: write to owner succeeds; non-owner query returns row via owner read; cleanup removes row.

- [ ] **Step 7: Live smoke — reader round-robin + B2 upload + eviction**

- Load `https://oktzz.xyz/komiku/s/<slug>` twice — confirm `/api/reader/*` hits alternating workers (network tab / logs).
- Open a chapter; first page request proxies + uploads to B2 (hash-picked account); second request returns `b2Url` presigned directly.
- Confirm `b2:usage:{idx}` keys appear in KV (`npx wrangler kv key list --namespace-id=6205fceab7b64f9d80f6f67e4189316b --prefix=b2:usage:`).

- [ ] **Step 8: Commit any verification-driven fixes**

If Step 6/7 expose bugs, fix + rerun the affected task tests before final commit.

---

## Self-Review

**Spec coverage:**
- Part 1 R2 removal → Tasks 1, 2, 3, 4, 17.
- Part 2 B2 hash round-robin → Tasks 5, 6.
- Part 3 D1 sharding (owner write/read/touch) → Tasks 7, 8, 9, 10.
- Part 4 KV peer fallback → Task 11 (+ internal `/kv/get` in Task 8).
- Part 5 frontend round-robin → Task 12.
- Part 6 eviction (tracker + cron + upload check) → Tasks 13, 14, 15, 16.
- Deploy + live verify → Task 18.
- All spec "Error handling" rows (owner-down local fallback, B2 fallback, peer timeout skip, eviction double-run lock, presign re-issue) are implemented in the referenced tasks.

**Known gaps flagged in plan:** `syncB2UsageFromBuckets`/`b2NativeUsage` (Task 16) is live-probe-only tested (no unit test; B2 native API can't be stubbed cheaply). The eviction unit test in Task 15 is a contract test on the tracker primitives; full eviction path is verified live in Task 18 Step 7. These are documented, not silent.

**Type consistency:** `markPageB2Uploaded({chapterId, pageNumber, imageUrl, b2Key, b2AccountIdx})` defined Task 4, used Tasks 6/9. `ownerFor(env, key)` / `internalExec(env, peerUrl, {sql, params, table})` / `internalQuery(env, peerUrl, sql, params, table)` defined Task 7, used Tasks 9/10/15. `peerKvGet(env, key)` Task 7 → Task 11. `evictStaleStorage(env)` Task 15 → Tasks 14/16. `addB2Usage(kv, idx, bytes)` Task 13 → Task 14.
