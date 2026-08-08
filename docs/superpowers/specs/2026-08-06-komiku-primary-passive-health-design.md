# Komiku Primary + Passive Source Health

## Problem
1. `api-cf` cron `* * * * *` ping LB origins tiap menit = buang Cloudflare request token.
2. Komiku belum jadi sumber primary di home page.
3. Status page tampilkan info real-time ping, bukan "terakhir dipakai user".

## Solusi
Model: **passive murni**. Cron dihapus. Source health dicatat hanya saat aktivitas user (search/reader) sukses atau gagal. `last_checked_at` = timestamp aktivitas terakhir.

## Perubahan

### 1. Hapus cron `api-cf`
- `apps/api-cf/wrangler.toml`: buang `[triggers] crons`
- `apps/api-cf/src/index.ts`: buang `scheduled` handler + fungsi `runHealthChecks`

### 2. Tambah [browser] binding ke `api-cf`
Komiku reader butuh Puppeteer. Tambah:
```toml
[browser]
binding = "MY_BROWSER"
remote = true
```

### 3. Passive health recording
Hook di `apps/api-cf/src/routes/reader.ts` dan `apps/data-api/src/routes/search.ts`:
- Setelah Komiku search/getSeries/listChapters/fetchPageUrls sukses → `recordSourceHealth({source:'komiku', healthy:true, latencyMs})`
- Kalau gagal → `recordSourceHealth({source:'komiku', healthy:false, error})`
- MangaDex tetap dicatat pas search/reader di data-api

### 4. `sourceStatus.ts` rewrite
Baca `getLatestSourceHealth(source)` dari D1 untuk `komiku` + `mangadex`. No live ping, no KV cache fetch. Response format sama supaya frontend tidak break.

### 5. Home page Komiku primary
`apps/web/app/page.tsx`: panggil `searchMerged` dengan prefer Komiku urutan atas. `MangaCard` default `source='komiku'`.

### 6. Frontend `/status` tweak
Tampilkan "Terakhir aktif: X menit lalu" (dari `checked_at`).

## Tidak berubah
- Search tetap gabung Komiku + MangaDex
- Reader Komiku tetap pakai Puppeteer via `MY_BROWSER`
- Image proxy ToS MangaDex tetap (stream, no rehost)
- D1 schema `source_health` tetap (tidak perlu migration baru)
