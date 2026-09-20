# Admin Redesign v2 — Plan B: Design Infra (CSS helpers + primitif + shell sticky + nav)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bangun fondasi bahasa desain admin baru: helpers CSS, shell sticky tak-nimpa, primitif kartu/chart bersama, dan nav dengan entri Konten + Log (Merge Queue dihapus).

**Architecture:** Helpless CSS di `global.css` (`.admin-page`, `.admin-panel`, `.admin-inner`) menggantikan `.admin-card` lama; `AdminLayout.astro` ganti wrapper `pt-24` → `<main class="admin-page">` (topbar masuk flow, `sticky`); `AdminTopbar.tsx` jadi sticky + nav baru. Primitif kartu/chart (Card, CardHead, StatCard, EmptyState, AreaChart, StorageDonut + fmtNum/fmtBytes) diextract dari `AdminSettings.tsx` ke modul bersama `apps/web/src/components/admin/charts.tsx`; `AdminSettings` langsung dikonsumsi ulang dari modul. Plan C/D (halaman Log + Konten) dan Plan E (restyle halaman lain) memakai modul ini.

**Tech Stack:** Astro, React islands (client:only), Tailwind, tokem oklch yang ada.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-redesign-design.md` (bagian A, B, G; plan berargumentasi dari spec ini).

## Global Constraints

- Node 22.12+ wajib: prefix semua perintah `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH"`.
- `npm run lint --prefix apps/web` (astro check): SATU-SATUNYA error yang ditolerir `apps/web/src/components/reader/PreferencesSection.tsx:121 ts(2345)`. Error baru = gagal.
- `npm test --prefix apps/web` (bun: canonical-url + round-robin) wajib PASS.
- Warna HANYA token oklch yang sudah ada — TIDAK ada warna baru, TIDAK ada hex.
- Radii konsisten: panel `rounded-2xl`, inner `rounded-xl`. Jangan radius seenaknya.
- Bahasa UI admin: Indonesia.
- Jangan pakai `.text-base` sebagai warna (ada kasus quirk nullifier).
- Skill `manga` wajib dibaca implementer sebelum edit kode project ini.
- Git: commit per task, gaya `fix(area): deskripsi`, hanya stage file relevan, branch `main`.
- Jangan edit file di luar task (mis. jangan sentuh AdminMonitoring/AdminDashboard di Plan B — itu punya Plan E; AdminMerge masih ada sampai Plan C).
- Jendela sementara (sengaja): halaman yang masih memakai class `.admin-card` (AdminDashboard, AdminMonitoring, AdminMerge) akan tampil polos/tanpa kartu setelah Task B1 sampai direstyle di Plan E (AdminMerge malah dihapus di Plan C). Ini keputusan spec (`.admin-card` dibuang di Plan A/E). Tercatat, bukan regresi.

---
---

### Task B1: CSS helpers + shell sticky (topbar masuk flow)

**Files:**
- Modify: `apps/web/src/styles/global.css:590-613` (hapus 3 token + `.admin-card`, tambah block helpers)
- Modify: `apps/web/src/layouts/AdminLayout.astro:34-36` (wrapper `pt-24` → `.admin-page`)
- Modify: `apps/web/src/styles/global.css:807-831` (`#admin-navbar` fixed → sticky)

**Interfaces:**
- Produces: class CSS baru `.admin-page`, `.admin-panel`, `.admin-inner` — dipakai Plan C/D/E dan `AdminLayout`. Class `.admin-card` HILANG (Plan E menggantinya).

- [ ] **Step 1: Hapus `.admin-card` + token mati di global.css**

Di `apps/web/src/styles/global.css`, hapus BARIS `592-595` dan `609-613` keseluruhan. Isi yang dihapus (jangan ada sisa):

```css
  --radius-admin: 6px;
  --radius-admin-sm: 4px;
  --font-mono: var(--font-geist-mono), ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  --bg-admin-panel: oklch(14% 0 0);
```

dan blok:

```css
.admin-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-admin);
  background: var(--bg-admin-panel);
}
```

PERTAHANKAN baris `--radius-panel: 16px` (di `:root` atas, baris ±83) dan `.font-mono { font-family: var(--font-mono); }` + `.tabular` (baris 598-599) — keduanya masih dipakai. Hapus HANYA 3 token, bukan `--font-mono` (dipakai `.font-mono`).

- [ ] **Step 2: Tambah block helpers admin (di lokasi bekas `.admin-card` comment) di global.css**

Tambahkan setelah comment `/* ── Admin dashboard tokens (0006 monitoring) ── */` block berjalan (setelah `.num-refresh.refreshing`), tepat di tempat `.admin-card` tadi:

```css
/* ══ Admin shell + panel primitives (Plan B) ═══════════════════════════ */

/* Lebar konten admin konsisten: max-w-7xl (80rem), tengah. */
.admin-page {
  width: 100%;
  max-width: 80rem;
  margin-inline: auto;
}

/* Panel kartu admin: border kuat ±1.5px, radius 16px. */
.admin-panel {
  background: var(--bg-card);
  border: 1.5px solid var(--border-strong);
  border-radius: 1rem;
}

/* Warna daerah dalam panel yang terpisah (inner card) — radius 12px. */
.admin-inner {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 0.75rem;
}
```

- [ ] **Step 3: `#admin-navbar` fixed → sticky**

Di `apps/web/src/styles/global.css`, blok `#admin-navbar { ... }` (mulai ±baris 808/812) saat ini:

```css
#admin-navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  padding-top: 0;
  contain: layout style;
  transition: padding-top 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
```

Ganti struktur ini jadi:

```css
#admin-navbar {
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  contain: layout style;
}
```

`#admin-navbar .nav-island` (821-831) DIAM (lebar `--nav-width-rest` = full, radius 0 — island admin sudah full-width, jadi sticky aman, tak ada sisi tembus). `@media (prefers-reduced-motion: reduce)` block (880-882) tetap (referensi `#admin-navbar .nav-island` masih valid).

- [ ] **Step 4: AdminLayout.astro — wrapper `.admin-page`, hapus `pt-24`**

Di `apps/web/src/layouts/AdminLayout.astro`, ganti **baris 34-36** persis:

```astro
    <div class="pt-24 p-4 md:p-8">
      <slot />
    </div>
```

menjadi:

```astro
    <main class="admin-page px-4 md:px-6 py-8">
      <slot />
    </main>
```

JANGAN sentuh baris lain (comment `client:only` pada baris 28-30, head, dsb).

- [ ] **Step 5: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
```

Expected: SATU error (PreferencesSection:121). Tidak ada error lain (AdminTopbar.astro/AdminLayout.astro/global.css tak terdorong bermasalah).

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
```

Expected: PASS (6 tests, canonical-url + round-robin).

Grep: `grep -rn "admin-card\|radius-admin\|bg-admin-panel" apps/web/src/styles/global.css && echo FAIL` — harus TANPA output (exit ≠ 0). (Catalan: match luar `global.css` di AdminDashboard.tsx/AdminMonitoring.tsx/AdminMerge.tsx diizinkan — plan E.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/global.css apps/web/src/layouts/AdminLayout.astro
git commit -m "fix(web): sticky admin shell + admin css helpers (.admin-page/.admin-panel)"
```

### Task B2: Topbar nav — Konten + Log, hapus Merge Queue

**Files:**
- Modify: `apps/web/src/components/pages/AdminTopbar.tsx:4-10` (NAV array), `:50` (header fixed→sticky)

**Interfaces:**
- Produces: nav hrefs `/admin/saved` (Konten) dan `/admin/log` (Log) — halaman dibuat di Plan C/D; JENDELA SEMENYARA link balik 404 sampai Plan C/D rilis. Diketahui-sengaja (spec: nav ikut Plan B, halaman ikut C/D).

- [ ] **Step 1: Ganti NAV array**

Di `apps/web/src/components/pages/AdminTopbar.tsx`, baris 4-10:

```tsx
const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/monitoring', label: 'Monitoring' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/merge', label: 'Merge Queue' },
  { href: '/admin/settings', label: 'Settings' },
] as const;
```

ganti jadi:

```tsx
const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/monitoring', label: 'Monitoring' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/saved', label: 'Konten' },
  { href: '/admin/log', label: 'Log' },
  { href: '/admin/settings', label: 'Settings' },
] as const;
```

- [ ] **Step 2: Header fixed → sticky**

Baris 50:

```tsx
    <header id="admin-navbar" className="fixed inset-x-0 top-0 z-50">
```

jadi:

```tsx
    <header id="admin-navbar" className="sticky top-0 z-50">
```

Jangkar: sekarang sticky via CSS `#admin-navbar` dan class — sama-sama sticky, konsisten.

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
```

Expected: SATU error (PreferencesSection:121) saja.

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
```

Expected: PASS.

Grep: `grep -rn "merge\|Merge" apps/web/src/components/pages/AdminTopbar.tsx && echo FAIL` — TANPA output.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/pages/AdminTopbar.tsx
git commit -m "feat(web): admin nav Konten/Log, hapus Merge Queue, topbar sticky"
```

### Task B3: Modul primitif bersama `admin/charts.tsx` + migrasikan AdminSettings

**Files:**
- Create: `apps/web/src/components/admin/charts.tsx`
- Modify: `apps/web/src/components/pages/AdminSettings.tsx` (hapus definisi lokal, import dari modul)

**Interfaces:**
- Produces (pisahkan eksak dari AdminSettings.current): `Card({children, className?, delay?})`, `CardHead({icon?, title, hint?, action?})`, `StatCard({icon, label, value, sub, tone?, delay?})`, `EmptyState({children})`, `fmtNum(n)`, `fmtBytes(b)`, `AreaChart({points: number[], labels: string[], height?})`, `StorageDonut({accounts, totalBytes, quota, d1Bytes, icon?})`, `type StorageAccount = { idx: number; name: string; bucket: string; bytes: number; quota: number }`.
- Consumes: Plan C (halaman Konten), Plan D (halaman Log), Plan E (restyle). `StorageDonut.icon` opsional — caller kirim ikon sendiri (Plan C pakai ikonnya; AdminSettings kirim `<IconDatabase className="w-4 h-4" />`).

- [ ] **Step 1: Buat `apps/web/src/components/admin/charts.tsx`**

File baru. Skema:
- Header comment Indonesia: `/* ══ Primitif admin bersama (Plan B) — Card/StatCard/chart. ═══════ */`.
- Import: `import { useState, useId, useMemo } from 'react';`
- Type export:

```tsx
export type StorageAccount = { idx: number; name: string; bucket: string; bytes: number; quota: number };
```

- Helper internal — salin PERSIS dari `AdminSettings.tsx` (eksak saat ini):

```tsx
export const fmtNum = (n: number): string => n.toLocaleString('id-ID');

export const fmtBytes = (b: number | null): string => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
```

(`fmtRel`/`fmtDayLabel` TIDAK dipindah ke modul — masih lokal AdminSettings, dipakai SourceHealthCard/OriginsCard. Modul cukup fmtNum + fmtBytes.)

- `Card` — versi SPEC (border kuat 1.5px, bukan subtlegaya lama):

```tsx
export function Card({
  children,
  className = '',
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={`relative rounded-2xl border-[1.5px] border-strong bg-card p-5 anim-slide-up ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </section>
  );
}
```

- `CardHead` — salin persis `AdminSettings.tsx:232-259` (icon `w-8 h-8 rounded-lg bg-bg-secondary/70 text-secondary`, title `text-[13px] font-medium text-primary truncate`, hint `text-[11px] text-muted`, action). Export.

- `StatCard` — salin persis `AdminSettings.tsx:269-298` (icon `w-7 h-7`, label `text-[11px] text-muted`, value `text-2xl font-semibold tabular tracking-tight`, sub `text-[11px] text-muted`; `tone: 'default'|'success'|'error'`). Export.

- `EmptyState` — salin persis `AdminSettings.tsx:261-267`. Export.

- `AreaChart({ points, labels, height = 190 })` — salin persis `AdminSettings.tsx:306-434`. Catatan preservasi: pakai `fmtNum` lokal modul; `useId` + `useState` dari import modul (`hover` state, `uid`), `w=640`, `padX=10`, `padY=18`, grid 0/0.25/0.5/0.75/1, gradient `fill-${uid}`, hover rect + tooltip, label bawah `[0]`/`[last]`. Teks empty-state "Belum cukup data. Grafik muncul setelah origin melayani permintaan minimal 2 hari." tetap. Export.

- `StorageDonut({ accounts, totalBytes, quota, d1Bytes, icon })` — salin persis `AdminSettings.tsx:441-559`, dengan SATU perubahan:
  - props: `{ accounts: StorageAccount[]; totalBytes: number; quota: number; d1Bytes: number | null; icon?: React.ReactNode }`
  - baris CardHead (476): `<CardHead icon={icon} title="Penyimpanan" hint="B2 object storage · kuota terkonfigurasi" />`
  - sisanya identik (palette `['var(--accent)','var(--text-secondary)','var(--text-muted)','var(--success)']`, R=40, C=2πR, pct/terpakai, segmen legend, empty "Belum ada objek tercatat di KV…"). Pakai `fmtBytes` modul.
  - Export.

- [ ] **Step 2: Migrasikan `AdminSettings.tsx` — import dari modul**

- Tambah import kiri atas (setelah import React):

```tsx
import {
  Card,
  CardHead,
  StatCard,
  EmptyState,
  AreaChart,
  StorageDonut,
  fmtNum,
  fmtBytes,
} from '@/components/admin/charts';
```

- Hapus definsi lokal di `AdminSettings.tsx`: `fmtNum` (baris 95), `fmtBytes` (baris 97-103), comment block "Shared UI primitives" (209-211, termasuk `/* ═══ */` pembatasnya), `Card` (213-230), `CardHead` (232-259), `EmptyState` (261-267), `StatCard` (269-298), comment block "Area chart — total requests per day…" (300-304), `AreaChart` (306-434), comment block "Storage donut — …" (436-439), `StorageDonut` (441-559). Hapus detil blok, sisakan satu blank line antar fiksi yang tersisa.

- Update import React (baris 2): `import { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react';` → hapus `useId` (kini tak terpakai): `import { useState, useEffect, useRef, useCallback, useMemo } from 'react';`

- Callsite `<StorageDonut` (baris 1134, props `accounts/…`): tambah prop `icon={<IconDatabase className="w-4 h-4" />}` sehingga:

```tsx
        <StorageDonut
          accounts={storage.accounts}
          totalBytes={storage.total_bytes}
          quota={storage.quota}
          d1Bytes={storage.d1_bytes}
          icon={<IconDatabase className="w-4 h-4" />}
        />
```

(idem jika prop berbeda dari contoh di atas — kecocokan struktural, nama data state diikuti apa adanya).

- Cek residual (bukan compile error, tapi hygiene):
  - `grep -n "useId" apps/web/src/components/pages/AdminSettings.tsx && echo FAIL` → tanpa output.
  - `grep -n "import \\{ useState" apps/web/src/components/pages/AdminSettings.tsx` → tanpa `useId`.

- [ ] **Step 3: Verifikasi**

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
```

Expected: SATU error (PreferencesSection:121) hanya. Error apa pun di `admin/charts.tsx` atau AdminSettings.tsx (unused, type) = gagal.

```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
```

Expected: PASS.

Grep hygiene:
- `grep -n "function Card\\|function CardHead\\|function StatCard\\|function EmptyState\\|function AreaChart\\|function StorageDonut\\|const fmtNum\\|const fmtBytes" apps/web/src/components/pages/AdminSettings.tsx && echo FAIL` → tanpa output.
- `grep -n "export function Card\\|export function AreaChart\\|export function StorageDonut\\|export const fmtBytes" apps/web/src/components/admin/charts.tsx` → keempat ada.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/admin/charts.tsx apps/web/src/components/pages/AdminSettings.tsx
git commit -m "refactor(web): extract shared admin chart primitives to admin/charts.tsx"
```