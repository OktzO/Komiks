# Deploy apps/web-astro (Astro → Cloudflare Workers static assets)

Pengganti `apps/web` (Next.js/OpenNext). Deploy target: **Cloudflare Workers
dengan static assets** (bukan Pages — `next-on-pages` deprecated dan adapter
`@astrojs/cloudflare` v14 output Workers format). Custom domain, free tier,
dan CDN behavior sama dengan Pages.

## Build

```bash
cd apps/web-astro
npm run build        # → dist/server (worker) + dist/client (assets)
npm test             # canonical-url + round-robin (bun, 2 proses terpisah)
npm run lint         # astro check (typecheck)
```

Butuh **Node >= 22.12**.

## Deploy

```bash
npm run deploy       # = astro build && wrangler deploy  → worker `manga-web` (production; domain oktzz.xyz ter-bind ke sini — cek via GET /accounts/{a}/workers/domains)
```

`wrangler deploy` membaca `dist/server/wrangler.json` (auto-generated):
- name: `manga-web` ← production domain `oktzz.xyz` ter-bind ke worker ini (2026-09-15)
- assets: `../client` (binding ASSETS)
- KV `SESSION` auto-provision (Astro sessions — tidak dipakai app, biarkan)

Preview URL worker = `https://manga-web.<account>.workers.dev` (aktifkan
workers.dev di dashboard bila 404). Worker preview lama `manga-web-astro`
SUDAH DIHAPUS (2026-09-15) — satu-satunya web worker: `manga-web`.

## Env vars (dashboard Worker `manga-web` → Settings → Variables)

| Var | Nilai production | Catatan |
|---|---|---|
| `PUBLIC_API_URL` | `https://manga-api.oktz.workers.dev` | worker API utama (akun-1) |
| `PUBLIC_SITE_URL` | `https://oktzz.xyz` | fallback image proxy base |
| `PUBLIC_AUTH_API_URL` | `https://manga-api-2.tzok5555.workers.dev` | auth origin (akun-2) |
| `PUBLIC_TURNSTILE_SITE_KEY` | (site key Turnstile) | unset → widget login disembunyikan |
| `SERVICE_TOKEN` | `openssl rand -hex 24` | **secret**, bukan var: BFF gate api.ts `serviceHeaders()` (SSR-only) |

**PENTING — PUBLIC_* di-inline saat build.** Env var di dashboard hanya
berlaku untuk nilai SSR runtime (`process.env`); nilai yang dibaca di client
bundle (Reader, SourceSwitcher, BookmarkButton, AuthForm) di-inline oleh Vite
dari `.env.local` / CI env saat `astro build` dijalankan. Jadi: **set env ini
di CI build environment** (atau `.env.local` saat build lokal), bukan hanya
di dashboard. Di GitHub Actions: secrets → env pada step build.

`.env.local` (gitignored) dipakai dev + build lokal. Jangan commit.

## Service-token BFF gate (API hardening)

API worker (api-cf) kini punya `serviceGateMw` (lib/serviceGate.ts): request
`/api/*` tanpa jalur sah (service token / Origin allowlist / session cookie /
Turnstile untuk tier SENSITIVE) ditolak 403. Panggilan **SSR** web → API wajib
membawa header `x-service-token` (di-attach otomatis oleh `serviceHeaders()`
di `src/lib/api.ts` + `sitemap.xml.ts`); **client island TIDAK** mengirim token.

Cara set — dua command **terpisah**, masing-masing dari repo root (jangan
menyalin dalam satu shell berurutan: `cd` pertama membuat `cd` berikutnya
salah folder):
```bash
# 1. tiap worker API (ulang sekali per config)
cd apps/api-cf && npx wrangler secret put SERVICE_TOKEN
```
```bash
# 2. worker web manga-web (config di-generate saat astro build)
cd apps/web && npx wrangler --config dist/server/wrangler.json secret put SERVICE_TOKEN
```
> Tidak ada `apps/web/wrangler.jsonc` — wrangler config di-generate otomatis
> (`dist/server/wrangler.json`) saat `astro build`. Token jadi secret binding
> `process.env.SERVICE_TOKEN` di SSR runtime. Jika tidak di-set, SSR web hanya
> bisa menjangkau tier PUBLIC-READ (via server → tapi tanpa Origin/cookie juga
> 403), jadi **set dulu sebelum deploy gate**.

Tier gate (ringkas):
- **EXEMPT**: `/api/health`, `/api/origins`, `/api/auth/*`, `/api/_internal/*`,
  `/api/scrape`, `/img/*`, legacy `/api/reader/:source/page/:chapterId/:pageNo`.
- **PUBLIC-READ**: `/api/search*`, `/api/series*`, `/api/homepage`, `/api/reader*`
  (non-page), `/api/manga`, `/api/source-status`, GET `/api/user/*`
  → token / Origin / cookie. `/api/search` sengaja di tier ini supaya pencarian
  tetap jalan buat tamu (client-island memanggilnya langsung).
- **SENSITIVE**: `/api/resolve`, `/api/identify`, `/api/admin/*`,
  mutasi `/api/user/*` → token / cookie / Turnstile (`?turnstile_token=` atau
  header `x-turnstile-token`).
- lain-lain `/api/*` → 403.

## Custom domain (kondisi saat ini)

Cutover SELESAI: `oktzz.xyz` sudah ter-bind ke worker `manga-web` (build Astro)
sejak 2026-09-15. Alur deploy normal: `npm run deploy` → worker `manga-web`
langsung ter-update. Worker `manga-web-astro` (eks percobaan Astro) sudah
dihapus; namespace KV `SESSION` lamanya (`656236...`) boleh dihapus dari
dashboard.

## Rendering matrix

| Route | Mode | Alasan |
|---|---|---|
| `/` | prerendered (build-time feed) | zero-JS, CDN; feed di-cache KV 12 jam |
| `/[type]/[slug]` | SSR | SEO penuh, ribuan slug |
| `/[type]/[slug]/[chapterId]` | SSR | noindex; 404 asli bila chapter kosong |
| `/search` | SSR | hasil di-HTML |
| `/login` `/bookmark` `/history` `/profile` | SSR shell + islands | cookie user |
| `/admin/*` | shell statis + island `client:only` | noindex; SSR React admin = 22–48ms CPU → 503 intermiten (2026-09-15), makanya client-only |
| `/status/*` | SSR (client fetch data) | |
| `sitemap.xml` | endpoint, `s-maxage=3600` | CDN cache 1 jam |
| `404` | prerendered `404.html` + inline render di route dinamis | status 404 asli |

## Caching

- `_astro/*` assets: `Cache-Control: immutable` (auto-inject adapter).
- SSR publik: tanpa cache header tambahan — cache di lapisan API Worker
  (KV two-tier + edge) sudah cukup.
- Auth pages (`/bookmark` `/history` `/profile` `/admin/*`): `no-store`
  via `public/_headers`.

## Perbedaan vs Next.js (diketahui, disengaja)

- Navigasi full-page (tanpa RSC prefetch/client router). SourceSwitcher pakai
  `window.location` + progress bar CSS — UX tetap instan via CDN + edge cache.
- Homepage feed di-build saat deploy (prerendered), bukan ISR 5 menit.
  Refresh = redeploy (opsional: cron deploy hook tiap N jam).
- `Astro.redirect` 301 wrong-type; 404 via `Astro.response.status` + render
  inline NotFoundPage.
