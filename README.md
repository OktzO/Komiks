# Manga Reader Platform

Baca manga/manhwa/manhua bahasa Indonesia. Sumber: MangaDex API (scanlation fan-translation). Frontend Next.js (Cloudflare Pages), backend Cloudflare Workers, cache KV, D1, R2.

## Struktur
```
apps/web      — Next.js frontend (dark theme, reader, admin)
apps/api-cf   — Cloudflare Worker API (Hono)
packages/db      — D1 schema + query helpers
packages/shared  — zod types
packages/sources — MangaDex source adapter
packages/lb      — load balancing (AES-GCM crypto, accounts, router)
```

## Status MVP
- ✅ D1 schema (konten + LB)
- ✅ MangaDex adapter (search, series, chapters, page URLs)
- ✅ Image proxy (server-side stream, no rehost)
- ✅ Reader (scroll + page mode)
- ✅ Auth (email+password, PBKDF2, KV sessions)
- ✅ Bookmark + reading history
- ✅ Search (MangaDex + KV cache)
- ✅ Admin LB panel (mode, accounts, origins, status)
- ✅ AES-GCM token encryption
- ✅ Cron health-check
- ✅ Rate limiting (60/min/IP)
- ✅ Dark theme Vercel-style

## Deploy
Lihat `docs/DEPLOY.md`.

## Legal
Konten dari MangaDex = scanlation fan-translation, mayoritas tanpa lisensi resmi. Gambar tidak pernah di-rehost — proxy stream via Worker. Platform ini reader saja.
