# Manga Platform — Deploy

## Prasyarat
- Cloudflare account (D1, KV, R2, Workers, Pages)
- Node 18+

## 1. Buat resources CF
```bash
npx wrangler d1 create manga-db           # catat database_id → wrangler.toml
npx wrangler kv namespace create CACHE_KV  # catat id → wrangler.toml
npx wrangler r2 bucket create manga-assets
```
Update `apps/api-cf/wrangler.toml` dengan ID asli.

## 2. Simpan secrets
```bash
cd apps/api-cf
npx wrangler secret put LB_ENCRYPTION_KEY     # 32-byte random string
npx wrangler secret put ADMIN_PASSWORD_HASH   # password admin untuk step-up
# Opsional:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## 3. Migrasi D1
```bash
npx wrangler d1 execute manga-db --file=../../packages/db/schema.sql --remote
npx wrangler d1 execute manga-db --file=../../packages/db/seed.sql --remote   # opsional, sample data
```

## 4. Deploy API (Worker)
```bash
cd apps/api-cf
npx wrangler deploy
```
Catat URL Worker (mis. `https://manga-api.<sub>.workers.dev`).

## 5. Deploy Frontend (Pages)
```bash
cd apps/web
# Set API URL ke Worker deploy
echo "NEXT_PUBLIC_API_URL=https://manga-api.xxx.workers.dev" > .env.local
npx next build
npx next-on-pages
# Deploy via CF Pages dashboard atau:
npx wrangler pages deploy .vercel/output/static --project-name manga-web
```

## 6. Setup domain + WAF
- Custom domain di CF Pages + Worker
- Aktifkan WAF + Bot Fight Mode di Cloudflare dashboard
- (Opsional) Native CF Load Balancer jika Mode A diaktifkan admin

## 7. Verifikasi
- Buka `https://<domain>/` → home manga Indonesia
- `/search?q=one+piece` → hasil pencarian
- `/komiku/s/<slug>?id=<mangaId>` → detail + chapter list
- `/komiku/s/<slug>/<chapterId>` → reader (gambar proxy)
- `/login` `/register` → auth
- `/admin/settings/load-balancing` → panel LB (password admin)

## Local dev
```bash
# API
cd apps/api-cf && npx wrangler dev --port 8787 --local
# Web (terminal lain)
cd apps/web && npx next dev --port 3000
```

## Catatan
- Gambar Komiku **diproxy server-side** + rehost cache-aside ke R2 (hash ring); sumber lain tetap 100% proxy
- Token LB dienkripsi AES-GCM at-rest, key = Worker secret
- Rate limit 60 req/min per IP via KV
- Cron health-check jalan tiap 1 menit saat LB mode=on
