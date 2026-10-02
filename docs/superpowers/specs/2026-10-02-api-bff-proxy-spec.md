# API BFF Proxy — mengunci worker API ke satu-satunya pintu

## Masalah

Worker API (4 akun, `manga-api` sampai `manga-api-4`) bisa dipanggil siapa saja dari internet. Yang memasang rem sekarang:

1. **CORS di `index.ts:47`** (`corsMw`) — hanya mengatur *response header*. Request tetap dieksekusi server-side. Header `Origin` bukan bukti asal request; bot/curl bebas memalsukannya.
2. **`serviceGate.ts:101`** (`decideServiceGate`) — untuk tier `public-read`, lolos bila `hasValidOrigin`, yaitu `Origin` match allowlist. Karena `Origin` bisa dipalsuin, `curl -H "Origin: https://oktzz.xyz" /api/series` tetap dapat 200.
3. **Hotlink guard `/img/*`** (`reader.ts:922`) — reject referer non-allowlist, tapi missing-referer diizinkan (dibutuhkan karena `Referrer-Policy: no-referrer`).

Prinsip yang berlaku sekarang: "request harus **terlihat** datang dari web". Yang benar: "request harus **terbukti** datang dari web".

## Prinsip

Satu pintu masuk: `manga-web` (Astro SSR). Browser tidak pernah bicara langsung ke worker API. Worker API menolak semua yang tidak membawa `x-service-token` — tanpa melihat `Origin` sama sekali.

```
browser ──(same-origin, cookie Lax)──► oktzz.xyz/api/*
                                         │ Astro endpoint: buang token masuk,
                                         │ sisipkan token sendiri, teruskan
                                         ▼
                                    manga-api-* ──► hanya SERVICE_TOKEN yang lolos
                                         ▲
                                         │ <img src> (HMAC signature, bukan header)
                                         └── /img/* dit-serving langsung ke browser
```

Yang **tidak** berubah: SSR tetap 2 hop (seperti sekarang). `/img/*` tetap 1 hop. Yang berubah: panggilan client-island (bookmark, admin, `/me`) dari 1 hop jadi 2 hop.

Zero Worker baru. `manga-web` yang sudah ada jadi proxy-nya.

## 1. Worker API — token-only

### 1a. `serviceGate.ts` — buang jalur Origin

`decideServiceGate` kehilangan cabang `hasValidOrigin`. `ServiceGateInput` kehilangan field `hasValidOrigin`. `classifyServiceTier` kehilangan tier `public-read`; sisanya (`exempt` / `sensitive` / `deny`) tetap.

Tier `sensitive` collapse ke `deny`: tidak ada lagi tamu yang bisa mencapai gate tanpa token. Cookie session hanya sampai ke worker API lewat proxy yang sudah memegang token, jadi cabang "session cookie" di gate juga tidak lagi dibutuhkan untuk keputusan allow/deny — `requireSession` di dalam route tetap memeriksa ulang (defense in depth, dan itu benar karena `exempt` bisa bocor).

Tier `exempt` menyisakan yang sudah punya credential sendiri:

| Path | Kunci |
|---|---|
| `/api/_internal/*` | `x-db-forward-key` / `x-db-mirror-key` |
| `/api/scrape*` | `requireAdminKey` (`x-admin-api-key`) |
| `/img/*` | signature HMAC (§3) |
| `/api/health`, `/api/origins` | dipanggil client-side (§7) |
| `/api/auth/*` | state cookie ECDSA + Turnstile (§6) |

HEAD/OPTIONS tetap exempt.

### 1b. `index.ts` — hapus `corsMw`

Tidak ada lagi panggilan browser lintas origin, jadi CORS tidak punya arti. Menghapusnya yang benar-benar mematikan kelas serangan CSRF, bukan hanya menyembunyikan gejalanya.

`securityHeadersMw` tetap. `noStoreMw` tetap di 4 prefix yang sama.

## 2. Proxy di `manga-web`

Satu endpoint: `apps/web/src/pages/api/[...path].ts`, `prerender = false`.

Berurutan:
1. **Buang token masuk.** Header `x-service-token` dari client selalu dihapus sebelum meneruskan. Token hanya boleh datang dari worker, bukan dari user.
2. **Sisipkan token sendiri** kalau ada. Kalau `SERVICE_TOKEN` unset di worker web → 503, bukan fail-open. Proxy tanpa token berarti API akan menolak semua (fail-closed di sisi API), jadi gagal diam-diam lebih buruk daripada error jelas.
3. **Teruskan** ke origin worker API yang dipilih load-balancer web (`getOrigins()` / `apiWithFailover` di `lib/api.ts`, sudah ada — pakai ulang, jangan tulis ulang).
4. **Teruskan balik** `Set-Cookie`, `Content-Type`, `Cache-Control`, status, dan body.

Allowlist path — tolak `/_internal` dan `/scrape` supaya proxy tidak jadi jalan baru ke sana:

```
/api/health  /api/origins  /api/auth  /api/user  /api/admin
/api/series  /api/search  /api/homepage  /api/reader  /api/manga
/api/novel   /api/resolve  /api/identify  /api/source-status
```

`/api/_internal` dan `/api/scrape` tidak ada di allowlist → 404 dari proxy.

### 2a. CSP dan middleware web

`connect-src` di `middleware.ts` dan `public/_headers` bisa kehilangan 4 host API — panggilan browser jadi same-origin. Tapi **jangan** menghapus `apiCspHosts()`: SSR fetch berjalan di server, tidak tunduk CSP. Biarkan `connect-src` apa adanya untuk sekarang; Oblast ini hanya penghematan administrative, bukan penghematan serangan.

`/api/*` masuk daftar `NO_STORE` di `middleware.ts` — response per-user (bookmark, `/me`) tidak boleh masuk edge cache. Ini lanjutan dari `noStoreMw` sisi API.

## 3. `/img/*` — fail-closed

`hasValidImgSignature` (`reader.ts:936`) sekarang fail-open: `SIGNED_IMG_SECRET` unset → terima semua + warning sekali. Begitu gate §1 dikunci, itu membuat `/img` jadi pintu belakang scraper.

Perubahan: secret unset → 403. Secret set → wajib signature valid, seperti sekarang.

Konsekuensi yang harus diterima, bukan dihindari: **`SIGNED_IMG_SECRET` wajib di-set di keempat worker API sebelum deploy.** Kalau tidak, semua gambar site break. Ini satu-satunya bagian yang bisa menyebabkan downtime, jadi harus jadi langkah pertama di runbook.

`refererAllowed` tetap sebagai lapisan kedua (defense in depth), bukan lapisan utama.

## 4. Cookie

`setSessionCookie` / `clearSessionCookie` (`auth.ts:312`) — `SameSite=None` → `SameSite=Lax`. Semua trafik sekarang same-origin, jadi `Lax` cukup.

`__Host-` prefix tetap: cookie di-set di oktzz.xyz, `Secure` + `Path=/` tanpa `Domain` — legal.

## 5. Yang tidak berubah

Kontrak ini dijaga persis, supaya diff di sisi server kecil:

- `getSessionUser` (verify ECDSA + baca row D1 owner shard) — tidak berubah
- `requireSession`, `requireAdminSession` — tidak berubah
- Seluruh `routes/user.ts` dan `routes/admin/*` — tidak berubah
- `createSession`, `revokeAllSessionsForUser`, sharding `sessions` — tidak berubah
- Semua route data (`series`, `reader`, `novel`, `search`, `homepage`, `resolve`) — tidak berubah

Firebase + pemusatan auth state ditunda. Tidak ada di scope dokumen ini.

## 6. OAuth — redirect_uri pindah

`routes/auth.ts:107` memakai `redirect_uri: ${base}/api/auth/google/callback` di mana `base` = origin worker API. Kalau begitu, `Set-Cookie` mendarat di domain worker API, bukan oktzz.xyz — dan cookie jadi tidak berguna untuk proxy (browser hanya kirim cookie ke domain yang menyetelnya).

Perubahan: `redirect_uri` → `https://oktzz.xyz/api/auth/google/callback`, dan request ke `/api/auth/google` + `/callback` lewat proxy (bukan direct).

**Aksi manual yang dibutuhkan:** daftarkan ulang redirect URI tersebut di Google Cloud Console. Tanpa itu, Google menolak callback dan login mati total. Ini blocker — harus selesai sebelum deploy.

`__Host-oauth-state` (`auth.ts:343`) ikut turun ke `SameSite=Lax` bersama session cookie. Ini aman: callback OAuth adalah top-level GET navigation, dan `Lax` memang dikirim pada top-level navigasi. Yang tidak dikirim adalah navigasi lintas-site yang *menyematkan* request — tidak ada di flow ini. Kalau ternyata gagal, gejalanya callback 400 `invalid or missing state cookie`, dan ini penyebabnya.

Alternatif tanpa Google Console: biarkan callback di worker API, lalu worker API redirect ke `oktzz.xyz/api/auth/session-exchange?code=...`, dan proxy yang menukar kode jadi cookie. Lebih banyak kode, tidak perlu sentuh Google Console. **Pilih ini kalau mengatur ulang Konsole merepotkan.**

## 7. Sisi client

`lib/api.ts` dapat dua konstanta:

- `API_URL` — untuk SSR, dipakai apa adanya dengan `serviceHeaders()` (token langsung, tanpa proxy)
- base **kosong** (`''`) untuk browser — semua fetch jadi relative, otomatis masuk proxy

`getAuthApiUrl()` + `setAuthOrigin()` + `sessionStorage` sticky-origin dihapus. EXISTS karena cookie tinggal di domain worker API; begitu cookie pindah ke oktzz.xyz, logika ini tidak lagi dipilih server manapun. Round-robin client-side juga hilang — load-balancer pindah ke server (proxy), yang justru lebih baik karena SSR stateless.

Komponen yang berubah dari `getAuthApiUrl()` ke base kosong:
`AuthForm`, `BookmarkButton`, `ContinueReadingRail`, `BookmarksPage`, `HistoryPage`, `ProfilePage`, `AdminSettings`, `AdminTopbar`, `AdminDashboard`, `AdminLog`, `AdminMonitoring`, `AdminSaved`, `AdminUsers`, `AdminUserDetail`, `Navbar`.

`ReaderShell` + `SourceSwitcher` menerima prop `apiUrl` dari `.astro` — `apiUrl={API_URL}` jadi `apiUrl=''`.

## 8. Urutan rollout

1. `wrangler secret put SIGNED_IMG_SECRET` di keempat worker API (nilai sama). **Sebelum anything else** — kalau lupa, `/img` fail-closed dan gambar break.
2. `wrangler secret put SERVICE_TOKEN` di worker web (pastikan nilainya sama dengan yang sudah ada di API worker).
3. Daftarkan redirect URI baru di Google Cloud Console, atau pilih alternatif §6.
4. Deploy API worker (gate ketat + `/img` fail-closed + `corsMw` dihapus).
5. Deploy web worker (proxy + client switch).
6. Verifikasi: `curl -i https://manga-api-2.../api/series` → harus 403. `curl -i https://oktzz.xyz/api/series` → 200.

Langkah 4 sebelum 5 intentional: versi lama masih jalan karena gate baru menolak semua yang non-token, jadi deploy web menyusul. Kalau deploy terbalik, web lama butuh token yang tak lagi ada jalannya.

## 9. Risiko

| Risiko | Mitigasi |
|---|---|
| `SIGNED_IMG_SECRET` lupa di-set | Langkah 1 runbook; `/img` 403 fail-closed bukan 500 |
| Redirect URI Google tidak terdaftar | Login mati total — verifikasi manual setelah deploy |
| Cookie `SameSite=Lax` insufficient | Tidak — semua trafik same-origin; kalau ternyata ada path lintas domain, `Lax` masih cukup untuk GET navigasi |
| Client island masih punya `credentials: 'include'` ke worker API | Dipertahankan — `SameSite=Lax` mengizinkan same-origin, dan `credentials: 'include'` tidak merusak same-origin |

## 10. Test

- `apps/api-cf/test/service-gate.test.mjs` — `classifyServiceTier` tidak lagi punya `public-read`; `decideServiceGate` menolak tanpa token walau `hasValidOrigin` true (field dihapus, jadi regresi ketahuan lewat signature type)
- `apps/api-cf/test/signed-image.test.mjs` — secret kosong → `verifyImgSig` return false (sudah begitu, `signedImage.ts:69`)
- Test baru: proxy tolak `x-service-token` dari client, proxy tolak path di luar allowlist, proxy 503 tanpa `SERVICE_TOKEN`
- Manual: `curl` langsung ke worker API → 403 (INI tes yang membuktikan tujuan tercapai)

## 11. Yang sengaja tidak dikerjakan

- **Firebase Auth** — ditunda. Butuh keputusan tersendiri: apakah konsolidasi auth state (15 komponen × `fetchMe()`) lebih baik lewat React Context tanpa dependency, atau memang mau pindah vendor. Tidak ada hubungannya dengan penguncian API ini.
- **Audit keamanan menyeluruh** — dokumen ini hanya soal mengunci API.
- **WAF / rate limiting edge** — sudah ada `rateLimit` per-tier; tidak disentuh.