# Admin Monitoring & User Dashboard Implementation Plan

> For agentic workers: Use executing-plans skill. Steps use `- [ ]` syntax.

**Goal:** Admin dashboard for session-role-gated monitoring of LB providers, scrape jobs, DB usage, and registered users.

**Architecture:** Session role (read) + step-up password (write, existing). New `/api/admin/*` GET-only endpoints behind `requireAdminSession`. Next.js middleware = cookie presence check. Admin pages = client components polling via SWR 12s.

**Tech Stack:** Hono (Worker), D1 (SQLite), Next.js 14 (Pages), Cloudflare KV (sessions), OKLCH dark tokens.

## Tasks

### Task 1: Migration 0006 + db helpers
- Create `packages/db/migrations/0006_admin_monitoring.sql` (users.last_login_at, provider_accounts, scrape_jobs_log, db_usage_snapshot + index)
- Add 11 methods to `packages/db/index.ts` Db interface + impl
- Test: `npx tsc --noEmit -p packages/db`

### Task 2: requireAdminSession + monitoring router + mount
- Add `requireAdminSession` to `apps/api-cf/src/lib/auth.ts`
- Create `apps/api-cf/src/routes/admin/monitoring.ts` (8 GET endpoints)
- Mount in `apps/api-cf/src/index.ts` + `rateLimitAdmin`
- Test: `npx tsc --noEmit -p apps/api-cf`

### Task 3: last_login_at update in auth.ts
- `POST /login` + `GET /google/callback` + `POST /register` → update users.last_login_at
- Test: `npx tsc --noEmit -p apps/api-cf`

### Task 4: Scraper TODO markers
- `apps/api-cf/src/routes/admin/scrape.ts` → add TODO comments at job start/success/fail
- Test: `npx tsc --noEmit -p apps/api-cf`

### Task 5: Design tokens globals.css
- Append admin tokens to `apps/web/app/globals.css`
- Test: `npx tsc --noEmit -p apps/web`

### Task 6: middleware.ts + roleLabel
- Create `apps/web/middleware.ts` (cookie presence → redirect /admin/* to /)
- Add `apiGet` + `roleLabel` to `apps/web/lib/api.ts`
- Test: `npx tsc --noEmit -p apps/web`

### Task 7: Move LB page → /admin/settings
- Move `apps/web/app/admin/load-balancing/page.tsx` content → `apps/web/app/admin/settings/page.tsx`
- Old route → redirect
- Update navbar link in `apps/web/app/layout.tsx`
- Test: `npx tsc --noEmit -p apps/web`

### Task 8: /admin overview page
- Create `apps/web/app/admin/page.tsx` (client, SWR 12s, stat cards + sparkline + provider dots)
- Test: `npx tsc --noEmit -p apps/web`

### Task 9: /admin/monitoring page
- Create `apps/web/app/admin/monitoring/page.tsx` (provider grid + DB usage + scrape log)
- Test: `npx tsc --noEmit -p apps/web`

### Task 10: /admin/users + /admin/users/[id]
- Create `apps/web/app/admin/users/page.tsx` (search + paginate)
- Create `apps/web/app/admin/users/[id]/page.tsx` (detail + bookmarks, disabled buttons)
- Test: `npx tsc --noEmit -p apps/web`

### Task 11: Deploy + test
- `wrangler d1 execute manga-db --remote --file=0006_admin_monitoring.sql` (akun1 + akun2)
- `wrangler deploy` (api-cf, akun1)
- `next build && next-on-pages && wrangler pages deploy` (web)
- QA: curl endpoints, test non-admin redirect
- Test: curl `/api/admin/overview` (403 no session, 200 with admin session)
