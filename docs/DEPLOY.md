# Manga Platform — Deploy

## Prasyarat
- Cloudflare account (D1, KV, Workers)
- **Node >=22.12 untuk toolchain web saja** (build/dev Astro + wrangler 4 untuk deploy web — Astro 7 tidak dukung Node 20). API worker memakai wrangler 3 dari root node_modules dan `wrangler dev` tetap jalan di Node 20.
- API worker: wrangler 3.114 dari root node_modules (jangan wrangler 4 + compat lama = error 1042)

## 1. Buat resources CF
```bash
npx wrangler d1 create manga-db           # catat database_id → wrangler.toml
npx wrangler kv namespace create CACHE_KV  # catat id → wrangler.toml
```
Update `apps/api-cf/wrangler.toml` dengan ID asli. Storage pakai Backblaze B2 (bukan R2) — credentials di-set via `B2_ACCOUNTS` secret JSON array.

## 1b. Web resources
Tidak ada. Web Astro (`apps/web`) auto-provision 1 KV `SESSION` saat deploy pertama
(`@astrojs/cloudflare` v14). ISR cache `NEXT_INC_CACHE_KV` zaman OpenNext sudah
tidak dipakai — namespace lamanya boleh dihapus dari dashboard setelah cutover.

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
⚠️ **Dua jalur, jangan dicampur.** `packages/db/schema.sql` adalah **baseline lengkap yang sudah current** — isinya sudah termasuk semua tabel/kolom yang pernah ditambahkan migrations, termasuk `_migrations` (baris 346) dan `lb_accounts.last_tested_at` (baris 262). Jadi:

| Keadaan D1 | Yang dijalankan | Yang TIDAK |
|---|---|---|
| **Fresh** (baru `wrangler d1 create`, belum ada data) | `schema.sql` (+ `seed.sql` opsional). **Selesai.** | numbered migrations |
| **Existing / pre-migration** (sudah ada data, belum pernah numbered migration) | `./scripts/migrate-all-4.sh` | `schema.sql` (itu baseline fresh — apply ulang akan bentrok dengan data) |

- **Fresh** — jangan menjalankan script migration sama sekali. D1 sudah punya `_migrations` tapi ledger-nya **kosong**, jadi script akan mencoba 0001–0020 di atas skema yang sudah lengkap dan gagal di myriad.
- **Existing** — ledger `_migrations` yang membedakan: file yang sudah tercatat dilewati, jadi script aman diulang dan hanya menjalankan yang kurang. Kalau `_migrations` kosong sementara D1 berisi data, itu DB pre-migration → jalankan script.
- Kalau ragu: cek dulu. `SELECT COUNT(*) FROM series` — `0` + tidak ada akun = fresh; selain itu = existing.

Semua command **dari repo root** (path relatif ke root; `--config` menunjuk file wrangler). `CFGS` = daftar config worker; samakan dengan `WORKER_CFGS` di `scripts/migrate-all-4.sh`.
```bash
# FRESH D1 — hanya ini
CFGS="apps/api-cf/wrangler.toml apps/api-cf/wrangler.origin.toml apps/api-cf/wrangler.origin3.toml apps/api-cf/wrangler.origin4.toml"
for cfg in $CFGS; do
  npx wrangler d1 execute manga-db --file=packages/db/schema.sql --remote --config "$cfg"
  # opsional, sample data:
  # npx wrangler d1 execute manga-db --file=packages/db/seed.sql --remote --config "$cfg"
done

# EXISTING / pre-migration D1 — hanya ini (0001–0020 + backfill, ledger-aware)
CF_TOKEN_AKUN1=... CF_TOKEN_AKUN2=... CF_TOKEN_AKUN3=... CF_TOKEN_AKUN4=... ./scripts/migrate-all-4.sh
```
Jangan pakai glob `packages/db/migrations/0*.sql`: dia mencakup 0001–0020 sekaligus (jadi 0013–0020 ikut jalan tanpa pernah ditinjau), melewatkan `backfill_entity_decode.sql` (namanya tidak mulai dengan `0`), menjalankan 0018 di posisi numerik bukan pertama, dan tidak lewat ledger sama sekali — jadi tidak aman diulang. Exit code script bukan 0 kalau ada file `FAILED` **atau** ada config tanpa `CF_TOKEN_AKUN{i}`; ulangi setelah perbaiki penyebabnya (file yang sukses sudah tercatat, jadi tidak diulang).


## 4. Deploy API (Worker)
```bash
cd apps/api-cf
npx wrangler deploy
```
Catat URL Worker (mis. `https://manga-api.<sub>.workers.dev`).

## 5. Deploy Frontend (Worker — Astro SSR + static assets)
```bash
cd apps/web
# Set API URL ke Worker deploy (client di-inline saat build; SSR baca process.env)
cat > .env.local <<'EOF'
PUBLIC_API_URL=https://manga-api.xxx.workers.dev
PUBLIC_AUTH_API_URL=https://manga-api-2.xxx.workers.dev
PUBLIC_SITE_URL=https://oktzz.xyz
PUBLIC_TURNSTILE_SITE_KEY=<sitekey>
EOF
npm run deploy   # = astro build && wrangler deploy (worker: manga-web)
```
Frontend jalan sebagai Worker dengan static assets (`@astrojs/cloudflare` v14 — Pages
tidak didukung lagi sejak adapter v13/Astro 6). Hybrid: halaman statis prerendered
(zero-JS), detail/reader/admin SSR per-request. `public/_headers` utk aset statis;
`src/middleware.ts` utk security headers response SSR. Detail: `apps/web/DEPLOY.md`.

## 6. Setup domain
- Custom domain di Worker frontend + Worker API
- (WAF zone TIDAK dipakai — free tier tanpa langganan Cloudflare; proteksi cukup dari lapisan worker: service-gate BFF + rate limiter + signed-img)
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
# Web (terminal lain) — Astro, bukan Next
cd apps/web && npx astro dev --port 3000
```
Node >=22.12 hanya diperlukan untuk perintah web (`astro dev`/`build`) — `wrangler dev` jalan normal di Node 20.

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

## 9. Hardening API: BFF service-token (2026-09-22)
- Worker API punya **BFF gate** (`apps/api-cf/src/lib/serviceGate.ts`, di-mount `apps/api-cf/src/index.ts` sebelum global rate limit): request `/api/*` tanpa jalur sah ditolak 403.
  Jalur sah per tier:
  - **EXEMPT** — `/api/health`, `/api/origins`, `/api/auth/*`, `/api/_internal/*` (guard PK forward-key sendiri), `/api/scrape` (requireAdminKey), `/img/*` (hotlink guard sendiri), legacy `/api/reader/:source/page/:chapterId/:pageNo` (gambar proxy).
  - **PUBLIC-READ** — `/api/search*`, `/api/series*`, `/api/homepage`, `/api/reader*`, `/api/manga`, `/api/source-status`, GET `/api/user/*`: service token **ATAU** Origin allowlisted (`ALLOWED_ORIGINS`) **ATAU** cookie session. `/api/search` sengaja di tier ini supaya pencarian tetap jalan buat tamu (web UI client-island mem-anggilnya langsung); bot tanpa Origin/UA tetap 403.
  - **SENSITIVE** — `/api/resolve`, `/api/identify`, `/api/admin/*`, mutasi `/api/user/*`: service token **ATAU** cookie session **ATAU** Turnstile valid (`?turnstile_token=` / header `x-turnstile-token`). `/api/resolve` dipakai SSR-only di reader (`getResolve`) sehingga aman di tier ini (SSR kirim token).
  - `/api/*` lain → 403. `/api/admin/*` diproteksi cookie session + role admin.
- **`SERVICE_TOKEN`** secret binding: nilai SAMA di worker web `manga-web` (untuk SSR: `serviceHeaders()` di `apps/web/src/lib/api.ts` + `sitemap.xml.ts`) dan semua worker API. Set via die-encrypt vars (`wrangler secret put SERVICE_TOKEN`); web tidak punya wrangler.jsonc → setelah `astro build`, pakai `dist/server/wrangler.json` untuk `wrangler secret put`. Client island tidak mengirim token (Origin/cookie/Turnstile dari sisi API).
- `verifyTurnstile` dipindah ke `apps/api-cf/src/lib/turnstile.ts` dan dipakai gate tier SENSITIVE (selain login `/api/auth/google`). Tanpa `TURNSTILE_SECRET_KEY` gate tetap aman (turnstileOk=false tanpa token; token ada + secret unset → dev-mode true, konsisten dgn login).
- **`SIGNED_IMG_SECRET`** (opsional, anti-scraping gambar, 2026-09-23): HMAC-SHA256 short-lived signature pada `/img/*` (`apps/api-cf/src/lib/signedImage.ts`). Chapter-detail mint `imgUrl=/img/...?exp=..&sig=..` (TTL 25 menit); route `/img/*` verify sebelum serve (403 no-store kalau gagal). **UNSET = perilaku lama** (tanpa signature, fail-open + warning sekali per isolate) — set nilainya SAMA di semua worker API via `wrangler secret put SIGNED_IMG_SECRET` kalau mau aktif; cukup untuk semua akun (satu nama secret), nilai boleh identik.

## 10. Dynamic-N multi-account config (2026-09-23)
Semua sharding/LB **tidak lagi menganggap jumlah account tetap**. N dibaca murni dari config (env `[vars]`); N=1 = no-op, N≥1 sah, dan deskripsi ini berlaku untuk N berapa pun.

- **Peer routing (API)** — `apps/api-cf/src/lib/peers.ts`: daftar peer = `PEER_URLS` (CSV, ordinal = index shard). `EXPECTED_PEER_COUNT` DIHAPUS; panjang apa pun valid.
  - N=1 → `ownerFor`/`backupOwnerFor` selalu self (tidak ada forward).
  - N=0 (kosong) → single-peer no-op router (warn).
  - ⚠️ **`PEER_URLS` harus IDENTIK (urutan sama) di semua worker account** — kalau berbeda, hash `murmur3_32(key) % N` memetakan ke index yang beda di tiap worker → silent owner-mismatch. Script `scripts/gen-peers-env.mjs` (kalau ada) / daftar manual wajib di-sync.
  - `PEER_INDEX` OOB / non-integer → warn + treat non-self (tidak crash).
- **B2 bucket pick** — `apps/api-cf/src/lib/b2Config.ts`: `pickB2AccountIdx` sudah `% N`, N=1 → selalu 0, N berapa pun deterministik.
- **Ring sharding (dipakai utk scheduler lama / eksperimen)** — `packages/shared/src/r2-routing.ts`: `buildRing`/`ringPick` sudah diimplementasikan + diuji N=0/1/2/5, TAPI **tidak di-wire** ke routing live (live routing tetap `murmur3_32 % N` supaya TIDAK ada remap chapter). Jangan di-wire tanpa migrasi re-upload B2 yang terencana.
- **Web CSP / round-robin** — `apps/web/src/lib/api.ts` `apiCspHosts()`: derive dari `PUBLIC_API_ORIGINS` (CSV origin lengkap), fallback = 4 host default saat ini (output identik sebelum var dibalik). `apps/web/src/middleware.ts` pakai itu utk `connect-src`. ⚠️ `apps/web/public/_headers` adalah **static** (tidak bisa template) → HARUS di-sync manual saat `PUBLIC_API_ORIGINS` berubah (duplikasi CSP dua layer = by design).
- **Script ops** — `scripts/gen-auth-keys.mjs`: jumlah worker dari `GEN_WORKERS` (CSV, default 4 nama saat ini). `scripts/migrate-all-4.sh`: daftar config dari `WORKER_CFGS` (whitespace-separated, default 4 toml saat ini); token `CF_TOKEN_AKUN{i}` mengikuti urutan index config.
- **Test N-proof** — `packages/shared/test/r2-routing.test.mjs` (N=0/1/2/5), `apps/api-cf/test/peers.test.mjs` (N=1/2 + kosong), `apps/api-cf/test/b2-pick.test.mjs` (N=1/2/5). `apps/web/test/round-robin.test.ts` jalankan dgn `TEST_ORIGINS` untuk menyimulasikan N lain (default 4).

## 11. Inventory resource dinamis (2026-09-25)
`/api/admin/inventory` (`apps/api-cf/src/routes/admin/inventory.ts`) menampilkan D1 / KV / Worker / B2 **live** per akun, bukan angka hardcode. N worker / N akun boleh berubah; tidak ada lagi asumsi "4" di UI.

- **Non-secret per worker** — tiap `apps/api-cf/wrangler*.toml` punya 4 var di `[vars]`, nilainya WAJIB sama dengan resource milik file itu sendiri:
  `CF_ACCOUNT_ID` = `account_id`, `CF_WORKER_NAME` = `name`, `CF_D1_ID` = `database_id` (d1_databases), `CF_KV_ID` = `id` (kv_namespaces). JANGAN salin id akun lain ke file lain. Dipakai sebagai identitas bridge peer → provider: peer hanya bisa melaporkan account/bucket **miliknya sendiri**.
- **Secret per worker** — `CF_INVENTORY_TOKEN` TIDAK BOLEH ada di toml mana pun; hanya lewat `wrangler secret put` (satu prompt per worker, nilai boleh sama antar-akun kalau satu token cukup):
  ```bash
  npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.toml
  npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.origin.toml
  npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.origin3.toml
  npx wrangler secret put CF_INVENTORY_TOKEN --config apps/api-cf/wrangler.origin4.toml
  ```
  Izin token (Account token/API token read-only): **Account Settings Read**, **Workers Scripts Read**, **D1 Read**, **KV Read**, **GraphQL Analytics Read**. Token yang kurang satu izin = read-only sebagian; inventory tetap jalan dalam mode degraded, bukan hard fail.
  ⚠️ Token tipe `cfut_` **tidak bisa** `wrangler secret put` (auth 10000/10405) — pakai workaround raw PUT di §8.
- **Cara baca `errorCode` (per resource)** — ini muncul di `data.accounts[].{account,worker,d1,kv}.state.errorCode`, **bukan** di `warnings`:
  - **403** (izin token kurang) → `"CF_HTTP_403"`. HTTP non-2xx apa pun jadi `CF_HTTP_<status>`, jadi 401/403/429 terbedakan dari masalah data.
  - **200 tapi isi tidak sesuai** (D1/KV/script tidak ada di akun itu, atau `CF_*_ID`/`CF_WORKER_NAME` menunjuk resource lain) → `CF_ACCOUNT_INVALID`, `CF_WORKER_INVALID`, `CF_D1_INVALID`, `CF_KV_INVALID`, `CF_KV_METRICS_INVALID`.
  - **200 tapi amplop provider aneh** (bukan `success:true` + `result`, atau GraphQL `errors`) → `CF_PROVIDER_ERROR`.
  - **var metadata tidak terisi** (`CF_ACCOUNT_ID`/`CF_WORKER_NAME`/`CF_D1_ID`/`CF_KV_ID` kosong, sementara token ada) → `CF_CONFIG_MISSING` + `degraded` (`adminInventory.ts:343-346`, `457-461`). Var metadata kosong = fallback yang wajar; `CF_CONFIG_MISSING` = token ada tapi tidak bisa cari resource-nya, itu bug config.
  - Tanpa token sama sekali: **tidak ada** `errorCode` — state `ok` + `source: "derived"`.
- **Semua `code` di `data.warnings`** (harus kosong kalau verifikasi lolos):

  | `code` | Arti | Penyebab |
  |---|---|---|
  | `INTERNAL_KEY_MISSING` | Tidak pernah mengirim request ke peer | `DB_FORWARD_KEY` kosong di worker ini (`peers.ts:101` — dicek sebelum fetch) |
  | `PEER_UNREACHABLE` | Fetch ke peer gagal sebelum dapat respons | network/DNS gagal, worker peer mati, atau timeout |
  | `PEER_HTTP_403` (atau `PEER_HTTP_<status>` lain) | Peer menjawab HTTP non-2xx | **`DB_FORWARD_KEY` tidak sama** dengan milik peer — route internal balas 403 `forbidden` (`routes/internal.ts:120`) |
  | `PEER_SCHEMA_INVALID` | Balasan peer tidak cocok schema | peer jalan versi lama (belum deploy) |
  | `SELF_COLLECT_FAILED` | Pengambilan inventory worker sendiri gagal | D1/KV worker tidak terjangkau |
  | `SELF_SCHEMA_INVALID` | Inventory worker sendiri tidak cocok schema | worker sendiri jalan versi lama |
  | `SELF_NOT_CONFIGURED` | Topology worker ini tidak punya `self` | **`PEER_INDEX` salah / di luar 0..N-1** → worker ini tidak pernah menandai dirinya sendiri, `consistent:false` |
  | `SELF_FLAG_MISMATCH` | Peer yang ditanya membalas `self:false` (seharusnya `self:true`) | Mapping `PEER_URLS`/`PEER_INDEX` koordinator beda dengan config worker tujuan — biasanya worker tujuan yang `PEER_INDEX`-nya rusak. Worker rusak itu sendiri melaporkan `SELF_NOT_CONFIGURED` |
  | `B2_CONFIG_INVALID` | Config B2 tidak bisa dibaca | `B2_ACCOUNTS` kosong, JSON rusak, atau **tidak ada satu pun akun** yang valid — yang terakhir dianggap invalid, bukan "nol bucket" |
  | `B2_INVENTORY_UNAVAILABLE` | `collectB2Inventory` sendiri gagal/lempar | bukan masalah config: collection-nya crash di luar jalur validasi config (bucket tidak bisa dibaca, dan sebagainya). Config salah = `B2_CONFIG_INVALID`, bukan kode ini |
  | `LB_REGISTRY_UNAVAILABLE` | `lb_accounts`/`lb_origins` gagal dibaca | **kolom `last_tested_at` belum ada** (`listAccounts` select kolom itu, `packages/db/index.ts:411` — artinya 0020 belum masuk D1 tsb, lihat §3), atau D1 tidak terjangkau |

  Kode provider (`CF_HTTP_403`, `CF_*_INVALID`, `CF_CONFIG_MISSING`) **tidak pernah muncul di `warnings`** — cek `state.errorCode` per baris.

- **Token kosong = fallback, bukan error** — tanpa `CF_INVENTORY_TOKEN` worker tetap jalan: D1/B2 dari data lokal, nama akun/worker `derived` dari `PEER_URLS`, dan UI menampilkan banner peringatan. KEEP: var metadata saja sudah cukup untuk fallback; `CF_INVENTORY_TOKEN` hanya menaikkan `source` jadi `live`.
- **Urutan aktivasi** (jangan dibalik):
  1. Pastikan tiap D1 punya `lb_accounts.last_tested_at`. D1 **fresh** (baru dibuat) sudah punya kolomnya dari `schema.sql` — tidak perlu apa-apa. D1 **existing** yang belum pernah numbered migration: jalankan `./scripts/migrate-all-4.sh` (ledger `_migrations` = probe `SELECT 1 AS applied … --json`, grep key `applied` di result + guard `PRAGMA table_info(lb_accounts)`), file yang sudah ada dilewati jadi aman diulang. ⚠️ **Jangan** apply ulang `schema.sql` ke D1 existing, dan **jangan** jalankan script migration ke D1 fresh — dua jalur, lihat §3.
  2. Deploy semua worker API dengan var metadata baru (deploy dulu, secret menyusul — `wrangler deploy` tidak menimpa secret).
  3. Set `CF_INVENTORY_TOKEN` per worker di akunnya (prompt, tanpa nilai di command).
  4. Verifikasi tiap worker (lihat blok verifikasi di bawah).
  5. Baru setelah itu boleh ubah `PEER_URLS` untuk menambah/mengurangi worker.
- **Verifikasi `/api/admin/inventory`** — WAJIB pakai `?refresh=1`; tanpa itu route served dari cache `admin:inventory:v2:<hash>` selama 5 menit (`CACHE_FRESH_MS`), jadi hasil lama bisa terbaca sebagai "beres":
  ```bash
  # di browser/curl dengan session admin (butuh cookie role=admin)
  GET /api/admin/inventory?refresh=1
  ```
  **Keempat syarat ini wajib terpenuhi, dan `stale` saja tidak cukup** — `stale` cuma menandai "ini bukan cache lama", bukan "datanya lengkap". Snapshot yang dikoleksi fresh tapi peer-nya ada yang gagal tetap `stale:false` (dan juga `warnings` terisi); yang bikin `stale:true` hanya jalur cache, yaitu `incomplete && !inconsistent && cached !== null` (`inventory.ts:325-329`). Jadi:
  1. `data.stale === false` — memastikan respons itu bukan cache lama (bukan bukti kelengkapan).
  2. `data.warnings` **kosong** — inilah yang membuktikan kelengkapan. Isi yang mungkin muncul (lengkap, 12 kode): `INTERNAL_KEY_MISSING`, `PEER_UNREACHABLE`, `PEER_HTTP_<status>` (termasuk `PEER_HTTP_403`), `PEER_SCHEMA_INVALID`, `SELF_COLLECT_FAILED`, `SELF_SCHEMA_INVALID`, `SELF_NOT_CONFIGURED`, `SELF_FLAG_MISMATCH`, `B2_CONFIG_INVALID`, `B2_INVENTORY_UNAVAILABLE`, `LB_REGISTRY_UNAVAILABLE` — arti dan penyebab tiap kode di tabel di atas.
  3. `data.topology.hash` **sama persis** di semua worker, dan `data.topology.consistent === true`. Hash beda **tidak** memunculkan warning — ia hanya menaikkan `consistent` ke `false` (`inventory.ts:310,326`), jadi cek kedua-duanya.
  4. tiap baris `data.accounts[]`: `account.state.source === "live"` dan `worker.state.source === "live"` (bukan `derived`), dengan `account.name` = nama akun asli di CF.
- **Test** — `node --test apps/api-cf/test/wrangler-inventory-config.test.mjs` (test ini mendeteksi sendiri semua `apps/api-cf/wrangler*.toml` lewat readdir: parity 4 var vs resource milik file yang sama, `CF_INVENTORY_TOKEN` tidak pernah ada di toml, tidak ada dua worker mengklaim resource yang sama, `.dev.vars.example` blank). Jalankan ulang tiap kali ganti/tambah `wrangler*.toml`.
- **Lokal** — `apps/api-cf/.dev.vars.example` punya 5 entri kosong (`CF_ACCOUNT_ID`, `CF_WORKER_NAME`, `CF_D1_ID`, `CF_KV_ID`, `CF_INVENTORY_TOKEN`) untuk `wrangler dev --local`. Salin ke `.dev.vars` dan isi seperlunya; **jangan** commit isinya (`.gitignore` sudah cover `.dev.vars`). `wrangler dev` sendiri tidak butuh Node 22 — syarat Node >=22.12 (§ Prasyarat) hanya untuk toolchain Astro/web (`npm run dev`/`build` di `apps/web`).

### 11a. Tambah worker / peer baru
⚠️ **Maintenance window wajib.** Mengubah N me-remap **seluruh** shard: `ownerFor` = `peers[murmur3_32(key) % N]`, jadi N=4→N=5 memindahkan sebagian besar key ke owner berbeda. Selama fleet tidak seragam N, worker A (N lama) forward ke index k berdasarkan N-nya, sementara worker B (N baru) menghitung owner berbeda untuk key yang sama → forwarding salah target / berputar. **Tidak boleh ada interval mixed-N.**

Aturan utama: **semua edit config selesai dulu, baru satu pun deploy.** Men-deploy worker dengan `PEER_INDEX`/lista peer yang belum final memunculkan mixed-N — dan `PEER_INDEX` salah tidak crash, hanya diam-diam jadi non-self router.

1. **Maintenance window dibuka** — traffic reader/resolve boleh downtime sebentar, atau dijadwalkan jam sepi. Yang penting tidak ada dua N hidup bersamaan.
2. **D1 baru worker itu = D1 fresh → `schema.sql` saja, JANGAN script migration** (`schema.sql` sudah termasuk `lb_accounts.last_tested_at` + tabel `_migrations`; lihat §3). Script tetap perlu dijalankan untuk **D1 fleet lama** yang belum numbered migration, supaya 0020 masuk di sana. Token bersifat **posisional** — `CF_TOKEN_AKUN{i}` untuk config ke-`i` di `WORKER_CFGS`, jadi jumlah keduanya harus sama:
   ```bash
   # D1 baru (fresh) — dari repo root
   npx wrangler d1 execute manga-db --file=packages/db/schema.sql --remote --config apps/api-cf/wrangler.<baru>.toml
   # D1 fleet existing yang belum 0020. Config baru sengaja TIDAK diikutsertakan:
   # D1-nya fresh, jadi tidak butuh numbered migration.
   WORKER_CFGS="apps/api-cf/wrangler.toml apps/api-cf/wrangler.origin.toml apps/api-cf/wrangler.origin3.toml" \
     CF_TOKEN_AKUN1=... CF_TOKEN_AKUN2=... CF_TOKEN_AKUN3=... ./scripts/migrate-all-4.sh
   # Kalau config baru ikut diikutsertakan, tambahkan juga CF_TOKEN_AKUN4 (atau sesuaikan).
   ```
   ⚠️ Kalau D1 baru dibuat lewat **auto-provision di panel admin**, jangan apply `schema.sql` manual — `packages/lb/provision.ts` sudah menjalankannya sendiri (langkah `schema.sql`) dan **sengaja tidak** menjalankan numbered migration, karena `schema.sql` sudah baseline lengkap. Verifikasi PRAGMA di langkah berikut tetap berlaku.
3. **Verifikasi D1 baru sebelum apa pun:** kolom harus ada, karena script tidak pernah menyentuhnya.
   ```bash
   npx wrangler d1 execute manga-db --remote --json \
     --command "PRAGMA table_info(lb_accounts)" --config apps/api-cf/wrangler.<baru>.toml
   ```
   Di output, `results` harus memuat baris dengan key `name` bernilai `last_tested_at`. Wrangler bisa mencetak JSON rapat (`"name":"last_tested_at"`) atau Pretty (`"name": "last_tested_at"`) — dua-duanya benar, yang penting value-nya muncul: `grep -o 'last_tested_at'`. Kalau tidak muncul, D1 itu bukan hasil `schema.sql` yang current.
4. **Siapkan SEMUA edit config (belum ada deploy sama sekali):**
   - **File baru** `apps/api-cf/wrangler.<baru>.toml`: `name` = `CF_WORKER_NAME`, `account_id` = `CF_ACCOUNT_ID`, `database_id` = `CF_D1_ID`, kv `id` = `CF_KV_ID` — semuanya milik akun/file itu sendiri, jangan copy-paste id akun lain. `PEER_URLS` = **lista final** (URL lama + URL baru, urutan final), `PEER_INDEX` = ordinal file baru di lista itu.
   - **Semua file existing**: `PEER_URLS` disamakan persis dengan lista final (urutan sama, byte sama), lalu `PEER_INDEX` dicek ulang — index worker yang ada tidak bergeser selama peer baru hanya **ditambahkan di akhir**.
   - `node --test apps/api-cf/test/wrangler-inventory-config.test.mjs` harus hijau. Test itu yang memastikan `PEER_URLS` identik di semua file dan `PEER_INDEX` = permutasi utuh 0..N-1.
5. **Deploy semua worker dalam window yang sama:** file baru dulu, lalu setiap file existing (`npx wrangler deploy --config <file>`). Kalau deploy di tengah-tengah dan satu worker gagal, fleet mixed-N — kembalikan semua worker ke commit config sebelumnya sebelum melanjut.
6. Set `CF_INVENTORY_TOKEN` di worker baru (`wrangler secret put` — bukan deploy).
7. Verifikasi `?refresh=1` di **semua** worker (`stale:false`, `warnings:[]`, hash sama, `consistent:true`, semua `source:"live"`).
8. **Baru** aktifkan origin akun baru. Provision di admin selalu membuat origin dengan `enabled=0` — origin baru TIDAK dilayani sampai operator mengaktifkannya di `/admin/settings` (arming manual). Ini yang membatasi blast radius selama N berubah.

### 11b. Hapus worker / peer
⚠️ **Tidak ada auto-cleanup.** Resource CF (worker, D1, KV) **tidak pernah** dihapus otomatis oleh sistem atau oleh step ini — penghapusan tetap keputusan operator, manual, di dashboard.

⚠️ **Data ownership berpindah.** Setelah N berubah, `murmur3_32(key) % N` remap shard: baris `chapter_pages`, D1 per-akun, dan session/shard lain yang tadinya milik worker keluar **ikut pindah** ke worker yang baru menjadi owner. Sebelum menghapus D1/KV worker yang keluar, **audit data orphan**: query D1 lama, pastikan tidak ada baris yang masih ditunjuk peer lain sebagai owner, baru hapus manual di dashboard.

1. **Maintenance window** + drain: pastikan tidak ada request yang sedang di-forward ke worker yang akan keluar (matikan LB/route dulu, atau jadwalkan jam sepi).
2. **Siapkan SEMUA edit config (belum ada deploy):**
   - Hapus URL worker tersebut dari `PEER_URLS` di **semua** file; urutan sisa **harus identik** di semua file.
   - Hitung ulang `PEER_INDEX` **tiap** file yang tersisa. Menghapus worker di tengah array menggeser semua index setelahnya; `PEER_INDEX` OOB tidak crash, tapi worker itu jadi "non-self router" (`peers.ts:51-54`) dan inventory melaporkan `SELF_NOT_CONFIGURED` + `topology.consistent === false` — penandanya cuma muncul lewat inventory, bukan error boot.
   - `node --test apps/api-cf/test/wrangler-inventory-config.test.mjs` harus hijau (`PEER_URLS` identik + `PEER_INDEX` permutasi 0..N-1 yang baru).
3. **Deploy semua worker sekaligus dalam window yang sama.** Mixed-N di sini sama berbahayanya dengan §11a.
4. Verifikasi `?refresh=1` di semua worker: `stale:false`, `warnings:[]`, hash sama, `consistent:true`, `topology.count` = N baru.
5. Audit data orphan di D1/KV worker yang keluar (lihat peringatan di atas).
6. **Baru** — kalau sudah yakin — hapus resource worker keluar **manual** di dashboard. Jangan pernah step ini menghapus D1/KV secara otomatis.
