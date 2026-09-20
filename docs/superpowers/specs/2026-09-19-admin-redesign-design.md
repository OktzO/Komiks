# Antarmuka Admin Oktz. v2 — Design Spec

Tanggal: 2026-09-19. Status: disetujui user (brainstorming).
Dasar: hasil explore agent `/tmp/admin-surface.md` + keputusan klarifikasi user.

## Tujuan

Redesign total semua halaman admin dengan bahasa desain baru (modern-futuristik, border tegas, sudut membulat), hapus fitur security alerts end-to-end, hapus halaman merge (API disimpan), tambah halaman `Konten Tersimpan` (grafik + panel downloaded/saved) dan halaman `Log` (gabungan audit admin + aktivitas scrape), serta bikin fungsi log yang nyata (writer + reader + UI).

## Keputusan user (kuat, tidak boleh diganggu)

1. **Fungsi log = "gabungan: satu halaman log lengkap"** — satu panel Aktivitas berisi semua jenis: audit admin + scrape jobs + internal events, dapat difilter per tipe.
2. **`/admin/merge`**: halaman + island `AdminMerge` + nav entry DIHAPUS. API `/api/admin/merge/*` TETAP (dipakai alur auto-merge di `admin/scrape.ts`).
3. **Shell admin**: topbar atas tetap, dibuat sticky + tak mungkin nimpa konten; konten satu kolom konsisten `max-w-7xl`.

## Lingkup

### A. Bahasa desain (semua halaman admin)
- Token oklch yang ada dipakai apa adanya; TIDAK ada warna baru.
- Panel: `rounded-2xl`, `border` kuat `--border-strong` (±1.5px), inner `rounded-xl`; kartu KPI angka `tabular` mono + chip ikon aksen.
- Satu primitif `Card`/`PanelHead` (pindahkan gaya AdminSettings) dipakai semua halaman. `.admin-card` lama dibuang.
- Helpers CSS baru di `global.css` block admin: `.admin-page` (max-w-7xl mx-auto), `.admin-panel`, `.panel-head`, variasi radius. `border-subtle` vs `border-border-subtle` disamakan.
- Animasi: pakai ulang `.anim-slide-up`, `.anim-rise`, `.num-refresh`. Container lebar konsisten `max-w-7xl` (bukan campuran 3xl..7xl).

### B. Shell + fix navbar nimpa
- `AdminLayout.astro`: topbar jadi **sticky** in-flow → kehilangan rely pada `pt-24`; wrapper `<main class="admin-page py-8">`.
- Nav: Dashboard, Monitoring, Users, **Konten** (baru), **Log** (baru), Settings. "Merge Queue" dihapus dari nav.
- Perbaiki quirk `.text-base { color: inherit }` bila menyentuh (jangan pindah).

### C. Security alerts — hapus total (end-to-end + bersihkan data)
- DB: migrasi baru `packages/db/migrations/0019_drop_security_events.sql` (`DROP TABLE` + index ikut). `schema.sql` dihapus blok tabelnya. `packages/db/index.ts`: hapus `addSecurityEvent`, `listSecurityEvents`, `resolveSecurityEvent` (interface ln 104-106 + impl ln 875-910).
- API writer: hapus file `apps/api-cf/src/lib/securityEvents.ts`; hapus import+call di `lib/rateLimit.ts:3,52-56` (blok 429) dan `src/index.ts:26,46-50` (blok cors blocked_origin). `routes/internal.ts:42` hapus `'security_events'` dari `ALLOWED_TABLES`.
- API reader: `routes/admin/dashboard.ts:80-98` hapus GET+PATCH `/security-events`.
- UI: `AdminDashboard.tsx` hapus `SecEvent` type (40-50), state `secEvents`/`secTotal` (334-335, 341), fetch (363, 372-373), `resolveEvent` (395-404), `severityColor` (465-470), StatCard "Security alerts" (502-515), section "Security feed" (655-689). `AdminSettings.tsx` hapus `SecEvent` type (44-54), state (801-802), fetch (831, 843-844), `SecurityCard` (734-772 + IconShield 230-236), bell badge (1127-1140 + secTotal), bento entry (1242), sebutan security-events di header comment (ln 10).
- Migrasi dijalankan ke 4 D1 via `scripts/migrate-all-4.sh` (perlu tambah `0019` ke skrip).

### D. Halaman baru `/admin/log` — fungsi log gabungan
- DB: `packages/db/index.ts` tambah reader `listAuditLog` (dari `lb_audit_log`) — writer `addAuditLog` sudah ada. Uji ada data (settings/account/origin/user update sudah menulis).
- API: endpoint baru `GET /api/admin/log?type=admin|scrape|all&page&limit` — gabung audit (lb_audit_log) + scrape (`listScrapeJobs` dari `scrape_jobs`, writer nyata) → seragam `{ts, type, actor?, message, meta}`, sort desc, paginasi + total.
- UI: `AdminLog.tsx` + `pages/admin/log.astro` — filter pill per tipe, baris timestamp mono, chip tipe, auto-refresh 30s, paginasi, empty state jujur.

### E. Halaman baru `/admin/saved` (ganti merge)
- DB: reader `getSavedContentSummary` + `listSavedSeries` + `listSavedChapters` dari `manga_source_link` + `chapters` + `series` + `chapter_pages` (count halaman tersimpan).
- API: `GET /api/admin/saved?page&limit` → `{data:{summary:{series_total, chapters_total, pages_stored, per_source:[{source, series, chapters, last_scraped_at}]}, series:[{slug,title,source,chapter_count,last_scraped_at}], chapters:[{series_title,chapter_id,chapter_number,pages_count,created_at}] , total, page}}`. Storage bytes B2 ambil dari endpoint `/dashboard/storage` yang sudah ada (KV `b2:usage`).
- UI: `AdminSaved.tsx` — KPI strip (Judul tersimpan, Chapter tersimpan, Panel tersimpan, bytes); grafik: bar per-source (series/chapters), donut storage per akun B2, tren `db_usage_snapshot`; tabel series terbaru + chapter terbaru. Primitif chart SVG yang ada di `AdminSettings`/`AdminDashboard` diextract jadi modul chart bareng (`admin/charts.tsx`).
- Hapus `pages/admin/merge.astro`; tambah `pages/admin/saved.astro`; nav "Konten" menunjuk ke sini.

### F. Monitoring — rapikan
- Panel mati tanpa writer dihapus: "Provider Accounts" (`provider_accounts`) + "Scrape Log" (`scrape_jobs_log` popular kosong). Ganti: source health (dari `source_health`), storage/db-usage trend (`db_usage_snapshot`), dan **scrape jobs live** dari `scrape_jobs` (writer nyata).
- `/api/admin/providers`, `/providers/:id/health`, `/api/admin/scrape-jobs`, `/api/admin/overview` — overview dipakai dashboard (provider counts). Keputusan: endpoint providers/scrape-jobs boleh tetap ada, UI page monitoring saja diubah. (Ditelaah saat task Monitoring; prioritaskan non-menyakiti.)

### G. Dashboard + Users + UserDetail — restyle
- Dashboard: buang seluruh security (bagian C), KPI ke-6 "Security alerts" → "Konten tersimpan" (total chapters tersimpan atau series tersimpan), pindah ke primitif Card baru.
- Users + UserDetail: pakai primitif Card baru, jaringan sama seperti halaman lain.

## Yang TIDAK disentuh
API merge, LB auto-provision, alur scrape, halaman publik, tabel `manga_merge_queue`, tabel `provider_accounts`/`scrape_jobs_log` (dibiarkan ada, tanpa UI), `lb_usage`/`lb_audit_log` skema.

## Batasan global (constraints — tiap task tunduk)
- Versi: Node ≥ 22.12 (web build), wrangler web = nested `apps/web/node_modules/.bin/wrangler` (v4) + node22 PATH; api-cf = wrangler root 3.114.
- Skill `manga` wajib dibaca sebelum edit kode project ini.
- `astro check`: hanya error yang ditolerir `PreferencesSection.tsx:121 ts(2345)`.
- Test: web `npm test` (bun canonical-url + round-robin) 2 file, wajib 22/22 sebelumnya; api-cf `npm run build` (tsc) wajib lulus; db `npm test`.
- api-cf tidak punya test runner — verifikasi via tsc + review + smoke manual bila ada.
- Bahasa UI admin: Indonesia (konsisten dengan halaman admin yang ada).
- Warna: hanya token oklch yang ada. `text-base` jangan dipakai untuk warna (quirk nullifier).
- Radii baru wajib konsisten (panel rounded-2xl, inner rounded-xl) — tidak ada radius seenaknya.
- Edit migrasi lama DILARANG. Migrasi baru `0019_drop_security_events.sql`.
- Git: commit per task, gaya `fix(area): deskripsi`, hanya stage file relevan. Branch `main`.

## Outline plan (per subsistem)
1. Plan A — Security removal (DB+API+UI) — mekanikal, independen, aman duluan.
2. Plan B — Admin design infra: helpers CSS + primitif Card/chart + shell sticky + topbar nav (Konten/Log).
3. Plan C — Halaman Konten Tersimpan + endpoint saved.
4. Plan D — Halaman Log + endpoint log.
5. Plan E — Restyle Dashboard, Settings, Monitoring, Users, UserDetail (migrasi ke primitif + buang security secara UI).

Urutan eksekusi: A kapan saja (independen); B sebelum C/D/E; C, D, E bebas setelah B.