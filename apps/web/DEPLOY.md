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
| `PUBLIC_AUTH_API_URL` | `https://manga-api-2.tzok5555.workers.dev` | kandidat fallback saja — **sticky auth origin sudah dihapus** (2026-10-02). Cookie session sekarang milik `oktzz.xyz`, jadi tidak ada worker yang perlu "diingat" browser. Nilai ini masuk sebagai kandidat di `getOrigins()` dan sebagai fallback `imgOriginFor()`; tidak ada pinning ke worker tertentu. |
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

API worker (api-cf) punya `serviceGateMw` (`apps/api-cf/src/lib/serviceGate.ts`):
request `/api/*` tanpa jalur sah ditolak 403. **Gate ini token-only** — `Origin`
diabaikan sepenuhnya, dan `corsMw` yang dulu ada sudah dihapus (2026-10-02).

Panggilan **SSR** web → API wajib membawa header `x-service-token` (di-attach
otomatis oleh `serviceHeaders()` di `src/lib/api.ts` + `sitemap.xml.ts`).
**Client island TIDAK** mengirim token; semua panggilan browser lewat proxy BFF
`src/pages/api/[...path].ts`, yang menyisipkan token sebelum meneruskan.

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
> `process.env.SERVICE_TOKEN` di SSR runtime. **Set sebelum deploy gate** —
> kalau tidak, SSR hanya bisa menjangkau path EXEMPT.

Tier gate (ringkas):
- **EXEMPT** (punya credential sendiri, tidak butuh token web): `/api/health`,
  `/api/origins`, `/api/auth/*`, `/api/_internal/*` (forward-key sendiri),
  `/api/scrape*` (`requireAdminKey`), `/img/*` (signature HMAC), `OPTIONS`.
- **selainnya** → hanya `x-service-token`. Tidak ada tier PUBLIC-READ/SENSITIVE
  lagi, dan tidak ada jalur alternatif lewat Origin atau cookie.
- `HEAD` tidak dikecualikan (dulu exempt bersama `OPTIONS` karena `corsMw`).

### Proxy BFF — route Workers yang wajib diperiksa

`src/pages/api/[...path].ts` adalah satu-satunya jalur browser ke worker API.
Karena itu **Workers Route `oktzz.xyz/api/* → manga-api` harus tetap dihapus**;
route yang boleh ada hanya `/img/* → manga-api`. Kalau `/api/*` dibikin ulang,
seluruh gate dilewati karena request browser tidak lagi menyertakan
`x-service-token`.

Detail aturan proxy (allowlist header/path, relay `Set-Cookie`, `redirect: 'manual'`,
`x-client-ip`) ada di README §Proxy BFF.

### Setelah deploy

```bash
node scripts/check-worker-secrets.mjs   # dari repo root
```

Secret write-only dan `wrangler deploy` tidak gagal saat secret hilang — worker
tetap melayani traffic lalu gagal hanya di jalur yang membaca secret itu.

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
