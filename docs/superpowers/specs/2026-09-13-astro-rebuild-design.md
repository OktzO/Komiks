# Rebuild: Next.js → Astro (apps/web-astro)

**Tanggal:** 2026-09-13
**Status:** Approved (user), implementasi dimulai
**Scope:** Frontend saja (`apps/web` → `apps/web-astro`). API Worker, B2, auth flow, Turnstile: tidak disentuh.

## Motivasi

- `next-on-pages` deprecated; user ingin deploy ke **Cloudflare Pages**.
- Astro: HTML ~70% lebih kecil (tanpa hydration React penuh), halaman statis zero-JS dari CDN, SEO identik (SSR per-request).
- Paritas fitur 100% — semua fitur web lama tetap ada, termasuk admin dashboard.

## Keputusan (user-approved)

1. **Scope:** frontend saja.
2. **Deploy target:** Cloudflare Pages.
3. **Rendering:** hybrid — static untuk halaman statis, **SSR on-demand** untuk halaman dinamis (SEO penuh, tidak mengorbankan index detail manga).
4. **Komponen interaktif:** React islands (reuse komponen existing).
5. **Admin:** ikut dimigrasi.
6. **Strategi:** paritas penuh dulu sebelum swap domain.

## Arsitektur

```
apps/web-astro/               (baru, paralel; apps/web tetap live sampai swap)
  astro.config.mjs            — output: 'server', adapter: @astrojs/cloudflare (Pages)
  src/pages/                  — 1:1 mirror App Router Next.js
  src/components/             — React islands (ReaderShell, SourceSwitcher, dst) + zero-JS templates
  src/lib/api.ts              — reuse dari apps/web (NEXT_PUBLIC_ → PUBLIC_ / server env)
  public/_headers             — security headers + CSP dari next.config.mjs
  tailwind.config.ts          — reuse
```

## Rendering matrix

| Route | Rendering | Alasan |
|---|---|---|
| `/` homepage | prerender + feed build-time | zero-JS, CDN; feed sudah di-cache KV API 12 jam (cron) |
| `/manga\|manhwa\|manhua/[slug]` | SSR (`prerender = false`) | HTML lengkap per-request → SEO; ribuan slug tak membebani build |
| `/[type]/[slug]/[chapterId]` reader | SSR | noindex meta, HTML cepat |
| `/search` | SSR shell (form zero-JS, hasil client fetch) | |
| `/login`, `/bookmark`, `/history`, `/profile` | SSR shell + islands | cookie user → per-request |
| `/admin/*` | SSR shell + islands | noindex, auth-guard client-side (sama seperti saat ini) |
| `/status/*` | prerender | statis penuh |
| `sitemap.xml` | SSR endpoint, `s-maxage=3600` | CDN cache 1 jam (≈ Next.js revalidate 3600) |
| `robots.txt` | prerender | statis |

## SEO preservation

- `generateMetadata` → frontmatter/inline `<title>`, `<meta>` per SSR request.
- 404 asli: `Response` status 404 sebelum render body (bukan soft-404).
- 301 wrong-type redirect: `Response.redirect('/{type}/{slug}', 301)` — identik behavior.
- Reader page: `noindex` meta.
- Canonical URL tag per halaman.

## Islands

- `client:load`: ReaderShell+Reader, SourceSwitcher, AuthForm (Turnstile).
- `client:idle`: BookmarkButton, Navbar (interaktif), Avatar.
- Zero-JS (server-only render): MangaCard, CoverImage, GenrePills, TypeBadge, SourceBadge, Skeleton, WindowedList (data server-side), Synopsis, BentoGrid (static part), HeroSpotlight (static part).
- Admin pages: islands `client:load` per halaman, client-side fetch pattern tetap.

## Data layer

- `lib/api.ts` reuse: round-robin worker pool, sticky auth origin (sessionStorage), health-check cache 5 min, 12s timeout.
- Env: `PUBLIC_API_URL`, `PUBLIC_SITE_URL`, `PUBLIC_AUTH_API_URL`, `PUBLIC_TURNSTILE_SITE_KEY` (client) + `API_URL` (server SSR, tanpa PUBLIC — tidak bocor ke client).
- `@manga-platform/shared` tetap dipakai (Vite resolve workspace package otomatis).

## Auth (tidak berubah)

- Login = redirect `/api/auth/google` di API worker, cookie cross-origin `__Host-session`.
- Turnstile widget explicit mode (`render=explicit&onload=onTurnstileLoad`) — site key `PUBLIC_TURNSTILE_SITE_KEY`.
- Bookmark/history/profile: client fetch `credentials: 'include'`.

## Deploy & caching

- `astro build` → `dist/` + `_worker.js` → `wrangler pages deploy dist`.
- Homepage "revalidate": redeploy / deploy hook cron (opsional), bukan KV cache.
- SSR detail/reader: cache tetap di lapisan API Worker (KV two-tier + edge) — frontend tidak cache sendiri.
- `Cache-Control: no-store` untuk auth pages (bookmark/history/profile/admin).
- CSP: adaptasi dari next.config.mjs; `unsafe-inline` script dapat diperketat (Astro tidak inject runtime inline React) — tapi tetap perlu untuk Turnstile callback + Astro island script kecil.

## Testing

- Port `test/canonical-url.test.ts`, `test/round-robin.test.ts` → `bun test` di apps/web-astro.
- Playwright e2e: port `canonical-streaming.spec.ts` ke route Astro.
- Verifikasi build: `astro build` sukses + paritas manual checklist halaman.

## Cutover

1. `apps/web-astro` dibangun paralel — Next.js tetap live di oktzz.xyz.
2. Deploy Astro ke `*.pages.dev` preview → uji paritas (e2e, view-source meta, lighthouse).
3. Fix gap → deploy ulang preview sampai hijau.
4. Swap domain oktzz.xyz → Pages project.
5. Matikan worker OpenNext `manga-web` (KV incremental cache obsolete).
6. Hapus `apps/web` setelah 1–2 minggu stabil.

## Error handling

- SSR fetch: 12s timeout + AbortController → 404/500 template Astro.
- 500.astro global error page; skeleton loading = HTML statis.
