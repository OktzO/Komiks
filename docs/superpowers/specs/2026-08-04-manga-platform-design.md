# Manga/Baca Platform Design (MangaDex-first)

> Spec covering agreed decisions from brainstorming. Supersedes relevant parts of original project prompt.

## Context
Manga/Manhwa/Manhua reader. Frontend Next.js di Cloudflare Pages. Backend Cloudflare Workers (+opsional Vercel edge fn) dengan KV cache + D1 + R2. Konten **scanlation via public API** (ex: MangaDex), **bukan CMS TL internal** (YAGNI — dibuang, tambah nanti bila tim TL aktif).

**Legal note:** konten manga di sumber eksternal termasuk MangaDex mayoritas **fan-translation/scanlation, tidak berlisensi**. Platform ini hanya *reader*; gambar tidak pernah di-rehost (ToS MangaDex melarang). Reader proxy sementara URL gambar via backend, lalu stream langsung ke browser user.

## Architecture
```
Browser -> CF DNS/CDN -> CF Pages (Next.js) -> /api/reader -> Router(sourceKey) -> Source Adapter (MangaDex ...)
                                                        \-> /api/user (auth, bookmark, history) -> D1/KV/R2 (own images if any)
```
- Source adapter: satu modul per sumber (MangaDex dulu), masing-masing expose: search/list metadata, chapter list, fetch page URLs (proxy token fetch), resolve image.
- `/api/reader/{source}/{seriesSlug}` or `/api/reader/{source}/{seriesId}/{chapterId}`.
- Image proxy flow: client request chapter → backend resolve fresh at-home token (MangaDex@Home) → Worker fetch image dari CDN eksternal → stream ke client (R2 tidak tersentuh). Respect rate limit (~5 req/s/token), rotasi API key.
- LB layer (`lb` pkg, KV-based, custom router, native-option) diterapkan pada **reader API endpoints** (bukan frontend statis).

## Data layer
D1 schema: `series`, `chapters`, `chapter_pages` (hanya metadata; image_url boleh null/dari proxy), `users`(email,google), `bookmarks`(user,series), `reading_history`(user,chapter,last_page), `sessions`(KV). FTS5 di D1 untuk search lokal.

KV keys: `series:{source}:{slug}`, `series:list:{source}:{genre}:{page}`, `chapter:{source}:{id}`, `search:hash`, `session:{token}`. TTL 5-30 min dengan stale-while-revalidate (trigger refresh via `waitUntil`).

R2: hanya **upload gambar chapter milik sendiri** bila nanti ada fitur upload CMS. Untuk MangaDex tidak dipakai.

## Frontend
Next.js App Router, dark theme Vercel-style (token warna di prompt). Path: `/`, `/[source]/s/[slug]` (detail), `/[source]/s/[slug]/[chapter]` (reader: scroll + page mode, lazy img), `/[source]/search`, `/genre/[g]`, `/bookmark`, `/history`, `/admin/*` (settings LB; no CMS TL dulu).

## Auth
Lucia Auth, email+pass atau Google OAuth, session di KV. User bisa bookmark + riwayat (posisi halaman auto-save). Admin role akses `/admin/*`.

## Load balancing (lihat §5 prompt)
Panel `/admin/settings/load-balancing`. Mode off/on. Akun provider CF & Vercel (token AES-GCM, key = Worker secret `LB_ENCRYPTION_KEY`). Origin pool, steering policy (failover/round-robin/weighted), health check tiap `GET /api/health`. Router KV-based (custom, gratis) sebagai default; opsi native CF LB sebagai pilihan Mode A. Audit log. **LB diterapkan pada reader API endpoints.**

## Search
D1 FTS5 untuk skala kecil. Meilisearch/Typesense terpisah bila perlu sync via webhook (future).

## Security / rate limit
WAF+Bot Fight cfPages. Rate limit IP via KV counter. `/api/admin/lb/*` hanya admin+step-up re-auth. External source API key hanya server-side, enkripsi at-rest.

## Scope MVP
- D1 schema (konten+LB) + migrasi
- KV cache + invalidation
- MangaDex source adapter (metadata list, chapter, image-proxy)
- Reader page (scroll+page, lazy load)
- Auth + bookmark + history
- Search (D1 FTS)
- Admin LB panel: on/off, add akun CF/Vercel (enkripsi), pool, native/custom select, health dashboard
- Cron health-check + `/api/health`
- Rate limiting & WAF
