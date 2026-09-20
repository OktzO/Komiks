# Admin Redesign v2 — Plan C: Halaman Konten Tersimpan (endpoint + UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buat halaman admin `/admin/saved` "Konten Tersimpan" (dipakai nav "Konten" dari Plan B): KPI judul/chapter/panel tersimpan + bytes B2, grafik per-source + donut storage + tren, tabel judul & chapter terbaru. Sekaligus hapus UI merge (`merge.astro` + `AdminMerge.tsx`) — API merge TETAP.

**Architecture:** Reader DB baru di `packages/db/index.ts` (`getSavedContentSummary`, `listSavedSeries`, `listSavedChapters`) hit tabel `series`/`chapters`/`chapter_pages`/`manga_source_link`. Endpoint `GET /api/admin/saved` baru di `routes/admin/saved.ts` (pola identik `dashboard.ts`: `requireAdminSession` + no-store, mounted via `app.route('/api/admin', savedAdminRouter)`) gabung summary + series + chapters + bytes B2 dari `GET /api/admin/dashboard/storage` (KV `b2:usage`). UI `AdminSaved.tsx` dipasang via `pages/admin/saved.astro` (client:only, superset `AdminLayout`), pakai primitif `admin/charts.tsx` (Card/CardHead/StatCard/AreaChart/StorageDonut) dan `.admin-inner`.

**Tech Stack:** Astro, React islands, Hono, D1 (Drizzle-less native SQL di wrapper `packages/db`), token oklch.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-redesign-design.md` (bagian D [`E`] halaman baru `/admin/saved`; bagian A bahasa desain).

## Global Constraints

- Node 22.12+ wajib: prefix semua perintah `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH"`.
- api-cf `npm run build` (tsc) wajib PASS tiap task yang menyentuh `apps/api-cf` atau `packages/db`.
- db: `npm test --prefix packages/db` (tsx `test/matching.test.mjs`) wajib PASS tiap task DB.
- `npm run lint --prefix apps/web`: SATU-SATUNYA error ditolerir `apps/web/src/components/reader/PreferencesSection.tsx:121 ts(2345)`. Baru = gagal.
- `npm test --prefix apps/web` (bun canonical-url + round-robin) wajib PASS tiap task web.
- Warna HANYA token oklch yang ada. Radius: panel `rounded-2xl`/`1rem`, inner `rounded-xl`/`.admin-inner`, kotak kecil `rounded-lg`, tak seenaknya.
- Bahasa UI admin: Indonesia. `text-base` jangan dipakai sebagai warna.
- Aturan wrap: sqlite native di `packages/db` (`prep(...).bind(...).all/first`), bukan ORM.
- API merge `/api/admin/merge/*` TIDAK disentuh. `scrape.ts` auto-merge butuh itu.
- Migrasi SQL lama DILARANG diedit.
- Bahasa field API: snake_case dari DB; endpoint mengirim camelCase ke UI (konsisten pola `/dashboard/storage` → `total_bytes` → UI `total_bytes`; spesifikasi Plan C menentukan bentuk persis di bawah).
- Skill `manga` wajib dibaca implementer sebelum edit kode project ini.
- Git: commit per task, gaya `fix(area): deskripsi`, hanya stage file relevan, branch `main`.

## Konvensi jawaban endpoint (bentuk persis)

`GET /api/admin/saved?page=1&limit=20` → `200`:

```json
{
  "data": {
    "summary": {
      "series_total": 12,
      "chapters_total": 421,
      "pages_stored": 19340,
      "per_source": [
        { "source": "komiku", "series": 5, "chapters": 180, "last_scraped_at": 1727000000 }
      ]
    },
    "series": [
      { "slug": "boruto", "title": "Boruto", "source": "komiku", "chapter_count": 293, "last_scraped_at": 1727000000 }
    ],
    "chapters": [
      { "series_slug": "boruto", "series_title": "Boruto", "chapter_id": "komiku-boruto-293", "chapter_number": 293, "pages_count": 18, "created_at": 1727000000 }
    ],
    "total": 421,
    "page": 1,
    "limit": 20
  }
}
```

`page` clamp 1..1_000_000, `limit` clamp 1..100. `last_scraped_at`/`created_at` nullable → `null`.

---
---

### Task 1: Reader DB `getSavedContentSummary` + `listSavedSeries` + `listSavedChapters`

**Files:**
- Modify: `packages/db/index.ts` (interface `Db` + impl)

**Interfaces:**
- Produces (nama persis, dipakai Task 2 endpoint):
  - `getSavedContentSummary(): Promise<{ series_total: number; chapters_total: number; pages_stored: number; per_source: Array<{ source: string; series: number; chapters: number; last_scraped_at: number | null }> }>`
  - `listSavedSeries(params: { page?: number; limit?: number }): Promise<{ total: number; rows: Array<{ slug: string; title: string; source: string; chapter_count: number; last_scraped_at: number | null }> }>`
  - `listSavedChapters(params: { page?: number; limit?: number }): Promise<{ total: number; rows: Array<{ series_slug: string; series_title: string; chapter_id: string; chapter_number: number; pages_count: number; created_at: number }> }>`

- [ ] **Step 1: Tambah 3 signature ke interface `Db`**

Di `packages/db/index.ts`, dalam `export interface Db { ... }` (mulai baris 23), tambahkan tepat setelah `listScrapeJobs` (baris 31; cek anchor: `listScrapeJobs: (limit?: number) =>`):

```ts
  // ── Konten tersimpan (Plan C) ──
  getSavedContentSummary: () => Promise<{
    series_total: number;
    chapters_total: number;
    pages_stored: number;
    per_source: Array<{ source: string; series: number; chapters: number; last_scraped_at: number | null }>;
  }>;
  listSavedSeries: (params: { page?: number; limit?: number }) => Promise<{
    total: number;
    rows: Array<{ slug: string; title: string; source: string; chapter_count: number; last_scraped_at: number | null }>;
  }>;
  listSavedChapters: (params: { page?: number; limit?: number }) => Promise<{
    total: number;
    rows: Array<{ series_slug: string; series_title: string; chapter_id: string; chapter_number: number; pages_count: number; created_at: number }>;
  }>;
```

- [ ] **Step 2: Tambah impl ke objek Db**

Di impl (dalam `} return { ... }` — dekat `listScrapeJobs` impl ~baris 463-466), tambahkan tepat setelah impl `listScrapeJobs`:

```ts
    getSavedContentSummary: async () => {
      const sRow = await prep(
        'SELECT COUNT(DISTINCT s.slug) AS c FROM series s JOIN chapters ch ON ch.series_slug = s.slug'
      ).first<Row>();
      const cRow = await prep('SELECT COUNT(*) AS c FROM chapters').first<Row>();
      const pRow = await prep('SELECT COUNT(*) AS c FROM chapter_pages').first<Row>();
      const per = (await prep(
        `SELECT m.source,
                COUNT(DISTINCT s.slug) AS series,
                COUNT(c.id) AS chapters,
                MAX(m.last_scraped_at) AS last_scraped_at
         FROM manga_source_link m
         JOIN series s ON s.id = m.manga_id
         LEFT JOIN chapters c ON c.series_slug = s.slug
         GROUP BY m.source
         ORDER BY chapters DESC`
      ).all<Row>()).results ?? [];
      return {
        series_total: Number(sRow?.c ?? 0),
        chapters_total: Number(cRow?.c ?? 0),
        pages_stored: Number(pRow?.c ?? 0),
        per_source: (per as Row[]).map((r) => ({
          source: r.source as string,
          series: Number(r.series),
          chapters: Number(r.chapters),
          last_scraped_at: r.last_scraped_at == null ? null : (r.last_scraped_at as number),
        })),
      };
    },

    listSavedSeries: async ({ page = 1, limit = 20 }) => {
      const rows = (await prep(
        `SELECT s.slug, s.title, s.source, COUNT(c.id) AS chapter_count,
                (SELECT MAX(m.last_scraped_at) FROM manga_source_link m WHERE m.manga_id = s.id) AS last_scraped_at
         FROM series s
         JOIN chapters c ON c.series_slug = s.slug
         GROUP BY s.id
         ORDER BY chapter_count DESC, s.title ASC
         LIMIT ?1 OFFSET ?2`
      ).bind(limit, (page - 1) * limit).all<Row>()).results ?? [];
      const totalRow = await prep(
        'SELECT COUNT(DISTINCT s.slug) AS c FROM series s JOIN chapters ch ON ch.series_slug = s.slug'
      ).first<Row>();
      return {
        total: Number(totalRow?.c ?? 0),
        rows: (rows as Row[]).map((r) => ({
          slug: r.slug as string,
          title: r.title as string,
          source: r.source as string,
          chapter_count: Number(r.chapter_count),
          last_scraped_at: r.last_scraped_at == null ? null : (r.last_scraped_at as number),
        })),
      };
    },

    listSavedChapters: async ({ page = 1, limit = 20 }) => {
      const rows = (await prep(
        `SELECT c.id AS chapter_id, c.series_slug, c.chapter_number, s.title AS series_title,
                COUNT(p.id) AS pages_count, c.created_at
         FROM chapters c
         JOIN series s ON s.slug = c.series_slug
         LEFT JOIN chapter_pages p ON p.chapter_id = c.id
         GROUP BY c.id
         ORDER BY c.created_at DESC, c.id ASC
         LIMIT ?1 OFFSET ?2`
      ).bind(limit, (page - 1) * limit).all<Row>()).results ?? [];
      const totalRow = await prep('SELECT COUNT(*) AS c FROM chapters').first<Row>();
      return {
        total: Number(totalRow?.c ?? 0),
        rows: (rows as Row[]).map((r) => ({
          series_slug: r.series_slug as string,
          series_title: r.series_title as string,
          chapter_id: r.chapter_id as string,
          chapter_number: Number(r.chapter_number),
          pages_count: Number(r.pages_count),
          created_at: r.created_at as number,
        })),
      };
    },
```

Catatan: `chapters.chapter_number` bertipe `REAL`; `Number()` menyamakan 293 vs 293.0.

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix packages/db
```

Expected: PASS (matching.test.mjs).

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
```

Expected: tsc PASS (interface + impl typecheck di konsumen).

Grep: `grep -n "listSavedSeries\|getSavedContentSummary\|listSavedChapters" packages/db/index.ts` → 3 baris (interface) + 3 header impl.

- [ ] **Step 4: Commit**

```bash
git add packages/db/index.ts
git commit -m "feat(db): saved-content readers (summary, list series, list chapters)"
```

### Task 2: Endpoint `GET /api/admin/saved`

**Files:**
- Create: `apps/api-cf/src/routes/admin/saved.ts`
- Modify: `apps/api-cf/src/index.ts` (import + mount)

**Interfaces:**
- Consumes: Task 1 readers.
- Produces: `GET /api/admin/saved?page&limit` — bentuk respon persis di "Konvensi jawaban" atas; dipakai Task 3 UI.

- [ ] **Step 1: Buat `apps/api-cf/src/routes/admin/saved.ts`**

Konten lengkap:

```ts
import { Hono } from 'hono';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminSession } from '../../lib/auth';

export const router = new Hono<{ Bindings: Env }>();

router.use('*', requireAdminSession);
router.use('*', async (_c, next) => {
  await next();
  _c.res.headers.set('Cache-Control', 'no-store');
});

// GET /api/admin/saved — konten tersimpan: judul/chapter/panel + storage (KV).
router.get('/saved', async (c: Context) => {
  const d = getDb(c);
  const page = Math.min(Math.max(Number(c.req.query('page') ?? 1) || 1, 1), 1_000_000);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
  const [summary, series, chapters] = await Promise.all([
    d.getSavedContentSummary(),
    d.listSavedSeries({ page, limit }),
    d.listSavedChapters({ page, limit }),
  ]);
  return json(c, {
    data: {
      summary,
      series: series.rows,
      chapters: chapters.rows,
      total: chapters.total,
      page,
      limit,
    },
  });
});
```

- [ ] **Step 2: Mount di `apps/api-cf/src/index.ts`**

Tiga edit di `index.ts`:
- baris 16 area (setelah `import { router as dashboardAdminRouter } ...`):

```ts
import { router as savedAdminRouter } from './routes/admin/saved';
```

- Setelah `app.route('/api/admin', dashboardAdminRouter);` (baris 108) tambah:

```ts
app.route('/api/admin', savedAdminRouter);
```

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
```

Expected: tsc PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api-cf/src/routes/admin/saved.ts apps/api-cf/src/index.ts
git commit -m "feat(api): GET /api/admin/saved (konten tersimpan summary + lists)"
```

### Task 3: Halaman `/admin/saved` + UI `AdminSaved` + hapus UI merge

**Files:**
- Create: `apps/web/src/pages/admin/saved.astro`
- Create: `apps/web/src/components/pages/AdminSaved.tsx`
- Delete: `apps/web/src/pages/admin/merge.astro`
- Delete: `apps/web/src/components/pages/AdminMerge.tsx`

**Interfaces:**
- Consumes: `admin/charts.tsx` (Card, CardHead, StatCard, AreaChart, StorageDonut, fmtNum, fmtBytes), endpoint Task 2, `GET /api/admin/dashboard/storage` (sudah ada), `@/lib/api` (`apiGet`, `fetchMe`, `roleLabel` — per `AdminSettings.tsx`).
- Produces: halaman `saved.astro`. Nav "Konten" (Plan B) menunjuk ke sini.

- [ ] **Step 1: Buat `apps/web/src/pages/admin/saved.astro`**

Konten lengkap (imitasi pola `merge.astro` lama yang dihapus):

```astro
---
import AdminLayout from '@/layouts/AdminLayout.astro';
import AdminSaved from '@/components/pages/AdminSaved';

export const prerender = false;
---

<AdminLayout title="Konten Tersimpan">
  <AdminSaved client:only="react">
    <div style="max-width:72rem;margin:0 auto;padding:3rem 1rem;font-size:.875rem;opacity:.6">Memuat konten tersimpan…</div>
  </AdminSaved>
</AdminLayout>
```

- [ ] **Step 2: Hapus UI merge**

- `rm apps/web/src/pages/admin/merge.astro`
- `rm apps/web/src/components/pages/AdminMerge.tsx`
- Cek referensi sisa: `grep -rn "AdminMerge\|merge.astro" apps/web/src` → mustahil (hanya 2 file ini yang import). Jika ada hit lain → hentikan, laporkan.

- [ ] **Step 3: Buat `apps/web/src/components/pages/AdminSaved.tsx`**

File lengkap berikut (tokem yang dipakai semua sudah ada; icon definisi lokal):

```tsx
'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiGet, fetchMe, type AuthUser } from '@/lib/api';
import { Card, CardHead, StatCard, AreaChart, StorageDonut, fmtNum, fmtBytes } from '@/components/admin/charts';

type SavedSummary = {
  series_total: number;
  chapters_total: number;
  pages_stored: number;
  per_source: Array<{ source: string; series: number; chapters: number; last_scraped_at: number | null }>;
};
type SavedSeries = { slug: string; title: string; source: string; chapter_count: number; last_scraped_at: number | null };
type SavedChapter = { series_slug: string; series_title: string; chapter_id: string; chapter_number: number; pages_count: number; created_at: number };
type SavedResp = {
  summary: SavedSummary;
  series: SavedSeries[];
  chapters: SavedChapter[];
  total: number;
  page: number;
  limit: number;
};
type StorageResp = {
  data: {
    accounts: Array<{ idx: number; name: string; bucket: string; bytes: number; quota: number }>;
    total_bytes: number;
    d1_bytes: number | null;
    quota: number;
    /* trend: Array<{ db_name: string; points: Array<{ ts: number; size_bytes: number | null; rows_or_objects: number | null }> }> */
    trend: Array<{ db_name: string; points: Array<{ ts: number; size_bytes: number | null; rows_or_objects: number | null }> }>;
  };
};

function IconBook({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function IconLayers({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 2 10 6-10 6L2 8l10-6z" />
      <path d="m2 14 10 6 10-6" />
    </svg>
  );
}
function IconHash({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </svg>
  );
}
function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 15v-4M12 15V7M17 15v-7" />
    </svg>
  );
}

const fmtRel = (ts: number | null): string => {
  if (!ts) return 'belum pernah';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return `${d} detik lalu`;
  if (d < 3600) return `${Math.floor(d / 60)} mnt lalu`;
  if (d < 86400) return `${Math.floor(d / 3600)} jam lalu`;
  return `${Math.floor(d / 86400)} hari lalu`;
};
const fmtRelIso = (ts: number | null): string => {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('id-ID', { dateStyle: 'medium' });
};

const PAGE_SIZE = 20;

export default function AdminSavedPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedResp | null>(null);
  const [storage, setStorage] = useState<StorageResp['data'] | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let alive = true;
    fetchMe().then((u) => {
      if (!alive) return;
      setUser(u);
      setLoading(false);
      if (!u || u.role !== 'admin') window.location.replace('/');
    });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (p: number) => {
    setErr(null);
    try {
      const [s, st] = await Promise.all([
        apiGet<SavedResp>(`/api/admin/saved?page=${p}&limit=${PAGE_SIZE}`),
        apiGet<StorageResp>('/api/admin/dashboard/storage'),
      ]);
      setSaved(s.data);
      setStorage(st.data);
      setPage(p);
    } catch (e) {
      setErr('Gagal memuat data konten tersimpan. Coba lagi.');
    }
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    setLoading(true);
    load(1).finally(() => setLoading(false));
  }, [load, user]);

  if (loading) {
    return (
      <div className="admin-page space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 rounded-2xl bg-elevated" />)}
        </div>
        <div className="h-64 rounded-2xl bg-elevated" />
      </div>
    );
  }

  if (err) {
    return (
      <div className="admin-page py-8">
        <div className="text-sm text-error border border-error/30 rounded-xl p-3 bg-error/5">{err}</div>
      </div>
    );
  }

  const s = saved?.summary;
  const pagesTotal = Math.max(1, Math.ceil((saved?.total ?? 0) / PAGE_SIZE));
  const sourceBarMax = Math.max(1, ...(s?.per_source.map((x) => x.chapters) ?? [1]));
  const trendPoints = (storage?.trend ?? []).map((t) => t.points).flat().map((p) => p.size_bytes ?? 0);
  const trendLabels = (storage?.trend ?? []).map((t) => t.points).flat().map((p) => p.ts ? new Date(p.ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : '');

  return (
    <div className="admin-page space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Konten Tersimpan</h1>
        <p className="text-[13px] text-muted mt-1">Judul, chapter, dan panel hasil scrape di storage B2.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<IconBook className="w-4 h-4" />} label="Judul tersimpan" value={fmtNum(s?.series_total ?? 0)} sub="dengan chapter" />
        <StatCard icon={<IconLayers className="w-4 h-4" />} label="Chapter tersimpan" value={fmtNum(s?.chapters_total ?? 0)} sub="total chapter" />
        <StatCard icon={<IconHash className="w-4 h-4" />} label="Panel tersimpan" value={fmtNum(s?.pages_stored ?? 0)} sub="objek di B2" />
        <StatCard icon={<IconChart className="w-4 h-4" />} label="Storage dipakai" value={fmtBytes(storage?.total_bytes ?? null)} sub={`${fmtBytes(storage?.d1_bytes ?? null)} estimasi D1`} />
      </div>

      <Card delay={60}>
        <CardHead icon={<IconChart className="w-4 h-4" />} title="Distribusi per source" hint="judul & chapter tersimpan per source aggregasi" />
        <div className="space-y-3">
          {(s?.per_source ?? []).map((row) => (
            <div key={row.source} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-[12px] text-secondary truncate uppercase tracking-wide">{row.source}</span>
              <div className="flex-1 h-6 flex items-center gap-2">
                <div className="flex-1 h-2.5 rounded-full bg-bg-secondary overflow-hidden">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(row.chapters / sourceBarMax) * 100}%` }} />
                </div>
                <span className="text-[11px] text-muted tabular w-20 text-right">{row.series} judul · {row.chapters} chapter</span>
              </div>
            </div>
          ))}
          {(s?.per_source ?? []).length === 0 && (
            <p className="text-[13px] text-muted leading-relaxed">Belum ada konten tersimpan dari source mana pun. Jalankan scrape dulu.</p>
          )}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        {storage && (
          <StorageDonut
            accounts={storage.accounts}
            totalBytes={storage.total_bytes}
            quota={storage.quota}
            d1Bytes={storage.d1_bytes}
            icon={<IconChart className="w-4 h-4" />}
          />
        )}
        <Card delay={120}>
          <CardHead icon={<IconChart className="w-4 h-4" />} title="Tren penyimpanan" hint="db_usage_snapshot · 30 hari" />
          {(trendPoints.length >= 2 ? (
            <AreaChart points={trendPoints} labels={trendLabels} />
          ) : (
            <p className="text-[13px] text-muted leading-relaxed py-8 text-center">Belum cukup data tren penyimpanan.</p>
          ))}
        </Card>
      </div>

      <Card delay={160}>
        <CardHead icon={<IconBook className="w-4 h-4" />} title="Judul tersimpan" hint="urut chapter terbanyak" />
        {(saved?.series ?? []).length === 0 ? (
          <p className="text-[13px] text-muted leading-relaxed py-8 text-center">Belum ada judul tersimpan.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {(saved?.series ?? []).map((row) => (
              <div key={row.slug} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] text-primary truncate">{row.title}</p>
                  <p className="text-[11px] text-muted mt-0.5 uppercase tracking-wide">{row.source}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[13px] text-primary tabular">{row.chapter_count} chapter</p>
                  <p className="text-[11px] text-muted mt-0.5">{fmtRel(row.last_scraped_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card delay={200}>
        <CardHead icon={<IconLayers className="w-4 h-4" />} title="Chapter terbaru" hint={`${fmtNum(saved?.total ?? 0)} chapter · halaman ${page}`} />
        {(saved?.chapters ?? []).length === 0 ? (
          <p className="text-[13px] text-muted leading-relaxed py-8 text-center">Belum ada chapter tersimpan.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {(saved?.chapters ?? []).map((row) => (
              <div key={row.chapter_id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] text-primary truncate">{row.series_title}</p>
                  <p className="text-[11px] text-muted mt-0.5 truncate">Chapter {row.chapter_number}{row.series_slug ? ` · ${row.series_slug}` : ''}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[13px] text-primary tabular">{row.pages_count} panel</p>
                  <p className="text-[11px] text-muted mt-0.5">{fmtRelIso(row.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {pagesTotal > 1 && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border-subtle">
            <button
              disabled={page <= 1}
              onClick={() => load(page - 1)}
              className="px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors disabled:opacity-50"
            >Sebelumnya</button>
            <span className="text-[12px] text-muted tabular">{page} / {pagesTotal}</span>
            <button
              disabled={page >= pagesTotal}
              onClick={() => load(page + 1)}
              className="px-4 py-2 border border-border-default rounded-xl text-sm text-secondary hover:bg-bg-secondary hover:text-primary transition-colors disabled:opacity-50"
            >Berikutnya</button>
          </div>
        )}
      </Card>
    </div>
  );
}
```

Catatan impl:
- `apiGet<T>(path): Promise<T>` (apps/web/src/lib/api.ts:488) mengembalikan badan JSON LANGKAH asli, yaitu envelope `{ data: {...} }`. Jadi `apiGet<SavedResp>(url)` → `{ data: SavedResp }`, lalu `s.data` — KODE PLAN SUDAH benar; jangan "unwrap" ganda.
- `Window location` guard `window.location.replace('/')` bila bukan admin — pola `AdminMerge` lama. 
- `chapter_number` bisa float (`1.5`); baris tabel tampil `Chapter 1.5` — `Number` pas.
- `IconHash`/`IconLayers` dll adalah ikon lokal (belum ada di charts.tsx) — definisi di file ini, nama tidak bentrok dengan icon Settings yang lokal ke file lain.

- [ ] **Step 4: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
```

Expected: SATU error (PreferencesSection:121) saja. Tidak ada error baru di AdminSaved.tsx / saved.astro / hilangnya AdminMerge.

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
```

Expected: PASS.

Grep:
- `grep -rn "AdminMerge\|merge.astro" apps/web/src` → tanpa output.
- `ls apps/web/src/pages/admin/merge.astro` → file tidak ada (command gagal = OK).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/saved.astro apps/web/src/components/pages/AdminSaved.tsx
git rm apps/web/src/pages/admin/merge.astro apps/web/src/components/pages/AdminMerge.tsx
git commit -m "feat(web): halaman Konten Tersimpan (/admin/saved), hapus UI merge"
```