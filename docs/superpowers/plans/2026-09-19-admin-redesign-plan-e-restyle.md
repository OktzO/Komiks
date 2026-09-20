# Admin Redesign v2 — Plan E: Restyle Dashboard, Monitoring, Users, UserDetail

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrasi 4 halaman admin terakhir ke bahasa desain Plan B (primitif `admin/charts.tsx` + `.admin-card` dibuang + `.admin-page`/`CardHead`/`admin-inner` konsisten). Buang panel mati di Monitoring (spec F). KPI ke-6 Dashboard "Security alerts" → **"Konten tersimpan"** (spec G). Perbaiki link 404 `/admin/merge` (R11). Settings SUDAH selesai (Plan B) — keluar dari scope.

**Architecture:** Web only — tidak ada perubahan `apps/api-cf` atau `packages/db` (endpoint `/api/admin/saved` Plan C + `/api/admin/log` Plan D sudah tersedia). Tiap komponen: root `<main max-w-*l>` → `<div className="admin-page space-y-6">` (AdminLayout main di Plan B sudah kasih `.admin-page px-4 md:px-6 py-8`), section `.admin-card p-5` → primitif `Card` + `CardHead`, tabel dalam `admin-inner`, loading → `<div className="admin-page">` skeleton tanpa main bersarang.

**Tech Stack:** Astro React islands + token oklch.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-redesign-design.md` bagian F (Monitoring rapikan) dan G (Dashboard + Users + UserDetail restyle). Primitif tersedia: `apps/web/src/components/admin/charts.tsx` — `Card({children, className?, delay?})`, `CardHead({icon?, title, hint?, action?})`, `StatCard({icon, label, value, sub, tone?, delay?})`, `EmptyState`, `AreaChart({points, labels, height?})`, `StorageDonut`, `fmtNum`, `fmtBytes`. CSS: `.admin-page` / `.admin-panel` / `.admin-inner` / `.status-dot` di `global.css:609-637`.

## Global Constraints

- Node 22.12+: prefix `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH"`.
- `npm run lint --prefix apps/web`: SATU-SATUNYA error ditolerir `PreferencesSection.tsx:121 ts(2345)`. Baru = gagal.
- `npm test --prefix apps/web` (bun) wajib PASS.
- Warna HANYA token oklch ada. `text-base` jangan dipakai untuk warna. Radius: panel `rounded-2xl`, inner `admin-inner` (rounded-xl), chip `rounded-lg`/`rounded-full`.
- Bahasa UI admin: Indonesia. Jangan terjemahkan string user-visible yang sudah ada ke Inggris.
- JANGAN tambah endpoint/reader baru. Status badge / `status-dot` / `quota-bar` dipakai apa adanya.
- Skill `manga` wajib dibaca implementer sebelum edit.
- Git: commit per task, gaya `style(web): ...` / `fix(web): ...`, hanya file relevan, branch `main`.

## Konvensi root render (berlaku semua task)

Saat ini AdminDashboard/Monitoring/Users/UserDetail render `<main className="max-w-6xl|5xl|4xl mx-auto px-4 py-8 sm:py-10/12">` DI DALAM layout yang sudah `<main className="admin-page px-4 md:px-6 py-8">` → main bersarang + width ganda. Ganti root jadi:

```tsx
return (
  <div className="admin-page space-y-6">
    {/* header + status */}
  </div>
);
```

Loading state → `<div className="admin-page space-y-4">` + skeleton `rounded-2xl bg-elevated` (bukan `<main>` + `rounded-lg bg-card`). Header h1: `text-xl font-semibold tracking-tight text-primary` + `<p className="text-[13px] text-muted mt-1">` (pola AdminSaved.tsx / AdminLog.tsx). Tutup `</main>` → `</div>`.

---
---

### Task 1: Restyle Dashboard (AdminDashboard.tsx)

**Files:**
- Modify: `apps/web/src/components/pages/AdminDashboard.tsx`

**Interfaces:**
- Consumes: `admin/charts.tsx` (Card, CardHead, StatCard, fmtNum, fmtBytes), `/api/admin/saved` (summary.chapters_total), endpoint yang sudah dipakai.
- Produces: Dashboard konsisten bahasa baru; KPI 6 = Konten tersimpan; link `/admin/merge` hilang.

- [ ] **Step 1: Imports & hapus duplikasi**

Ke atas: `import { Card, CardHead, StatCard, fmtNum, fmtBytes } from '@/components/admin/charts';`. HAPUS definisi lokal `fmtBytes` (baris 49-55) dan `fmtNum` (57) — `fmtRel` (59-66) dan `fmtDay` (68-69) TETAP lokal (modul tak punya). HAPUS komponen lokal `StatCard` (baris 234-258) dan `SectionHead` (288-298).

- [ ] **Step 2: Data — tambah chapters tersimpan**

Di `loadAll`, tambah fetch ke Promise.all (nullable ROOT daftar: `const [ov, st, sh, rq, a, o, us] = await Promise.all([...])` → jadi juga `sv` untuk saved):

```ts
apiGet<{ data: { summary: { chapters_total: number } } }>('/api/admin/saved?page=1&limit=1'),
```

- Destruktur:`const [ov, st, sh, rq, a, o, us, sv] = await Promise.all([...])`.
- State baru `const [savedChapters, setSavedChapters] = useState(0);`
- `setSavedChapters(sv.data?.summary?.chapters_total ?? 0);`

- [ ] **Step 3: Root + header**

Ganti root `<main className="max-w-6xl mx-auto px-4 py-8 sm:py-10">` → `<div className="admin-page space-y-6">`, tutup `</main>` → `</div>`. Header:

```tsx
<div className="flex items-center justify-between gap-4 flex-wrap">
  <div>
    <h1 className="text-xl font-semibold tracking-tight text-primary">Dashboard</h1>
    <p className="text-[13px] text-muted mt-1">{user.email} · {roleLabel(user.role)}</p>
  </div>
  <span className="flex items-center gap-2 text-xs text-muted">
    <span className={`status-dot ${refreshing ? 'live' : 'unknown'}`} />
    {refreshing ? 'refreshing' : 'live'}
  </span>
</div>
```

Loading state root → `<div className="admin-page space-y-4">`, chunks `h-28 rounded-2xl bg-elevated` dan grid `grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3`.

- [ ] **Step 4: KPI strip (6 kartu) → module StatCard**

Grid tetap `grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3` (bukan `mb-5`). Kartu pakai module StatCard, ikon definisi lokal (tipa kecil `{ className?: string }` dikembalikan svg stroke saat ini — pola IconBook di AdminSaved). Mapping persis:

| Label | value | sub |
|---|---|---|
| Storage · B2 | `fmtBytes(storageTotal)` | `` `${storagePct.toFixed(1)}% dari ${fmtBytes(storageQuota)} quota` `` |
| Konten tersimpan | `fmtNum(savedChapters)` | `chapter tersimpan · lihat halaman Konten` |
| Request · 14d | `fmtNum(reqTotal7d)` | `` `${requests?.series.length ?? 0} origin terlayani` `` |
| Source uptime | `avgUptime > 0 ? \`${avgUptime}%\` : '—'` | `` `${sources.length} source dipantau` `` |
| Scrape · 24h | `scrapeTotal > 0 ? \`${scrapeRate}%\` : '—'` | `scrapeTotal > 0 ? \`${overview!.scrape24h.success}/${scrapeTotal} sukses\` : 'belum ada aktivitas'` |
| Users | `fmtNum(usersTotal)` | `` `+${users7d} minggu ini` `` |

Catatan: `storageDelta`/`usersGrowth`/`delta`/`refreshing` prop di module TIDAK ada → buang chip delta & animasi num-refresh (status-dot header cukup). Variabel `storageDelta` boleh dihapus atau dibiarkan (bila tak dipakai lagi, bandingkan kapasitas usersGrowth dihapus bila warning noUnusedLocals di astro check — JANGAN biarkan error baru; hapus yang jadi tak terpakai).

- [ ] **Step 5: Sections → Card + CardHead**

`<section className="admin-card p-5 lg:col-span-2">` → `<Card className="lg:col-span-2 grid grid-cols-subgrid">`; pola grid baris `lg:grid-cols-3`/`lg:grid-cols-4` tetap. `SectionHead` → `<CardHead icon={...} title="..." hint="..." action={...} />`. Tentang `lg:col-span-*`: posisikan Card di grid sebagaimana section dulu (kolom sama). Khusus LB accounts & Users terbaru: header di dalam `<div className="p-5 pb-3"><CardHead .../></div>` dulu di HAPUS — Card sudah `p-5`; letakkan CardHead langsung di dalam Card, lalu tabel row `> div className="admin-inner overflow-hidden"` atau langsung row dengan `divide-y divide-border-subtle`.

Konversi persis:
- Storage trend: `<Card>` + CardHead icon storage "Storage trend · B2" hint "Snapshot tiap jam · 30 hari terakhir" + `AreaChart` (KEEP komponen AreaChart lokal — punya tooltip date + fmtBytes; module AreaChart tooltip pakai fmtNum) + legend row.
- Source health: `<Card>` + CardHead icon activity "Source health" hint "Uptime dari riwayat pengecekan" + bar list (KEEP markup baris source, token sudah oklch).
- Sistem gauge: `<Card>` (tengah) + CardHead "Sistem" + `Gauge` (KEEP komponen Gauge).
- Request per origin: `<Card>` + CardHead icon request "Request per origin" hint (KEEP) + `ReqBars` (KEEP komponen ReqBars).
- LB accounts: `<Card>` (overflow ok di dalam Card; tambah `overflow-hidden` di Card className bila perlu) + CardHead icon "Load balancer accounts" hint (KEEP) action "Kelola →" `/admin/settings`. Table header row: `border-t border-border-subtle` aja (border-b di kepala tabel cukup).
- Users terbaru: `<Card>` + CardHead icon users "Users terbaru" hint total "· +N minggu ini" action "Kelola →" `/admin/users`.

Legenda/legend "Total usage" baris bawah di Storage trend tetap pakai `text-[11px] text-muted`.

- [ ] **Step 6: Nav links bawah — buang merge (R11)**

```tsx
<nav className="flex flex-wrap gap-2">
  <a href="/admin/monitoring" ...>Monitoring →</a>
  <a href="/admin/users" ...>Users →</a>
  <a href="/admin/saved" ...>Konten →</a>
  <a href="/admin/log" ...>Log →</a>
  <a href="/admin/settings" ...>Settings →</a>
</nav>
```

(`/admin/merge` HILANG. Ini penutup R11.)

- [ ] **Step 7: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
```

Expected: lint = SATU error (PreferencesSection:121); bun PASS. Grep: `grep -rn "admin/merge" apps/web/src` → TANPA output (menutup R11); `grep -rn "admin-card" apps/web/src/components/pages/AdminDashboard.tsx` → tanpa output.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/pages/AdminDashboard.tsx
git commit -m "style(web): dashboard migrasi primitif admin, buang link /admin/merge, KPI Konten tersimpan"
```

### Task 2: Restyle Monitoring (AdminMonitoring.tsx)

**Files:**
- Modify: `apps/web/src/components/pages/AdminMonitoring.tsx`

**Interfaces:**
- Consumes: `admin/charts.tsx` (Card, CardHead, EmptyState, fmtBytes), `/api/admin/dashboard/source-health` (SourceHealth[]), `/api/admin/db-usage?days=7` (existing DbUsage), `/api/admin/log?type=scrape&limit=30` (Plan D — live jobs `{ts,type,actor,message,meta:{id,source,status,series_slug}}`), `roleLabel`.
- Produces: Monitoring tanpa panel mati (spec F): Source health + Storage/DB usage + Scrape jobs live.

- [ ] **Step 1: Import + hapus duplikasi**

`import { Card, CardHead, EmptyState, fmtBytes } from '@/components/admin/charts';`. HAPUS fungsi lokal `formatBytes` (46-52) → pakai `fmtBytes`. `formatRelative` (37-44) TETAP lokal. HAPUS tipa `Provider` + state `providers` + fetch `/api/admin/providers` dari `loadAll`.

- [ ] **Step 2: Root + header**

Root `<main className="max-w-5xl mx-auto px-4 py-8 sm:py-12">` → `<div className="admin-page space-y-6">`; loading → `<div className="admin-page space-y-4">` skeleton `h-16 rounded-2xl bg-elevated`. Header: h1 `text-xl ...` "Monitoring" + p `text-[13px] text-muted mt-1` "Source health · storage · scrape jobs live" (HAPUS backlink "← Overview" — topbar nav menangani navigasi; atau PERTAHANKAN jika ingin — keputusan lalu). Status-dot refresh pill (KEEP).

- [ ] **Step 3: HAPUS panel "Provider Accounts"**

Seluruh section (baris 142-205) HAPUS. State/tipe `Provider`, fetch, `expandedError` HAPUS.

- [ ] **Step 4: Panel Source health (baru)**

Data `SourceHealth[]` (tipa sama dpt copy AdminDashboard): fetch `/api/admin/dashboard/source-health` → `.data || []` (state `sources`). `SOURCE_NAMES: Record<string,string>` kecil (komiku/bacakomik/thrive/manhwaindo/shinigami → label judul kapital). `fmtRel` lokal versi monitoring (`formatRelative`).

```tsx
<Card>
  <CardHead icon={<IconActivity className="w-4 h-4" />} title="Source health" hint="Uptime dari riwayat pengecekan" />
  {sources.length === 0 ? (
    <EmptyState>Belum ada data health. Tercatat pasif saat aktivitas baca.</EmptyState>
  ) : (
    <div className="space-y-3">
      {sources.map((s) => {
        const pct = s.uptime_pct ?? 0;
        const tone = pct >= 95 ? 'var(--success)' : pct >= 70 ? 'oklch(70% 0.12 75)' : 'var(--error)';
        return (
          <div key={s.source}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-primary font-medium">{SOURCE_NAMES[s.source] ?? s.source}</span>
              <span className="font-mono tabular text-secondary">{pct.toFixed(1)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--border-subtle)] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
            </div>
            <div className="flex justify-between mt-1 text-[10px] text-muted">
              <span>↑ {s.last_healthy ? formatRelative(s.last_healthy) : '—'}</span>
              <span>{fmtNum(s.chapters_7d)} chapter · 7d</span>
            </div>
          </div>
        );
      })}
    </div>
  )}
</Card>
```

Butuh `fmtNum` di import (default module). Dan 1 icon (IconActivity, stroke) definisi lokal.

- [ ] **Step 5: Panel Storage / DB usage**

Perbaiki section DB usage (baris 208-240): bungkus dalam `<Card>` + CardHead icon storage "Storage / DB usage" hint "Snapshot tiap jam · 30 hari terakhir". `.admin-card p-4` per item → `admin-inner p-4` (masih di dalam Card). Empty state → `EmptyState`. Jadi:

```tsx
<Card>
  <CardHead icon={<IconDatabase className="w-4 h-4" />} title="Storage / DB usage" hint="Snapshot db_usage · tiap jam" />
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
    {dbUsage?.current.length ? dbUsage.current.map((d) => {
      const trend = dbUsage.trend.find((t) => t.db_name === d.db_name);
      const prev = trend && trend.points.length > 1 ? trend.points[trend.points.length - 2] : null;
      const curr = trend && trend.points.length > 0 ? trend.points[trend.points.length - 1] : null;
      const sizeDelta = prev && curr && prev.size_bytes != null && curr.size_bytes != null
        ? curr.size_bytes - prev.size_bytes : null;
      return (
        <div key={d.db_name} className="admin-inner p-4">
          <div className="text-[11px] text-muted mb-1 truncate">{d.db_name}</div>
          <div className="font-mono tabular text-lg text-primary">{fmtBytes(d.size_bytes)}</div>
          <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted">
            <span className="font-mono tabular">{d.rows_or_objects ?? '—'} rows/obj</span>
            {sizeDelta != null && (
              <span className={sizeDelta > 0 ? 'text-success' : sizeDelta < 0 ? 'text-error' : 'text-muted'}>
                {sizeDelta > 0 ? '↑' : sizeDelta < 0 ? '↓' : '→'} {fmtBytes(Math.abs(sizeDelta))}
              </span>
            )}
          </div>
        </div>
      );
    }) : <EmptyState>Belum ada snapshot penyimpanan. Terisi tiap jam oleh cron.</EmptyState>}
  </div>
</Card>
```

(Gunakan icon IconDatabase/IconStorage lokal kecil.)

- [ ] **Step 6: Panel Scrape jobs live**

Ganti section "Scrape Log · latest 30" (`scrape_jobs_log`) → LIVE dari `/api/admin/log?type=scrape`. Fetch di `loadAll`:

```ts
apiGet<{ data: { rows: Array<{ ts: number; type: 'scrape'; actor: string | null; message: string; meta: { id: string; source: string; status: string; series_slug: string | null; error: string | null } }> } }>('/api/admin/log?type=scrape&limit=30'),
```

State `logRows`, set `.data.rows || []`. Render:

```tsx
<Card>
  <CardHead icon={<IconActivity className="w-4 h-4" />} title="Scrape jobs live" hint="scrape_jobs · refresh 30 detik" />
  {logRows.length === 0 ? (
    <EmptyState>Belum ada job scrape aktif. Jalankan scraper dulu.</EmptyState>
  ) : (
    <div className="admin-inner divide-y divide-border-subtle overflow-hidden">
      {logRows.map((r) => {
        const failed = r.meta.status === 'failed' || r.meta.status === 'skipped_robots';
        return (
          <div key={r.meta.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className={`status-dot shrink-0 ${failed ? 'down' : r.meta.status === 'running' ? 'live' : 'healthy'}`} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-primary truncate">{r.message}</p>
              {r.meta.series_slug && <p className="text-[11px] text-muted truncate">{r.meta.series_slug}</p>}
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full border capitalize shrink-0 
              ${failed ? 'text-error border-error/30 bg-error/10' : r.meta.status === 'running' ? 'text-accent border-accent/30 bg-accent/10' : 'text-secondary border-border-default'}">
              {r.meta.status}
            </span>
            <span className="text-[11px] text-muted font-mono tabular shrink-0">{formatRelative(r.ts)}</span>
          </div>
        );
      })}
    </div>
  )}
</Card>
```

- [ ] **Step 7: Verifikasi (seperti Task 1)** — lint 1 err; bun PASS; `grep -rn "admin-card" apps/web/src/components/pages/AdminMonitoring.tsx` → tanpa output.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/pages/AdminMonitoring.tsx
git commit -m "style(web): monitoring restyle — source health, storage usage, scrape jobs live (buang panel mati)"
```

### Task 3: Restyle Users (AdminUsers.tsx)

**Files:**
- Modify: `apps/web/src/components/pages/AdminUsers.tsx`

**Interfaces:**
- Consumes: `admin/charts.tsx` (Card, CardHead, fmtNum), `roleLabel`. StatusBadge lokal KEEP.
- Produces: Users konsisten; tabel dalam Card + admin-inner.

- [ ] **Step 1: Import.** Tambah `import { Card, CardHead, fmtNum } from '@/components/admin/charts';`.

- [ ] **Step 2: Root + loading.** `<main className="max-w-4xl ...">` → `<div className="admin-page space-y-6">`. Loading → `<div className="admin-page space-y-4">` skeleton `h-12 rounded-2xl bg-elevated`. Header: h1 `text-xl` "Users" + p `text-[13px] text-muted` `` `${fmtNum(total)} terdaftar` ``; hapus backlink "← Dashboard" (topbar ada) ATAU keep (keputusan) — konsisten dgn Task 2 nanti cek. Status-dot pill KEEP.

- [ ] **Step 3: Search input** — tetap `w-full`, ubah kelas jadi `w-full bg-bg-base border border-border-default rounded-xl px-3 py-2 mb-4 text-primary placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30` (rounded-x1 → konsisten). Placeholder Indonesia: `Cari email atau nama...`.

- [ ] **Step 4: Tabel**

`<div className="border border-subtle rounded-lg overflow-hidden bg-card">` → `<Card>` + `<CardHead title="Daftar user" hint={`${fmtNum(total)} total`} />` + isi tabel dalam `<div className="admin-inner overflow-hidden">`. Baris header grid (col-span-12) → `px-4 py-2 border-b border-subtle` (tetap). Baris user `border-b border-subtle last:border-0 hover:bg-bg-secondary/30` (tetap). Empty → `EmptyState` ("Tidak ada user ditemukan."). Tombol aksi (suspend/ban/activate/member/admin) KEEP markup.

- [ ] **Step 5: Pagination + confirm dialog.** Pagination wrapper `mt-4` (KEEP). Confirm dialog: `rounded-2xl border border-border-default bg-elevated p-6 shadow-2xl` (KEEP — sudah bahasa baru).

- [ ] **Step 6: Verifikasi** — lint 1 err; bun PASS; `grep -rn "admin-card" apps/web/src/components/pages/AdminUsers.tsx` → tanpa output.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/pages/AdminUsers.tsx
git commit -m "style(web): users restyle ke primitif admin"
```

### Task 4: Restyle UserDetail (AdminUserDetail.tsx)

**Files:**
- Modify: `apps/web/src/components/pages/AdminUserDetail.tsx`

**Interfaces:**
- Consumes: `admin/charts.tsx` (Card, CardHead, fmtNum). StatusBadge style inline (role chip) KEEP.
- Produces: UserDetail konsisten; `.admin-card` hilang (tutup R5 terakhir), bookmark tabel → admin-inner.

- [ ] **Step 1: Import** `import { Card, CardHead, fmtNum } from '@/components/admin/charts';`.

- [ ] **Step 2: Root + loading.** `<main className="max-w-3xl ...">` → `<div className="admin-page space-y-6">`; backlink "← Users" KEEP (di dalam root div). Loading `<div className="admin-page space-y-4">`.

- [ ] **Step 3: Profil**

`.admin-card p-6 mb-6` (baris 130) → `<Card>`:
- header baris: h1 `text-lg font-semibold tracking-tight text-primary truncate` + role chip (KEEP markup chip).
- grid `grid grid-cols-2 gap-4 text-sm` (KEEP) — label `text-[11px] text-muted mb-0.5` + nilai `text-primary`.
- Ini menutup R5 (sisa `.admin-card` terakhir di repo).

- [ ] **Step 4: Tombol disabled** — KEEP markup (opsi kecil: `rounded-lg` → `rounded-xl` agar konsisten — terserah).

- [ ] **Step 5: Bookmarks**

Section (baris 185-230): `<section><h2 ...>` → `<Card>` + `<CardHead title="Bookmark" hint={`${fmtNum(bmTotal)} total`} />`; daftar bookmarks dalam `<div className="admin-inner divide-y divide-border-subtle overflow-hidden">`, row `flex items-center gap-3 px-4 py-3` (border-b dihapus — divide menangani). Pagination KEEP (`mt-4`). Empty → `<EmptyState>Tidak ada bookmark.</EmptyState>`.

- [ ] **Step 6: Verifikasi** — lint 1 err; bun PASS; `grep -rn "admin-card" apps/web/src` → TANPA output (seluruh repo bebas `.admin-card` — R5 tuntas).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/pages/AdminUserDetail.tsx
git commit -m "style(web): user detail restyle, buang sisa .admin-card terakhir"
```