# Admin Redesign v2 — Plan D: Halaman Log `/admin/log` (endpoint + UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bikin halaman admin `/admin/log` "Log" (nav dari Plan B): panel gabungan aktivitas — type `admin` (dari `lb_audit_log`, writer `addAuditLog` sudah menulis data nyata saat settings/account/origin update) dan type `scrape` (live dari `scrape_jobs`). Filter pill per tipe, timestamp mono, chip tipe, auto-refresh 30s, paginasi (tab audit), empty state jujur.

**Architecture:** Reader DB baru `listAuditLog` di `packages/db/index.ts` (tabel `lb_audit_log`, paginated + total). Endpoint baru `GET /api/admin/log?type=admin|scrape|all&page&limit` di `routes/admin/log.ts` (pola `dashboard.ts`/`saved.ts`: `requireAdminSession` + no-store, mount `app.route('/api/admin', logAdminRouter)`), normalisasi kedua sumber ke baris seragam `{ ts, type, actor?, message, meta }`, sort desc. UI `AdminLog.tsx` + `pages/admin/log.astro` (client:only, superset `AdminLayout`), pakai primitif `admin/charts.tsx` (Card/CardHead) + `.admin-inner` + helper CSS.

CATATAN skope (keputusan spec E/desain D): `scrape_jobs_log` (history) TIDAK dipakai di halaman ini — histori tetap khusus lewat `/api/admin/scrape-jobs` (monitoring, sudah ada). Tab `scrape` di Log = jobs LIVE dari `scrape_jobs` (writer nyata `createScrapeJob`). Tabel `provider_accounts`/`scrape_jobs_log` dibiarkan di skema tanpa UI.

**Tech Stack:** Astro, React islands, Hono, D1 (native SQL di wrapper `packages/db`), token oklch.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-redesign-design.md` (bagian D). Plan C ditandai selesai (Left: `59c49b2`; Plan C branch: `1d94675` `e72b1d9` `c0b9286`).

## Global Constraints

- Node 22.12+ wajib: prefix semua perintah `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH"`.
- api-cf `npm run build` (tsc) wajib PASS tiap task yang menyentuh `apps/api-cf` atau `packages/db`.
- db: `npm test --prefix packages/db` wajib PASS.
- web: `npm run lint --prefix apps/web` — SATU-SATUNYA error ditolerir `apps/web/src/components/reader/PreferencesSection.tsx:121 ts(2345)`. Baru = gagal. `npm test --prefix apps/web` (bun) wajib PASS.
- Warna HANYA token oklch yang ada. Bahasa UI admin: Indonesia. `text-base` jangan dipakai sebagai warna.
- API merge, scrape auto, tabel path TIDAK disentuh. `scrape_jobs_log`/`provider_accounts` tak dibaca di halaman ini.
- Bahasa field API: snake_case DB → endpoint seragam `{ ts, type, actor, message, meta }` (camelCase) ke UI.
- Skill `manga` wajib dibaca implementer sebelum edit.
- Git: commit per task, gaya `fix(area): deskripsi`, hanya file relevan, branch `main`.

## Konvensi jawaban endpoint (bentuk persis)

`GET /api/admin/log?type=all&page=1&limit=20` → `200`:

```json
{
  "data": {
    "type": "all",
    "rows": [
      { "ts": 1727000000, "type": "scrape", "actor": null, "message": "komiku · completed · boruto", "meta": { "id": "sc-1", "source": "komiku", "status": "completed", "series_slug": "boruto", "error": null } },
      { "ts": 1726999900, "type": "admin", "actor": "user#1", "message": "settings.update", "meta": { "account_id": null, "origin_id": null } }
    ],
    "total": 41,
    "page": 1,
    "limit": 20
  }
}
```

`type` = `admin` | `scrape` | `all` (default `all`). `page` clamp 1..1e6, `limit` clamp 1..100.

Cara gabung `type=all`: query audit `listAuditLog({page, limit})` + scrape `listScrapeJobs(limit)` (live, tanpa paginasi), campur kedua set, `rows.sort((a,b)=>b.ts-a.ts)` lalu `.slice(0, limit)`. `total` = `audit.total + scrape_rows.length`. `page`/limit jarang ideal di halaman tinggi, tidak menjanjikan konsistensi lintas-acuan — halaman READ-ONLY, ini sengaja.

Tab `scrape`: `rows` = normalisasi scrape saja, `total` = jumlah jobs live, `page` = 1, tanpa paginasi UI. Tab `admin`: `rows` = audit `listAuditLog({page,limit})`, `total` = `audit.total`, paginasi.

## Normalisasi (persis)

- `admin` (dari `listAuditLog` row: `{ account_id, origin_id, action, user_id, created_at }`):
  - `ts` = `created_at`; `message` = `action`; `actor` = `user_id != null ? \`user#${user_id}\` : null`; `meta` = `{ account_id, origin_id }`.
- `scrape` (dari `ScrapeJob` row: `{ id, source, source_url, query, status, series_slug, error, created_by, created_at, completed_at }` — cek nama presisi di `@manga-platform/shared/types` lalu sesuaikan):
  - `ts` = `created_at`; `message` = `[source] + (query ? \` · ${query}\` : '')`; `actor` = null; `meta` = `{ id, source, status, series_slug, error }`.

---
---

### Task 1: Reader DB `listAuditLog`

**Files:**
- Modify: `packages/db/index.ts` (interface `Db` + impl)

- [ ] **Step 1: Signature di interface `Db`**

Di `packages/db/index.ts`, dalam `export interface Db { ... }`, tambahkan tepat setelah `listScrapeJobsLog` signature (bentuknya `listScrapeJobsLog: (params: { source?: string; status?: string; from?: number; to?: number; page?: number; limit?: number }) => Promise<...>` — tambah di bawahnya; selaras wilayah "Plan C: saved readers" yang menyusul):

```ts
  // ── Log admin (Plan D) ──
  listAuditLog: (params: { page?: number; limit?: number }) => Promise<{
    total: number;
    rows: Array<{
      id: number;
      account_id: string | null;
      origin_id: string | null;
      action: string;
      user_id: number | null;
      created_at: number;
    }>;
  }>;
```

- [ ] **Step 2: Implementasi**

Di objek impl Db, tambahkan tepat setelah impl `listScrapeJobsLog` (impl sudah ada sekitar baris 768):

```ts
    listAuditLog: async ({ page = 1, limit = 100 }) => {
      const rows = (await prep(
        `SELECT id, account_id, origin_id, action, user_id, created_at
         FROM lb_audit_log
         ORDER BY created_at DESC, id DESC
         LIMIT ?1 OFFSET ?2`
      ).bind(limit, (page - 1) * limit).all<Row>()).results ?? [];
      const totalRow = await prep('SELECT COUNT(*) AS c FROM lb_audit_log').first<Row>();
      return {
        total: Number(totalRow?.c ?? 0),
        rows: (rows as Row[]).map((r) => ({
          id: Number(r.id),
          account_id: (r.account_id ?? null) as string | null,
          origin_id: (r.origin_id ?? null) as string | null,
          action: r.action as string,
          user_id: r.user_id == null ? null : Number(r.user_id),
          created_at: r.created_at as number,
        })),
      };
    },
```

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix packages/db
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
```

Expected: db PASS, tsc PASS.

Grep: `grep -n "listAuditLog" packages/db/index.ts` → 2 baris (interface + impl).

- [ ] **Step 4: Commit**

```bash
git add packages/db/index.ts
git commit -m "feat(db): listAuditLog reader (lb_audit_log, paginated)"
```

### Task 2: Endpoint `GET /api/admin/log`

**Files:**
- Create: `apps/api-cf/src/routes/admin/log.ts`
- Modify: `apps/api-cf/src/index.ts` (import + mount)

- [ ] **Step 1: Buat `apps/api-cf/src/routes/admin/log.ts`**

Inspect dulu tipa `ScrapeJob` persis dari `@manga-platform/shared/types` (package `packages/shared`), pakai field yang benar sesuai Normalisasi di atas. Konten:

```ts
import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';
import type { ScrapeJob } from '@manga-platform/shared/types';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

type AuditLogRow = {
  id: number;
  account_id: string | null;
  origin_id: string | null;
  action: string;
  user_id: number | null;
  created_at: number;
};

type LogRow = {
  ts: number;
  type: 'admin' | 'scrape';
  actor: string | null;
  message: string;
  meta: Record<string, unknown>;
};

const normAudit = (r: AuditLogRow): LogRow => ({
  ts: r.created_at,
  type: 'admin',
  actor: r.user_id != null ? `user#${r.user_id}` : null,
  message: r.action,
  meta: { account_id: r.account_id, origin_id: r.origin_id },
});

const normScrape = (j: ScrapeJob): LogRow => ({
  ts: j.created_at ?? 0,
  type: 'scrape',
  actor: null,
  message: j.query ? `${j.source} · ${j.query}` : j.source,
  meta: { id: j.id, source: j.source, status: j.status, series_slug: j.series_slug ?? null, error: j.error ?? null },
});

// GET /api/admin/log?type=admin|scrape|all&page&limit — aktivitas admin + jobs scrape live.
router.get('/log', async (c: Context) => {
  const d = getDb(c);
  const typeRaw = c.req.query('type') || 'all';
  const type: 'admin' | 'scrape' | 'all' = typeRaw === 'admin' || typeRaw === 'scrape' ? typeRaw : 'all';
  const page = Math.min(Math.max(Number(c.req.query('page') ?? 1) || 1, 1), 1_000_000);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);

  if (type === 'admin') {
    const a = await d.listAuditLog({ page, limit });
    return json(c, {
      data: { type, rows: a.rows.map(normAudit), total: a.total, page, limit },
    });
  }
  if (type === 'scrape') {
    const jobs = (await d.listScrapeJobs(limit)) as ScrapeJob[];
    return json(c, {
      data: { type, rows: jobs.map(normScrape), total: jobs.length, page: 1, limit },
    });
  }
  const [a, jobs] = await Promise.all([
    d.listAuditLog({ page, limit }),
    d.listScrapeJobs(limit),
  ]);
  const rows = [...a.rows.map(normAudit), ...(jobs as ScrapeJob[]).map(normScrape)]
    .sort((x, y) => y.ts - x.ts)
    .slice(0, limit);
  return json(c, {
    data: { type, rows, total: a.total + (jobs as ScrapeJob[]).length, page, limit },
  });
});
```

- [ ] **Step 2: Mount di `apps/api-cf/src/index.ts`**

- Tambah import setelah `import { router as savedAdminRouter } ...`:
```ts
import { router as logAdminRouter } from './routes/admin/log';
```
- Tambah mount setelah `app.route('/api/admin', savedAdminRouter);` (baris ~111):
```ts
app.route('/api/admin', logAdminRouter);
```

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
```

Expected: tsc PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api-cf/src/routes/admin/log.ts apps/api-cf/src/index.ts
git commit -m "feat(api): GET /api/admin/log (audit admin + jobs scrape live)"
```

### Task 3: Halaman `/admin/log` + UI `AdminLog`

**Files:**
- Create: `apps/web/src/pages/admin/log.astro`
- Create: `apps/web/src/components/pages/AdminLog.tsx`

- [ ] **Step 1: `apps/web/src/pages/admin/log.astro`**

```astro
---
import AdminLayout from '@/layouts/AdminLayout.astro';
import AdminLog from '@/components/pages/AdminLog';

export const prerender = false;
---

<AdminLayout title="Log">
  <AdminLog client:only="react">
    <div style="max-width:72rem;margin:0 auto;padding:3rem 1rem;font-size:.875rem;opacity:.6">Memuat log…</div>
  </AdminLog>
</AdminLayout>
```

- [ ] **Step 2: `apps/web/src/components/pages/AdminLog.tsx`**

Kode lengkap (pola AdminSaved: `fetchMe` guard, `apiGet<{data: ...}>` — INGAT envelope: `apiGet<T>` return `{ data }`, jangan unwrap ganda; berikut dipakai langsung dengan `apiGet<LogResp>(...)` di mana `LogResp = { data: { type, rows, total, page, limit } }`):

```tsx
'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiGet, fetchMe, type AuthUser } from '@/lib/api';
import { Card, CardHead, fmtNum } from '@/components/admin/charts';

type LogRow = {
  ts: number;
  type: 'admin' | 'scrape';
  actor: string | null;
  message: string;
  meta: Record<string, unknown>;
};
type LogResp = { data: { type: 'admin' | 'scrape' | 'all'; rows: LogRow[]; total: number; page: number; limit: number } };

type Tab = 'all' | 'admin' | 'scrape';

function IconActivity({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

const fmtWhen = (ts: number): string => new Date(ts * 1000).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
const fmtWhenFull = (ts: number): string => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

const PAGE_SIZE = 20;
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'all', label: 'Semua' },
  { key: 'admin', label: 'Admin' },
  { key: 'scrape', label: 'Scrape' },
];

export default function AdminLogPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [data, setData] = useState<LogResp['data'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      if (!u || u.role !== 'admin') window.location.replace('/');
    });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (t: Tab, silent = false) => {
    if (!silent) setErr(null);
    try {
      const j = await apiGet<LogResp>(`/api/admin/log?type=${t}&page=1&limit=${PAGE_SIZE}`);
      setData(j.data);
    } catch {
      if (!silent) setErr('Gagal memuat log. Coba lagi.');
    }
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    setLoading(true);
    load(tab).finally(() => setLoading(false));
  }, [load, tab, user]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    const id = setInterval(() => { load(tab, true); }, 30_000);
    return () => clearInterval(id);
  }, [load, tab, user]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        <div className="h-10 rounded-full bg-elevated w-64" />
        <div className="h-96 rounded-2xl bg-elevated" />
      </div>
    );
  }

  const pagesTotal = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="admin-page space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Log</h1>
        <p className="text-[13px] text-muted mt-1">Aktivitas admin + jobs scrape live. Refresh otomatis tiap 30 detik.</p>
      </div>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 rounded-full bg-bg-secondary p-1 w-fit">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={[
                  'px-4 py-1.5 rounded-full text-[13px] transition-colors',
                  tab === t.key ? 'bg-accent text-accent-fg font-medium' : 'text-secondary hover:text-primary',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-muted tabular">{data ? fmtNum(data.total) : 0} entri</div>
        </div>
      </Card>

      {err && (
        <div className="text-sm text-error border border-error/30 rounded-xl p-3 bg-error/5">{err}</div>
      )}

      <Card>
        {(data?.rows ?? []).length === 0 ? (
          <div className="py-10 text-center">
            <IconActivity className="w-6 h-6 mx-auto text-muted mb-2" />
            <p className="text-[13px] text-muted">Tidak ada entri log{' '}
              {tab === 'admin' ? 'admin' : tab === 'scrape' ? 'scrape' : ''}

              untuk filter ini. Admin update settings/account/origin akan tercatat di sini.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border-subtle">
              {(data?.rows ?? []).map((row, i) => (
                <div key={`${row.type}-${row.ts}-${i}`} className="flex items-start gap-3 py-2.5">
                  <time className="text-[11px] font-mono tabular text-muted leading-5 shrink-0" title={fmtWhenFull(row.ts)}>
                    {fmtWhen(row.ts)}
                  </time>
                  <span
                    className={[
                      'shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded leading-4 mt-0.5',
                      row.type === 'admin' ? 'bg-accent/15 text-accent' : 'bg-bg-secondary text-secondary',
                    ].join(' ')}
                  >
                    {row.type}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-primary font-mono break-words">{row.message}</p>
                    <p className="text-[11px] text-muted mt-0.5 truncate">
                      {[row.actor, Object.entries(row.meta).filter(([, v]) => v != null).map(([k, v]) => `${k}=${String(v)}`).join(' ') || null]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {tab !== 'scrape' && data && data.page < pagesTotal && (
              <div className="flex items-center justify-center mt-4 pt-3 border-t border-border-subtle">
                <button
                  onClick={async () => {
                    setErr(null);
                    try {
                      const j = await apiGet<LogResp>(`/api/admin/log?type=${tab}&page=${data.page + 1}&limit=${PAGE_SIZE}`);
                      setData((prev) => prev ? { ...j.data, rows: [...prev.rows, ...j.data.rows] } : j.data);
                    } catch {
                      setErr('Gagal memuat halaman berikutnya.');
                    }
                  }}
                  className="px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors"
                >
                  Muat lebih banyak ({fmtNum(data.total - data.page * PAGE_SIZE)} tersisa)
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
```

Catatan impl:
- `Card` modul: `{ children, className?, delay? }` — `<Card>` tanpa delay valid. `CardHead`: `{ icon, title, hint? }`.
- Paginasi pakai pola "muat lebih banyak" (append page+1) — total + tombol sisa. Tab `scrape` tanpa paginasi (live).
- Auto-refresh 30s saat tab aktif & admin, silent reload (tak reset `err`), hanya ganti `data` bila sukses.
- `LogResp` envelope persis `apiGet<T>` return `{ data }` (lib/api.ts:488).

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
```

Expected: lint = SATU error (PreferencesSection:121) saja; bun PASS. Grep: `grep -rn "/admin/log" apps/web/src` → AdminLog.tsx + AdminTopbar.tsx (nav Plan B).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/admin/log.astro apps/web/src/components/pages/AdminLog.tsx
git commit -m "feat(web): halaman Log (/admin/log) gabungan audit + jobs scrape"
```