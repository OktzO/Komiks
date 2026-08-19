# Frontend Audit — Manga (oktzz.xyz)

Date: 2026-08-19
Commit: eee2432
Preview deploy: https://2ebc6194.manga-web-d32.pages.dev (branch `preview-audit`)
Production: untouched (`oktzz.xyz` still serving prior build)

Scope: `apps/web` only. API/worker/D1/R2/B2 unchanged.

## Method

4 parallel explore subagents: static dead-code, bundle/perf, memory-leak/
runtime, animation inventory. Findings reviewed; safe+high-value fixes
applied in one commit. Build + tsc + next-on-pages green; preview deploy
smoke (curl, all routes 200).

Note: in-sandbox browser verification was blocked — /dev/shm is 64 MB and
the bundled chromium/firefox runtime libs are missing (no sudo to install
deps). Visual side-by-side must be run on a machine with a working browser.
All other evidence (build, tsc, route 200s, SSR content) is captured below.

## Metrics (before / after)

| Route | FL JS before | FL JS after |
|---|---|---|
| / | 94.1 kB | 94.1 kB |
| /[source]/s/[slug] | 101 kB | 101 kB |
| /[source]/s/[slug]/[chapterId] | 102 kB | 102 kB |
| /admin | 97.1 kB | 97.1 kB |
| /bookmark | 98.1 kB | 98.1 kB |
| /profile | 100 kB | 100 kB |
| /search | 94.1 kB | 94.1 kB |
| /status/[source] | 99.1 kB | 99.1 kB |
Shared: 87.1 kB (unchanged). No new deps.

Bundle didn't shrink because there was nothing heavy to cut — dep tree is
already minimal (next/react/react-dom + @manga-platform/shared only; no
animation/state/fetch libs). The win is correctness, not size.

## Subagent 1 — Static Audit (dead code)

Removed:
- `components/profile/MobileTabs.tsx`: unused `Link` import; dead `sessions`
  nav tab (target `id="sessions"` section no longer renders — sessions UI
  removed in earlier auth rework)
- `components/profile/Sidebar.tsx`: same dead `sessions` tab
- `components/MangaCard.tsx`: unused `bookmarkable` / `bookmarkSlug` props +
  unused `BookmarkButton` import (homepage never used them; detail page owns
  the bookmark button)
- `lib/api.ts`: unused exports `listSessions`, `revokeSession`,
  `revokeAllSessions`, `getCurrentSessionToken`, `SessionMeta` type re-export
  (sessions UI gone)
- `app/register/page.tsx`: stale (auth is Google OAuth-only)

No unused CSS classes found (every custom selector in globals.css verified
against app+components; pseudo/runtime-set classes flagged check-manually).
No unused components. Deps are all referenced.

Stray files noted but not deleted (out of audit scope, gitignored):
`apps/web/apps/` (nested build artifact), `apps/web/check.spec.ts` (one-off
prod probe — tracked, kept as deploy smoke). `@playwright/test` + `playwright`
devDeps are referenced by `check.spec.ts`.

## Subagent 2 — Bundle & Performance

Baseline `next build`:
```
First Load JS shared by all: 87.1 kB
  chunks/526-...: 31.6 kB
  chunks/fd9d...: 53.7 kB
  other: 1.9 kB
Middleware: 27.2 kB
```
- No heavy deps to lazy/dynamic import. Reader/admin are already route-split.
- Images use raw `<img loading="lazy">` (B2/CDN incompatible with
  next/image optimizer — by design, per skill).
- Fonts: system stack, no web-font payload.
- No outdated Next.js/React APIs found.

## Subagent 3 — Memory Leaks & Runtime Health

Fixed:
1. `components/Reader.tsx` — retry timer overwrite (clear previous before
   new) + IntersectionObserver rewritten to a `Map<idx, el>` + reusable
   observer that re-observes ALL mounted pages on recreate. Old code tracked
   a single `observedEl`; when `onActivePage`'s identity changed, the observer
   was recreated but already-mounted `<img>` ref callbacks never re-ran → new
   observer observed nothing → silent active-page-tracking break. Also gated
   observation by `activeMode`; unobserve-all on `pages` change.
2. `components/WindowedList.tsx` — one observer per `total`; disconnect on
   unmount; sentinel re-observe as window grows (was correct in prior
   session; verified).
3. `components/Navbar.tsx`, `profile/MobileTabs.tsx`, `profile/Sidebar.tsx`
   — `cancelAnimationFrame` in scroll-listener cleanup (one-frame race).
4. `app/admin/settings/page.tsx` — provision-status polling capped at 100
   ticks (~5 min); stuck jobs no longer poll forever.
5. `app/admin/users/[id]/page.tsx` — sequence counter on `loadBookmarks`;
   late stale response can no longer overwrite newer page data during fast
   pagination.
6. `components/BookmarkButton.tsx` — `AbortSignal.timeout(8000)` on POST
   (was missing on POST only) + `aliveRef` guard before setState post-unmount.
7. `components/SourceSwitcher.tsx` — per-slug `localStorage` keys
  (`src-pref:<slug>`) replaced with single JSON `src-prefs` key + LRU cap 50.
   Old path grew one key per manga slug, never pruned.
8. `lib/api.ts` — module-level `authOriginCache` (5 min) + `originsCache`
   (60s) to avoid repeated health/origins fetches across mount/SSR (prior
   session; verified).

Verified clean (no action needed):
- every `addEventListener` paired with `removeEventListener`
- ReaderShell rAF/autoscroll cleanup correct
- all other effects have `alive`/`cancelled` guards

## Subagent 4 — Animation Inventory

No animation library in use. All animations are CSS keyframes/transitions in
`globals.css`. Inventory:

| Location | Type | Trigger | Perf | Rewrite? |
|---|---|---|---|---|
| slideUp / .anim-slide-up | css | mount | transform+opacity | no |
| #navbar padding-top + .nav-island width | css | scroll class | layout (contained via `contain: layout style`) | no |
| hamburger / #nav-menu | css | aria-expanded | transform/opacity | no |
| reader chrome (.reader-hidden) | css | scroll dir | transform + will-change | no |
| reader-settings / backdrop / sheet | css | .open | transform/opacity + will-change | no |
| shimmer-sweep / .skeleton | css | infinite | transform + will-change | no |
| route-progress | css | route change | scaleX forwards | no |
| riseIn / .anim-rise | css | mount, staggered | transform/opacity | no |
| marquee | css | infinite, pause hover | transform + will-change | no |
| pulse-soft / .status-dot.live | css | infinite while refreshing | opacity | no |

JS-driven: Navbar scroll toggle, ReaderShell scroll-dir state +
auto-scroll rAF, profile scrollspy — all state-flip only, no style writes
per frame. No manual `style.transform` mutators.

Reduced-motion gap closed: `.anim-slide-up`, `.route-progress`,
`.pulse-soft` now honor `prefers-reduced-motion: reduce` (were the only
animation blocks missing it). Zero visual change for default users.

No animation was rewritten — everything was already compositor-friendly.

## Deploy verification

- `next build`: exit 0
- `next-on-pages`: exit 0, `.vercel/output/static` generated
- `wrangler pages deploy ... --project-name manga-web --branch preview-audit`
  → https://2ebc6194.manga-web-d32.pages.dev (alias
  https://preview-audit.manga-web-d32.pages.dev)
- Route smoke (curl, all 200):
  - `/` 200, `/bookmark` 200, `/search?q=...` 200, `/login` 200,
    `/history` 200, `/status` 200
  - detail `/komiku/s/<slug>` 200 (live SSR, content present, JSON-LD valid)
- Production `oktzz.xyz` untouched (preview branch only)

## Files changed (commit eee2432)

31 files, +444/-211.

Code: `lib/api.ts`, `components/Reader.tsx`, `components/WindowedList.tsx`,
`components/Navbar.tsx`, `components/MangaCard.tsx`, `components/
BookmarkButton.tsx`, `components/SourceSwitcher.tsx`, `components/profile/
MobileTabs.tsx`, `components/profile/Sidebar.tsx`, `app/admin/settings/
page.tsx`, `app/admin/users/[id]/page.tsx`, `app/globals.css`,
`tailwind.config.ts`, deleted `app/register/page.tsx` + others from prior
session.

## What was NOT done

- Visual side-by-side via Playwright (sandbox browser unusable — /dev/shm
  64 MB + missing libglib, no sudo). Run on a local machine:
  ```
  cd apps/web && npx playwright test   # against oktzz.xyz or preview URL
  ```
- Lighthouse re-run (CLI not installed; baseline json present at repo root).
  No bundle change → expect identical scores.
- Promotion to production. Preview is live; `oktzz.xyz` still serves the
  prior build. Promote when ready:
  ```
  npx wrangler pages deploy apps/web/.vercel/output/static \
    --project-name manga-web --branch main
  ```
