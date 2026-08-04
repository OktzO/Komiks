# Task 2 Report — D1 schema + migrations + db pkg

## Status
**Complete.** `packages/db` + `packages/shared` created; TS strict typecheck passes; SQLite loads schema+seed and every helper SQL statement executes against real bindings.

## Commit
`3299ea8` — *feat(task2): D1 schema + seed + db helpers + shared zod types* (branch `sdd/manga-platform`, on top of BASE `6fbde81`).

## Files created
- `packages/db/package.json` (`@manga-platform/db`, no runtime deps; devDeps `@cloudflare/workers-types`, `typescript`)
- `packages/db/tsconfig.json` — strict, ES2022, Bundler, worker types
- `packages/db/schema.sql` — 10 tables + `series_search` FTS5 shadow + 3 sync triggers
- `packages/db/seed.sql` — One Piece / Solo Leveling sample data
- `packages/db/index.ts` — `db(d1)` factory with typed async helpers (`getSeriesBySlug`, `listSeries`, `getChapter`, `listChapterPages`, `searchSeries`, `createUser`, `getUserById`, `addBookmark`, `removeBookmark`, `listBookmarks`, `upsertHistory`, `listHistory`, `getLbSettings`, `setLbSettings`, `listAccounts`, `addAccount`, `createOrigin`, `listOrigins`, `updateOrigin`, `recordOriginHealth`, `getOriginStatus`, `addAuditLog`) + `client` alias
- `packages/shared/package.json` (`@manga-platform/shared`, dep `zod`)
- `packages/shared/tsconfig.json`
- `packages/shared/types.ts` — Zod schemas `SeriesSchema`, `ChapterSchema`, `ChapterPageSchema`, `UserSchema`, `BookmarkSchema`, `ReadingHistorySchema`, `LbSettingsSchema`, `LbAccountSchema`, `LbOriginSchema` + inferred row types (`Series`, `Chapter`, `ChapterPage`, `Bookmark`, `ReadingHistory`, `LbSettings`, `LbAccount`, `LbOrigin`)
- `scripts/smoke-db.mjs` — offline SQL smoke harness using Node built-in `node:sqlite`

## Verification (Step 4)
- `sqlite3 :memory: < schema.sql` → **EXIT 0**; `sqlite_master` lists all expected tables (`series`, `chapters`, `chapter_pages`, `users`, `bookmarks`, `reading_history`, `lb_settings`, `lb_accounts`, `lb_origins`, `lb_audit_log`, `series_search`).
- FTS5 trigram MATCH (`'treasure'`) returns the shadow row mirrored from `series.synopsis` via triggers → confirms `series.synopsis` → `series_search.description` mapping works.
- **tsc strict**: `npx tsc --noEmit -p packages/db` → **EXIT 0**. `packages/shared` → **EXIT 0**. `apps/api-cf` (regression) → **EXIT 0**.
- **SQL smoke** (`node scripts/smoke-db.mjs`) → **ALL PASS (exit 0)**: loads schema+seed, executes every helper SQL statement with `?1/?2` positional bindings through `node:sqlite` DatabaseSync `prepare().get/all/run` — validates `INSERT … RETURNING`, `ON CONFLICT … DO UPDATE` upsert, FTS5 `MATCH … ORDER BY rank`, JOINs, and genre `LIKE` filtering. (ExperimentalWarning for `node:sqlite` is benign.)

## Decisions applied (per ambiguity resolution)
- D1 = SQLite-compatible SQL; no ORM — raw `sqlite3` CLI + `node:sqlite` node binding for smoke test.
- `series.type CHECK(type IN ('manga','manhwa','manhua'))`, `chapters.chapter_number REAL` (0.5 ok), status enums checked.
- FTS5: `series_search(title, description)` mapped to `series.synopsis` via a **simple shadow table + sync triggers** (naming mismatch `description` vs `synopsis` resolved by not using EXTERNAL CONTENT, which would require matching column names).

## Concerns / notes
- DB package is a `.ts` source module (no build emit); `wrangler` bundles it at deploy. The `db(d1)` factory returns a fresh helper set per-request/Env binding — call once per request context, do not cache across different D1 instances.
- `recordOriginHealth` is append-only (writes a `lb_audit_log` row); `getOriginStatus` reads the latest row for an origin. True per-origin KV status (`lb:origin_status`) is written by the worker cron (Task 12), not the DB layer.
- `updateOrigin` builds `SET` dynamically from `Object.entries` — column names come from typed `LbOrigin` keys only; no string interpolation of user data, no SQLi.
- Workspace `@manga-platform/*` symlinks + `zod`/`workers-types` resolved into repo `node_modules` after `npm install`.

---

## Fix Report — Review Round 1 (Spec-Conformance for `lb_*` tables)
**Commit:** `b9d81d0` — *fix(task2): realign lb_* helpers, types, smoke test to spec §6 schema*

### Reviewer finding (Critical)
The `lb_*` tables in commit `3299ea8` used a legacy `key/value` schema (`lb_settings(key, value)`, `lb_accounts(id INTEGER AUTOINCREMENT, name, provider CHECK IN ('cloudflare','vercel','custom'), encrypted_token TEXT, enabled)`, `lb_origins(name, url, INTEGER ids)`) that deviated from prompt §6.

### Changes applied
Schema (`packages/db/schema.sql`):
- `lb_settings`: `id INTEGER PK CHECK (id=1)` + typed columns (`mode`, `implementation`, `steering_policy`, `health_check_interval_sec`, `health_check_timeout_ms`, `failure_threshold`) with CHECKs/defaults per §6.
- `lb_accounts`: `id TEXT PRIMARY KEY`, `provider CHECK IN ('cloudflare','vercel')` (dropped `'custom'`), `label TEXT`, `account_ref TEXT`, `encrypted_token BLOB NOT NULL`, `token_last4 TEXT`, `status CHECK IN (...) DEFAULT 'unverified'`, `created_by INTEGER REFERENCES users(id)`, `created_at`.
- `lb_origins`: `id TEXT PRIMARY KEY`, `account_id TEXT REFERENCES lb_accounts(id) ON DELETE SET NULL`, `origin_url TEXT`, `priority/weight/enabled`, `last_health_status TEXT`, `last_checked_at INTEGER`, `created_at`.
- `lb_audit_log`: `account_id`/`origin_id` changed to `TEXT` FK matching `lb_accounts`/`lb_origins`.

Types (`packages/shared/types.ts`):
- `LbProvider` enum reduced to `['cloudflare','vercel']`.
- `LbSettingsSchema`: added `id` + all spec §6 fields with enum defaults.
- `LbAccountSchema`: swapped `name`→`label`, `status`, `created_by`; `encrypted_token` → `ArrayBuffer | Uint8Array` (avoids `Buffer` dependency under `@cloudflare/workers-types`-only tsconfig).
- `LbAccountSafeSchema`: omits `encrypted_token`.
- `LbOriginSchema`: `id TEXT`, `name`→`origin_url`, added `account_id`, `last_health_status`, `last_checked_at`.
- Added `LbAuditLogSchema` + type.

Helpers (`packages/db/index.ts`):
- `getLbSettings()`: returns single row (`WHERE id = 1`), type `Promise<LbSettings | null>`.
- `setLbSettings(updates, id=1)`: dynamic `UPDATE SET … WHERE id=?, id` excluded from SET.
- `listAccounts()`: explicit column list excluding `encrypted_token` → `LbAccountSafe[]`.
- `addAccount({label,provider,account_ref,encrypted_token,token_last4,created_by?})`: generates `TEXT` id via `crypto.randomUUID()`, returns `{id: string>`.
- `createOrigin({account_id?,origin_url,priority?,weight?,enabled?})`: generates `TEXT` id, returns `{id: string>`.
- `updateOrigin(id: string, params)`: `id` is now `TEXT`.
- `recordOriginHealth(originId, healthy, checkedAt?)`: **UPDATEs** `lb_origins` `last_health_status` + `last_checked_at` (per §6, not append-only audit log).
- `getOriginStatus(originId)`: **reads from `lb_origins`** (not audit_log), returns `{healthy, last_checked_at}`.
- `addAuditLog({accountId?,originId?,action,userId?})`: TEXT ids throughout.

Smoke test (`scripts/smoke-db.mjs`):
- Replaced legacy `key/value` checks with: single-row `lb_settings` fetch, `setLbSettings` column update, `addAccount` TEXT id verification, `listAccounts` token-omission check, `createOrigin` with `account_id` FK, `recordOriginHealth` → `lb_origins` UPDATE, `getOriginStatus` from origin row, `addAuditLog` with TEXT ids.

### Verification (all pass)
- `node scripts/smoke-db.mjs` → **ALL PASS (exit 0)** — 20 checks green including all lb_* assertions.
- `npx tsc --noEmit -p packages/db` → **EXIT 0**.
- `npx tsc --noEmit -p packages/shared` → **EXIT 0**.
- `npx tsc --noEmit -p apps/api-cf` → **EXIT 0** (regression).

### Files modified in fix commit
- `packages/db/schema.sql`
- `packages/db/seed.sql`
- `packages/db/index.ts`
- `packages/shared/types.ts`
- `scripts/smoke-db.mjs`

### Concerns / notes
- `encrypted_token` type widened to `ArrayBuffer | Uint8Array` (was `ArrayBuffer | Buffer`) to avoid `@types/node` dependency in db pkg's `@cloudflare/workers-types`-only tsconfig. `Buffer` is a `Uint8Array` subclass, so runtime compatibility with `node:sqlite` smoke test (which binds `Buffer.from(...)` for BLOB) is preserved.
- `addAccount` / `createOrigin` generate `TEXT` ids internally via `crypto.randomUUID()` — Cloudflare Workers global available under `@cloudflare/workers-types`.`
