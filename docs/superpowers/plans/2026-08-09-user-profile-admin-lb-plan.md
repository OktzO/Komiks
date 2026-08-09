# User Profile + Admin-Only Load Balancing Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/profile` user page (profile, account, preferences, privacy, sessions, admin-link sections), restructure the navbar hamburger to expose an admin-only "Load Balancing" entry, rename the LB admin route to `/admin/load-balancing`, add user-profile DB columns via migration 0005, add 7 new `/api/user/*` Worker routes, and seed default LB data (2 accounts + 2 origins). Finish by typechecking, deploying to Cloudflare Workers/Pages for both accounts, and verifying live.

**Architecture:** Database is D1 (SQLite) — one migration adds user columns; Worker is a single Hono bundle (`apps/api-cf`); frontend is Next.js 14 app router (`apps/web`). LB logic lives in `packages/lb` + `packages/db` helpers; profile is a new `/api/user/*` route group mounted in `index.ts`. Frontend talks to Worker only. R2 assets are Komiku-only (no changes).

**Tech Stack:** Cloudflare Workers (Hono), D1, KV, Next.js 14 (Pages), TypeScript, Zod, Tailwind/OKLCH dark theme, Wrangler.

## Global Constraints

- Login = Google OAuth only
- Avatar = Google `picture` (stored in `users.avatar_url` by OAuth callback), fallback to initials
- Admin = `role === 'admin'` in session (email allowlist `ADMIN_EMAILS`, default `oktzoffc@gmail.com`)
- LB admin auth = session role=admin OR legacy `x-admin-stepup` header
- Akun 1 (main): R2 + KV + D1. Akun 2 (origin): D1 + KV only (no R2)
- Two CF accounts pre-seeded in LB: main + origin (tzok5555)
- Session TTL = 7 hari. Secondary KV key `session-user:{userId}:{token}` untuk list/revoke
- `preferences` kolom = JSON TEXT, validated by Zod (never partial malformed)
- Frontend routes: `/admin/load-balancing` (admin only), `/profile` (auth required), redirect `/admin/settings/*` -> `/admin/load-balancing`

---

See full plan in spec: `docs/superpowers/specs/2026-08-09-user-profile-admin-lb-design.md`.
This plan is the executable checklist. — ## Task 1: D1 Migration 0005_user_profile.sql

**Files:**
- Create: `packages/db/migrations/0005_user_profile.sql`

**Interfaces:**
- Consumes: `users`, `lb_settings`, `lb_accounts`, `lb_origins` tables
- Produces: ALTER users + seed data (idempotent)

- [ ] Step 1: Create migration file (ALTER + INSERT OR IGNORE seed)
- [ ] Step 2: Apply locally for sanity check
- [ ] Step 3: Commit

---

## Task 2: D1 helper functions

**Files:**
- Modify: `packages/db/index.ts` (+4 interface methods + impl)
- Test: `packages/db/test/user-profile.test.mjs` (NEW)

**Interfaces:**
- Consumes: D1 client, `users`/`bookmarks`/`reading_history` tables
- Produces: `updateUserProfile`, `deleteUserAccount`, `clearUserHistory`, `clearUserBookmarks`

- [ ] Step 1: Add interface declarations to `Db` type
- [ ] Step 2: Implement the 4 methods (pattern match existing `deleteAccount`)
- [ ] Step 3: Write unit test (reference `matching.test.mjs` style)
- [ ] Step 4: Run test
- [ ] Step 5: Commit

---

## Task 3: Shared types

**Files:**
- Modify: `packages/shared/types.ts`

**Interfaces:**
- Produces: `UserPreferences`, `MeResponse`, `SessionMeta`

- [ ] Step 1: Add the 3 type exports
- [ ] Step 2: Commit

---

## Task 4: Worker auth.ts — session-user KV index

**Files:**
- Modify: `apps/api-cf/src/lib/auth.ts`

**Interfaces:**
- Consumes: `createSession`, `getSessionUser`, KV env
- Produces: Secondary key `session-user:{userId}:{token}` on create + touch on validate

- [ ] Step 1: In `createSession` — add PUT for `session-user:{userId}:{token}`
- [ ] Step 2: In `getSessionUser` — fire-and-forget update `lastSeen` di secondary key
- [ ] Step 3: Add helper `listSessionsForUser(env, userId)` + `revokeSessionForUser(env, userId, token)`
- [ ] Step 4: Typecheck: `npx tsc --noEmit -p apps/api-cf`
- [ ] Step 5: Commit

---

## Task 5: OAuth callback — save avatar_url

**Files:**
- Modify: `apps/api-cf/src/routes/auth.ts`

**Interfaces:**
- Consumes: `gUser.picture`
- Produces: `INSERT/UPDATE users SET avatar_url = gUser.picture`

- [ ] Step 1: Edit INSERT user baru — add `avatar_url = gUser.picture ?? NULL`
- [ ] Step 2: Edit UPDATE existing — set `avatar_url` kalau NULL
- [ ] Step 3: Commit

---

## Task 6: Worker /api/user/* routes

**Files:**
- Create: `apps/api-cf/src/routes/user.ts`
- Modify: `apps/api-cf/src/index.ts` (mount router)

**Interfaces:**
- Consumes: `db.updateUserProfile`, `db.deleteUserAccount`, `clearUserHistory`, `clearUserBookmarks`, `getSessionUser`, session KV helpers (Task 4), Zod schemas (Task 3)
- Produces: GET/PATCH/DELETE /me, GET /sessions, DELETE /sessions/:token, POST /sessions/revoke-all, DELETE /history, DELETE /bookmarks

- [ ] Step 1: Write router with `requireSession` middleware
- [ ] Step 2: Implement /me GET (extend existing return ke MeResponse)
- [ ] Step 3: Implement /me PATCH (Zod validate + db update)
- [ ] Step 4: Implement /me DELETE (confirm guard + db.deleteUserAccount + clear session)
- [ ] Step 5: Implement /sessions GET/POST revoke-all + DELETE/:token
- [ ] Step 6: Implement /history DELETE + /bookmarks DELETE
- [ ] Step 7: Mount in `index.ts`
- [ ] Step 8: Smoke: `node scripts/smoke-user.mjs`
- [ ] Step 9: Commit

---

## Task 7: Frontend types + API client

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: `packages/shared/types` (MeResponse, SessionMeta, UserPreferences)
- Produces: `AuthUser` extend + 7 new client helpers (patchMe, deleteMe, listSessions, revokeSession, revokeAllSessions, clearHistory, clearBookmarks)

- [ ] Step 1: Extend `AuthUser` interface
- [ ] Step 2: Add 7 helpers (pattern match `fetchMe`/`logout`)
- [ ] Step 3: Commit

---

## Task 8: Frontend /profile page + profile components

**Files:**
- Create: `apps/web/app/profile/page.tsx`
- Create: `apps/web/components/profile/{Sidebar,MobileTabs,ProfileSection,AccountSection,PreferencesSection,PrivacySection,SessionsSection,AdminSection}.tsx`
- Create: `apps/web/components/Avatar.tsx`
- Modify: `apps/web/app/globals.css` (scroll-margin-top)

Uses skills: **frontend-design, design-taste-frontend, impeccable** (apply visual review — anti-generic patterns, tight typography, glass surfaces matching existing nav-island aesthetic).

- [ ] Step 1: Avatar.tsx (shared, picture/initial)
- [ ] Step 2: Section components (6 + mobile/desktop nav)
- [ ] Step 3: profile/page.tsx layout (sidebar anchor — desktop / top tabs — mobile)
- [ ] Step 4: Wire API calls (patchMe/deleteMe/listSessions/etc)
- [ ] Step 5: Apply visual polish (OKLCH tokens, glass cards, sticky save bar mobile)
- [ ] Step 6: Commit

---

## Task 9: Hamburger restructure + LB route rename

**Files:**
- Modify: `apps/web/components/Navbar.tsx` (admin-only "Load Balancing" entry + user-only "Profile" entry)
- Move: `apps/web/app/admin/settings/load-balancing/page.tsx` -> `apps/web/app/admin/load-balancing/page.tsx` (rename heading)
- Create: `apps/web/app/admin/settings/page.tsx` (redirect)

- [ ] Step 1: Navbar restructure (LINKS + conditional admin/user entries)
- [ ] Step 2: Move + rename LB page
- [ ] Step 3: Create redirect page
- [ ] Step 4: Commit

---

## Task 10: Typecheck + lint

- [ ] Step 1: `npx tsc --noEmit -p apps/api-cf`
- [ ] Step 2: `npx tsc --noEmit -p apps/web`
- [ ] Step 3: `npx tsc --noEmit -p packages/db packages/shared packages/lb`
- [ ] Step 4: Fix any errors (record before/after)

---

## Task 11: Deploy migration (akun 1 + akun 2)

- [ ] Step 1: `CLOUDFLARE_API_TOKEN=<cfut_akun1> npx wrangler d1 execute manga-db --remote --file=packages/db/migrations/0005_user_profile.sql`
- [ ] Step 2: Switch token akun 2 -> apply migration ke akun-2 D1
- [ ] Step 3: Verify: `GET /api/admin/lb/accounts` show 2 akun + `GET /api/admin/lb/origins` 2 origin

---

## Task 12: Deploy Worker (akun 1 + akun 2)

- [ ] Step 1: `cd apps/api-cf && npx wrangler deploy --config apps/api-cf/wrangler.toml`
- [ ] Step 2: Deploy bundle baru ke akun 2 (manual PUT via CF API — see skill section 7)
- [ ] Step 3: Verify routes `/api/user/me`, `/api/user/sessions` terjangkau

---

## Task 13: Deploy Frontend

- [ ] Step 1: `cd apps/web && npx next build`
- [ ] Step 2: Deploy ke Pages: `npx next-on-pages && npx wrangler pages deploy .vercel/output/static --project-name manga-web --branch main`
- [ ] Step 3: Verify `/profile` load (login required)

---

## Task 14: Live test + audit

- [ ] Login `oktzoffc@gmail.com` → hamburger tampil "Load Balancing"
- [ ] Login user biasa → hamburger tidak tampil "Load Balancing"
- [ ] `/profile` — isi display_name + bio → save → reload persist
- [ ] Preferences theme/language/reader_mode → save → persist
- [ ] /sessions — buka tab lain → revoke di satu tab → lain forced logout
- [ ] `/admin/load-balancing` → tampilan 2 akun + 2 origin (seed)
- [ ] `/admin/settings/load-balancing` → redirect ke `/admin/load-balancing`
- [ ] Audit loop: cek 1 kejangkelan — report or fix

---

## Task 15: Smoke cleanup

- [ ] Run: `node scripts/smoke-user.mjs` (verify /me PATCH flow)
- [ ] Run: `node scripts/smoke-db.mjs` (verify D1 schema)
- [ ] Commit smoke results (jika ada fix)
