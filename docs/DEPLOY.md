# Manga Platform — Deploy

## Prasyarat
- Cloudflare account (D1, KV, Workers)
- Node 20+ (build) + Wrangler 4 (`@opennextjs/cloudflare`)

## 1. Buat resources CF
```bash
npx wrangler d1 create manga-db           # catat database_id → wrangler.toml
npx wrangler kv namespace create CACHE_KV  # catat id → wrangler.toml
```
Update `apps/api-cf/wrangler.toml` dengan ID asli. Storage pakai Backblaze B2 (bukan R2) — credentials di-set via `B2_ACCOUNTS` secret JSON array.

## 1b. Buat resources CF (web — ISR cache)
```bash
cd apps/web
npx wrangler kv namespace create NEXT_INC_CACHE_KV
# catat id → update apps/web/wrangler.jsonc, ganti "REPLACE_WITH_KV_NAMESPACE_ID"
npx wrangler kv namespace create --preview NEXT_INC_CACHE_KV
# catat preview_id → wrangler.jsonc jika perlu
```

## 2. Simpan secrets
```bash
cd apps/api-cf
npx wrangler secret put LB_ENCRYPTION_KEY     # 32-byte random string — HANYA utk encrypt CF API token di lb_accounts
npx wrangler secret put AUTH_SIGNING_KEY      # ECDSA P-256 JWK private key (sign session cookie)
# Opsional:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## 3. Migrasi D1
```bash
npx wrangler d1 execute manga-db --file=../../packages/db/schema.sql --remote
npx wrangler d1 execute manga-db --file=../../packages/db/seed.sql --remote   # opsional, sample data
# Apply migrations 0001–0012 secara berurutan:
for m in ../../packages/db/migrations/0*.sql ../../packages/db/migrations/0012_drop_r2_last_access.sql; do
  npx wrangler d1 execute manga-db --file="$m" --remote
done
```

## 4. Deploy API (Worker)
```bash
cd apps/api-cf
npx wrangler deploy
```
Catat URL Worker (mis. `https://manga-api.<sub>.workers.dev`).

## 5. Deploy Frontend (Worker via OpenNext)
```bash
cd apps/web
# Set API URL ke Worker deploy
echo "NEXT_PUBLIC_API_URL=https://manga-api.xxx.workers.dev" > .env.local
npx opennextjs-cloudflare build
npx wrangler deploy   # config dari apps/web/wrangler.jsonc
```
Frontend jalan sebagai Worker (bukan Pages) dengan `nodejs_compat`. Tidak perlu `runtime='edge'` per-halaman — App Router default runtime sudah cocok.

## 6. Setup domain + WAF
- Custom domain di Worker frontend + Worker API
- Aktifkan WAF + Bot Fight Mode di Cloudflare dashboard
- (Opsional) Native CF Load Balancer jika Mode A diaktifkan admin

## 7. Verifikasi
- Buka `https://<domain>/` → home manga Indonesia
- `/search?q=one+piece` → hasil pencarian
- `/komiku/s/<slug>?id=<mangaId>` → detail + chapter list
- `/komiku/s/<slug>/<chapterId>` → reader (gambar proxy)
- `/login` → auth (Google OAuth)
- `/admin/monitoring` → panel admin (session role=admin)

## Local dev
```bash
# API
cd apps/api-cf && npx wrangler dev --port 8787 --local
# Web (terminal lain)
cd apps/web && npx next dev --port 3000
```

## Catatan
- Gambar Komiku **diproxy server-side** + rehost cache-aside ke B2 (hash-pick); sumber lain tetap 100% proxy
- Token LB dienkripsi AES-GCM at-rest, key = `LB_ENCRYPTION_KEY` Worker secret
- Session cookie ECDSA-signed (cross-account, nol shared secret) — `AUTH_SIGNING_KEY` per-worker private, public keys di-share via `[vars] AUTH_PUBLIC_KEYS`
- Rate limit 60 req/min per IP via in-memory Map per Worker isolate
- Cron health-check + B2 eviction jalan hourly di akun-1 (`EVICTION_OWNER=1`)


## 8. Catatan opsional (2026-09-10)
- **akun-1 sengaja minim secret** (hanya `ALLOWED_ORIGINS` + `TURNSTILE_SECRET_KEY`) — akun-1 nopang web (`manga-web`) juga, jadi dijaga hemat. Login/B2 yang kena akun-1 akan fail ke worker lain (500 → failover) — by design, jangan dianggap gap.
- **Token CF tipe `cfut_`** tidak bisa POST (termasuk `wrangler secret put` → auth 10000/10405). Workaround: PUT raw API sebagai upsert:
  `curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"name":"SECRET","text":"...","type":"secret_text"}' .../workers/scripts/<name>/secrets`
- Deploy mapping: `wrangler.toml`=akun1, `wrangler.origin.toml`=akun2, `wrangler.origin3.toml`=akun3, `wrangler.origin4.toml`=akun4. Web deploy butuh Node 22 (wrangler 4).
