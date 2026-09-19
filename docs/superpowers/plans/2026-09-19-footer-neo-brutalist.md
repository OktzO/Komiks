# Footer Neo-Brutalist (Dark) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ganti footer situs Oktz. dengan footer neo-brutalist yang diadaptasi ke tema gelap (referensi: footer `https://api.onigi.biz.id/`), dipasang global di semua halaman non-bare, dan hapus link "Syarat" dari menu hamburger sehingga ToS hanya muncul di footer.

**Architecture:** Komponen server-statistik baru `Footer.astro` (zero-JS, Astro scoped `<style>` untuk hard-shadow brutalist) dipasang sekali di `BaseLayout.astro` untuk semua halaman non-bare. Footer lama di `index.astro` dihapus. Link `/tos` dihapus dari array `LINKS` di `Navbar.tsx` (menu hamburger/desktop). Halaman admin (pakai `AdminLayout`, bukan BaseLayout) dan reader bare tidak ikut kena footer.

**Tech Stack:** Astro (server component), Tailwind CSS v4 (utilitas token dari `apps/web/tailwind.config.ts`), TypeScript, Cloudflare Workers deploy.

**Spec:** Keputusan brainstorming (disetujui user):
1. **Dark-adaptive** — bukan copy putih persis referensi. Band footer pakai `bg-elevated`, top border tebal `border-strong`, hard-shadow pakai aksen orange (`color-mix(in oklab, var(--accent) 45%, transparent)`).
2. **Global di semua halaman** via `BaseLayout` (semua halaman non-bare; reader `bare` dan admin TIDAK).
3. **Tanpa floating quick menu**.
4. **Link "Syarat"/ToS dihapus dari hamburger** (`Navbar.tsx:9`), ToS hanya tersedia di kolom footer "Sumber & Legal".

## Global Constraints

- JANGAN gunakan utilitas `text-base` (dll `sm:text-base`/`md:text-base`/`lg:text-base`/`xl:text-base`) untuk warna — ini tabrakan dengan token `base` (`bg-base`) dan menghasilkan teks hitam tak terlihat (bug yang baru diperbaiki via `.text-base{color:inherit!important}` di `global.css`). Semua teks wajib pakai token eksplisit: `text-primary`, `text-secondary`, `text-muted`.
- Utilitas warna yang boleh dipakai di footer: `bg-elevated`, `border-border-strong`, `text-primary`, `text-secondary`, `text-muted`, `bg-accent`, `bg-accent-soft`, `text-accent-ink`, `bg-emerald-400`, `text-emerald-*`. Semua sudah ada di `tailwind.config.ts` (tidak perlu edit config).
- Hard-shadow brutalist didefinisikan di `<style>` scoped Footer.astro (bukan config): `box-shadow: 4px 4px 0 color-mix(in oklab, var(--accent) 45%, transparent)`.
- Font mono uppercase untuk header kolom (pola navigasi brutalist): `font-mono text-[11px] font-black uppercase tracking-[0.2em]`.
- Source links memakai `SOURCE_LABELS`/`sourceLabel` & `SourceBadge` dari `@/components/SourceBadge` (sudah ada).
- `npx astro check` wajib lulus (satu error pra-eksisting `PreferencesSection.tsx:121 ts(2345)` terima/tolerir — bukan dari footer).
- Build: `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build` (dari `apps/web`).
- Deploy: `set -a; source /home/user/indohome-mmk/Manga/.env; set +a; PATH="..." CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN1" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID_AKUN1" npx wrangler deploy --config /home/user/indohome-mmk/Manga/apps/web/dist/server/wrangler.json`.
- Konten footer di `index.astro` lama (baris 172–217) adalah sumber copy legal: "© 2026 Oktz. Hak cipta gambar & komik milik masing-masing kreator/penerbit." dan "Ditenagai Cloudflare Pages & Astro" → ganti "Cloudflare Pages" jadi "Cloudflare Workers".

---

### Task 1: Buat komponen `Footer.astro`

**Files:**
- Create: `apps/web/src/components/Footer.astro`

**Interfaces:**
- Consumes: `SourceBadge`, `sourceLabel`, `SOURCE_ORDER` (export dari `@/components/SourceBadge` — sudah tersedia).
- Produces: Komponen `<Footer />` tanpa props yang merender `<footer id="site-footer">`; dipakai oleh BaseLayout (Task 2) dan tidak diberi props apapun.

- [ ] **Step 1: Tulis komponen** (file baru `apps/web/src/components/Footer.astro`)

```astro
---
import { SourceBadge, sourceLabel, SOURCE_ORDER } from '@/components/SourceBadge';
---

<footer id="site-footer" class="mt-24 border-t-2 border-border-strong bg-elevated">
  <div class="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
    <div class="grid gap-10 lg:grid-cols-4">
      <!-- Brand + status -->
      <div class="lg:pr-4">
        <div class="flex items-center gap-3">
          <a
            href="/"
            aria-label="Oktz. — beranda"
            class="brutal-grid h-11 w-11 place-items-center border-2 border-border-strong bg-accent font-display text-xs font-black tracking-tight text-accent-ink"
          >
            OKTZ
          </a>
          <div>
            <p class="font-mono text-[10px] font-black uppercase tracking-[0.2em] text-primary">
              Oktz. Ecosystem
            </p>
            <p class="text-xs text-muted">Baca komik, tanpa ribet.</p>
          </div>
        </div>
        <p class="mt-4 max-w-sm text-xs leading-relaxed text-secondary">
          Platform baca komik (manga, manhwa, manhua) bahasa Indonesia modern, cepat, dan
          terorganisir dari 5 agregator independen.
        </p>
        <a
          href="/status"
          class="brutal-badge mt-5 inline-flex items-center gap-2 rounded-md border-2 border-border-strong bg-accent-soft px-3 py-1.5 font-mono text-[10px] font-black uppercase tracking-wider text-primary transition-colors hover:bg-accent hover:text-accent-ink"
        >
          <span class="relative flex h-2 w-2" aria-hidden="true">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
          </span>
          5 Sumber Terhubung
        </a>
      </div>

      <!-- Sumber Terhubung -->
      <nav aria-label="Sumber terhubung">
        <h2 class="border-b-2 border-border-strong pb-2 font-mono text-[11px] font-black uppercase tracking-[0.2em] text-primary">
          Sumber Terhubung
        </h2>
        <ul class="mt-4 space-y-1.5 text-xs">
          {SOURCE_ORDER.map((s) => (
            <li>
              <a
                href="/status"
                class="flex items-center gap-2 text-secondary transition-colors hover:text-primary"
              >
                <SourceBadge sources={[s]} size="sm" />
                <span>{sourceLabel(s)}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <!-- Navigasi -->
      <nav aria-label="Navigasi utama">
        <h2 class="border-b-2 border-border-strong pb-2 font-mono text-[11px] font-black uppercase tracking-[0.2em] text-primary">
          Navigasi
        </h2>
        <ul class="mt-4 space-y-1.5 text-xs">
          <li>
            <a href="/search" class="text-secondary transition-colors hover:text-primary">Eksplorasi Judul</a>
          </li>
          <li>
            <a href="/bookmark" class="text-secondary transition-colors hover:text-primary">Daftar Bookmark</a>
          </li>
          <li>
            <a href="/history" class="text-secondary transition-colors hover:text-primary">Riwayat Membaca</a>
          </li>
          <li>
            <a href="/status" class="text-secondary transition-colors hover:text-primary">Status & Kesehatan Sumber</a>
          </li>
        </ul>
      </nav>

      <!-- Sumber & Legal -->
      <nav aria-label="Sumber dan legal">
        <h2 class="border-b-2 border-border-strong pb-2 font-mono text-[11px] font-black uppercase tracking-[0.2em] text-primary">
          Sumber &amp; Legal
        </h2>
        <ul class="mt-4 space-y-1.5 text-xs">
          <li>
            <a href="/tos" class="text-secondary transition-colors hover:text-primary">Syarat &amp; Ketentuan</a>
          </li>
          <li>
            <a href="/status" class="text-secondary transition-colors hover:text-primary">Sumber &amp; Status</a>
          </li>
          <li>
            <a href="/bookmark" class="text-secondary transition-colors hover:text-primary">Daftar Bookmark</a>
          </li>
          <li>
            <a href="/history" class="text-secondary transition-colors hover:text-primary">Riwayat Membaca</a>
          </li>
        </ul>
      </nav>
    </div>

    <div class="mt-12 flex flex-col items-center justify-between gap-3 border-t border-border-strong/60 pt-6 sm:flex-row">
      <p class="text-[11px] text-muted">
        © 2026 Oktz. Hak cipta gambar &amp; komik milik masing-masing kreator/penerbit.
      </p>
      <div class="flex items-center gap-5">
        <p class="font-mono text-[11px] text-muted">
          Ditenagai Cloudflare Workers &amp; Astro
        </p>
        <a href="#top" class="font-mono text-primary transition-colors hover:underline">
          Kembali ke Atas &uarr;
        </a>
      </div>
    </div>
  </div>
</footer>

<style>
  .brutal-grid {
    box-shadow: 4px 4px 0 color-mix(in oklab, var(--accent) 45%, transparent);
  }
  .brutal-badge {
    box-shadow: 2px 2px 0 color-mix(in oklab, var(--accent) 45%, transparent);
  }
</style>
```

- [ ] **Step 2: Verifikasi compile komponen**

Run: `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npx astro check`
Expected: hanya error pra-eksisting `PreferencesSection.tsx:121` yang muncul (tolerir); TIDAK ada error baru dari Footer.astro.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/Footer.astro
git commit -m "feat(web): add neo-brutalist dark footer component"
```

---

### Task 2: Pasang footer global & hapus footer lama di homepage

**Files:**
- Modify: `apps/web/src/layouts/BaseLayout.astro` (import + render `<Footer />`)
- Modify: `apps/web/src/pages/index.astro` (hapus blok footer baris 172–217; rapikan import)

**Interfaces:**
- Consumes: `<Footer />` dari Task 1 (no props).
- Produces: Semua halaman via BaseLayout (non-bare) merender footer di akhir `<body>`.

- [ ] **Step 1: Hapus footer lama di `index.astro`**

Hapus seluruh blok dari `{/* Modern Aesthetic Footer */}` (baris 172) sampai `</footer>` (baris 217) inclusive, termasuk komentar. Simpan `</main>` + `</BaseLayout>`.

- [ ] **Step 2: Rapikan import `index.astro`**

`sourceLabel` dan `SOURCE_ORDER` hanya dipakai di footer lama → hapus dari import SourceBadge:
```astro
import { SourceBadge } from '@/components/SourceBadge';
```
(`SourceBadge` masih dipakai di kartu line 164; `TypeBadge`, `HeroSpotlight`, dll tidak berubah.)

- [ ] **Step 3: Render `<Footer />` di `BaseLayout.astro`**

Import komponen setelah import Navbar, dan render untuk halaman non-bare:
```astro
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
```
```html
  <body class="min-h-screen bg-base text-primary antialiased">
    {!bare && <Navbar client:idle />}
    {!bare && <div class="pt-24"><slot /></div>}
    {bare && <slot />}
    {!bare && <Footer />}
  </body>
```

- [ ] **Step 4: Verifikasi build**

Run: `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build` (dari `apps/web`)
Expected: build sukses; cek file `dist/server/index.html` (atau output build) mengandung `id="site-footer"` dan tidak lagi mengandung `cv-footer`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/layouts/BaseLayout.astro apps/web/src/pages/index.astro
git commit -m "feat(web): mount global footer, remove homepage inline footer"
```

---

### Task 3: Hapus link Syarat dari menu hamburger/dock

**Files:**
- Modify: `apps/web/src/components/Navbar.tsx:4-10`

**Interfaces:**
- Consumes: tidak ada (murni hapus item).
- Produces: `LINKS` array tanpa `/tos`; ToS hanya muncul di footer.

- [ ] **Step 1: Hapus item Syarat dari `LINKS`**

```ts
const LINKS = [
  { href: '/search', label: 'Cari' },
  { href: '/bookmark', label: 'Bookmark' },
  { href: '/history', label: 'Riwayat' },
  { href: '/status', label: 'Status' },
] as const;
```

- [ ] **Step 2: Verifikasi tidak ada ref `/tos` lain di Navbar**

Run: `grep -rn "tos" apps/web/src/components/Navbar.tsx`
Expected: tidak ada match (render menu memakai `LINKS.map`, tidak hardcode `/tos`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/Navbar.tsx
git commit -m "chore(web): drop Syarat link from navbar, keep ToS in footer only"
```

---

### Task 4: Verifikasi end-to-end + deploy

**Files:**
- None (verifikasi & deploy saja).

**Interfaces:**
- Consumes: hasil Task 1–3.

- [ ] **Step 1: Astro check + build**

Run (dari `apps/web`):
```bash
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npx astro check
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build
```
Expected: check hanya error pra-eksisting; build sukses.

- [ ] **Step 2: Deploy ke Workers**

```bash
set -a; source /home/user/indohome-mmk/Manga/.env; set +a
PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN1" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID_AKUN1" npx wrangler deploy --config /home/user/indohome-mmk/Manga/apps/web/dist/server/wrangler.json
```
Expected: `Current Version ID: <hex>` + URL worker.

- [ ] **Step 3: Verifikasi browser**

Via Playwright di `https://oktzz.xyz`:
1. Homepage: `#site-footer` ada; warna teks kolom ≠ `oklch(0.1 0.008 262)` (terlihat); header kolom mono uppercase; badge status ada; `cv-footer` TIDAK ada.
2. `/tos`: global footer tampil di bawah footer konten ToS; teks terlihat.
3. `/search`, satu halaman detail `/{type}/{slug}`: `#site-footer` ada.
4. Navigasi hamburger (viewport mobile ≤ 640px): menu TIDAK lagi memuat "Syarat".
5. Halaman admin `/admin` (pakai session/login): footer TIDAK muncul.
6. Link "Kembali ke Atas" (`#top`) ada; scroll-behavior smooth (`scroll-margin-top` sudah di global.css).

- [ ] **Step 4: Komit build artifacts bila repo menggit file dist** (per konvensi repo; jika `dist/` di-ignore, skip)

Run: `git status --short`
Expected: hanya source yang berubah (Footer.astro, BaseLayout.astro, index.astro, Navbar.tsx). Jika ada file lain ikut berubah tanpa sengaja, jangan commit — lapor di summary.

- [ ] **Step 5: Lapor hasil**

Summary berisi: version ID deploy, verifikasi tiap poin Step 3 (pass/fail), dan catatan bahwa footer tidak muncul di reader/admin (ruling teknis).