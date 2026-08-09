# Admin System, Load Balancer Monitoring & User Dashboard

Date: 2026-08-09
Status: approved (brainstormed)
Source spec: user prompt (Sections 0–7)

## Context

Manga aggregator (oktzz.xyz) — Next.js + Turborepo monorepo, Cloudflare Workers/D1/R2/KV.
Existing: Google OAuth + `isAdminEmail` + `users.role` column + `ADMIN_EMAILS` env +
`/admin/load-balancing` page (step-up password) + `requireAdminKey`/`requireAdminStepUp`
middlewares + `AdminSection` profile component + `status/page.tsx` (BetterStack-style
passive health, the "live numbers" signature).

This spec extends the admin surface with: (1) session-role gate for read access,
(2) monitoring tables + read-only API, (3) admin dashboard pages, (4) user
management read views. Tone matches the existing "Design that whispers" identity
from oktz.qzz.io.

## Decisions (from brainstorm)

- **Auth model:** Session role for read, keep step-up password for writes. New
  `/api/admin/*` monitoring endpoints (GET-only) check `session.role === 'admin'`
  via `requireAdminSession`. Existing `/api/admin/lb/*` mutations keep
  `x-admin-stepup` header. Two auth rails, least-breaking.
- **Scope:** Build all 6 spec sections end-to-end in one cycle.
- **Scraper hooks:** Provide db helpers (`upsertProviderAccount`,
  `logScrapeJob`, `insertDbUsageSnapshot`) + TODO markers in
  `routes/admin/scrape.ts`. No scraper logic modification now.
- **Middleware:** Next.js `middleware.ts` = cookie `session` presence check
  only (edge can't read Worker KV). Real role authz stays at API layer
  (`requireAdminSession`) + page-level `fetchMe()` guard. No JWT migration.
- **LB page location:** Move from `/admin/load-balancing` → `/admin/settings`
  (existing `admin/settings/page.tsx` is a legacy empty redirect). Old route
  becomes redirect or removed; navbar link updated.
- **Role labels:** DB stores `role='user'|'admin'` (CHECK constraint unchanged).
  Display mapping: `user → Member`, `admin → Admin`. Helper `roleLabel(role)`.
- **LB visibility:** Admin-only. Non-admin sees no LB menu entry in hamburger
  (existing pattern in `layout.tsx` preserved).

## 1. Architecture

```
Admin auth (final model):
  Google OAuth → callback (existing) → isAdminEmail check (existing) → users.role
  → KV session (existing, cookie-based, 7d TTL)

  Read paths (/admin pages, /api/admin/* GET monitoring):
    middleware.ts (NEW) → cookie presence check only (edge can't read KV)
    page-level → fetchMe() → role===admin guard (loading state until resolved)
    API-level (NEW) → getSessionUser() → role===admin enforce (server-side truth)

  Write paths (/api/admin/lb/* mutations, /api/scrape):
    Existing step-up password (x-admin-stepup) → unchanged

  New /api/admin/* monitoring endpoints:
    requireAdminSession middleware (NEW) → getSessionUser + role check
    rate-limited via rateLimitAdmin (existing 600/min)

Data flow:
  Scraper → TODO: upsertProviderAccount + logScrapeJob (helpers provided)
  Client poll /api/admin/* (SWR refetchInterval 12s) → D1 reads
  middleware gates /admin/** → API enforces → D1 returns
```

### File touch map

| Change | File |
|---|---|
| `users.last_login_at` column | `packages/db/migrations/0006_admin_monitoring.sql` (NEW) |
| `provider_accounts` table | same migration |
| `scrape_jobs_log` table | same migration |
| `db_usage_snapshot` table | same migration |
| db helpers (8 new) | `packages/db/index.ts` |
| `requireAdminSession` middleware | `apps/api-cf/src/lib/auth.ts` |
| `roleLabel(role)` helper | `apps/web/lib/api.ts` |
| Admin monitoring router | `apps/api-cf/src/routes/admin/monitoring.ts` (NEW) |
| Router mount | `apps/api-cf/src/index.ts` |
| Scraper TODO markers | `apps/api-cf/src/routes/admin/scrape.ts` |
| Update `last_login_at` on login | `apps/api-cf/src/routes/auth.ts` (login + oauth callback) |
| `middleware.ts` (cookie check) | `apps/web/middleware.ts` (NEW) |
| Admin design tokens | `apps/web/app/globals.css` (append) |
| `/admin` overview page | `apps/web/app/admin/page.tsx` (NEW) |
| `/admin/monitoring` page | `apps/web/app/admin/monitoring/page.tsx` (NEW) |
| `/admin/users` list page | `apps/web/app/admin/users/page.tsx` (NEW) |
| `/admin/users/[id]` detail page | `apps/web/app/admin/users/[id]/page.tsx` (NEW) |
| `/admin/settings` (LB moved here) | `apps/web/app/admin/settings/page.tsx` (move from load-balancing) |
| Old LB route redirect | `apps/web/app/admin/load-balancing/page.tsx` → redirect to `/admin/settings` |
| Navbar admin link update | `apps/web/app/layout.tsx` |

## 2. Data Model

Migration `packages/db/migrations/0006_admin_monitoring.sql`:

```sql
-- users: tambah last_login_at (created_at udah ada di schema.sql line 62)
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- provider_accounts: metrik runtime, bukan kredensial.
--   Distinct dari lb_accounts (encrypted CF token + provision state).
--   Hubung via `provider` label, bukan FK — scraper bisa log tanpa resolve lb_accounts.id.
CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,          -- 'r2-account-1' | 'scraper-proxy-a' | match lb_accounts.label
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',  -- 'healthy'|'degraded'|'down'|'unknown'
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error TEXT,
  requests_24h INTEGER NOT NULL DEFAULT 0,
  failures_24h INTEGER NOT NULL DEFAULT 0,
  quota_used_bytes INTEGER,
  quota_limit_bytes INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- scrape_jobs_log: append-only histori buat chart, bukan state machine.
--   Distinct dari scrape_jobs (existing job-tracker runtime).
CREATE TABLE scrape_jobs_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- 'komiku'|'bacakomik'|'thrive'|'manhwaindo'
  provider_account_id TEXT REFERENCES provider_accounts(id),
  status TEXT NOT NULL,            -- 'success'|'failed'|'partial'
  items_scraped INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- db_usage_snapshot: D1 rows + R2 objects/bytes, append-only, 1 row per snapshot per db
CREATE TABLE db_usage_snapshot (
  id TEXT PRIMARY KEY,
  db_name TEXT NOT NULL,           -- 'd1-main'|'r2-shard-1'|'r2-shard-2'
  rows_or_objects INTEGER,
  size_bytes INTEGER,
  captured_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_db_usage_time ON db_usage_snapshot(db_name, captured_at);
```

### db helpers (`packages/db/index.ts`, 8 new methods on `Db`)

- `upsertProviderAccount({provider,label,status,lastSuccessAt,lastFailureAt,lastError,requests24h,failures24h,quotaUsedBytes,quotaLimitBytes})` — idempotent by `provider`+`label` (UNIQUE assumed; if not, add `CREATE UNIQUE INDEX`). Upsert by provider+label.
- `listProviderAccounts()` → `ProviderAccount[]`
- `getProviderAccount(id)` → `ProviderAccount | null`
- `logScrapeJob({source,providerAccountId,status,itemsScraped,durationMs,errorMessage,startedAt,finishedAt})` — insert `scrape_jobs_log` row + bump `provider_accounts.requests_24h`/`failures_24h` + `last_success_at`/`last_failure_at`/`last_error`. Single transaction.
- `listScrapeJobsLog({source?,status?,from?,to?,page,limit})` → `{data:ScrapeJobLog[], total, page}`
- `insertDbUsageSnapshot({dbName,rowsOrObjects,sizeBytes})` — insert row
- `getDbUsageTrend(days=7)` → `{db_name, points:{ts, size_bytes, rows_or_objects}[]}[]`
- `getAdminOverview()` → `{usersTotal, bookmarksTotal, scrape24h:{success,failed}, providers:{healthy,degraded,down}}` — single aggregate query
- `listUsersAdmin({q?,page,limit})` → `{data:UserSummary[], total, page}` (UserSummary: id, email, name, role, created_at, last_login_at, bookmark_count)
- `getUserDetail(id)` → `UserDetail | null` (profile + bookmark count + last login)
- `listUserBookmarksAdmin(userId, {page,limit})` → `{data:BookmarkRow[], total, page}` (BookmarkRow: series_slug, title, cover_image, added_at; join with series for title/cover)

## 3. Backend / API Endpoints

### `requireAdminSession` middleware (`lib/auth.ts`)

```ts
export const requireAdminSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = await getSessionUser(c);
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'admin required' }, 403);
  }
  c.set('user', user);
  await next();
};
```

### Router `routes/admin/monitoring.ts` (mount `/api/admin`)

All GET-only. `requireAdminSession` applied to router. `rateLimitAdmin` (600/min) mount in `index.ts`.

| Endpoint | Query | Return |
|---|---|---|
| `/api/admin/overview` | — | `{usersTotal, bookmarksTotal, scrape24h:{success,failed}, providers:{healthy,degraded,down}}` |
| `/api/admin/providers` | — | `ProviderAccount[]` (no secrets — metrics only) |
| `/api/admin/providers/:id/health` | `?hours=24` | `{labels:number[], requests:number[], failures:number[]}` from `scrape_jobs_log` grouped by hour |
| `/api/admin/scrape-jobs` | `?source=&status=&from=&to=&page=1&limit=20` | `{data:ScrapeJobLog[], total, page}` |
| `/api/admin/db-usage` | `?days=7` | `{current:{db_name,rows_or_objects,size_bytes}[], trend:{db_name,points:{ts,size}[]}}` |
| `/api/admin/users` | `?q=&page=1&limit=20` | `{data:UserSummary[], total, page}` |
| `/api/admin/users/:id` | — | `UserDetail` |
| `/api/admin/users/:id/bookmarks` | `?page=1&limit=20` | `{data:BookmarkRow[], total, page}` |

**Response sanitization:** `provider_accounts.last_error` truncate to 200 chars in
API response (cap before return, not in query — prevent credential leak via error
message). No token/secret columns exist in this table by design.

**Scraper hooks (TODO markers):** In `routes/admin/scrape.ts` at job start/success/fail
points, add `// TODO(admin-monitoring): call logScrapeJob + upsertProviderAccount`.
Helpers exist in `packages/db/index.ts` but not wired — scraper integration is
separate task.

### `last_login_at` update

In `routes/auth.ts`:
- `POST /login` success → `UPDATE users SET last_login_at = ? WHERE id = ?`
- `GET /google/callback` success → same update after session create
- `POST /register` → `last_login_at = unixepoch()` at insert (set in createUser call or separate update)

### Frontend client (`lib/api.ts`)

- `apiGet<T>(path): Promise<T>` — fetch with `credentials: 'include'` (cookie session). No `x-admin-stepup` header (read-only).
- `roleLabel(role: 'user'|'admin'): string` → `'user' → 'Member'`, `'admin' → 'Admin'`.
- SWR usage in client components: `useSWR('/api/admin/overview', fetcher, { refreshInterval: 12000 })`.

### `index.ts` mount

```ts
import { router as monitoringAdminRouter } from './routes/admin/monitoring';
// after existing admin mounts:
app.use('/api/admin', rateLimitAdmin);   // applies to all /api/admin/*
app.route('/api/admin', monitoringAdminRouter);
// existing: app.route('/api/admin/lb', lbAdminRouter);  // step-up inside router
// existing: app.route('/api/admin/merge', mergeAdminRouter);
```

Note: `rateLimitAdmin` already mounted for `/api/scrape`. Adding `/api/admin` mount
covers monitoring + lb + merge uniformly (lb/merge still need their own step-up
inside router — rate limit is orthogonal).

## 4. Page Structure

```
/admin              → Overview (stat cards + sparkline 7d + provider dots row)
/admin/monitoring   → LB health detail (provider grid + DB usage + scrape log)
/admin/users        → User list (search + paginate)
/admin/users/[id]   → User detail + bookmarks
/admin/settings     → LB settings (moved from /admin/load-balancing, step-up password unchanged)
```

### `/admin` — Overview (client component, SWR refetch 12s)

- Header: "Admin Overview" + subtle live pulse dot (pulse on refresh)
- Stat grid 4 cards (big mono number, small label below — "DNS queries · 24h" style):
  - Total user terdaftar
  - Total bookmark tersimpan
  - Scrape 24h: `{success}/{failed}` (two numbers inline)
  - Provider: `healthy / degraded / down` (3 numbers inline, colored dot per number)
- Sparkline 7d scrape run (inline SVG, 1 accent color, no axis labels — quiet)
- Quick links: Monitoring → Users → Settings (pill nav, not sidebar)

### `/admin/monitoring` — signature page

- Provider grid: each row = 1 account
  - Status dot (pulsing healthy, static degraded/down) + label
  - `requests_24h` + `failure rate %` (mono, tabular-nums)
  - `last success` relative time (reuse `formatRelative` from status page)
  - `last_error` truncated 80 char, click → expand inline
  - Quota progress bar (2px thin, accent fill)
- DB usage panel: per db/bucket — `rows/objects` + `size` + trend arrow (↑/↓ vs previous snapshot)
- Scrape log: scrollable list (max-h 60vh, overflow-y), each row `source · status · duration · items · time`, click failed row → expand error
- Auto-refresh indicator: small dot pulse on fetch, not spinner

### `/admin/users`

- Search bar (by email) + pagination (limit 20)
- Table: email, display name, role (Member/Admin badge via `roleLabel`), created_at, bookmark count, last login
- Click row → `/admin/users/[id]`

### `/admin/users/[id]`

- Header: email + role badge + created_at + last login
- Bookmark list: manga title (link to series), last chapter read (from history join), date added
- Edit/ban/delete buttons: **disabled placeholder** with tooltip "Coming soon", no action handler

### `/admin/settings` (LB moved)

Content identical to current `/admin/load-balancing/page.tsx`. Only path changes.
Old route becomes `redirect('/admin/settings')` or removed; navbar link updated.

## 5. Design Token System

Append to `apps/web/app/globals.css`. Existing tokens (bg oklch 8%, card 12%,
accent white oklch 98%, border-subtle 8%, success/error oklch 65% chroma) unchanged.

```css
:root {
  /* NEW: admin precision tokens */
  --radius-admin: 6px;        /* tighter than --radius 12px — precise, not playful */
  --radius-admin-sm: 4px;     /* dots, progress bar, inline tags */

  /* NEW: metric font — system mono stack (zero font load) */
  --font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;

  /* NEW: admin surface — slightly elevated from card for monitoring panels */
  --bg-admin-panel: oklch(14% 0 0);   /* between card 12% and secondary 18% */
}

/* NEW utilities */
.font-mono { font-family: var(--font-mono); }
.tabular { font-variant-numeric: tabular-nums; }

/* Live indicator pulse — subtle, reuse existing animate-ping pattern. */
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.pulse-soft { animation: pulse-soft 1.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .pulse-soft { animation: none; }
}

/* Smooth number transition on refresh — opacity fade, no count-up animation */
.num-refresh { transition: opacity 0.18s ease; }
.num-refresh.refreshing { opacity: 0.5; }

/* Admin card — hairline border, tight radius, no shadow */
.admin-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-admin);
  background: var(--bg-admin-panel);
}

/* Status dot — 6px, colored, optional pulse. Replaces big badge. */
.status-dot {
  width: 6px; height: 6px; border-radius: 50%;
  display: inline-block;
}
.status-dot.healthy { background: var(--success); }
.status-dot.degraded { background: oklch(70% 0.12 75); }   /* amber, single new hue */
.status-dot.down { background: var(--error); }
.status-dot.unknown { background: var(--text-muted); }
.status-dot.live { animation: pulse-soft 1.8s ease-in-out infinite; }

/* Quota bar — 2px thin, accent fill */
.quota-bar {
  height: 2px; border-radius: 1px;
  background: var(--border-subtle);
  overflow: hidden;
}
.quota-bar > span {
  display: block; height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
```

### Token rationale

- **Color:** 1 accent (white oklch 98%) + existing success/error + 1 amber new
  for `degraded` (oklch 70% 0.12 75 — distinct hue, not accent derivative). Total
  palette 6 colors including bg/border. No gradients.
- **Type:** Geist sans body (existing), system mono stack for metrics/numbers
  (`.font-mono`). Zero font load. Small label BELOW number (hand-built, not
  label-above) — consistent with "DNS queries · 24h" on landing.
- **Layout:** `--radius-admin` 6px (tight) vs `--radius` 12px (public). Admin =
  precise. Hairline `border-subtle` as separator, no shadow. `--bg-admin-panel`
  oklch 14% — panel slightly raised from card without high contrast.
- **Signature:** Status dot + big mono number with label below. Tabular-nums
  wherever metrics appear. 7d sparkline = inline SVG single-line polyline (7
  points input), no axis/labels — quiet.
- **Motion:** `pulse-soft` 1.8s for live dot (on refresh), `num-refresh` opacity
  0.18s on data refresh. No count-up, no big animation. `prefers-reduced-motion`
  disables both.

### Cross-check vs 3 default looks

Not cream+serif (dark oklch 8% bg, Geist sans). Not near-black+acid-neon (accent
is white oklch 98%, not acid green/vermilion — brief-driven, matches existing
oktz.qzz.io identity). Not broadsheet (has 6px radius, not 0; hairline yes but
not newspaper columns). Choice holds.

## 6. Security & Guardrail

### Authorization (3 layer)

1. `middleware.ts` — cookie `session` present? no → redirect `/`. Presence-only
   (edge can't read KV).
2. Page guard — `fetchMe()` client-side, `role !== 'admin'` →
   `router.replace('/')`. Loading state until resolved, no unauthorized content
   flash.
3. API `requireAdminSession` — `getSessionUser()` → `role === 'admin'`? no →
   403 JSON `{error:'admin required'}`. Server-side truth. Never trust UI state.

### Self-assign role prevention

- `ADMIN_EMAILS` = Worker secret (server-side), not `NEXT_PUBLIC_*`. No endpoint
  writes `users.role` from client input. Only OAuth callback + `isAdminEmail()`
  sets role.
- No PATCH/PUT `/api/admin/users/:id/role` endpoint (read-only scope). Role
  mutation = out of scope now, TODO in code.

### Rate-limit

`rateLimitAdmin` (existing 600/min) mount at `/api/admin/*` router. Per-IP via KV
counter (existing factory). Sufficient for 1 admin user, still best-practice
anti-DoS D1.

### Credential leak prevention

- `provider_accounts` response: metrics columns only (status, requests_24h,
  failures_24h, last_success_at, last_failure_at, last_error, quota_used_bytes,
  quota_limit_bytes). No token/secret columns in table by design.
- `last_error` truncate 200 chars in API response (cap before return, not in
  query — prevent credential leak via error message).
- `lb_accounts` (existing) keeps exposing `token_last4` only, no raw token —
  already correct.

### Session

- KV TTL 7 days (existing), HttpOnly + SameSite=Lax + Secure cookie. Re-login to
  refresh.
- No permanent admin session. `getSessionUser()` reads KV every request — if
  session revoked (logout), access cut immediately.

### Manual QA checklist (comment at top of `routes/admin/monitoring.ts`)

1. Login Google non-`oktzoffc@gmail.com` → access `/admin` → redirect `/`
   (middleware) or 403 (API). Must NOT see empty data (that'd mean UI-only guard).
2. Login Google `oktzoffc@gmail.com` → access `/admin` → see overview data. API
   `/api/admin/overview` → 200 + numbers.
3. Delete `session` cookie manually → access `/admin` → redirect `/`. API → 401.
4. Login admin, fetch `/api/admin/overview` with `x-admin-stepup: <wrong>` → still
   200 (read uses session, not step-up). Confirm read doesn't need step-up.
5. Fetch `/api/admin/lb/settings` PUT with admin session but no `x-admin-stepup`
   → 401 (write needs step-up, still enforced).

## 7. Execution order

1. Migration `0006_admin_monitoring.sql` + db helpers (`packages/db/index.ts`).
2. `requireAdminSession` middleware (`lib/auth.ts`) + monitoring router
   (`routes/admin/monitoring.ts`) + mount in `index.ts`.
3. `last_login_at` update in `routes/auth.ts` (login + oauth callback).
4. Scraper TODO markers in `routes/admin/scrape.ts`.
5. Design tokens append to `globals.css`.
6. `middleware.ts` (cookie presence check) + `roleLabel` helper in `lib/api.ts`.
7. Move LB page: `/admin/load-balancing` → `/admin/settings` + navbar link
   update + old route redirect.
8. Build `/admin` overview page.
9. Build `/admin/monitoring` page.
10. Build `/admin/users` + `/admin/users/[id]` pages.
11. QA manual per Section 6 checklist.
12. Typecheck: `npx tsc --noEmit -p apps/api-cf` + `npx tsc --noEmit -p apps/web` +
    `npx tsc --noEmit -p packages/db`.

## Out of scope (TODO in code)

- Scraper actual integration (call `logScrapeJob`/`upsertProviderAccount` at run
  time). Helpers ready, call sites marked.
- Admin write actions on users (ban/delete/edit). Buttons are disabled
  placeholders.
- Role management UI (add/remove admin via `ADMIN_EMAILS`). YAGNI — single admin.
- DB usage snapshot capture cron (no cron in project). Manual insert or
  scraper-triggered snapshot only.
- SSE push for realtime (spec said reuse if exists; no SSE exists). Poll 12s.
