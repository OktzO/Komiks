# Design Spec: Landing Page Modern & Aesthetic Polish (Oktz.)

**Date:** 2026-09-05  
**Topic:** Landing Page Polish for Oktz. Manga Reader  
**Status:** In Review  

---

## 1. Problem Statement & Goals

### Problem
Halaman utama (landing page) Oktz. saat ini fungsional dan ringan, tetapi tampilannya masih flat:
- Hero section hanya berupa teks terpusat dengan search bar standar.
- Bagian "Populer Hari Ini" hanya horizontal carousel biasa.
- Bagian "Update Terbaru" berupa 2-col list sederhana tanpa pembeda visual atau variasi tata letak modern.
- Tidak ada spotlight/featured banner manga, bento grid, indikator stats/social proof, atau client-side "Lanjut Baca" rail untuk user yang memiliki riwayat baca lokal/akun.

### Goals
1. **Modern & Aesthetic (Monokromatis)**: Mempertahankan tema monokromatis `oklch(8% 0 0)` murni (accent putih/near-white), namun meningkatkan hierarki visual dengan kedalaman (subtle glass, backdrop blur, radial ambient glow, layered cards).
2. **Zero Performance Overhead**:
   - Tanpa third-party JS runtime / berat (no heavy GSAP/framer-motion).
   - Mempertahankan ISR 5-menit (`revalidate = 300`) + Next.js App Router streaming SSR (`<Suspense>`).
   - Pure CSS hardware-accelerated animations (`transform`, `opacity`, `filter`).
   - `content-visibility: auto` dipertahankan untuk rendering viewport efisien.
3. **Komprehensif & Kaya Fitur**:
   - **Featured Manga Spotlight**: Hero bento/banner interaktif dengan backdrop cover blur dinamis.
   - **"Lanjut Baca" (Continue Reading) Section**: Client component ringan yang membaca `history` dari localStorage / user session tanpa memblokir SSR.
   - **Stats / Feature Highlights Bar**: Social proof ("5 Sumber Independen", "100% Bebas Iklan", "Pembaruan Real-Time").
   - **Bento Grid Discovery**: Tata letak asimetris (1 card besar featured + 4 card medium berjenjang) untuk tren mingguan/populer.
   - **Genre Pill Badges**: Tag genre pill dengan micro-interaction hover dan visual indicator.
   - **Micro-Interactions**: Hover elevation, subtle cover scale `scale-[1.02]`, border glow halus saat fokus/hover.

---

## 2. Architecture & Components

```
apps/web/
  app/
    page.tsx                — Server component orchestrator (ISR 300s, streaming HomeFeed)
    globals.css             — CSS tokens, glass gradients, ambient radial glow, keyframes
  components/
    HeroSpotlight.tsx       — Hero dengan search bar + featured manga spotlight & stats bar
    ContinueReadingRail.tsx — Client component: baca recent history dari localStorage/API
    BentoGrid.tsx           — Asymmetric grid layout (1 large + 4 small manga cards)
    MangaCard.tsx           — Enhanced with refined hover elevation, badge spacing
    GenrePills.tsx          — Genre scroll rail with micro-interactions
```

### Component Details

1. **`HeroSpotlight` (`components/HeroSpotlight.tsx`)**:
   - Hero headline modern & impactful dengan ambient radial gradient di background.
   - Search bar terintegrasi dengan shortcut indicator (`Ctrl + K` / `⌘K` visual cue) dan search button modern.
   - Stats ticker kecil di bawah search bar: 5 Sumber Terhubung • Ribuan Judul • Fast CDN Caching.

2. **`ContinueReadingRail` (`components/ContinueReadingRail.tsx`)**:
   - Client Component (`'use client'`).
   - Membaca `manga_history` dari `localStorage` saat mounted.
   - Jika ada riwayat: menampilkan row "Lanjut Baca" dengan progress chapter terakhir yang dibaca dan tombol one-click resume.
   - Jika kosong: `null` (tanpa layout shift).

3. **`BentoGrid` (`components/BentoGrid.tsx`)**:
   - Menampilkan 5 manga terpilih dalam format Bento:
     - 1 Card Utama (Kiri/Besar): Cover dominan, sinopsis singkat, badge tipe, rating/popularitas, tombol "Baca Sekarang".
     - 4 Card Sekunder (Kanan/2x2 Grid): Kompak dengan cover, judul, dan update chapter terakhir.

4. **`HomeFeed` in `apps/web/app/page.tsx`**:
   - Tetap Server Component async yang memanggil `fetchHomepage()`.
   - Mengirim data ke:
     - `BentoGrid` (menggunakan 5 manga terpopuler).
     - `Populer Carousel` (horizontal scroll untuk manga populer lainnya).
     - `Update Terbaru` (grid 2 kolom yang dipercantik dengan timestamp relatif dan badge sumber).

---

## 3. Visual & CSS Design Tokens (`globals.css`)

- **Color Palette**: Tetap murni monokrom OKLCH
  - `--bg-base`: `oklch(8% 0 0)`
  - `--bg-surface`: `oklch(12% 0 0)`
  - `--bg-elevated`: `oklch(15% 0 0)`
  - `--border-subtle`: `oklch(100% 0 0 / 0.08)`
  - `--border-default`: `oklch(100% 0 0 / 0.14)`
  - `--border-focus`: `oklch(100% 0 0 / 0.3)`
  - `--accent`: `oklch(98% 0 0)`
- **Ambient Effects**:
  - Soft radial glow mesh untuk hero backdrop: `radial-gradient(ellipse at 50% -20%, oklch(98% 0 0 / 0.08), transparent 70%)`
  - Subtle card border gradient on hover: `linear-gradient(135deg, oklch(100% 0 0 / 0.2), oklch(100% 0 0 / 0.04))`
  - Micro-scale transform on cards: `transform: scale(1.025)` GPU-accelerated.

---

## 4. Performance & Compatibility Guards

1. **Next.js & OpenNext**:
   - Tidak ada heavy third-party library.
   - Menggunakan native `<img>` sesuai konvensi project (`next.config.mjs` has `images: { unoptimized: true }`).
   - Image proxy B2-first & CDN caching tetap berjalan tanpa intervensi.
2. **SSR & Streaming**:
   - Skeleton loading (`HomeSkeleton`) diperbarui agar selaras dengan Bento + Hero spotlight.
3. **Accessibility**:
   - Kontras teks primary `>= 4.5:1` (`oklch(98% 0 0)` di atas `oklch(8% 0 0)` = ~16:1).
   - Aria-labels pada carousel buttons, search inputs, dan image links.
   - Touch targets `>= 44px`.

---

## 5. Testing & Verification

1. `npm run pages:build` / `npm run build:bundle` / TypeScript check `npx tsc --noEmit` di `apps/web`.
2. Responsive layout verification (Mobile 375px, Tablet 768px, Desktop 1280px).
3. Verifikasi riwayat "Lanjut Baca" muncul saat ada data di localStorage.
