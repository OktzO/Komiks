# Komiks — Platform Baca Komik & Novel Indonesia

> Baca manga, manhwa, manhua, dan novel bahasa Indonesia. Enam sumber komik independen
> plus tiga sumber novel, di-backbone 4 Cloudflare Workers di 4 akun Cloudflare berbeda,
> D1 sharded, dan penyimpanan Backblaze B2 multi-akun. Frontend Astro 7 (SSR on-demand
> + React islands) yang deploy sebagai satu Cloudflare Worker dengan static assets.

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Astro](https://img.shields.io/badge/Astro-7-orange?logo=astro) ![React](https://img.shields.io/badge/React_19-islands-282C34?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Hono](https://img.shields.io/badge/Hono-3-E36002)
![Backblaze B2](https://img.shields.io/badge/Storage-Backblaze_B2-E21E29?logo=backblaze&logoColor=white)

**Live:** [oktzz.xyz](https://oktzz.xyz)

---

## Daftar Isi

- [Apa yang aplikasi ini benar-benar lakukan](#apa-yang-aplikasi-ini-benar-benar-lakukan)
- [Menjalankan secara lokal](#menjalankan-secara-lokal)
- [Arsitektur](#arsitektur)
- [Alur data: dari klik sampai gambar](#alur-data-dari-klik-sampai-gambar)
- [Sistem 4 Worker](#sistem-4-worker)
- [Penyimpanan](#penyimpanan)
- [Modul komik](#modul-komik)
- [Modul novel](#modul-novel)
- [Cache](#cache)
- [Autentikasi](#autentikasi)
- [API](#api)
- [Halaman web](#halaman-web)
- [Admin](#admin)
- [Cron](#cron)
- [Rate limit](#rate-limit)
- [Database](#database)
- [Testing](#testing)
- [CI](#ci)
- [Deploy](#deploy)
- [Struktur repo](#struktur-repo)
- [Batasan yang diketahui](#batasan-yang-diketahui)
- [Dokumentasi lain](#dokumentasi-lain)

---

## Apa yang aplikasi ini benar-benar lakukan

Pengguna membuka `oktzz.xyz` dan tidak perlu tahu apa pun di bawah ini. Yang terjadi:

1. Halaman `/manga/{slug}` dirender server-side oleh satu Worker Astro. Sebelum halaman itu
   dirender, frontend menanyakan ke API worker mana pun yang sehat, mana yang punya data
   untuk slug itu.
2. API worker itu menjawab dari cache KV kalau ada. Kalau tidak, ia ambil dari D1, dan kalau
   D1 belum punya serial itu, ia scrape sumber aslinya lalu simpan.
3. Daftar chapter dirender. Setiap chapter punya daftar URL gambar dari sumber aslinya.
4. Browser meminta gambar satu per satu lewat `/img/...` — bukan langsung ke situs sumber.
   Worker lebih dulu melirik B2; kalau belum ada, ia ambil dari sumber, simpan ke B2, lalu
   serve. Dari situlah CDN Edge mengambil alih.
5. Bookmark dan riwayat synchronize ke D1 kalau user login, tetap jalan di device kalau tidak.

Enam sumber komik adalah situs-situs berbeda yang tidak saling tahu. Kenapa tidak satu
sumber? Karena masing-masing punya strengths (kelengkapan chapter, kesegaran upload,
keterbacaan di Reader) dan masing-masing akan drop rate limit kami kalau kami cuma ambil
dari satu. Jadi: coba semuanya, gabungkan, pilih yang terbaik per judul.

Tiga sumber novel dipisah di modul sendiri karena sifatnya berbeda — bukan manga, tidak ada
halaman gambar, dan ID chapter-nya berupa string yang tidak boleh dipecah.

---

## Menjalankan secara lokal

Butuh Node >= 20 untuk API, **Node >= 22.12 untuk web** (Astro 7 menolak versi di bawah itu),
dan [bun](https://bun.sh) (dipakai runner test web).

```bash
git clone git@github.com:OktzO/Komiks.git && cd Komiks
npm install

npm run dev:api                # Worker API → http://localhost:8787
npm run dev:web                # Astro      → http://localhost:4321
```

Worker butuh D1 dan KV yang sudah di-bind, plus secret yang sudah di-set. Panduan lengkap
termasuk migrate ada di [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Arsitektur

```
 4 Cloudflare Worker (round-robin, 4 akun berbeda)   Cloudflare Worker (Astro SSR + assets)
┌──────────────────────────────────────────┐      ┌──────────────────────────────────┐
│ akun-1  manga-api     web + fallback     │      │ apps/web  manga-web  (Astro 7)  │
│ akun-2  manga-api-2   API + storage      │◄────►│ src/pages, src/components,      │
│ akun-3  manga-api-3   API + storage      │      │ src/lib/api.ts (origin picker)  │
│ akun-4  manga-api-4   API + storage      │      └──────────────────────────────────┘
└──────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
   D1 × 4 database      CACHE_KV            Backblaze B2 × N akun
   (sharded by key)     (cache, cursor,     (gambar komik + cover novel)
                         usage, lock)

packages/
  db/        D1 client + schema + 22 migration + 1 backfill
  shared/    Zod types, murmur3, r2-routing, HTTP utils, mapStatusText
  sources/   6 adapter komik + 3 adapter novel
  lb/        enkripsi token akun + provisioning worker
  vision/    pHash + hamming distance (untuk identify)
```

Bedakan dua hal yang mudah tertukar:

- **akun** = akun Cloudflare. Tiap akun punya D1, KV, dan quota-nya sendiri. Ini yang
  bikin request dari empat tempat berbeda dan tidak bisa semuanya tumbang serumai.
- **worker** = kode yang jalan di satu akun. Empatnya kode-nya sama persis; yang beda
  cuma `[vars]`-nya (`PEER_URLS`, `PEER_INDEX`, `EVICTION_OWNER`).

### Urutan middleware di Worker API

 Dari `apps/api-cf/src/index.ts`:

```
securityHeadersMw   → nosniff, DENY, no-referrer, COOP
corsMw              → fail-closed; ALLOWED_ORIGINS kosong = tidak ada origin yang lolos
noStoreMw           → no-store untuk /api/_internal, /api/auth, /api/user, /api/admin, /api/scrape
rateLimitAdmin      → 600/menit, prefix /api/admin/*
rateLimitInternal   → 300/menit, prefix /api/_internal/*
  ↳ /api/_internal/* dan /img/* sudah punya guard sendiri, jadi TIDAK lewat gate di bawah
rateLimitImg        → 300/menit, prefix /img/*
serviceGateMw       → token BFF; hanya /api/* normal yang kena
rateLimit           → 60/menit, global (self-skip untuk /api/admin dan /api/_internal)
  ↳ baru di sini semua router di-mount
```

Dua akibat yang tidak intuitif dan sudah jadi perangkap beberapa kali:

- `/api/_internal/*` dan `/img/*` **tidak pernah** sampai ke `serviceGateMw` maupun
  `rateLimit` global, karena router-nya di-mount lebih dulu. Itu disengaja — keduanya
  high-volume dan punya guard sendiri.
- `rateLimit` global **self-skip** untuk prefix `/api/admin`, jadi `rateLimitAdmin` adalah
  satu-satunya pembatas di sana. Karena itu mount-nya harus `/api/admin/*`: Hono mencocokkan
  `use('/api/admin')` hanya pada path persis, dan `/api/admin/overview` tidak akan
  kena. Ada test yang mengunci bentuk mount ini — `apps/api-cf/test/rate-limit-mount.test.mjs`.

---

## Alur data: dari klik sampai gambar

### Halaman detail

```
GET /manga/naruto
  └─ SSR oleh manga-web
       └─ getResolve(slug)          → pilih origin yang sehat, round-robin
            └─ GET /api/resolve/:slug
                 ├─ D1?  manga_source_link
                 ├─ KV?   resolve:{slug}  (positive 300s / negative 300s)
                 └─ live?  coba tiap adapter satu per satu → persist di background
       └─ render header + chapter list
```

### Pembaca chapter

```
GET /manga/naruto/chapter-700
  └─ ReaderShell island
       └─ GET /api/reader/:source/series/:id/chapter/:chapterId
            └─ pages: [{ proxyUrl, imgUrl(signed), b2Url: null }]
                 └─ tiap halaman: GET /img/:source/:chapterId/:pageNo
                      ├─ HMAC signature + referer check
                      ├─ chapter_pages (row di shard owner) → r2_key + account idx
                      ├─ B2 hit?  → serve, Cache-Control immutable 1 tahun
                      └─ B2 miss? → Cloudflare Cache → upstream CDN → upload B2 (cache-aside)
```

`imgUrl` yang dikembalikan sudah ditandatangani HMAC dan berlaku 25 menit, jadi URL bisa
ditempel di `<img src>` tanpa(header yang exposes kredensial B2. Fallback ke `/img` selalu
ada, jadi kalau signature habis atau secret-nya belum di-set, gambar tetap muncul.

---

## Sistem 4 Worker

Empat worker, satu kode, empat akun. Yang membedakannya cuma variabel.

| Config | Akun | `PEER_INDEX` | Peran |
|---|---|---|---|
| `wrangler.toml` | akun-1 | 0 | Serve web, fallback API, **satu-satunya** yang menjalankan eviction + snapshot usage |
| `wrangler.origin.toml` | akun-2 | 1 | API + storage |
| `wrangler.origin3.toml` | akun-3 | 2 | API + storage |
| `wrangler.origin4.toml` | akun-4 | 3 | API + storage |

**Round-robin terjadi di client**, bukan di worker. `apps/web/src/lib/api.ts` menyimpan
pool origin di module cache + `sessionStorage`, mengambil satu per request, dan membuka
circuit breaker per origin yang gagal 2× berturut-turut (60 detik). Semua worker berjalan
dengan kode identik, jadi tidak ada yang perlu tahu worker mana yang "utama".

**D1 dipecah per key, bukan per tabel.** Yang dipecah:

| Data | Shard by | Kenapa |
|---|---|---|
| `chapter_pages` | `chapterId` | paling besar — satu row per halaman |
| `sessions` | `user_id` | semua session 1 user di 1 shard, jadi revoke/list cukup 1 baca |
| `novel_series` / `novel_chapters` | `seriesId` | id-nya single-segment by design |
| `_outbox` | lokal | antrean retry, tidak perlu dipakai bersama |

`ownerFor(key)` = `murmur3_32(key) % peers.length`. Kalau peer yang dituju tidak hidup,
operasi jatuh ke shard lokal (**row-healing**) — jaringnya dimatikan, bukan disalin. Itu
cukup untuk kekosongan sementara; kalau peer hilang permanen, sharding perlu di-re-shard,
dan itu belum diotomasi.

**Auth asimetris, bukan HMAC bersama.** Tiap worker punya private key ECDSA P-256 sendiri
(secret `AUTH_SIGNING_KEY`); public key keempat worker di-share lewat `[vars]`
`AUTH_PUBLIC_KEYS` yang sudah di-commit. Cookie membawa `kid`, jadi worker mana pun bisa
verify cookie buatan worker mana pun. Nol secret yang perlu di-sync lintas akun.

---

## Penyimpanan

100% Backblaze B2. R2 sudah dihapus total (migration `0012_drop_r2_last_access.sql`).

**Upload** = hash-pick. `pickB2AccountIdx = murmur3_32(b2Key) % accounts.length`, lalu kalau
gagal upload, wrap ke akun berikutnya. Idempoten karena key sama = overwrite. Kalau semua
akun gagal, sistem turun ke proxy-only: gambar dilayani langsung dari CDN sumber tanpa
disimpan.

**Serve** = B2-first, selalu server-side. `b2GetObject` membangun header SigV4 di worker;
kredensial tidak pernah sampai ke browser. Response `Cache-Control: public, max-age=31536000,
immutable` — URL-nya tidak berubah, jadi aman di-cache selamanya.

**Row cache-aside.** Baris yangyelaku disimpan di `chapter_pages` (b2Key + accountIdx) di
shard owner. Forward ke peer pakai `/api/_internal/db/exec`; kalau forward gagal, tulis
lokal.

**Quota & eviction.** Usage dihitung di KV (`b2:usage:{idx}`), quota default 10 GiB
(`B2_QUOTA_BYTES`). Saat usage > 80% (`B2_EVICTION_DAYS`, default 30 hari), objek yang
belum diakses > 30 hari dihapus sampai usage turun ke 70%. Trigger-nya: lazy tiap 100
request chapter, plus cron di akun-1 (hourly, dengan lock KV 10 menit).

**Novel cover** lewat pipeline yang sama persis — key `novel/covers/{seriesId}`, signed
`/img/novel/:seriesId`, `immutable` 1 tahun. Tidak ada jalur gambar kedua di sistem.

---

## Modul komik

### Enam adapter

| Source | Prioritas | Cara ambil | Mitigasi |
|---|---|---|---|
| **Komiku** | primary | regex HTML | UA browser saja — UA non-browser bikin stall |
| **BacaKomik.my** | fallback | regex HTML | Cloudflare Bot Fight → fallback Puppeteer via `MY_BROWSER` |
| **Thrive.moe** | fallback | `__NEXT_DATA__` JSON | UA saja (Next.js SSG) |
| **Shinigami** | fallback | JSON API `api.shngm.io` | tidak ada — API publik |
| **ManhwaIndo.my** | fallback | regex HTML | Cloudflare Bot Fight → fallback Puppeteer |
| **Webtoon** | fallback | mobile API `m.webtoons.com` | tidak ada |

Registry-nya di `packages/sources/index.ts`. Homepage memakai 5 sumber (Webtoon tidak),
search memakai keenamnya.

### Status yang jujur

Aturannya satu baris, di `packages/shared/src/status.ts`: **jangan pernah default ke
`'ongoing'`**. Sumber yang tidak memberi info status menghasilkan `'unknown'`, dan UI
merender `-`. Menebak "ongoing" membuat komik tamat terbaca masih jalan — kesalahan yang
lebih buruk daripada tidak tahu.

Adapter webtoon ikut aturan ini lewat mapper yang sama; label-nya bisa Korea (`연재` / `완결` /
`휴재`), jadi pola itu ada di `status.ts` dan bukan ditebak ulang di adapter.

### Update chapter 24 jam

Default-nya boros: setiap user yang membuka halaman menarik data dari sumber. Sekarang:

1. Fresh TTL untuk `series:full:` / `series:detail:` / `chapters:list:` = **24 jam**
   (dulu 10 menit). Selama 24 jam itu **nol request ke source**.
2. Setelah 24 jam, cache basi disajikan **instan** dan satu revalidate jalan di background.
3. Revalidasi itu: persist snapshot ke D1 (`chapter_count`, `last_scraped_at`, status),
   mirror daftar chapter ke cache, invalidate cache `/sources`.
4. Anti dobel: singleflight dua lapis — Map in-isolate (5 request = 1 fetch) + lock KV
   antar-isolate.

Kenapa 24 jam dan bukan lebih pendek? Karena sumber komik jarang update chapter, dan satu
request per chapter per 24 jam sudah cukup untuk menangkap update. Yang lebih pendek hanya menambah
rate-limit source tanpa menambah judul baru.

Singleflight KV bersifat best-effort: Cloudflare KV tidak punya atomic conditional-write,
jadi dua isolate di colo berbeda bisa dua-duanya fetch (worst case beberapa duplikat per
24 jam — harmless, karena write-nya idempotent). Kalau dedupe global keras dibutuhkan,
jalur upgrade-nya Durable Object.

---

## Modul novel

Terpisah dari komik karena sifatnya berbeda: tidak ada halaman gambar, chapter-nya prosa,
dan ID-nya bukan angka.

### Tiga sumber

| Source | Kemampuan | Cara penemuan | Chapter? |
|---|---|---|---|
| **novelid** | chapter | `browse()` — jalan seluruh katalog `/genre//page/{N}/` | ya |
| **gooddreamer** | metadata | `search()` via JSON API publik | tidak (coin-gated) |
| **noveltoon** | metadata | `search()` jalan listing genre, filter title di client | tidak (di balik app) |

`capability` menentukan apa yang boleh dilakukan sebuah adapter. Adaptor yang hanya punya kapabilitas metadata tidak akan pernah dipanggil untuk
mengisi chapter — dicek di level adapter, bukan di pemanggil.

novelid dan noveltoon cek `robots.txt` sebelum tiap fetch (cache di KV). gooddreamer
`robots.txt`-nya permisif, jadi tidak ada gate.

### Chapter ID yang tidak boleh dipecah

novelid memberi chapter id berbentuk `{slug}/{bab}`. String itu **dibuat** oleh upstream dan
dipakai sebagai `novel_chapters.id`. Tidak dipecah, tidak diurut ulang, tidak di-normalisasi.

Konsekuensi yang sudah menyakitkan: `Astro.params` memberikan *raw* segment, jadi id
composite terbaca sebagai `tekaburu%2F1` di situ. `getNovelChapter` meng-encode untuk path
API, jadi kalau halaman ini meng-encode lagi, permintaannya jadi `tekaburu%252F1` — dan
**setiap chapter 404**. Karena itu `src/lib/novelRoutes.ts` mendekode setiap segment tepat
sekali, dan dipakai oleh halaman, bukan `Astro.params` langsung.

### Tabel

`novel_series` — `id` (`{source}-{sourceSeriesId}`, TEXT PK, single-segment by design),
`source_series_id`, `source`, `title`, `author`, `genre` (JSON string, bukan relasi),
`status`, `cover_ref` (B2 key), `cover_fallback` (URL upstream), `synopsis`,
`created_at`, `updated_at`.

`novel_chapters` — `id` (`{series.id}:{source_chapter_id}`), `series_id`,
`source_chapter_id` (verbatim), `number`, `title`, `content`, `content_hash` (sha256,
hanya pembanding), `source_url`, `scraped_at`.

`updated_at` di `novel_series` adalah jam LRU sekaligus jam staleness.

### Cron novel

Dua langkah, keduanya di callback `scheduled()` yang sama, dan keduanya ber-budget dari
`lib/cronBudget.ts` terhadap **50 subrequest per invocation** di free plan.

**Step 1 — jelajah katalog** (`syncCatalog`). Budget 8.
Hanya satu worker yang jalan: `ownerFor('novel:catalog:crawl').self`, jadi tepat satu dari
empat membayar ongkos upstream. Baris ditulis ke D1 yang memiliki series-nya.

Biaya per baris: 1 untuk cek keberadaan, +1 untuk halaman series kalau `needsDetail`, +4
lagi kalau serial baru (cover GET + B2 PUT + write-forward). Baris yang sudah ada **hanya
di-gap-fill, tidak pernah di-upsert ulang** — kartu listing adalah sumber yang lebih lemah,
jadi menimpanya akan menurunkan kualitas data. Dua pengaman: baca owner sebelum INSERT, dan
`ON CONFLICT … COALESCE(NULLIF(excluded.col,''), novel_series.col)`.

Cursor disimpan di KV (`novel:catalog:cursor`, TTL 30 hari) dan **dikembalikan ke 0** saat
listing habis, sehingga novel yang baru terbit terlihat di penelusuran berikutnya.

**Step 2 — refresh chapter** (`refreshStaleSeries`). Budget 16, jalan di **semua** worker
karena masing-masing memegang sebagian katalog. 20 series per invocation, window 24 jam.

Series dianggap basi kalau `updated_at < now - 86400`, **atau** `updated_at = created_at`
dan belum punya chapter. Klausa kedua memberi serial baru satu kesempatan langsung alih-alih
menunggu sehari, dan dipakai sekali lalu berhenti berlaku karena setiap kunjungan menaikkan
`updated_at` — jadi ini bootstrap, bukan loop.

`refreshWindowFor` = budget − biaya per giliran (6), dan `refreshVisitsFor` =
`floor(budget / (6 + window))`. Window saja tidak membatasi invocation; baris di luar
jumlah itu bahkan tidak dibaca.

Bab dengan body kosong **dibuang**, bukan ditulis — kalau ditulis, `content_hash` akan
mencatat string kosong sebagai perubahan yang sah.

### Sharding novel

`murmur3_32(seriesId) % peers.length` — ring yang sama dengan `ownerFor()`. Baca lewat
`lib/novelShard.ts`, yang membungkus peer sebagai **facade D1 read-only** daripada menulis
SQL forwarding manual, jadi `novelDb` tetap memegang daftar kolom dan predicate-nya.

`novelDbFor` (route by series id) dan `novelDbOn` (route ke peer tertentu, dengan
callback `onUnreachable`) dipisah karena katalog tidak punya satu owner: `/api/novel/catalog`
menyebar ke self + semua peer, menggabungkan, dedupe by id, lalu sort ulang. Yang tidak
terjangkau dilaporkan, bukan dijawab dengan data shard sendiri — menjawab dengan baris
sendiri akan membuat shard yang tidak terbaca terlihat terjawab, diam-diam, karena id yang
dihasilkan itu milik shard itu dan lolos dedupe.

Katalog dibatasi 400 baris (`MERGE_WINDOW = 100` × 4 shard). Paginasi di luar itu menampilkan
katalog yang tidak lengkap — batas ini dicatat, bukan disembunyikan.

---

## Cache

Dua lapis, dengan stale-while-revalidate.

| Lapis | Default | Series/chapter | Isi |
|---|---|---|---|
| Fresh | 10 menit | **24 jam** | `series:full:`, `series:detail:`, `chapters:list:` |
| Stale | 24 jam | 7 hari | disaikan instan sambil revalidate |

Circuit breaker: 2 kegagalan berturut-turut → origin dilewati 60 detik. Peer fallback:
baca lokal → peer KV → upstream.

`readThroughCache(env, key, fetchFn, opts)` adalah wrapper generiknya. Dua lapis singleflight
untuk cold start: Map sinkron in-isolate (5 request = 1 `load()`, ada test-nya) + lock KV
antar-isolate (best-effort, lihat di atas).

**Tabrakan TTL yang diketahui:** `series:detail:{slug}` ditulis dengan TTL 600s oleh `routes/series.ts`
dan 86400s oleh `routes/reader.ts`. Writer terakhir menang, jadi efektifnya bergantung
urutan request, bukan desain. Belum dibersihkan.

---

## Autentikasi

**Google OAuth saja.** Tidak ada password.

```
GET /api/auth/google?turnstile_token=...
  └─ verifyTurnstile (siteverify, IP dicek di worker SEBELUM redirect OAuth)
       └─ 302 ke Google
            └─ GET /api/auth/google/callback
                 └─ cek state cookie (ECDSA-signed, TTL 10 menit)
                 └─ verifikasi id_token: aud, iss, exp
                 └─ upsert user, cek status (banned/suspended → 403)
                 └─ baris session di shard pemilik user_id
                 └─ set __Host-session (SameSite=None; Secure; HttpOnly)
```

Cookie `__Host-session` isinya payload b64url yang dipisah titik:
`{sid,uid,email,role,kid,iat,exp}.{ECDSA-sig}`. `kid` menunjuk private key mana yang harus
dipakai untuk verify — itulah yang membuat empat worker bisa saling verify tanpa shared
secret.

`getSessionUser` = verify signature → cek expiry → **satu** baca session di shard owner.
Fail-closed: row hilang = revoked. Tidak ada cache, tidak ada fallback.

**Turnstile gate.** Widget di `AuthForm.tsx` memakai **explicit render** — script URL wajib
`?render=explicit&onload=onTurnstileLoad`. Tanpa `&onload=` itu, widget tidak pernah muncul
dan halaman login diam saja. Kalau `PUBLIC_TURNSTILE_SITE_KEY` kosong, widget disembunyikan
dan gate mati (fail-open, supaya dev lokal tidak tersangkut). Kalau
`TURNSTILE_SECRET_KEY` ter-set tapi tidak di-set di keempat worker, verifikasi dilewati —
ini yang membuat bug paling sulit terdeteksi, jadi secret-nya di-set di keempat worker.

---

## API

81 route. Base URL salah satu worker; client memilih sendiri lewat round-robin.

### Publik — komik

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/health` | `{status, ts}` |
| GET | `/api/series` · `/api/series/:slug` · `/api/series/:slug/:chapterId` | katalog D1, KV 600s (chapter 300s) |
| GET | `/api/search?q=` | FTS5 + LIKE di D1, digabung dengan live search 6 sumber |
| GET | `/api/homepage` | feed gabungan, KV 12 jam |
| GET | `/api/manga/:id` | series + chapters + sources, KV 1 jam |
| GET | `/api/resolve/:slug` | slug kanonik → source + `recommendedSource` + daftar source lain |
| GET | `/api/source-status` | health + latency + uptime per sumber |
| GET | `/api/origins` | pool origin untuk round-robin |

### Publik — reader

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/reader/:source/series/:id/detail` | series + chapters, satu fetch upstream |
| GET | `/api/reader/:source/series/:id` | series saja |
| GET | `/api/reader/:source/series/:id/chapters` | daftar chapter |
| GET | `/api/reader/:source/series/:id/sources` | agregasi lintas sumber + `recommendedSource` |
| GET | `/api/reader/:source/chapter/:chapterId` | chapter + URL halaman (`proxyUrl`, `imgUrl` signed) |
| GET | `/api/reader/:source/page/:chapterId/:pageNo` | **legacy** image proxy |

### Publik — novel

| Method | Path | Keterangan |
|---|---|---|
| GET | `/api/novel/catalog` | katalog gabungan lintas shard, `?genre&page&limit` |
| GET | `/api/novel/series/:slug` | series + ringkasan chapter |
| GET | `/api/novel/series/:slug/chapters` | daftar chapter tanpa `content` |
| GET | `/api/novel/series/:slug/chapter/:chapterId` | prosa lengkap; re-scrape bila basi ≥ 24 jam |

### Image proxy

| Method | Path | Keterangan |
|---|---|---|
| GET | `/img/:source/:chapterId/:pageNo` | B2-first, signed + referer guard, immutable 1 tahun |
| GET | `/img/novel/:seriesId` | cover novel, B2, signed |

### Auth · user

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| GET | `/api/auth/google` · `/api/auth/google/callback` | Turnstile | OAuth |
| GET | `/api/auth/me` | — | guest-friendly, `{data:null}` kalau belum login |
| POST | `/api/auth/logout` | — | revoke session |
| GET/PATCH/DELETE | `/api/user/me` | session | profil; DELETE butuh `{confirm:"DELETE"}` |
| POST/DELETE | `/api/user/bookmark` · `/api/user/bookmark/:slug` | session | mutate 60/jam |
| GET/DELETE | `/api/user/bookmarks` | session | mutate 60/jam |
| POST/GET/DELETE | `/api/user/history` | session | riwayat baca |
| GET/DELETE | `/api/user/sessions` · `/api/user/sessions/:token` | session | manajemen session |
| POST | `/api/user/sessions/revoke-all` | session | revoke semua kecuali sekarang |

### Admin

| Method | Path | Keterangan |
|---|---|---|
| GET/PATCH | `/api/admin/users/:id` | moderasi `{status, role}`; ban/suspend → revoke semua session |
| GET | `/api/admin/dashboard/storage` · `/source-health` · `/requests` | trend 30 hari |
| GET | `/api/admin/inventory` | snapshot resource peer + lokal |
| GET | `/api/admin/saved` · `/admin/log` · `/admin/overview` · `/admin/db-usage` | agregat |
| GET/PUT/POST/DELETE | `/api/admin/lb/*` | settings, accounts, origins, provision |
| POST | `/api/admin/novel/catalog/sync` | paksa jalankan jelajah katalog; 409 kalau bukan crawler terpilih |
| GET/POST | `/api/admin/merge/queue/*` | antrean dedup (butuh admin key **dan** session) |
| POST/GET | `/api/scrape` · `/api/scrape/:job_id` | job scrape (butuh `x-admin-api-key`) |

### Internal

| Method | Path | Keterangan |
|---|---|---|
| POST | `/api/_internal/db/exec` | write lintas akun; allowlist 16 tabel; tolak stacked statement |
| POST | `/api/_internal/db/query` | SELECT-only; allowlist 11 tabel |
| GET/POST | `/api/_internal/kv/get` · `/kv/put` | peer read/write; allowlist prefix |

Guard: `x-db-forward-key` atau (`x-db-mirror-key` + `x-db-mirror: 1`).

---

## Halaman web

`output: 'server'`, jadi semua halaman SSR on-demand kecuali `/404` yang di-prerender.
Interaktivitas = React islands; sisanya HTML.

| URL | SSR | Isi |
|---|---|---|
| `/` | ✓ | hero spotlight, rail lanjut baca, genre pills, feed bento |
| `/search` | ✓ | hasil gabungan + saran |
| `/login` | ✓ | `AuthForm` island (Turnstile) |
| `/bookmark` · `/history` · `/profile` | ✓ | island; `no-store` |
| `/status` · `/status/:source` | ✓ | monitor sumber |
| `/manga/{slug}` | ✓ | detail + chapter list + source switcher, JSON-LD `Book` |
| `/manga/{slug}/{chapterId}` | ✓ | `ReaderShell` |
| `/novel` | ✓ | katalog, 24/halaman |
| `/novel/{slug}` | ✓ | header series + synopsis + chapter list |
| `/novel/{slug}/{chapter}` | ✓ | `NovelReader` island |
| `/admin/*` | ✓ | 7 halaman, semua `client:only="react"` |
| `/tos` | ✓ | ToS, rev 2026.09 |
| `/404` | prerender | — |

**Budget render.** Halaman detail komik punya budget 300ms sebelum menyerah dan menyerahkan
sisanya ke island yang mengambil sendiri. Halaman `/novel/[slug]` punya **900ms** —
pembacaannya melintasi dua worker (pool origins, lalu series) yang bersama-sama ~250–350ms,
dan tidak ada apa pun di halaman itu yang bisa memulihkan race yang kalah: header-nya
server-render saja, sehingga 300ms membuat separuh render jatuh ke skeleton tanpa penulis,
tanpa sinopsis, dan tanpa tombol baca.

**Redirect salah type** = 301 ke type yang benar (`Astro.redirect(..., 301)`). Format URL lama
`/{source}/s/{slug}` dihapus total, jadi 404.

**Aturan 404.** Halaman reader **tidak boleh** 404 server-side karena kegagalan transport.
Hanya upstream yang menjawab 404 yang boleh memicu 404. Outage Worker harus merender shell
(yang akan mencoba lagi), bukan memberi "bab tidak ditemukan" ke crawler.

---

## Admin

Tujuh halaman, semuanya `client:only="react"`, **bukan** `client:load` — island admin
yang di-SSR memakan 22–48ms CPU di isolate dingin, dan itu sempat memicu 503 yang terlihat
sebagai halaman hitam total. Setelah diubah, CPU turun ke 2–4ms. Island yang berat + `noindex`
memang tidak butuh SSR.

Isinya: dashboard (storage trend, source health, request count), monitoring (overview,
provider, scrape job, DB usage), user + moderasi, log, saved content, settings (termasuk LB
settings), dan pemicu sync katalog novel.

**Yang tidak ada.** Bandwidth/egress bytes tidak pernah dicatat, jadi grafik memakai
request count dari `lb_usage`. Tidak ada Analytics Engine, jadi gauge "uptime" adalah
agregat uptime sumber, bukan uptime worker. Tabel `provider_accounts` dan `scrape_jobs_log`
pernah tanpa writer — snapshot kini diisi cron, dua lainnya masih kosong. Grafik kosong ~2
jam pertama setelah deploy karena `db_usage_snapshot` butuh minimal 2 titik.

Moderasi user: ban/suspend ditolak di `requireAdminSession` (cek `status != active`) dan di
login (`account suspended`). Proteksi self-demote ada.

---

## Cron

`triggers.crons = ["0 * * * *"]` di keempat worker. Setiap langkah memutuskan sendiri worker
 mana yang menjalaninya:

| Step | Worker mana | Budget |
|---|---|---|
| Outbox flush | semua | 6 |
| Jelajah katalog novel | crawler terpilih saja | 8 |
| Refresh chapter novel | semua | 16 |
| Eviction + temp-object sweep + usage snapshot | **akun-1 saja** (`EVICTION_OWNER=1`) | 6 |
| Homepage feed refresh + peer push | **akun-1 saja** | 8 |

Total 44 dari 50 subrequest, sisa 6 sebagai slack. Semua angka ini ada di satu tempat,
`lib/cronBudget.ts`, karena workers free plan mengizinkan 50 subrequest **per invocation** —
bukan per langkah, jadi kelimanya mengambil dari ukuran yang sama. Plan berbayar
mengizinkan 1000: naikkan `CRON_SUBREQUEST_CAP` dan angka langkahnya ikut naik.

Kelima langkah ini dulu berdiri sendiri dan masing-masing mengambil hampir seluruh kuota.
"Too many subrequests" tidak bisa ditangkap — runtime menjatuhkan invocation-nya, sehingga
langkah setelahnya tidak pernah jalan sama sekali. Bug-nya berpindah, bukan hilang.

**Outbox** adalah antrean retry untuk write yang gagal forward. Diurutkan `attempts ASC,
id ASC`, bukan `id ASC` saja: baris diurutkan sesuai urutan kerja masuk, jadi baris untuk
peer yang dikonfigurasi tapi tidak terjangkau memiliki id terendah — dan slice dua baris
artinya baris itu *adalah* slice-nya, di setiap tick, selama 50 jam. Peer di sebelahnya
sehat selama itu dan tidak pernah tersentuh. Diurutkan berdasarkan attempts, baris yang baru
gagal placement-nya di belakang semua yang belum dicoba. Baris yang sudah mencapai batas
dicatat lalu dibuang — membiarkannya menuju target yang tak akan kembali adalah starvation
yang sama dengan kalimat yang lebih panjang.

---

## Rate limit

Enam limiter, semuanya counter in-memory per Worker isolate (bukan KV — GET+PUT ke KV per
request menghabiskan kuota terlalu cepat). Kunci = `{ip}:{windowStart}`, di-GC tiap 10 detik.

| Limiter | Limit | Dipasang di |
|---|---|---|
| `rateLimit` | 60 / menit | `app.use('*')` — global, self-skip `/api/admin` + `/api/_internal` |
| `rateLimitIdentify` | 10 / menit | `app.use('/api/identify')` |
| `rateLimitAdmin` | 600 / menit | `app.use('/api/admin/*')` |
| `rateLimitMutate` | 60 / jam | `POST/DELETE /api/user/bookmark*` saja |
| `rateLimitImg` | 300 / menit | `app.use('/img/*')` |
| `rateLimitInternal` | 300 / menit | `app.use('/api/_internal/*')` |

GET bookmark dan GET history **tidak** dibatasi `rateLimitMutate` — hanya mutasinya. Tanpa
pemisahan itu, user yang membuka halaman bookmark beberapa kali akan kena 429.

Efektif per prefix (hasil reproduksi dengan Hono 3.12.12):

| Prefix | Yang benar-benar jalan |
|---|---|
| `/api/_internal/*` | 300/menit saja |
| `/img/*` | 300/menit saja |
| `/api/admin/merge/*`, `/api/admin/inventory` | 600/menit |
| Route `/api/admin/*` lain | **600/menit** (sejak mount diperbaiki ke `/api/admin/*`; sebelumnya tidak ada limiter sama sekali) |
| `/api/identify` | 60/menit **dan** 10/menit |
| `/api/scrape` | 60/menit **dan** 600/menit → 60 yang mengikat |
| `/api/scrape/:job_id` | 60/menit |
| Sisanya | 60/menit |

---

## Database

22 file migration (`0001`–`0021` + `backfill_entity_decode.sql`), plus `schema.sql` yang
sudah berisi hasil akhirnya. Dijalankan ke keempat D1 lewat `scripts/migrate-all-4.sh`.

Tabel utama: `series` (+`series_search` FTS5), `chapters`, `chapter_pages`, `users`,
`sessions`, `bookmarks`, `reading_history`, `image_hashes`, `manga_source_link`,
`manga_merge_queue`, `novel_series`, `novel_chapters`, `scrape_jobs`, `scrape_jobs_log`,
`source_health`, `db_usage_snapshot`, `lb_settings` / `lb_accounts` / `lb_origins` /
`lb_usage` / `lb_audit_log`, `b2_usage`, `b2_temp_objects`, `_outbox`, `_migrations`.

`security_events` pernah ada (0013) lalu di-drop (0019) — DROP itu adalah catatannya, bukan
sisa. `chapter_pages_new` dibuat dan di-rename dalam satu migration (0007), juga by design.

Status di DB menerima 4 nilai; `'unknown'` tidak ada di CHECK constraint dan di-sanitize
`upsertSeries` saat persist — status yang diketahui tidak pernah tertimpa oleh yang tidak
diketahui.

---

## Testing

65 file test. Semuanya unit / parser test tanpa jaringan.

```bash
# Worker API — 31 file
npm --prefix apps/api-cf test

# Web — 9 file, runner bun
npm --prefix apps/web test

# Packages
npm --prefix packages/db test
npm --prefix packages/sources test
npm --prefix packages/lb test
npm --prefix packages/vision test

# node:sqlite, butuh Node >= 22.13 (unflagged) — tidak bisa di job Node 20
npm --prefix packages/db run test:sqlite

# shared: tidak punya test script, dipinjam tsx milik db
packages/db/node_modules/.bin/tsx --test packages/shared/test/*.test.mjs

# Typecheck
cd apps/api-cf && npx tsc --noEmit
cd apps/web    && npx astro check    # butuh Node >= 22.12
```

Sebagian test sengaja menguji hal yang mustahil diuji runner biasa — `readThroughCache.test.mjs`
membuktikan 5 request bersamaan = 1 `load()`; `novel-chapter-page.test.ts` menjalankan
frontmatter halaman Astro yang asli dengan `Astro` palsu dan `fetch` perekam, lalu
memeriksa URL yang keluar. Itu yang menangkap regresi chapter-id: `resolveNovelRoute` benar
sendiri, dan tidak pernah disentuh halaman yang memang sedang diuji.

`packages/vision` butuh runtime Worker untuk menguji pHash/aHash (`OffscreenCanvas` tidak
ada di Node), jadi yang diuji hanya hamming distance. Jalur fallback `ahash` — yang aktif
setiap kali pHash melempar error — belum punya test.

---

## CI

Dua workflow, keduanya jalan di push dan pull_request.

**`tests.yml`** — dua job:

- `node20`: api-cf, db, sources, lb, vision, shared, plus test untuk `scan-secrets` dan
  `ci-baseline`. lb dan vision sebelumnya punya test file tapi tidak punya test script,
  jadi tidak ada yang pernah menjalankannya.
- `node22` (**22.13**): web test, web build, db `test:sqlite`, lalu `astro check` yang
  output-nya dipipe ke `scripts/ci-baseline.mjs`.

Node 22 di-pin ke floor-nya, bukan `latest`, supaya pemakaian API Node yang lebih baru gagal
di sini dan bukan di mesin deploy. Floor itu 22.13, bukan 22.12 milik Astro, karena
`node:sqlite` masih di balik `--experimental-sqlite` sampai 22.12.

`astro check` keluar dengan kode 1 untuk "ada error" tanpa menyebutkan yang mana, jadi
tidak bisa dipakai sebagai `run` biasa. `ci-baseline.mjs` mengunci error yang sudah ada
berdasarkan posisi, dan gagal kalau ada error baru — **dan juga kalau error yang dikunci itu
hilang**, supaya daftar itu tidak bisa outlive penyebabnya.

**`secrets.yml`** — pemindai secret, bukan deploy. Test scanner-nya dijalankan lebih dulu,
baru scanner-nya: kumpulan aturan yang diam-diam tidak lagi mencocokkan apa pun akan lolos CI
sambil memindai tidak ada. Tidak ada build, tidak ada deploy, tidak menyentuh Cloudflare.

---

## Deploy

```bash
# Worker API — 4 akun. wrangler 3.114 dari root WAJIB:
# wrangler 4 + compatibility_date lama membuat worker 500 (error 1042).
node scripts/build-worker-bundle.mjs
npx wrangler deploy --config apps/api-cf/wrangler.toml          # akun-1
npx wrangler deploy --config apps/api-cf/wrangler.origin.toml   # akun-2
npx wrangler deploy --config apps/api-cf/wrangler.origin3.toml  # akun-3
npx wrangler deploy --config apps/api-cf/wrangler.origin4.toml  # akun-4

# Web — Node >= 22 + wrangler 4
cd apps/web && npm run deploy    # astro build && wrangler deploy

# Migration ke keempat D1
./scripts/migrate-all-4.sh       # CF_TOKEN_AKUN1..4 ada di env
```

⚠️ `apps/web` **tidak punya** `wrangler.toml`. Setelah `astro build`, config-nya ada di
`dist/server/wrangler.json` — `wrangler secret put` harus diarahkan ke sana. Ini tercatat di
`docs/DEPLOY.md`. Menjalankan `wrangler deploy` di `apps/web` tanpa configsinya berarti yang
terpakai adalah default wrangler, bukan punyamu.

Detail operasional ada di [`docs/DEPLOY.md`](docs/DEPLOY.md) dan
[`docs/ADDING-ACCOUNT.md`](docs/ADDING-ACCOUNT.md).

---

## Struktur repo

```
Komiks/
├── apps/
│   ├── api-cf/                # Worker API (Hono)
│   │   ├── src/index.ts      # pipeline middleware + mount router
│   │   ├── src/routes/        # 14 router + routes/admin/ (9 router)
│   │   ├── src/lib/           # cache, B2, shard, rate limit, cron
│   │   ├── test/              # 31 file
│   │   └── wrangler*.toml     # 4 config, satu per akun
│   └── web/                   # Astro 7
│       ├── src/pages/         # 24 halaman + 2 endpoint (.ts)
│       ├── src/components/    # 31 entri, island React + komponen view
│       ├── src/lib/api.ts     # client: origin picker, typed URL, signature
│       ├── src/middleware.ts  # CSP + no-store per halaman privat
│       └── test/              # 9 file
├── packages/
│   ├── db/                    # D1 client, schema.sql, 22 migration
│   ├── shared/                # Zod types, murmur3, r2-routing, status
│   ├── sources/               # 6 adapter komik + 3 adapter novel + registry
│   ├── lb/                    # enkripsi token + provisioning worker
│   └── vision/                # pHash + hamming
├── scripts/                   # 15 file: build, migrate, smoke, CI gate, scan secrets
├── docs/                      # DEPLOY, ADDING-ACCOUNT, TOS-REVIEW, audit
│   └── superpowers/           # specs/ (25) · plans/ (23) · backlog/ (1)
└── .github/workflows/         # tests.yml · secrets.yml
```

---

## Batasan yang diketahui

Hal-hal yang sengaja tidak diselesaikan, dan sebaiknya diketahui sebelum mengubahnya:

- **Read-through cache bentrok.** `series:detail:{slug}` ditulis dengan TTL 600s oleh
  `routes/series.ts` dan 86400s oleh `routes/reader.ts`. Writer terakhir menang, jadi TTL
  efektifnya bergantung urutan request.
- **Dedupe global keras belum ada.** Singleflight antar-isolate lewat KV tidak atomic.
  Worst case beberapa fetch duplikat per 24 jam, dan write-nya idempoten. Durable Object
  adalah jalur upgrade-nya.
- **`altTitles` diterima lalu diabaikan** oleh `dedupeOnIndex`. `matchCandidate` hanya
  menilai `title` yang masuk, padahal ia membaca `alt_titles` tiap kandidat — jadi serial
  yang judul alternatifnya yang cocok tidak akan ter-merge. Memperbaikinya berarti
  menurunkan skor fuzzy pada beberapa kasus, jadi ini keputusan soal ambang merge, bukan
  sekadar pembersihan.
- **Phash/aHash belum punya test.** Butuh `OffscreenCanvas` yang hanya ada di runtime
  Worker. Jalur fallback yang aktif setiap kali pHash gagal tidak ter-cover.
- **Batas merge katalog novel 400 baris.** Pager di luar itu menampilkan katalog tidak
  lengkap. Batas ini konsekuensi `MERGE_WINDOW`, bukan pilihan desain.
- **Sharding belum bisa di-re-shard otomatis.** D1 yang hilang permanen butuh intervensi
  manual; fallback-nya hanya menutup kekosongan sementara.
- **Tabel `provider_accounts` dan `scrape_jobs_log` masih kosong** di jalur yang tidak
  ditulis cron.
- **Tidak ada metrik bandwidth.** Data egress tidak pernah dicatat; grafik admin memakai
  request count.
- **`specs/` (25) dan `plans/` (23) lebih banyak dari yang dijalankan.** Beberapa
  menjelaskan keputusan yang sudah berubah; `README.md` ini dan
  `.opencode/skills/manga/SKILL.md` yang menggambarkan kode seperti adanya.

---

## Dokumentasi lain

| Dokumen | Isi |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Panduan deploy lengkap: D1/KV, secrets, migration, domain/WAF, operasional |
| [`docs/ADDING-ACCOUNT.md`](docs/ADDING-ACCOUNT.md) | Menambah akun B2 + akun Worker API |
| [`docs/TOS-REVIEW.md`](docs/TOS-REVIEW.md) | Checklist review ToS/AUP Cloudflare sebelum production |
| [`docs/2026-08-19-frontend-audit.md`](docs/2026-08-19-frontend-audit.md) | Audit frontend: dead code, bundle, memory leak |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | 25 design doc, satu per fitur besar |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | 23 implementation plan (checkbox per task) |
| [`docs/superpowers/backlog/`](docs/superpowers/backlog/) | Backlog risiko tinggi |
| [`.opencode/skills/manga/SKILL.md`](.opencode/skills/manga/SKILL.md) | Reference untuk AI assistant: arsitektur, modul, deploy, gotcha |

---

## Lisensi

[MIT](LICENSE)
