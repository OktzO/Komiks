# Navbar Hamburger 2-Garis + Scroll-Triggered Island — Design Spec

**Date:** 2026-08-07
**Status:** Approved
**Scope:** Frontend navbar rewrite (`apps/web`)

---

## Context

Navbar saat ini inline di `apps/web/app/layout.tsx:14-28`. Selalu island (fixed + blur + rounded + max-width 1024px). Tidak ada hamburger menu — link tampil inline semua ukuran. Tidak ada transisi scroll-triggered.

**Problems:**
- Link inline menumpuk di mobile (5 link + logo dalam 1024px max → cramped di <768px).
- Tidak ada perbedaan visual top vs scrolled — island aesthetic lost (always-on).
- No mobile-optimized menu.

**User requirements (2026-08-07):**
1. Hamburger 2-garis, animasi menyilang saat dibuka.
2. Navbar nempel saat tidak di-scroll, jadi island saat scroll — dengan animasi transisi.
3. Cari kode native + ringan (no animation library).
4. Improve tampilan mobile/HP.

---

## Design

### Component

Satu client component baru: `apps/web/components/Navbar.tsx`. Gantikan inline nav di `layout.tsx`.

**Why single component:** Hamburger semua ukuran (desktop + mobile sama). Satu mode render, simpler.

### States

| State | Trigger | Visual |
|-------|---------|--------|
| **Top** | `scrollY === 0` | Nempel: `position: fixed; top: 0; inset-inline: 0`, full-width, bg `--bg-base` (solid), border-bottom subtle. No rounded, no blur, no margin. |
| **Island** | `scrollY > 1px` | `max-width: 1024px`, `margin: 1rem auto`, `rounded-2xl`, `backdrop-filter: blur(18px) saturate(1.8)`, border subtle. |
| **Menu open** | hamburger tap | Panel drop-down below navbar. Semi-transparent backdrop blur, same width as navbar (max 1024px), centered. |

Transisi Top ↔ Island: 280ms `cubic-bezier(0.16, 1, 0.3, 1)` pada `margin`, `border-radius`, `background`, `backdrop-filter`, `max-width`.

### Hamburger Button

2 garis (`<span>` × 2) di dalam `<button>`. 

- **Closed:** 2 garis horizontal paralel, jarak ~6px.
- **Open:** Garis atas rotate 45deg + translateY ke tengah. Garis bawah rotate -45deg + translateY ke tengah. Menyilang (X).
- **Specs:** button 44×44px (WCAG min touch target). Garis: 2px height, 22px width, `background: var(--text-primary)`. Transisi 200ms ease-out pada `transform`.

CSS native:
```css
.hamburger span { transition: transform 0.2s ease-out; transform-origin: center; }
.hamburger[aria-expanded="true"] span:nth-child(1) { transform: translateY(3px) rotate(45deg); }
.hamburger[aria-expanded="true"] span:nth-child(2) { transform: translateY(-3px) rotate(-45deg); }
```

### Menu Panel (Drop-down)

- **Trigger:** hamburger tap → `useState` toggle `open`.
- **Position:** below navbar, `max-width: 1024px`, centered, `rounded-2xl`, backdrop blur, border subtle.
- **Content:** link vertikal, full-width, `py-3` per link, `text-base` (16px min untuk mobile), tap target generous.
- **Animation:** `opacity: 0 → 1`, `translateY(8px → 0)`, 200ms ease-out. Reverse saat close.
- **Auto-close:** saat link di-tap (route change via `usePathname()` effect).
- **Accessibility:** `aria-expanded` on button, `aria-controls` linking button ↔ panel. Focus management: saat open, fokus pindah ke first link (optional — start simple, add if needed). `Esc` key closes.

### Scroll Detection

`scroll` listener + `requestAnimationFrame` throttle. Toggle class `navbar-scrolled` pada root header element.

```ts
useEffect(() => {
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const header = document.getElementById('navbar');
      if (window.scrollY > 1) header?.classList.add('navbar-scrolled');
      else header?.classList.remove('navbar-scrolled');
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => window.removeEventListener('scroll', onScroll);
}, []);
```

**Why not IntersectionObserver sentinel:** scroll listener + rAF cukup ringan untuk 1 element. Simpler, no extra DOM node.

### Links

Same as current: Cari, Bookmark, Riwayat, Status, Masuk. Logo kiri (Link ke `/`).

### Mobile Focus

- Hamburger 44×44px touch target.
- Link `py-3` (12px vertikal) — easy tap.
- Panel `max-width: 1024px` but on mobile fills width minus 1rem margin.
- Font `text-base` (16px) — no iOS zoom on focus.

---

## Files Changed

| File | Change |
|------|--------|
| `apps/web/components/Navbar.tsx` | **New.** Client component. Scroll effect + hamburger toggle + menu panel. |
| `apps/web/app/layout.tsx` | Import `Navbar`, delete inline `<header>` (lines 14-28). |
| `apps/web/app/globals.css` | Add `.navbar-scrolled` class + hamburger keyframes + panel animation. |

---

## Skipped (YAGNI)

- `framer-motion` / animation library — CSS native sufficient.
- `IntersectionObserver` sentinel — scroll listener + rAF simpler for 1 element.
- Persistent menu state across route change — close on navigation (cleaner).
- Focus trap inside menu — start simple, add if accessibility audit demands.
- Direction-based scroll hide/show — user chose scroll > 1px trigger.
- Desktop inline links — user chose hamburger all sizes.

→ Add focus trap when accessibility audit or user feedback demands. Upgrade path: `focus-trap-react` package or manual `Tab` key handler.
