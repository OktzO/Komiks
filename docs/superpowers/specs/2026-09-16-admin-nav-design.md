# Admin Navigation Redesign — 2026-09-16

## Problem
- `/admin` appeared blank because `AdminSidebar` rendered an empty `min-h-screen` wrapper around a `fixed` aside, pushing admin content one viewport down.
- Admin content islands require an admin session; the sidebar has no auth gate, so the sidebar can appear while content is empty.

## Approved direction
- Option A: landing-style top admin navbar.
- Section 1 approved: remove the sidebar wrapper layout footprint.
- Section 2.1 approved: fixed top `.nav-island` admin bar; desktop inline admin buttons; mobile hamburger.
- Section 2.2 approved: admin-only menu plus site/user utilities.
- Section 2.3 approved: new island, admin-scoped IDs, router-aware active state, offset/testing plan.

## Architecture
- Replace `AdminSidebar` usage in `AdminLayout` with a new `AdminTopbar` React island.
- The replacement also removes the old sidebar wrapper layout footprint; no empty `min-h-screen` block may remain in normal document flow.
- Keep `client:only="react"` for admin islands.
- Keep admin pages `noindex`.
- Remove `md:ml-20` content offset; use top padding for the fixed admin navbar.

## Components
- `AdminTopbar`
  - Left: `Oktz. Admin` brand/home link.
  - Desktop: inline buttons for Dashboard, Monitoring, Users, Merge Queue, Settings.
  - Right/desktop utilities: `Ke situs`, admin email/badge, `Keluar`.
  - Mobile: hamburger opens admin-only menu with the same destinations plus utilities.
- Active state
  - Pathname-based.
  - `/admin/users/...` counts as Users.
  - Updates on Astro ClientRouter navigation, not only first mount.

## Styling/isolation
- Reuse landing navbar visual language: `.nav-island`, hamburger, floating menu.
- Use admin-scoped IDs/classes such as `#admin-navbar` and `#admin-menu`.
- Do not reuse the public `#navbar` / `#nav-menu` IDs.
- Preserve dark admin theme and existing tokens.

## Data flow/auth
- Topbar may use `fetchMe()` for email/role/logout display.
- Admin content islands keep existing `fetchMe()` admin guard and redirect behavior.
- Only admin destinations appear in the hamburger menu.
- Public site navigation remains available through `Ke situs`.

## Error handling
- Preserve island fallback text during client-only load.
- Failed admin API calls must show inline error UI, not blank content.
- Hamburger menu must close on successful navigation.
- No unrelated refactor of admin data fetching.

## Testing
- Hard refresh `/admin` on desktop and mobile.
- Verify content is visible without scrolling past an empty viewport.
- Verify hamburger opens/closes and lists only admin destinations.
- Verify active state on `/admin`, `/admin/monitoring`, `/admin/users`, `/admin/users/:id`, `/admin/merge`, `/admin/settings`.
- Verify no new console errors.
- Verify admin API behavior is unchanged.

## Scope
- In scope: layout spacer fix, new admin topbar, responsive behavior, active state, tests.
- Out of scope: changes to admin API envelopes, auth/session logic, public landing navbar behavior, unrelated admin refactors.
