# Landing Page Modern & Aesthetic Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Oktz. manga reader landing page into a modern, aesthetic, theater-like dark-mode UI with a Featured Bento Grid, Hero spotlight, interactive Lanjut Baca rail, and micro-interactions with zero performance penalty.

**Architecture:** Next.js App Router (RSC + Suspense streaming), Tailwind CSS with OKLCH tokens, pure CSS hardware-accelerated animations, zero runtime JS libraries.

**Tech Stack:** Next.js 15+ (App Router, OpenNext), React 19, Tailwind CSS v3, OKLCH color space.

## Global Constraints
- Monochrome dark theme: Base `oklch(8% 0 0)`, cards `oklch(12% 0 0)`, text `oklch(98% 0 0)`.
- No new external runtime npm packages (keep it pure CSS + lightweight native React).
- Image handling must use `<img>` with `CoverImage` wrapper adhering to project proxy specs.
- ISR 300s & streaming Suspense must remain active and unbroken.

---

### Task 1: CSS Design Tokens & Ambient Effects in globals.css

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Update `globals.css` with ambient radial glows, bento gradient cards, and smooth micro-hover keyframes**
- [ ] **Step 2: Verify styles compile without error**

---

### Task 2: Implement `ContinueReadingRail` Client Component

**Files:**
- Create: `apps/web/components/ContinueReadingRail.tsx`

- [ ] **Step 1: Build client component reading local reading history from localStorage**
- [ ] **Step 2: Provide clean empty-state fallback (renders nothing if no history)**

---

### Task 3: Implement `BentoGrid` Component for Trending/Featured Manga

**Files:**
- Create: `apps/web/components/BentoGrid.tsx`

- [ ] **Step 1: Build BentoGrid layout with 1 dominant featured card + 4 compact secondary cards**
- [ ] **Step 2: Wire up SourceBadge, TypeBadge, and CoverImage integration**

---

### Task 4: Upgrade `HeroSpotlight` with Social Proof & Ambient Backdrop

**Files:**
- Create: `apps/web/components/HeroSpotlight.tsx`

- [ ] **Step 1: Implement modern Hero headline, search bar with keyboard shortcut hint, and stats feature bar**

---

### Task 5: Upgrade `GenrePills` & Enhanced `HomeSkeleton`

**Files:**
- Create: `apps/web/components/GenrePills.tsx`
- Modify: `apps/web/components/Skeleton.tsx`

- [ ] **Step 1: Implement GenrePills with micro-hover states and responsive scroll rail**
- [ ] **Step 2: Update HomeSkeleton to reflect BentoGrid + modern layout**

---

### Task 6: Assemble Orchestrator in `apps/web/app/page.tsx` & Verify Build

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Integrate HeroSpotlight, ContinueReadingRail, BentoGrid, GenrePills, and refined Update Terbaru into page.tsx**
- [ ] **Step 2: Run TypeScript check and verify build (`npm run pages:build` / `tsc --noEmit`)**
