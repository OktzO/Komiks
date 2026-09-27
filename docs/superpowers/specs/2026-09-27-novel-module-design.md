# Novel / Light Novel Module Design

**Date:** 2026-09-27
**Status:** Approved in chat; awaiting written-spec review
**Scope:** New `/novel` module (web + API + D1 + adapters) on the existing Turborepo/Astro/Hono/Workers stack, plus a bounded audit pass over the existing manga adapter layer

Supersedes the draft *"Mangaku Ecosystem Expansion: Web Novel / Light Novel Module + Backend Audit"*. That draft was written before any source was verified; §5 lists every point where it was wrong.

---

## 1. Problem

Mangaku is a manga aggregator. Goal: add a web novel / light novel reading module under the same domain, reusing the existing platform rather than standing up new infrastructure.

The original draft assumed two Indonesian novel sources structurally similar to the manga scrapers. Verification found that assumption false for both, and a market sweep found no second open chapter-capable Indonesian novel source at all. This spec records the verified reality and designs around it.

## 2. Verified source landscape

Probed 2026-09-27 with `curl` from outside Cloudflare, plus Firecrawl. **This section is evidence, not opinion. Do not re-litigate it without re-probing.**

| Source | Status | Chapter text | Verdict |
|---|---|---|---|
| `novelid.org` | 200, server-rendered, `robots.txt` allows `/novel/`, no login | yes, in `div.watch-chapter-detail` | **primary, chapter-capable** |
| `gooddreamer.id` | 200, client-rendered; Laravel JSON API at `api.gooddreamer.id/api/web/*` | **no** — `novel_price:29`, `free_chapter:5`, `is_exclusive:1`; all 8 probed chapter paths return `404 Route Not found` | metadata fallback only |
| `noveltoon.mobi` | 200, `/id` serves Indonesian | not in SSR; `robots.txt` has `Disallow: /api` | metadata fallback only |
| `cabaca.id` | 200, Framework7 SPA, API at `cabaca.id:8443/api/v2/` | **no** — `400 No session token (JWT) or API Key detected` | rejected |
| `sakuranovel.id` | 403 Cloudflare challenge | — | rejected |
| `novelhall.com` | 403 Cloudflare challenge | — | rejected |
| `novelbook.id` | DNS NXDOMAIN | — | rejected (was a named source in the original draft) |
| `dreambooks.id`, `lightnovel.id`, `komikav2.com` | DNS NXDOMAIN | — | rejected |

Conclusion: `novelid.org` is the only chapter-capable source available. The design must therefore buy resilience through *tiering* and *graceful degradation*, not through source redundancy that does not exist.

### 2.1 `novelid.org` shapes (verified)

```
catalog   /                     /novel/arsip-nol        /doujin/page/{n}
series    /novel/{slug}/                                    (Author, Genre present)
chapter   /novel/{slug}/bab/{n}/                           (prose in div.watch-chapter-detail)
cover     /uploads/....jpg?resize=139,184                  (query stripped by sanitizeCoverUrl)
```

`robots.txt` disallows only `/includes/`, `/themes/`, `/search/`, `/memeen/`. `/novel/` is allowed. Chapter fetch returns 200 with no login redirect.

## 3. Goals

1. Read and browse novels at `/novel/*` on the same domain, same auth, same theme system.
2. Shard novel data across all four D1 databases from day one, using the existing hash function.
3. Reuse every existing platform primitive: adapter registry, retry, robots, R2/B2 cover path, KV cache, four-Worker failover, cron scrape.
4. Degrade gracefully when a source is down: serve stale content, never hard-fail a chapter read.
5. Fill metadata gaps from secondary sources when the primary lacks a cover or synopsis.
6. Complete the audit of the manga adapter layer at low risk, and record high-risk items in a backlog without touching them.

## 4. Non-goals

- AI translation pipeline for foreign-language sources. Deferred; separate design pass.
- Merging novel and manga into one schema. Separate module, connected by link.
- Any change to the session signing keyring, the Cloudflare token encryption, D1 core schema, the consistent-hash load balancer, or sharding logic. Flagged only.

  Two distinct protected mechanisms are commonly conflated here, and they are risky for different reasons:
  - **Session signing** is **ECDSA P-256 with a `kid` keyring** (`apps/api-cf/src/lib/auth.ts`), used for cross-account asymmetric session verification. Its risk is key rotation across the four accounts, not cipher choice.
  - **Cloudflare API tokens at rest** are **AES-GCM** encrypted via Web Crypto (`packages/lb/crypto.ts`). Its risk is the key derivation from the signing secret.
- A second chapter source. None is available; re-probe before assuming this still holds.

## 5. Corrections to the original draft

| Draft claim | Reality | Decision |
|---|---|---|
| Stack is "Next.js + Turborepo" | Turborepo yes; web is **Astro**, API is **Hono** | Build as Astro pages + Hono routes |
| Sources: novelbook.id, gooddreamer.id | novelbook DNS-dead; gooddreamer chapter coin-gated | `novelid.org` primary; gooddreamer metadata-only |
| `SourceAdapter` to be authored in Phase 0 | Already exists at `packages/sources/index.ts:20-38`, used by 6 production adapters | Novel adapters **conform**; no rewrite |
| `selectors: Record<string,string>` | Workers have no DOMParser (`packages/sources/komiku/index.ts:29`); CSS selectors cannot be evaluated | Typed regex/segment rules, following `packages/sources/komiku/selectors.ts` |
| Audit 4 manga adapters | 6 exist (incl. shinigami, webtoon) | Audit all 6 |
| Retry/timeout/logging to be built | `apps/api-cf/src/lib/retry.ts` + per-client `AbortSignal.timeout` already exist | Reuse unchanged |
| Hardcoded URLs are a problem | Repo-wide grep finds 7 (2 × `komiku.org` in `reader.ts`, 5 Google OAuth in `auth.ts`) | Audit value is small; focus on shared `lib/` instead |
| Novel tables lack upstream IDs | Cannot re-scrape a stored series | Add `source_series_id`, `source_chapter_id`, `content_hash` |
| Robots compliance unmentioned | Already implemented per adapter | Reuse; mandatory for novel |
| Stale: "webtoon planned as fifth" | webtoon shipped, 381 lines, largest adapter | — |

## 6. Architecture

### 6.1 Module boundary

Novel lives beside manga, not inside it. It gets its own D1 tables, its own adapters, its own routes. It reuses shared infrastructure, not manga data structures. Cross-linking between a novel and a manga does not exist.

### 6.2 Source tiering

```
Tier 1 (chapter)   novelid
Tier 2 (metadata)  gooddreamer   → /api/web/novels, /api/web/novels/{id|uri}, /api/web/categories, /api/web/tags
                   noveltoon     → SSR HTML under /id/
```

Read path resolves in order: novelid data from D1; if `cover_ref`, `synopsis`, or `author` is empty, fill from tier 2 and persist. A metadata gap must never trigger a chapter-level cross-source resolution, because only one source has chapters.

### 6.3 Graceful degradation (B'')

- Chapter read serves D1 content unconditionally. Scraping never happens in the read path.
- A stale `scraped_at` is served, not an error, when refresh fails.
- Existing circuit breaker in `apiWithFailover` (2 consecutive failures → 60s open) covers Worker-level failover.
- KV holds the catalog for 24h with lazy refresh on first view, matching the manga pattern.
- Catalog refresh hooks the **existing** hourly cron (`crons = ["0 * * * *"]` in `apps/api-cf/wrangler.toml`). No new trigger is added.

### 6.4 Adapter contract

The manga `SourceAdapter` in `packages/sources/index.ts` is **not modified**. Novel adapters are a separate type, because a novel has no paged images, no `fetchPageUrls`, and no proxy headers — forcing it into the manga shape would produce a dozen methods that return null.

A new `packages/sources/novel.ts` holds the novel-side interface. `index.ts` changes only to register the novel source keys:

```ts
// packages/sources/novel.ts — new file
export interface NovelSourceAdapter {
  sourceKey: NovelSourceKey;          // 'novelid' | 'gooddreamer' | 'noveltoon'
  capability: 'chapter' | 'metadata';
  search(params): Promise<NovelSeries[]>;
  getSeries(sourceId): Promise<NovelSeries>;
  listChapters(sourceId): Promise<NovelChapter[]>;
  getChapterContent?(chapterSourceId): Promise<{ html: string }>;  // required iff capability==='chapter'
}
```

Parsing rules live in a per-source `rules.ts` holding typed regexes and segment anchors, exported `as const` — the shape already proven by `packages/sources/komiku/selectors.ts`. No CSS selector strings. No inline parsing logic in adapter bodies.

### 6.5 D1 schema

```sql
novel_series (
  id              TEXT PRIMARY KEY,
  source_series_id TEXT NOT NULL,      -- upstream id/slug; required to re-scrape
  source          TEXT NOT NULL,
  title           TEXT NOT NULL,
  author          TEXT,
  genre           TEXT,                -- JSON array of strings (see note below)
  status          TEXT,
  cover_ref       TEXT,                -- R2/B2 key via existing cover pipeline
  cover_fallback  TEXT,                -- tier-2 cover URL
  synopsis        TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (source, source_series_id)
)

novel_chapters (
  id                TEXT PRIMARY KEY,
  series_id         TEXT NOT NULL,     -- FK novel_series.id
  source_chapter_id TEXT NOT NULL,     -- upstream chapter id; required to re-scrape
  number            REAL NOT NULL,
  title             TEXT,
  content           TEXT NOT NULL,     -- sanitized HTML, <25KB typical
  content_hash      TEXT NOT NULL,     -- sha256 hex of normalized text
  source_url        TEXT,
  scraped_at        INTEGER NOT NULL,
  UNIQUE (series_id, source_chapter_id)
)
```

`content_hash` is what makes the 24h update check cheap: fetch, normalize, hash, write only on change. This also protects the KV write quota. Normalization is fixed and shared: strip tags, decode entities, collapse all whitespace runs to a single space, trim. Hash with Web Crypto `SHA-256`, hex-encoded — available in Workers with no dependency.

Note on `genre`: the manga side has **no** genre column in D1 (verified across `packages/db/migrations/0001`–`0020`); its `Series.genres` is adapter-derived at request time. Novel persists genres deliberately, because novel browsing filters by genre. This is an intentional divergence, not an inconsistency.

### 6.6 Sharding

Both tables shard by **series**, never by chapter:

```
shard = murmur3_32(series_id) % num_accounts
```

`murmur3_32` comes from `packages/shared/src/r2-routing.ts`; live routing is `% N` in `apps/api-cf/src/lib/peers.ts`. The existing owner-forwarding path in `peers.ts` applies unchanged.

Consequence, stated explicitly because it constrains the route shape: reading a chapter requires its `series_id` first. The reader route is `/novel/{seriesSlug}/{chapterRef}`, so the series is always known from the URL before any D1 read. Never introduce a route that resolves a chapter without a series.

### 6.7 Web routes

```
src/pages/novel/index.astro                  catalog
src/pages/novel/[slug].astro                 series detail
src/pages/novel/[slug]/[chapter].astro       chapter reader
```

**Routing footgun.** `src/pages/[type]/[slug]/index.astro` is a catch-all, so `/novel/x` would otherwise be captured as `type='novel'` and coerced by `safeType()` to `'manga'`. Astro resolves the static segment first, so the explicit `novel/` pages win — but only if the manga side also guards.

Both manga pages already carry a `notFound` flag and render `NotFoundPage`; the guard reuses that idiom rather than redirecting, so status stays a real 404:

```ts
// apps/web/src/pages/[type]/[slug]/index.astro  (and [chapterId].astro)
if (!isValidType(type!)) notFound = true;   // falls through to the existing NotFoundPage render
```

`'novel'` is **not** added to `VALID_TYPES`. Adding it would pull novels into the manga shell.

`apps/web/src/lib/api.ts` gains `getNovelCatalog`, `getNovelSeries`, `getNovelChapters`, `getNovelChapter`, and their paths are appended to `ORIGIN_PATH_ALLOWLIST` so they participate in four-Worker round-robin.

The chapter reader is a new component. It is not a variant of `Reader.tsx`, which is built for paged images and reserves aspect ratio to prevent CLS — none of which applies to prose. Text reader v1: font-size control, line-height control, chapter nav, progress persisted per user, dark/light/orange theme from the existing token system.

### 6.8 Cloudflare constraints driving the design

| Constraint | Design consequence |
|---|---|
| `apiWithFailover` timeout 8s | No inline scraping. Refresh runs in `executionCtx.waitUntil` after the response. |
| `setTimeout` sleep costs CPU (see `ponytail` in `lib/retry.ts`) | Backoff stays under 3 attempts; no scheduler binding assumed. |
| KV 1000 writes/day (free) | Write only on `content_hash` change. |
| No DOMParser | Regex parsing only. |
| Browser Rendering `MY_BROWSER` (all 4 wrangler configs) | Cold-path fallback only, as already done in `webtoon/client.ts:69`. Never in the chapter read path. |
| D1 row/statement limits | Chapter `TEXT` is safe at 5-25KB; R2/B2 is unnecessary for prose. |
| Subrequest budget | One upstream fetch per chapter. |

Covers reuse the existing R2 + B2 + signed `/img` pipeline. No new image path. novelid's `?resize=139,184` query is stripped by `sanitizeCoverUrl`, which already exists in `packages/shared/src/http.ts`.

## 7. Audit scope (manga side)

Checklist, applied to all six adapters (komiku, bacakomik, thrive, manhwaindo, shinigami, webtoon):

1. Does it satisfy `SourceAdapter` in `packages/sources/index.ts`?
2. Are parsing rules and base URLs in the per-source `client.ts` / `selectors.ts` rather than inline?
3. Is the log shape uniform?
4. Is there any literal secret or URL that belongs in config?

Plus a shared-layer pass over `apps/api-cf/src/lib/` — the trunk, not just the leaves.

**Low risk, fix in place:** selectors and base URLs moved into config; log shape unified; per-adapter timeouts made explicit.

**High risk, backlog only — do not touch:** D1 core schema, the consistent-hash ring (`packages/shared/src/r2-routing.ts` is explicitly not wired; live routing stays `% N`), the ECDSA P-256 session keyring (`apps/api-cf/src/lib/auth.ts`), the AES-GCM encryption of Cloudflare tokens at rest (`packages/lb/crypto.ts`), and sharding logic itself.

Each low-risk fix is its own commit so any regression reverts in isolation.

## 8. Testing

- **novelid adapter:** fixture-based unit tests over saved HTML for catalog, series, chapter list, and chapter content. Assert chapter text is non-empty and free of the `<script>`/CSS preamble observed in the real page.
- **Metadata adapters:** same, plus a test that a missing tier-1 cover triggers a tier-2 fill and persists.
- **Hash routing:** assert `murmur3_32(series_id) % 4` distributes across shards and that a chapter read resolves the shard from the series slug.
- **Route guard:** assert `/novel/{slug}` is served by the novel page, and that `/bogus/{slug}` 404s rather than being coerced to manga.
- **Manga regression:** full existing suite after the audit refactor; behaviour must be unchanged.
- **Secrets:** automated scan in CI, not a manual review step. A human or agent review is exactly what let the Google OAuth secret reach `README.md` previously. A pre-commit or CI gate is required.
- **Manual:** spot-check 3 series end-to-end (catalog → series → chapter) before adding `/novel` to site navigation.

## 9. Rollout

1. Migrations applied to all four D1 databases via `scripts/migrate-all-4.sh`.
2. Deploy API workers, verify health and origin count.
3. Deploy web with `/novel` routes live but **not linked** from navigation.
4. Manual spot-check 3 series.
5. Add `/novel` to navigation.

## 10. Deferred

- AI translation for foreign-language sources. Needs its own design; introduces a multi-provider AI dimension unrelated to source adapters.
- A second chapter source. Market sweep found none available. Re-probe before assuming; the design does not depend on one existing.
- Novel bookmarks, history, and reading progress beyond local persistence. Manga equivalents exist and should be mirrored, but not in this round.
