# Navbar Hamburger 2-Garis + Scroll-Triggered Island — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline navbar with a client component: hamburger 2-garis (animasi menyilang), scroll-triggered island transition, mobile-first drop-down panel.

**Architecture:** One client component (`Navbar.tsx`) handles scroll detection (`scroll` listener + rAF throttle) and menu toggle (`useState`). CSS native transitions for all animations (no JS animation library). Class toggle on root header for island state. `usePathname()` effect for auto-close on route change.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, CSS custom properties (OKLCH dark theme).

## Global Constraints

- **No animation library.** CSS `transition` + `transform` + `opacity` only.
- **OKLCH dark theme** — palette tokens from `apps/web/app/globals.css:5-20`. No new color values.
- **Touch target minimum 44×44px** (WCAG) for hamburger button.
- **Font `text-base` (16px)** on menu links — prevents iOS focus zoom.
- **Client component** — `'use client'` directive required.
- **No new dependencies.** Stdlib + React + Next.js + Tailwind only.
- **`pt-24` body offset stays** in `layout.tsx` (navbar fixed height ~64px + 1rem top margin when island).
- **Existing links:** Cari (`/search`), Bookmark (`/bookmark`), Riwayat (`/history`), Status (`/status`), Masuk (`/login`). Logo links to `/`.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/web/components/Navbar.tsx` | **New.** Client component: scroll effect, hamburger toggle, menu panel render. Single export `Navbar`. |
| `apps/web/app/layout.tsx` | Import `Navbar`, delete inline `<header>` (lines 14-28), keep `pt-24` offset. |
| `apps/web/app/globals.css` | Add `#navbar` transition, `#navbar.navbar-scrolled` island styles, `.hamburger span` transforms, `#nav-menu` panel animation. |

---

### Task 1: CSS — Navbar transitions + hamburger + menu panel

**Files:**
- Modify: `apps/web/app/globals.css` (append after line 46, before EOF)

**Interfaces:**
- Produces: CSS selectors `#navbar`, `#navbar.navbar-scrolled`, `.hamburger`, `.hamburger[aria-expanded="true"]`, `#nav-menu`, `#nav-menu.open`. Later tasks' JSX references these IDs/classes.

- [ ] **Step 1: Read current globals.css to confirm end of file**

Run: `cat apps/web/app/globals.css`
Expected: file ends at line 46 (`.anim-slide-up` keyframes).

- [ ] **Step 2: Append navbar CSS to globals.css**

Append this block after the existing `.anim-slide-up` rule:

```css
/* ── Navbar: scroll-triggered island + hamburger ── */
#navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-subtle);
  transition: margin 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              border-radius 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              background 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              backdrop-filter 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}
#navbar.navbar-scrolled {
  max-width: 1024px;
  margin: 1rem auto;
  border-radius: var(--radius);
  background: oklch(0 0 0 / 0.66);
  backdrop-filter: blur(18px) saturate(1.8);
  -webkit-backdrop-filter: blur(18px) saturate(1.8);
  border: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}
@media (max-width: 767px) {
  #navbar.navbar-scrolled {
    left: 0.5rem;
    right: 0.5rem;
    margin: 0.5rem auto;
    width: auto;
  }
}

/* Hamburger 2-garis → menyilang */
.hamburger {
  display: inline-flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  width: 44px;
  height: 44px;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
}
.hamburger span {
  display: block;
  width: 22px;
  height: 2px;
  background: var(--text-primary);
  border-radius: 1px;
  transition: transform 0.2s ease-out;
  transform-origin: center;
}
.hamburger[aria-expanded="true"] span:nth-child(1) {
  transform: translateY(4px) rotate(45deg);
}
.hamburger[aria-expanded="true"] span:nth-child(2) {
  transform: translateY(-4px) rotate(-45deg);
}

/* Menu panel drop-down */
#nav-menu {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transition: max-height 0.25s ease-out, opacity 0.2s ease-out;
}
#nav-menu.open {
  max-height: 400px;
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  #navbar, .hamburger span, #nav-menu { transition: none; }
}
```

- [ ] **Step 3: Verify CSS syntax (no build needed, just visual check)**

Confirm: `#navbar` has transition, `.navbar-scrolled` has island props, `.hamburger span` has transform closed state, `[aria-expanded="true"]` has menyilang transforms, `#nav-menu` has closed/open states, reduced-motion media query disables transitions.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): navbar CSS — scroll island + hamburger + menu panel transitions"
```

---

### Task 2: Navbar component — scroll detection + hamburger toggle + menu panel

**Files:**
- Create: `apps/web/components/Navbar.tsx`

**Interfaces:**
- Consumes: CSS selectors from Task 1 (`#navbar`, `.navbar-scrolled`, `.hamburger`, `#nav-menu`).
- Produces: `Navbar` export (default), rendered by `layout.tsx` in Task 3.

- [ ] **Step 1: Write the Navbar component**

Create `apps/web/components/Navbar.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/search', label: 'Cari' },
  { href: '/bookmark', label: 'Bookmark' },
  { href: '/history', label: 'Riwayat' },
  { href: '/status', label: 'Status' },
] as const;

export function Navbar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Scroll → island toggle (rAF throttle, passive)
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const el = document.getElementById('navbar');
        if (!el) { ticking = false; return; }
        if (window.scrollY > 1) el.classList.add('navbar-scrolled');
        else el.classList.remove('navbar-scrolled');
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Route change → close menu
  useEffect(() => { setOpen(false); }, [pathname]);

  // Esc → close menu
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header id="navbar" className="px-4 py-3">
      <div className="mx-auto flex items-center" style={{ maxWidth: 'min(1024px, 100%)' }}>
        <Link href="/" className="flex items-center gap-2 text-xl tracking-tight font-medium text-primary hover:text-accent">
          <span className="inline-block h-7 w-7 rounded-full bg-gradient-to-br from-accent to-muted" />
          Manga
        </Link>
        <button
          className="hamburger ml-auto"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen(o => !o)}
        >
          <span />
          <span />
        </button>
      </div>
      <nav id="nav-menu" className={open ? 'open' : ''} aria-hidden={!open}>
        <div className="mx-auto mt-2 flex flex-col" style={{ maxWidth: 'min(1024px, 100%)' }}>
          {LINKS.map(l => (
            <Link key={l.href} href={l.href} className="px-3 py-3 text-base text-secondary hover:text-primary rounded-lg hover:bg-bg-secondary transition-colors">
              {l.label}
            </Link>
          ))}
          <Link href="/login" className="mx-3 my-2 px-3 py-2.5 text-base text-primary border border-border-default rounded-lg hover:bg-bg-secondary transition-colors text-center">
            Masuk
          </Link>
        </div>
      </nav>
    </header>
  );
}

export default Navbar;
```

- [ ] **Step 2: Verify file written correctly**

Run: `cat apps/web/components/Navbar.tsx`
Expected: file matches above. `'use client'` at top, exports `Navbar`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS (no errors related to Navbar.tsx). Pre-existing errors in other files OK.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/Navbar.tsx
git commit -m "feat(web): Navbar client component — scroll island + hamburger + drop-down panel"
```

---

### Task 3: Layout — replace inline nav with Navbar component

**Files:**
- Modify: `apps/web/app/layout.tsx` (lines 1-33)

**Interfaces:**
- Consumes: `Navbar` from `apps/web/components/Navbar.tsx` (Task 2).
- Produces: All pages get the new navbar via root layout.

- [ ] **Step 1: Read current layout.tsx**

Run: `cat apps/web/app/layout.tsx`
Expected: 33 lines, inline `<header>` at lines 14-28.

- [ ] **Step 2: Replace layout.tsx with Navbar import + render**

Replace entire file content:

```tsx
import type { Metadata } from 'next';
import { Navbar } from '../components/Navbar';
import './globals.css';

export const metadata: Metadata = {
  title: 'Manga Reader',
  description: 'Baca manga/manhwa/manhua bahasa Indonesia',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className="dark">
      <body className="min-h-screen bg-base text-primary antialiased">
        <Navbar />
        <div className="pt-24">{children}</div>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p apps/web`
Expected: PASS (no errors related to layout.tsx).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/layout.tsx
git commit -m "feat(web): layout uses Navbar component, remove inline header"
```

---

### Task 4: Manual smoke test — dev server visual verification

**Files:**
- No file changes.

**Interfaces:**
- Consumes: All previous tasks.

- [ ] **Step 1: Start web dev server**

Run (separate terminal or background): `cd apps/web && npm run dev`
Wait for: `Ready - started server on localhost:3000`

- [ ] **Step 2: Verify top state (not scrolled)**

Open `http://localhost:3000`.
Expected:
- Navbar full-width, solid `--bg-base` background, border-bottom subtle.
- No rounded corners, no blur.
- Logo left, hamburger icon (2 horizontal lines) right.
- Menu closed (not visible).

- [ ] **Step 3: Verify island state (scrolled)**

Scroll down 1px+ (or scroll a few hundred px).
Expected:
- Navbar shrinks to `max-width: 1024px`, centered.
- `rounded-2xl`, blur background, border all around.
- `margin: 1rem auto`.
- Smooth transition (280ms) visible.
- On mobile width (<768px): island uses `left/right: 0.5rem` margin instead of full auto.

- [ ] **Step 4: Verify hamburger open**

Click hamburger.
Expected:
- 2 lines animate to X (top rotates 45deg, bottom rotates -45deg).
- Menu panel drops down below navbar, links visible vertically.
- Panel: backdrop blur, border, rounded.
- Links: Cari, Bookmark, Riwayat, Status, Masuk (button-style).

- [ ] **Step 5: Verify menu close on navigation**

Click any link (e.g. "Cari").
Expected:
- Menu closes.
- Route changes to `/search`.
- Hamburger resets to 2 lines.

- [ ] **Step 6: Verify Esc key closes menu**

Open menu, press `Escape`.
Expected: Menu closes, hamburger resets.

- [ ] **Step 7: Verify reduced motion**

If OS has reduced-motion enabled: transitions instant (no animation).
Expected: State changes are instant, no 280ms or 200ms transitions.

- [ ] **Step 8: No commit needed (verification only)**

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|------------------|------|
| Hamburger 2-garis, animasi menyilang | Task 1 (CSS) + Task 2 (JSX) |
| Nempel saat tidak scroll | Task 1 (`#navbar` default: solid bg, no rounded) |
| Island saat scroll > 1px + animasi | Task 1 (`.navbar-scrolled` + transition) + Task 2 (scroll listener) |
| Native + ringan (no animation lib) | All tasks — CSS transitions only, no deps |
| Mobile focus (44px touch, py-3 links, text-base) | Task 1 (`.hamburger` 44px) + Task 2 (link classes) |
| Drop-down panel | Task 1 (`#nav-menu` CSS) + Task 2 (panel JSX) |
| Auto-close on route change | Task 2 (`usePathname` effect) |
| Esc closes | Task 2 (keydown effect) |
| Reduced motion | Task 1 (`@media (prefers-reduced-motion: reduce)`) |
| Logo + links (Cari/Bookmark/Riwayat/Status/Masuk) | Task 2 (LINKS array + logo + Masuk) |

All spec requirements covered.

**2. Placeholder scan:** No TBD/TODO. All code blocks complete.

**3. Type consistency:**
- `Navbar` export: named + default (Task 2) → imported as named `{ Navbar }` (Task 3). ✓
- CSS IDs/classes: `#navbar`, `.navbar-scrolled`, `.hamburger`, `#nav-menu`, `.open` — used consistently across Task 1 CSS and Task 2 JSX. ✓
- `aria-expanded` + `aria-controls` on button → `id="nav-menu"` on nav. ✓
- `aria-hidden={!open}` on nav matches `open` state. ✓

No issues found.
