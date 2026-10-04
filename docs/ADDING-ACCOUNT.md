# Menambah Akun B2 Baru (dan Akun Worker API)

> Untuk menambah/mengurangi **worker API** (perubahan jumlah peer `PEER_URLS`),
> ikuti `docs/DEPLOY.md` §11a (tambah) / §11b (hapus) — bukan daftar di bawah.
> Perubahan N me-remap semua shard `murmur3_32 % N`, jadi harus lewat maintenance
> window terkoordinasi, bukan langsung deploy.

## B2 storage (gambar komiku)

1. Buat bucket (misal `manga-images`) di Backblaze B2 akun baru
2. B2 application key: access **Read & Write** untuk bucket tsb
3. Update secret `B2_ACCOUNTS` di **semua worker** — tambah entry JSON
   (`name`/`bucket`/`keyId`/`appKey`/`region`). **Append di akhir array** —
   jangan reorder: `r2_account_idx` (-1, -2, ...) di `chapter_pages` memetakan
   posisi array, reorder = salah bucket. Set via raw API
   `PUT .../workers/scripts/{name}/secrets` (name `B2_ACCOUNTS`, type `secret_text`).
4. Urutan list TIDAK berpengaruh untuk correctness (hash pick deterministik
   by key), tapi jaga `B2_CONFIG` (legacy single) konsisten dengan
   `B2_ACCOUNTS[0]`
5. Triple-check: seluruh worker mendapat **nilai JSON yang identik** (hash
   pick + index mapping harus konsisten lintas worker)
6. Verifikasi: upload via `/api/reader/*` → `b2:usage:{idx}` bertambah di KV;
    `curl -I https://s3.<region>.backblazeb2.com/<bucket>/<key>` → 200

## Akun Worker API (origin rotasi per request)

- Provision via panel admin LB (auto-provision) atau manual
- ⚠️ Untuk menambah worker API: **`docs/DEPLOY.md` §11a** (maintenance window, deploy
  semua worker dengan `PEER_URLS` identik, verifikasi `?refresh=1`, baru enable origin)
- `CF_ACCOUNT_ID` / `CF_WORKER_NAME` / `CF_D1_ID` / `CF_KV_ID` di `wrangler.<baru>.toml`
  wajib diisi dari resource file itu sendiri — jangan copy-paste id akun lain

### Checklist secret (WAJIB — ini yang paling sering luput)

Secret bersifat write-only dan `wrangler deploy` **tidak gagal** kalau ada yang hilang.
Worker tetap ter-deploy dan melayani traffic, lalu gagal hanya di jalur yang membaca
secret itu — dan gejalanya kelihatan acak, karena proxy merotasi request ke semua worker.
Ini bukan teoritis: `manga-api` pernah berjalan tanpa `AUTH_SIGNING_KEY`, dan
tidak ada mekanisme di repo yang bisa mendeteksinya.

- [ ] `node scripts/gen-auth-keys.mjs` → dapat private key untuk worker baru di
      `apps/api-cf/.auth-keys.json` (gitignored)
- [ ] Public key worker baru **ditambahkan** ke `AUTH_PUBLIC_KEYS` di **keempat** toml.
      Kalau satu worker tidak punya `kid` milik worker lain, cookie worker itu ditolak
      diam-diam dan terbaca sebagai logout acak. Dijaga oleh
      `apps/api-cf/test/worker-parity.test.mjs`.
- [ ] Private key di-set sebagai secret `AUTH_SIGNING_KEY` **via `wrangler secret put`**
- [ ] `AUTH_SIGNING_KEY`, `DB_FORWARD_KEY`, `SERVICE_TOKEN`, `SIGNED_IMG_SECRET`,
      `ALLOWED_ORIGINS`, `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
      `TURNSTILE_SECRET_KEY` ada di worker baru
- [ ] `DB_FORWARD_KEY` **nilai sama** dengan worker lain. Auth bergantung pada ini:
      bacaan session milik user yang shard-nya di worker lain butuh forward, dan
      forward 403 (key beda) bikin hasilnya fail-closed → logout.
- [ ] `PEER_URLS` identik di keempat toml, dan `PEER_INDEX` worker baru = posisinya
      di list itu
- [ ] Terakhir: `node scripts/check-worker-secrets.mjs` — keluarannya harus `ok` untuk
      semua worker

### Yang TIDAK ada lagi: CORS

Dulu ada checklist CORS per akun (`ALLOWED_ORIGINS`, preflight `OPTIONS`, echo
`Access-Control-Allow-Origin`). **Semuanya dihapus** — `corsMw` tidak lagi di
`apps/api-cf/src/index.ts` dan `serviceGateMw` mengabaikan `Origin` sepenuhnya.
Browser tidak pernah bicara lintas origin ke API karena semuanya lewat proxy BFF
same-origin di `oktzz.xyz`. `ALLOWED_ORIGINS` masih dipakai, tapi hanya untuk
`oauthRedirectUri()` (nilai pertamanya jadi callback URL OAuth).

Verifikasi yang benar sekarang:

```bash
# harus 403 — request tanpa token
curl -s -o /dev/null -w '%{http_code}\n' https://<origin>/api/user/me

# lewat proxy, harus 200
curl -s -o /dev/null -w '%{http_code}\n' https://oktzz.xyz/api/user/me
```

### Endpoint yang boleh dipanggil lintas origin

Allowlist persis di `apps/web/src/lib/api.ts` (`ORIGIN_PATH_ALLOWLIST`, dicocokkan dengan
`path.startsWith`, jadi itu **prefix**, bukan path persis):
`/api/reader/`, `/api/series`, `/api/search`, `/api/homepage`, `/api/health`,
`/api/resolve`, `/api/novel/`. Jadi `/api/series/:slug` ikut ter-cover oleh prefix
`/api/series`. Yang **tidak** ada di allowlist (sengaja, hanya ke main API):
`/api/source-status` — `source_health` dicatat per-akun jadi harus konsisten
dari akun-1 — serta semua `/api/admin/*` dan `/api/scrape`, yang tidak pernah
dipanggil dari klien. Tambah path baru? Tambah di `ORIGIN_PATH_ALLOWLIST`
dulu, jangan di doc ini saja.

Allowlist ini hanya mengatur **rotasi worker dari sisi server** (SSR). Di browser,
seluruh `/api/*` lewat proxy dan rotasi dilakukan proxy.

## Hash konsisten

Hash function = satu file `packages/shared/src/r2-routing.ts` (murmur3_32 +
`b2KeyFor`), di-import sisi scraper (Worker API) dan frontend (web worker
Astro). Tidak ada duplikasi → tidak ada drift.
