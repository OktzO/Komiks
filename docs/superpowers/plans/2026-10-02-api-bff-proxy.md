# API BFF Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengunci 4 worker API agar hanya menerima request yang membawa `SERVICE_TOKEN`, sehingga `curl` langsung ke worker API dapat 403 dan satu-satunya pintu masuk adalah `oktzz.xyz`.

**Architecture:** `manga-web` (Astro SSR) jadi BFF proxy di `/api/*`. Proxy membuang token dari client, menyisipkan `SERVICE_TOKEN` miliknya, meneruskan ke worker API dengan round-robin, lalu relayed `Set-Cookie` balik. Worker API hanya melihat `x-service-token`; `Origin` tidak lagi memberi akses apa pun. `/img/*` tetap dilayani langsung ke browser (cross-origin `<img>` tak bisa membawa header), dijaga signature HMAC yang jadi fail-closed. Cookie session pindah ke same-origin sehingga `SameSite=Lax` cukup dan CORS dihapus total.

**Tech Stack:** Hono (worker API), Astro 7 + `@astrojs/cloudflare` (web SSR), TypeScript, `node:test` via `tsx` (test api-cf), `bun test` (test web).

**Spec:** `docs/superpowers/specs/2026-10-02-api-bff-proxy-spec.md`

## Global Constraints

- Node.js ≥ 22.12 wajib untuk `apps/web` (Astro 7 menolak Node 20). Kalau `node -v` < 22, pakai `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH"`.
- **Deploy worker API HARUS pakai wrangler 3.114** (`node_modules/wrangler` di root = `3.114.17`). Wrangler 4 hanya untuk `apps/web`. Pakai wrangler 4 untuk worker API pernah bikin worker 500 (error 1042).
- **Selalu sertakan `--config` eksplisit** saat `wrangler secret` / `wrangler deploy`. Tanpa itu, wrangler diam-diam memakai `account_id` dari toml yang terakhir dibaca dan bisa salah akun.
- Mapping toml ↔ akun: `wrangler.toml`=akun1 (`manga-api`), `wrangler.origin.toml`=akun2 (`manga-api-2`), `wrangler.origin3.toml`=akun3, `wrangler.origin4.toml`=akun4.
- `SERVICE_TOKEN` dan `SIGNED_IMG_SECRET` sudah terpasang di keempat worker API dan di `manga-web` (terverifikasi 2026-10-02). **Jangan generate nilai baru** — pakai yang sudah ada di root `.env`.
- Nilai `redirect_uri` OAuth yang terdaftar di Google = `https://oktzz.xyz/api/auth/google/callback` (terverifikasi 2026-10-02). Jangan diubah.
- `ALLOWED_ORIGINS` entry pertama = `https://oktzz.xyz` dan ada di keempat worker. Dipakai sebagai sumber `redirect_uri` — jangan tambah secret `FRONTEND_URL` baru (hanya ada di akun2).
- Worker API tidak boleh punya akses ke `origin` browser dalam bentuk apa pun setelah Task 1. `ALLOWED_ORIGINS` tetap ada (dipakai `refererAllowed` untuk `/img`), tapi tidak lagi granting akses.
- Gaya kode: komentar berbahasa Indonesia, menjelaskan *kenapa* bukan *apa*. Ikuti pola yang sudah ada di file yang kamu ubah.
- Jangan tambahkan dependency baru. Rencana ini nol dependency baru.

## Review Focus

Lima kelas input/kondisi yang implied oleh spec tapi tidak diuji test mana pun — paling mungkin menggigit orang yang memakai sistem ini:

1. **Client mengirim `x-service-token` sendiri lewat proxy.** Proxy harus membuang header itu sebelum meneruskan; kalau tidak, siapa pun bisa menyamar sebagai manga-web dan seluruh penguncian jadi tidak berarti. (Task 5)
2. **User logout/login persecuted di tengah navigasi — `Set-Cookie` relay.** Proxy harus meneruskan *semua* header `Set-Cookie` dari worker API, bukan cuma yang pertama. Kalau cuma satu, session state bisa tidak konsisten. (Task 5)
3. **Path traversal lewat proxy: `/api/../_internal/db/exec`.** Allowlist proxy harus mencocokkan segment, bukan `startsWith` longgar, supaya `_internal` dan `scrape` tidak bisa dijangkau. (Task 5)
4. **`/img` tanpa `SIGNED_IMG_SECRET` = 403 total, termasuk development lokal.** Fail-closed yang tidak punya jalan keluar lokal = developer kehilangan peta dan mematikan semua gambar. Repo perlu `.dev.vars` terisi. (Task 3)
5. **Respons non-JSON dari worker API (gambar, redirect 302 OAuth, 204).** Proxy harus relay status + body apa adanya, bukan selalu `res.json()`. Kalau dipaksa parse JSON, OAuth callback dan streaming rusak. (Task 5)

---

## File Structure

**apps/api-cf (worker API):**

| File | Tanggung jawab |
|---|---|
| `src/lib/serviceGate.ts` | Gate token-only. Klasifikasi tier + keputusan allow/deny. Menghapus logika Origin/cookie/Turnstile. |
| `src/index.ts` | Pipeline Hono. Hapus `corsMw` + `SAFE_METHODS`. |
| `src/routes/reader.ts` | `hasValidImgSignature` jadi fail-closed. |
| `src/lib/auth.ts` | `SameSite=None` → `Lax` di 4 cookie helper. |
| `src/routes/auth.ts` | `redirect_uri` dari `ALLOWED_ORIGINS[0]`, bukan dari request URL. |
| `test/service-gate.test.mjs` | Diwrite ulang — test lama menguji perilaku Origin yang sengaja dihapus. |
| `test/img-signature-failclosed.test.mjs` | Baru — `/img` tanpa secret = 403. |
| `test/cookie-samesite.test.mjs` | Baru — semua cookie helper pakai `Lax`. |
| `.dev.vars` | Tambah `SERVICE_TOKEN` + `SIGNED_IMG_SECRET` untuk dev lokal. |
| `.dev.vars.example` | Tambah nama variabel yang sama. |

**apps/web (BFF + client):**

| File | Tanggung jawab |
|---|---|
| `src/pages/api/[...path].ts` | **Baru.** Proxy BFF. Satu-satunya tempat token disisipkan. |
| `src/lib/api.ts` | `API_URL` polymorphic (browser = same-origin). `apiWithFailover` jadi single-hop di browser. Hapus `getAuthApiUrl`/`setAuthOrigin`. |
| `src/middleware.ts` | `/api` masuk `NO_STORE`. |
| 11 komponen client | Hapus `getAuthApiUrl()`, pakai path relatif. |

---

### Task 1: Gate token-only di worker API

Menghapus kemampuan `Origin` memberi akses. Ini fondasi — semua task lain bergantung padanya.

**Files:**
- Modify: `apps/api-cf/src/lib/serviceGate.ts`
- Test: `apps/api-cf/test/service-gate.test.mjs`

**Interfaces:**
- Consumes: `constantTimeEqualStr(a: string, b: string): boolean` dari `src/lib/auth.ts` (sudah ada, tidak diubah)
- Produces:
  - `type ServiceTier = 'exempt' | 'deny'`
  - `classifyServiceTier(path: string, method: string): ServiceTier`
  - `interface ServiceGateInput { hasServiceToken: boolean; isExempt: boolean }`
  - `type ServiceGateDecision = 'allow' | 'deny'`
  - `decideServiceGate(input: ServiceGateInput): ServiceGateDecision`
  - `serviceGateMw: MiddlewareHandler<{ Bindings: Env }>`

- [ ] **Step 1: Rewrite the test file to describe token-only behaviour**

Ganti seluruh isi `apps/api-cf/test/service-gate.test.mjs`:

```js
// Token-only service gate. Test lama menguji jalur Origin/cookie/Turnstile yang
// sengaja dihapus: Origin bisa dipalsuin curl, jadi tidak pernah jadi bukti
// asal request. Satu-satunya jalur sah selain exempt = x-service-token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { classifyServiceTier, decideServiceGate, serviceGateMw } from '../src/lib/serviceGate.ts';

const stubEnv = (over = {}) => ({
  ALLOWED_ORIGINS: 'https://oktzz.xyz, http://localhost:3000',
  SERVICE_TOKEN: 'test-service-token',
  ...over,
});

// Mini-app: hanya serviceGateMw + catch-all, supaya menguji gate apa adanya
// (index.ts asli juga akan menaruh gate sebelum rute publik).
const app = new Hono();
app.use('*', serviceGateMw);
app.all('*', (c) => c.json({ path: c.req.path, method: c.req.method }));

const go = (path, init = {}, env = stubEnv()) => app.request(path, init, env);
const TOKEN = { headers: { 'x-service-token': 'test-service-token' } };

// ── Tier classifier ────────────────────────────────────────────────────────────
test('classifyServiceTier: hanya yang punya credential sendiri yang exempt', () => {
  // Secret/credential sendiri, bukan butuh token web.
  assert.equal(classifyServiceTier('/api/_internal/db/exec', 'POST'), 'exempt');
  assert.equal(classifyServiceTier('/api/scrape', 'GET'), 'exempt');
  // Image: signature HMAC, bukan header (tag <img> tak bisa bawa header).
  assert.equal(classifyServiceTier('/img/komiku/x.webp', 'GET'), 'exempt');
  // Dipanggil client-side lewat proxy (public, bukan data pengguna).
  assert.equal(classifyServiceTier('/api/health', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/origins', 'GET'), 'exempt');
  // OAuth: state cookie ECDSA + Turnstile, callback dari Google.
  assert.equal(classifyServiceTier('/api/auth/google', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/auth/google/callback', 'GET'), 'exempt');
  // Preflight.
  assert.equal(classifyServiceTier('/anything', 'OPTIONS'), 'exempt');
  assert.equal(classifyServiceTier('/anything', 'HEAD'), 'exempt');
});

test('classifyServiceTier: semua data pengguna butuh token', () => {
  assert.equal(classifyServiceTier('/api/series', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/search?q=x', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/homepage', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/reader/komiku/chapter/abc', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/novel/catalog', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/resolve/komiku', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/identify', 'POST'), 'deny');
  assert.equal(classifyServiceTier('/api/user/me', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/admin/monitoring', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/user/bookmark/naruto', 'POST'), 'deny');
  // Legacy page proxy: lalu lintas API worker, jadi butuh token juga.
  assert.equal(classifyServiceTier('/api/reader/komiku/page/1234/1', 'GET'), 'deny');
});

test('classifyServiceTier: path tak dikenal ditolak, bukan lolos diam-diam', () => {
  assert.equal(classifyServiceTier('/api/unknown-thing', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/', 'GET'), 'deny');
});

// ── Pure decision ──────────────────────────────────────────────────────────────
test('decideServiceGate: token adalah satu-satunya jalan', () => {
  const decide = (o) => decideServiceGate({ isExempt: false, hasServiceToken: false, ...o });
  assert.equal(decide({ isExempt: true }), 'allow');
  assert.equal(decide({ hasServiceToken: true }), 'allow');
  assert.equal(decide({}), 'deny');
});

// ── E2E middleware ─────────────────────────────────────────────────────────────
test('E2E: exempt lolos tanpa kredensial', async () => {
  assert.equal((await go('/api/health')).status, 200);
  assert.equal((await go('/api/origins')).status, 200);
  assert.equal((await go('/api/auth/google')).status, 200);
  assert.equal((await go('/api/_internal/db/exec', { method: 'POST' })).status, 200);
  assert.equal((await go('/img/komiku/x.webp')).status, 200);
  assert.equal((await go('/anywhere', { method: 'OPTIONS' })).status, 200);
});

test('E2E: tanpa token DITOLAK — termasuk walau Origin di-allowlist', async () => {
  // Ini regresi yang paling penting. Header Origin dipalsuin curl/Postman
  // sesuka hati; kalau ia masih memberi akses, penguncian ini tidak berarti.
  const spoofed = { headers: { origin: 'https://oktzz.xyz' } };
  assert.equal((await go('/api/series')).status, 403);
  assert.equal((await go('/api/series', spoofed)).status, 403);
  assert.equal((await go('/api/search', spoofed)).status, 403);
  assert.equal((await go('/api/homepage', spoofed)).status, 403);
  assert.equal((await go('/api/source-status', spoofed)).status, 403);
  assert.equal((await go('/api/user/me', spoofed)).status, 403);
  assert.equal((await go('/api/resolve/komiku', spoofed)).status, 403);
  assert.equal((await go('/api/novel/catalog', spoofed)).status, 403);
});

test('E2E: cookie session palsu bukan kredensial', async () => {
  // Gate tidak lagi menebak "ada cookie = user sah". Session diverifikasi
  // ECDSA di dalam requireSession; gate cuma butuh token.
  const fake = { headers: { cookie: '__Host-session=abc.def.ghi' } };
  assert.equal((await go('/api/user/me', fake)).status, 403);
  assert.equal((await go('/api/admin/monitoring', fake)).status, 403);
});

test('E2E: Turnstile bukan lagi kredensial di gate', async () => {
  // Turnstile tetap ngecek /api/auth/google di routes/auth.ts, tapi gate sudah
  // tidak pernah memanggil siteverify untuk tamu — request-nya tidak pernah sampai.
  assert.equal((await go('/api/resolve/komiku', { headers: { 'x-turnstile-token': '0.abc' } })).status, 403);
  assert.equal((await go('/api/resolve/komiku?turnstile_token=dummy')).status, 403);
});

test('E2E: token benar lolos semua path', async () => {
  assert.equal((await go('/api/series', TOKEN)).status, 200);
  assert.equal((await go('/api/search', TOKEN)).status, 200);
  assert.equal((await go('/api/resolve/komiku', TOKEN)).status, 200);
  assert.equal((await go('/api/user/bookmark/naruto', { ...TOKEN, method: 'POST' })).status, 200);
  assert.equal((await go('/api/admin/monitoring', TOKEN)).status, 200);
  assert.equal((await go('/api/reader/komiku/page/1234/1', TOKEN)).status, 200);
});

test('E2E: token salah ditolak (constant-time compare)', async () => {
  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'wrong' } })).status, 403);
  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'test-service-toke' } })).status, 403); // prefix
  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'test-service-tokenx' } })).status, 403); // suffix
});

test('E2E: respons 403 tidak ke-cache', async () => {
  const res = await go('/api/series', spoofedOrigin());
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('E2E: SERVICE_TOKEN kosong → gate TIDAK AKTIF (fail-open, dev-friendly)', async () => {
  const env = stubEnv({ SERVICE_TOKEN: '' });
  // Dikeputusan sengaja: fail-open saat secret kosong menjaga alur dev lokal
  // tetap jalan. Semua worker produksi sudah punya secret terpasang (2026-10-02),
  // jadi cabang ini hanya menyala di mesin tanpa secret.
  assert.equal((await go('/api/series', {}, env)).status, 200);
  assert.equal((await go('/api/admin/monitoring', {}, env)).status, 200);
});

function spoofedOrigin() {
  return { headers: { origin: 'https://oktzz.xyz' } };
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/service-gate.test.mjs
```

Expected: FAIL. `classifyServiceTier('/api/series', 'GET')` masih `'public-read'`, bukan `'deny'`. besiekan error TypeScript atau assertion mismatch.

- [ ] **Step 3: Rewrite serviceGate.ts**

Ganti seluruh isi `apps/api-cf/src/lib/serviceGate.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import type { Env } from './context';
import { constantTimeEqualStr } from './auth';

// ── Token-only service gate (API hardening) ───────────────────────────────────
//
// Supersedes versi 2026-09 yang membiarkan tiga jalur lain (Origin allowlist,
// session cookie, Turnstile).access. Semuanya gagaladu Attack Origin bisa
// dipalsuin curl/Postman tanpa alat apa pun — `curl -H "Origin: https://oktzz.xyz"`
// lolos persis seperti browser sungguhan. Header yang bisa ditulis siapa saja
// bukan bukti asal request, dan session cookie hanya "ada" (bukan "valid") di
// titik ini.
//
// Satu-satunya jalur sah selain exempt: `x-service-token`, secret yang hanya
// dimiliki worker manga-web. Browser tidak pernah memegang token — semua
// panggilan browser masuk lewat proxy BFF di manga-web (`/api/[...path].ts`).
//
// EXEMPT (sudah punya credential sendiri, bukan butuh token web):
//   /api/_internal/*  → x-db-forward-key / x-db-mirror-key
//   /api/scrape*      → requireAdminKey (x-admin-api-key)
//   /img/*            → signature HMAC; tag <img> tak bisa membawa header
//   /api/health       → health-check load balancer, bukan data
//   /api/origins      → daftar origin publik, bukan data
//   /api/auth/*       → OAuth: state cookie ECDSA + Turnstile, callback dari Google
//   HEAD/OPTIONS      → preflight
//
// Fail-open saat SERVICE_TOKEN belum di-set: dev lokal tidak boleh rusak.
// Semua worker produksi sudah terpasang (diverifikasi 2026-10-02).

export type ServiceTier = 'exempt' | 'deny';

export const classifyServiceTier = (path: string, method: string): ServiceTier => {
  const m = method.toUpperCase();
  if (m === 'HEAD' || m === 'OPTIONS') return 'exempt';
  if (
    path === '/api/health' ||
    path === '/api/origins' ||
    path === '/api/auth' ||
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/_internal') ||
    path.startsWith('/api/scrape') ||
    path === '/img' ||
    path.startsWith('/img/')
  ) {
    return 'exempt';
  }
  return 'deny';
};

export interface ServiceGateInput {
  hasServiceToken: boolean;
  isExempt: boolean;
}

export type ServiceGateDecision = 'allow' | 'deny';

// Pure decision — dipakai unit test langsung.
export const decideServiceGate = (input: ServiceGateInput): ServiceGateDecision => {
  if (input.isExempt) return 'allow';
  return input.hasServiceToken ? 'allow' : 'deny';
};

let warnedUnsetToken = false;

export const serviceGateMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  try {
    if (classifyServiceTier(c.req.path, c.req.method) === 'exempt') return next();

    const expected = (c.env.SERVICE_TOKEN as string | undefined)?.trim() ?? '';
    if (!expected) {
      if (!warnedUnsetToken) {
        warnedUnsetToken = true;
        console.warn(
          '[serviceGate] SERVICE_TOKEN belum di-set di worker ini — gate TIDAK AKTIF (fail-open). ' +
            'PRODUKSI: set SERVICE_TOKEN (nilai sama di web + semua worker API) via `wrangler secret put`.'
        );
      }
      return next();
    }

    const supplied = c.req.header('x-service-token');
    const hasServiceToken = !!supplied && constantTimeEqualStr(supplied, expected);
    const decision = decideServiceGate({ hasServiceToken, isExempt: false });

    if (decision === 'allow') return next();
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'forbidden' }, 403);
  } catch (e) {
    // Jangan pernah crash pipeline karena gate ini — log + fail OPEN.
    console.error('[serviceGate] unexpected error, failing open:', e);
    return next();
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/service-gate.test.mjs
```

Expected: PASS — semua test hijau.

- [ ] **Step 5: Verify no stale imports break the build**

`serviceGate.ts` tidak lagi mengimpor `allowedOriginFor` atau `verifyTurnstile`. Pastikan tidak ada file lain yang mengimpor simbol yang dihapus (`ServiceTier` nilai `'public-read'`, `hasValidOrigin`, `turnstileOk`):

```bash
cd /home/user/indohome-mmk/Manga && grep -rn "hasValidOrigin\|turnstileOk\|requiresTurnstile\|public-read" apps/api-cf/src apps/api-cf/test apps/web/src
```

Expected: tidak ada output. Kalau ada, perbaiki file yang masih merujuk simbol lama.

Lalu typecheck:

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsc --noEmit
```

Expected: tidak ada error.

- [ ] **Step 6: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/api-cf/src/lib/serviceGate.ts apps/api-cf/test/service-gate.test.mjs && git commit -m "fix(api-cf): the gate accepted a spoofable Origin header, so the API was never actually locked"
```

---

### Task 2: Hapus CORS middleware

Menghapus `corsMw` mematikan kelas serangan CSRF, bukan hanya menyembunyikan gejalanya. Tidak ada lagi panggilan browser lintas origin setelah Task 5–6.

**Files:**
- Modify: `apps/api-cf/src/index.ts`

**Interfaces:**
- Consumes: tidak ada
- Produces: tidak ada (penghapusan)

- [ ] **Step 1: Write the failing test**

Buat `apps/api-cf/test/no-cors-mw.test.mjs`:

```js
// corsMw hanya menambah header CORS ke respons; request tetap dieksekusi.
// Setelah semua trafik browser lewat proxy same-origin, middleware itu jadi
// sia-sia — dan sebagai bonus ia dihapus supaya tidak ada yang kelihat
// bergantung padanya. Test ini mengunci ketiadaannya di source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX = new URL('../src/index.ts', import.meta.url);
const source = readFileSync(fileURLToPath(INDEX), 'utf8');

test('index.ts does not mount a CORS middleware', () => {
  assert.ok(!/const\s+corsMw/.test(source), 'corsMw masih didefinisikan');
  assert.ok(!/app\.use\('\*',\s*corsMw\)/.test(source), 'corsMw masih di-mount');
  assert.ok(!/Access-Control-Allow-Origin/.test(source), 'header CORS masih ditulis');
});

test('index.ts still mounts the token-only gate before any /api route', () => {
  const gateAt = source.indexOf("app.use('*', serviceGateMw)");
  assert.ok(gateAt > -1, 'serviceGateMw tidak ter-mount');
  // Gate harus sebelum route data, setelah /api/_internal + /img yang punya
  // credential sendiri.
  const internal = source.indexOf("app.route('/api/_internal', internalRouter)");
  const img = source.indexOf("app.route('/img', imgRouter)");
  assert.ok(gateAt < internal, 'gate dipasang setelah /api/_internal');
  assert.ok(gateAt < img, 'gate dipasang setelah /img');
});

test('index.ts still mounts security headers on every response', () => {
  assert.ok(/app\.use\('\*',\s*securityHeadersMw\)/.test(source));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/no-cors-mw.test.mjs
```

Expected: FAIL — `corsMw masih didefinisikan`.

- [ ] **Step 3: Delete corsMw from index.ts**

Di `apps/api-cf/src/index.ts`, hapus blok ini (baris 37–68):

```ts
// CORS: allow credentials only when origin matches the allowlist.
// Fail-closed: if ALLOWED_ORIGINS is unset, no origin is echoed and no
// credentials header is emitted.
//
// CSRF guard: for state-changing methods, a cross-origin request whose Origin
// fails the allowlist is REJECTED (403), not merely left without CORS headers.
// SameSite=None cookie is sent on cross-site form POSTs, so the request would
// otherwise execute server-side even though the browser can't read the reply.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const corsMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const origin = c.req.header('origin');

  if (origin && !SAFE_METHODS.has(c.req.method) && !allowedOriginFor(c.env, origin)) {
    return c.json({ error: 'forbidden origin' }, 403);
  }

  if (origin && allowedOriginFor(c.env, origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    c.res.headers.set('Vary', 'Origin');
  }
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-api-key');

  if (c.req.method === 'OPTIONS') {
    c.res.headers.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: c.res.headers });
  }

  await next();
};
```

Dan hapus baris mount-nya:

```ts
app.use('*', corsMw);
```

Terakhir, bersihkan import yang jadi tak terpakai. Ganti:

```ts
import { Env, json, allowedOriginFor, Context } from './lib/context';
```

menjadi:

```ts
import { Env, json, Context } from './lib/context';
```

`MiddlewareHandler` masih dipakai oleh `securityHeadersMw`, `noStoreMw`, jadi import-nya tetap.

- [ ] **Step 4: Run both tests to verify they pass**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/no-cors-mw.test.mjs test/service-gate.test.mjs
```

Expected: PASS semua.

- [ ] **Step 5: Typecheck**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsc --noEmit
```

Expected: tidak ada error.

- [ ] **Step 6: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/api-cf/src/index.ts apps/api-cf/test/no-cors-mw.test.mjs && git commit -m "fix(api-cf): drop the CORS middleware now that nothing is cross-origin"
```

---

### Task 3: `/img` fail-closed + dev vars

Setelah gate dikunci, `/img` yang fail-open jadi pintu belakang scraper. Tapi fail-closed tanpa escape hatch lokal mematikan semua gambar di dev — jadi `.dev.vars` ikut dalam task ini.

**Files:**
- Modify: `apps/api-cf/src/routes/reader.ts`
- Modify: `apps/api-cf/.dev.vars`
- Modify: `apps/api-cf/.dev.vars.example`
- Test: `apps/api-cf/test/img-signature-failclosed.test.mjs`

**Interfaces:**
- Consumes: `verifyImgSig(secret, path, exp, sig, nowSec, graceSeconds): Promise<boolean>` dari `src/lib/signedImage.ts` (tidak diubah)
- Produces: tidak ada simbol baru

- [ ] **Step 1: Write the failing test**

Buat `apps/api-cf/test/img-signature-failclosed.test.mjs`:

```js
// /img setelah gate dikunci tidak lagi bisa jadi pintu belakang scraper.
// Sebelumnya SIGNED_IMG_SECRET unset → terima semua + warning (fail-open).
// Sekarang unset → 403. Dev lokal dilindungi oleh SIGNED_IMG_SECRET di
// .dev.vars, bukan oleh kelonggaran produksi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyImgSig } from '../src/lib/signedImage.ts';

const READER = new URL('../src/routes/reader.ts', import.meta.url);
const source = readFileSync(fileURLToPath(READER), 'utf8');
const NOW = 1_700_000_000;
const SECRET = 'a'.repeat(64);

test('source: hasValidImgSignature tidak punya cabang fail-open', () => {
  // Menolak tempelkan signature yang valid saat secret kosong. Cek eksplisit
  // 'return true' di dalam blok secret kosong.
  const fn = source.slice(source.indexOf('const hasValidImgSignature'));
  const block = fn.slice(0, fn.indexOf('const ', 20));
  assert.ok(
    !/if\s*\(\s*!secret\s*\)[\s\S]{0,400}return true/.test(block),
    'masih ada fail-open: secret kosong → return true'
  );
});

test('source: bukan ada lagi warning "belum di-set" untuk /img', () => {
  assert.ok(!/warnedSignedImgUnset/.test(source), 'warnedSignedImgUnset masih ada');
});

test('verifyImgSig menolak apa pun saat secret kosong', async () => {
  // Secret kosong = tidak ada yang bisa diverifikasi, jadi tidak ada yang boleh
  // lolos. Ini yang membuat hasValidImgSignature bisa fail-closed tanpa logika
  // tambahan.
  assert.equal(await verifyImgSig('', '/img/komiku/x/1', NOW + 600, 'deadbeef', NOW, 60), false);
  assert.equal(await verifyImgSig('', '/img/komiku/x/1', NaN, '', NOW, 60), false);
});

test('verifyImgSig tetap benar saat secret ada', async () => {
  const { signImgPath } = await import('../src/lib/signedImage.ts');
  const { exp, sig } = await signImgPath(SECRET, '/img/komiku/x/1', 1500, NOW);
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/1', exp, sig, NOW, 60), true);
  // Path lain tidak boleh memakai signature yang sama.
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/2', exp, sig, NOW, 60), false);
  // Expired di luar grace → tolak.
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/1', exp, sig, exp + 61, 60), false);
});

test('.dev.vars punya escape hatch untuk dev lokal', async () => {
  const devVars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  assert.ok(/^SERVICE_TOKEN=/m.test(devVars), '.dev.vars tidak punya SERVICE_TOKEN');
  assert.ok(/^SIGNED_IMG_SECRET=/m.test(devVars), '.dev.vars tidak punya SIGNED_IMG_SECRET');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/img-signature-failclosed.test.mjs
```

Expected: FAIL — masih ada `return true` di blok secret kosong, dan `warnedSignedImgUnset` masih ada.

- [ ] **Step 3: Make hasValidImgSignature fail-closed**

Di `apps/api-cf/src/routes/reader.ts`, ganti blok ini:

```ts
// Fail-open saat SIGNED_IMG_SECRET belum di-set di worker ini: /img menerima
// request tanpa signature (perilaku lama) + warning sekali per isolate.
let warnedSignedImgUnset = false;

// Anti-scraping /img: SIGNED_IMG_SECRET ter-set → request wajib membawa
// signature valid (?exp=&sig=). Sig di-verify terhadap RAW pathname dari
// browser — persis string yang di-sign saat mint (encoded chapterId, tanpa
// query). Query `retry`/`exp`/`sig` tidak pernah ikut di-sign.
const signedImgSecretOf = (env: Env): string => (env.SIGNED_IMG_SECRET as string | undefined)?.trim() || '';

const hasValidImgSignature = async (c: Context): Promise<boolean> => {
  const secret = signedImgSecretOf(c.env);
  if (!secret) {
    if (!warnedSignedImgUnset) {
      warnedSignedImgUnset = true;
      console.warn(
        '[img] SIGNED_IMG_SECRET belum di-set di worker ini — /img tanpa signature (fail-open, dev-friendly). ' +
          'PRODUKSI: set secret (nilai sama di semua worker API) sebelum anti-scraping gambar aktif.'
      );
    }
    return true; // dev: terima apa adanya (perilaku ini hari ini)
  }
  const exp = Number(c.req.query('exp') ?? NaN);
  const sig = c.req.query('sig') ?? '';
  return verifyImgSig(secret, c.req.path, exp, sig, Math.floor(Date.now() / 1000), 60);
};
```

menjadi:

```ts
// Anti-scraping /img. Fail-CLOSED: secret kosong → 403 untuk semua gambar.
// Sebelumnya fail-open, dan begitu gate /api dikunci (serviceGate token-only)
// itu membuat /img jadi pintu belakang scraper. Tag <img> tidak bisa membawa
// header, jadi signature query adalah satu-satunya credential yang tersedia di
// sini — kalau secret tidak ada, tidak ada yang bisa diverifikasi, jadi tidak
// ada yang boleh lolos.
// Dev lokal dilindungi oleh SIGNED_IMG_SECRET di .dev.vars, bukan oleh
// kelonggaran produksi.
//
// Sig di-verify terhadap RAW pathname — persis string yang di-sign saat mint
// (encoded chapterId, tanpa query). Query `retry`/`exp`/`sig` tidak ikut.
const signedImgSecretOf = (env: Env): string => (env.SIGNED_IMG_SECRET as string | undefined)?.trim() || '';

const hasValidImgSignature = async (c: Context): Promise<boolean> => {
  const secret = signedImgSecretOf(c.env);
  if (!secret) return false;
  const exp = Number(c.req.query('exp') ?? NaN);
  const sig = c.req.query('sig') ?? '';
  return verifyImgSig(secret, c.req.path, exp, sig, Math.floor(Date.now() / 1000), 60);
};
```

- [ ] **Step 4: Add the dev escape hatch**

Tambah dua baris ke `apps/api-cf/.dev.vars` (nilainya harus sama dengan root `.env` supaya signature yang di-mint worker dev cocok dengan yang di-verify — keduanya satu worker di dev, tapi tetap konsisten):

```
SERVICE_TOKEN=7bca...
SIGNED_IMG_SECRET=99c3...
```

Ganti `...` dengan nilai persis dari root `.env` baris 60–61. Ambil tanpa mencetak:

```bash
cd /home/user/indohome-mmk/Manga && grep -E '^(SERVICE_TOKEN|SIGNED_IMG_SECRET)=' .env >> apps/api-cf/.dev.vars && tail -2 apps/api-cf/.dev.vars | sed -E 's/=(.{4}).*/=\1…/'
```

`.dev.vars` sudah gitignored — pastikan:

```bash
cd /home/user/indohome-mmk/Manga && git check-ignore apps/api-cf/.dev.vars && echo "ignored OK"
```

- [ ] **Step 5: Document the new vars in .dev.vars.example**

Tambah dua baris di `apps/api-cf/.dev.vars.example`:

```
# Wajib di dev lokal sejak /img jadi fail-closed: tanpa SIGNED_IMG_SECRET semua
# gambar 403. Nilai harus sama di semua worker API (root .env).
SERVICE_TOKEN=
SIGNED_IMG_SECRET=
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/img-signature-failclosed.test.mjs test/signed-image.test.mjs
```

Expected: PASS semua.

- [ ] **Step 7: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/api-cf/src/routes/reader.ts apps/api-cf/.dev.vars.example apps/api-cf/test/img-signature-failclosed.test.mjs && git commit -m "fix(api-cf): /img was fail-open, which left a scraper door open once /api was locked"
```

`.dev.vars` tidak ikut di-commit (gitignored) — itu benar, nilainya secret.

---

### Task 4: Cookie `SameSite=Lax` + OAuth `redirect_uri` ke web

`__Host-session` adalah host-only, jadi hanya bisa disetel oleh domain yang mengirim respons. Kalau callback tetap di worker API, cookie mendarat di domain worker dan proxy di oktzz.xyz tidak pernah menerimanya — semua request terautentikasi mati. Karena itu `redirect_uri` harus ke `oktzz.xyz`.

**Files:**
- Modify: `apps/api-cf/src/lib/auth.ts`
- Modify: `apps/api-cf/src/routes/auth.ts`
- Test: `apps/api-cf/test/cookie-samesite.test.mjs`

**Interfaces:**
- Consumes: `setStateCookie`, `verifyStateCookie`, `clearStateCookie` dari `src/lib/auth.ts`
- Produces: tidak ada simbol baru

- [ ] **Step 1: Write the failing test**

Buat `apps/api-cf/test/cookie-samesite.test.mjs`:

```js
// Setelah semua trafik same-origin (proxy BFF), SameSite=None tidak lagi
// dibutuhkan — dan justru berbahaya: None membuat cookie ikut terkirim pada
// request lintas site, yaitu surface CSRF yang sedang ditutup. Lax cukup karena
// satu-satunya request lintas-site yang ada (callback OAuth) adalah top-level
// GET navigation, dan Lax memang dikirim pada navigasi tersebut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AUTH = new URL('../src/lib/auth.ts', import.meta.url);
const source = readFileSync(fileURLToPath(AUTH), 'utf8');

test('tidak ada cookie helper yang lagi memakai SameSite=None', () => {
  assert.ok(!/SameSite=None/.test(source), 'masih ada SameSite=None');
});

test('keempat cookie helper memakai SameSite=Lax', () => {
  const helpers = ['setSessionCookie', 'clearSessionCookie', 'setStateCookie', 'clearStateCookie'];
  for (const name of helpers) {
    const at = source.indexOf(`export function ${name}`);
    assert.ok(at > -1, `${name} tidak ditemukan`);
    const body = source.slice(at, source.indexOf('}', at));
    assert.ok(/SameSite=Lax/.test(body), `${name} tidak memakai SameSite=Lax`);
  }
});

test('redirect_uri OAuth berasal dari ALLOWED_ORIGINS, bukan request URL', async () => {
  const routes = readFileSync(new URL('../src/routes/auth.ts', import.meta.url), 'utf8');
  // Base dari request URL = origin worker API. Proxy meneruskan ke worker, jadi
  // c.req.url selalu menunjuk domain worker — cookie __Host-session akan
  // mendarat di sana, bukan di oktzz.xyz, dan proxy tidak pernah menerimanya.
  assert.ok(
    !/redirect_uri: `\$\{base\}\/api\/auth\/google\/callback`/.test(routes),
    'redirect_uri masih diturunkan dari base (origin request)'
  );
  assert.ok(/redirectUri/.test(routes), 'redirect_uri belum pakai helper redirectUri');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/cookie-samesite.test.mjs
```

Expected: FAIL — masih ada `SameSite=None` di empat helper.

- [ ] **Step 3: Flip SameSite in the four cookie helpers**

Di `apps/api-cf/src/lib/auth.ts`, ubah empat baris ini:

```ts
export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
}
```

menjadi:

```ts
export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}
```

Dan dua helper state:

```ts
  return `${STATE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${STATE_TTL}`;
```

menjadi:

```ts
  return `${STATE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${STATE_TTL}`;
```

```ts
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
```

menjadi:

```ts
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
```

- [ ] **Step 4: Point redirect_uri at the frontend origin**

Di `apps/api-cf/src/routes/auth.ts`, tambahkan helper di dekat `resolveFrontendOrigin` (sekitar baris 69):

```ts
// Redirect URI OAuth harus menunjuk origin FRONTEND (oktzz.xyz), bukan worker
// API. Alasannya cookie: __Host-session itu host-only, jadi hanya bisa disetel
// oleh domain yang mengirim respons. Kalau callback mendarat di worker API,
// cookie-nya hidup di domain worker — dan proxy BFF di oktzz.xyz tidak akan
// pernah menerimanya, sehingga setiap request terautentikasi jadi 401.
//
// Nilai ini WAJIB sama persis dengan yang terdaftar di Google Cloud Console
// (https://oktzz.xyz/api/auth/google/callback, diverifikasi 2026-10-02).
// ALLOWED_ORIGINS dipakai sebagai sumber karena ada di keempat worker;
// FRONTEND_URL hanya ada di satu akun dan tidak boleh jadi sumber kebenaran.
const oauthRedirectUri = (c: Context): string => {
  const frontend = resolveFrontendOrigin(c);
  return `${frontend}/api/auth/google/callback`;
};
```

Lalu di route `/google`, ganti:

```ts
  const base = new URL(c.req.url).origin;
  const state = crypto.randomUUID();
  const origin = resolveFrontendOrigin(c);
  const redirect = safePath(c.req.query('redirect'));
  // Set signed state cookie — replaces KV.put('oauth:state:{state}').
  c.header('Set-Cookie', await setStateCookie(c, { state, origin, redirect }));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/api/auth/google/callback`,
```

menjadi:

```ts
  const state = crypto.randomUUID();
  const origin = resolveFrontendOrigin(c);
  const redirect = safePath(c.req.query('redirect'));
  // Set signed state cookie — replaces KV.put('oauth:state:{state}').
  c.header('Set-Cookie', await setStateCookie(c, { state, origin, redirect }));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: oauthRedirectUri(c),
```

Dan di route `/google/callback`, ganti:

```ts
  const base = new URL(c.req.url).origin;

  // 2. Exchange code → access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${base}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
```

menjadi:

```ts
  // 2. Exchange code → access token. redirect_uri harus identik dengan yang
  // dikirim di langkah authorize — Google mencocokkan string-nya persis.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: oauthRedirectUri(c),
      grant_type: 'authorization_code',
    }),
  });
```

Pastikan `const base = new URL(c.req.url).origin;` di callback sudah dihapus (tidak lagi dipakai di sana).

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsx --test test/cookie-samesite.test.mjs test/service-gate.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
cd /home/user/indohome-mmk/Manga/apps/api-cf && npx tsc --noEmit
```

Expected: tidak ada error.

- [ ] **Step 7: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/api-cf/src/lib/auth.ts apps/api-cf/src/routes/auth.ts apps/api-cf/test/cookie-samesite.test.mjs && git commit -m "fix(api-cf): the session cookie has to live on oktzz.xyz for the proxy to ever see it"
```

---

### Task 5: Proxy BFF di `manga-web`

Ini task inti. Semua request browser masuk lewat sini, dan ini satu-satunya tempat `SERVICE_TOKEN` disisipkan.

**Files:**
- Create: `apps/web/src/pages/api/[...path].ts`
- Modify: `apps/web/src/lib/api.ts` (export `getOrigins`)
- Test: `apps/web/test/bff-proxy.test.ts`

**Interfaces:**
- Consumes: `getOrigins(): Promise<{ url: string }[]>` dari `src/lib/api.ts` (diekspor di task ini)
- Produces:
  - `export const ALLOWED_PREFIXES: readonly string[]`
  - `export const isProxyAllowed(path: string): boolean`
  - `export const buildUpstreamHeaders(req: Request, token: string): Headers`
  - `export const relayHeaders(upstream: Headers): Headers`
  - route `ALL` di `src/pages/api/[...path].ts`

- [ ] **Step 1: Write the failing test**

Buat `apps/web/test/bff-proxy.test.ts`:

```ts
// Proxy BFF manga-web → worker API. Tiga job yang harus benar, dan ketiganya
// adalah pembeda antara "API terkunci" dan "API terkunci yang bisa ditembus":
//   1. token milik client dibuang (kalau tidak, siapa pun bisa menyamar)
//   2. hanya path yang benar-benar diizinkan yang diteruskan
//   3. respons non-JSON (302 OAuth, 204, gambar) diteruskan apa adanya
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_PREFIXES, buildUpstreamHeaders, isProxyAllowed, relayHeaders } from '../../src/pages/api/[...path].ts';

// ── Allowlist ──────────────────────────────────────────────────────────────────
test('path data & auth diteruskan', () => {
  const ok = [
    '/api/health', '/api/origins', '/api/auth', '/api/auth/google',
    '/api/auth/google/callback', '/api/auth/logout', '/api/user/me',
    '/api/user/bookmark/naruto', '/api/admin/monitoring', '/api/series',
    '/api/search', '/api/homepage', '/api/reader/komiku/chapter/abc',
    '/api/manga/komiku/x', '/api/novel/catalog', '/api/resolve/komiku',
    '/api/identify', '/api/source-status',
  ];
  for (const p of ok) assert.equal(isProxyAllowed(p), true, `${p} harusnya boleh`);
});

test('jalur privileged ditolak — proxy bukan jalan baru ke sana', () => {
  const no = [
    '/api/_internal/db/exec', '/api/_internal/db/query', '/api/_internal/kv/get',
    '/api/scrape', '/api/scrape/job/1',
  ];
  for (const p of no) assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
});

test('admin baca tetap boleh — browser butuh untuk dashboard', () => {
  assert.equal(isProxyAllowed('/api/admin/monitoring'), true);
  assert.equal(isProxyAllowed('/api/admin/dashboard/storage'), true);
  assert.equal(isProxyAllowed('/api/admin/users'), true);
});

// Path traversal & prefix-grabbing ditolak. Ini yang paling mudah lupa: naive
// startsWith('/api/user') ikut mencerna '/api/usersecret'.
test('prefix tidak boleh mencerna path di luar namespace', () => {
  const sneaky = [
    '/api/_internalX', '/api/internal/db/exec',
    '/api/scraped', '/api/scraper', '/api/scrapeable',
    '/api/seriesXYZ', '/api/seriesfoo',
    '/api/userstuff', '/api/users',
  ];
  for (const p of sneaky) assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
});

test('path di luar /api selalu ditolak', () => {
  for (const p of ['/', '/login', '/admin', '/img/komiku/x/1', '/api', '/api/', '/x/api/series']) {
    assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
  }
});

// ── Token stripping ────────────────────────────────────────────────────────────
test('token milik client dibuang, milik worker yang dikirim', () => {
  const req = new Request('https://oktzz.xyz/api/series', {
    headers: {
      'x-service-token': 'ATTACKER-SUPPLIED',
      cookie: '__Host-session=abc',
      accept: 'application/json',
    },
  });
  const h = buildUpstreamHeaders(req, 'REAL-TOKEN');
  assert.equal(h.get('x-service-token'), 'REAL-TOKEN', 'token client menimpa token worker');
  assert.notEqual(h.get('x-service-token'), 'ATTACKER-SUPPLIED');
});

test('header hop-by-hop / host tidak diteruskan', () => {
  const req = new Request('https://oktzz.xyz/api/series', {
    headers: { host: 'evil.example', 'cf-connecting-ip': '1.2.3.4', origin: 'https://evil.example' },
  });
  const h = buildUpstreamHeaders(req, 'REAL-TOKEN');
  assert.equal(h.get('host'), null, 'host diteruskan');
  assert.equal(h.get('origin'), null, 'origin diteruskan — gate sudah tidak memakainya');
  assert.equal(h.get('cf-connecting-ip'), null);
});

test('cookie diteruskan — session harus sampai ke worker API', () => {
  const req = new Request('https://oktzz.xyz/api/user/me', {
    headers: { cookie: '__Host-session=abc.def; other=1' },
  });
  assert.equal(buildUpstreamHeaders(req, 'T').get('cookie'), '__Host-session=abc.def; other=1');
});

// ── Relay ──────────────────────────────────────────────────────────────────────
test('relay membawa status-worthy headers, terutama semua Set-Cookie', () => {
  const up = new Headers();
  up.set('content-type', 'application/json');
  up.set('cache-control', 'no-store');
  up.append('set-cookie', '__Host-session=aaa; Path=/; HttpOnly; SameSite=Lax; Secure');
  up.append('set-cookie', '__Host-oauth-state=; Path=/; HttpOnly; Max-Age=0');
  const out = relayHeaders(up);
  assert.equal(out.get('content-type'), 'application/json');
  assert.equal(out.get('cache-control'), 'no-store');
  const cookies = out.getSetCookie();
  assert.equal(cookies.length, 2, `hanya ${cookies.length} Set-Cookie diteruskan`);
  assert.ok(cookies.some((c) => c.includes('__Host-session=aaa')));
  assert.ok(cookies.some((c) => c.includes('__Host-oauth-state=')));
});

test('relay tidak membocorkan header internal worker', () => {
  const up = new Headers();
  up.set('cf-ray', 'abc');
  up.set('x-service-token', 'REAL-TOKEN');
  up.set('content-type', 'text/plain');
  const out = relayHeaders(up);
  assert.equal(out.get('cf-ray'), null);
  assert.equal(out.get('x-service-token'), null, 'token bocor ke browser');
});

test('relay menghasilkan header valid walau upstream kosong', () => {
  const out = relayHeaders(new Headers());
  assert.ok(out instanceof Headers);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga && npx bun test apps/web/test/bff-proxy.test.ts
```

Expected: FAIL — modul `../../src/pages/api/[...path].ts` belum ada.

- [ ] **Step 3: Export getOrigins from lib/api.ts**

Di `apps/web/src/lib/api.ts`, ubah:

```ts
const getOrigins = async (): Promise<{ url: string }[]> => {
```

menjadi:

```ts
export const getOrigins = async (): Promise<{ url: string }[]> => {
```

- [ ] **Step 4: Create the proxy endpoint**

Buat `apps/web/src/pages/api/[...path].ts`:

```ts
import type { APIRoute } from 'astro';
import { getOrigins } from '@/lib/api';

// BFF proxy: satu-satunya pintu masuk ke worker API.
//
// Semua trafik browser melewati sini, dan di sinilah SERVICE_TOKEN disisipkan.
// Worker API menolak apa pun yang tidak membawa token itu (serviceGate token-only),
// jadi proxy ini yang membuat penguncian itu mungkin tanpa membocorkan token ke
// browser — token hanya hidup di memori worker, tidak pernah sampai ke client.
//
// Tiga aturan yang tidak boleh dilonggarkan:
//   1. Token dari client SELALU dibuang. Kalau tidak diteruskan, siapa pun bisa
//      menyamar sebagai manga-web dan mengunci ini tidak berarti apa-apa.
//   2. Allowlist path. Tanpa ini, proxy jadi jalan BARU ke /api/_internal/* (yang
//      punya key sendiri) dan /api/scrape (admin key). Proxy tidak boleh menambah
//      attack surface.
//   3. Respons non-JSON diteruskan apa adanya. OAuth callback mengembalikan 302
//      + Set-Cookie; memaksanya jadi JSON akan mematikan login.
export const prerender = false;

// Prefix dicocokkan dengan batas slash: '/api/user' TIDAK boleh mencerna
// '/api/users' atau '/api/userstuff'. Perbandingan pakai startsWith(p + '/').
export const ALLOWED_PREFIXES: readonly string[] = [
  '/api/health',
  '/api/origins',
  '/api/auth',
  '/api/user',
  '/api/admin',
  '/api/series',
  '/api/search',
  '/api/homepage',
  '/api/reader',
  '/api/manga',
  '/api/novel',
  '/api/resolve',
  '/api/identify',
  '/api/source-status',
];

// Segmen yang hanya boleh namun tak pernah dibutelyahi lewat proxy publik.
// Dipisah dari ALLOWED_PREFIXES supaya reviewer bisa melihatnya eksplisit.
const NEVER_VIA_PROXY = ['/api/_internal', '/api/scrape'];

export const isProxyAllowed = (path: string): boolean => {
  if (!path.startsWith('/api/')) return false;
  for (const denied of NEVER_VIA_PROXY) {
    if (path === denied || path.startsWith(denied + '/')) return false;
  }
  return ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
};

// Header yang TIDAK boleh diteruskan ke worker: milik koneksi atau identitas pengirim.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-service-token',
  'cookie2',
]);

export const buildUpstreamHeaders = (req: Request, token: string): Headers => {
  const out = new Headers();
  for (const [key, value] of req.headers) {
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    out.set(lower, value);
  }
  // Token worker menimpa apa pun yang dikirim client.
  out.set('x-service-token', token);
  return out;
};

// Header yang tidak diteruskan balik ke browser.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'x-service-token',
  'cf-ray',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

export const relayHeaders = (upstream: Headers): Headers => {
  const out = new Headers();
  for (const [key, value] of upstream) {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    out.set(lower, value);
  }
  for (const cookie of upstream.getSetCookie()) out.append('set-cookie', cookie);
  return out;
};

const serviceTokenOf = (): string => {
  const g = globalThis as { __SERVICE_TOKEN__?: string };
  return g.__SERVICE_TOKEN__ ?? '';
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const ALL: APIRoute = async ({ request, params }) => {
  const path = `/api/${params.path ?? ''}`;
  if (!isProxyAllowed(path)) return json({ error: 'not found' }, 404);

  const token = serviceTokenOf();
  if (!token) {
    // Fail-closed: tanpa token, worker API akan menolak semua request anyway.
    // Gagal diam-diam lebih buruk daripada error yang jelas.
    return json({ error: 'proxy not configured' }, 503);
  }

  const url = new URL(request.url);
  const upstream = `${path}${url.search}`;

  const headers = buildUpstreamHeaders(request, token);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let lastError = 'no origin';
  for (const origin of await getOrigins()) {
    try {
      const res = await fetch(`${origin.url}${upstream}`, {
        method: request.method,
        headers,
        body,
        // redirect: 'manual' wajib — OAuth callback mengembalikan 302 + Set-Cookie.
        // Kalau fetch mengikuti redirect, cookie-nya hilang dan login mati.
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const relayed = relayHeaders(res.headers);
      // Cache per-user tak boleh nyangkut di edge manga-web.
      if (!relayed.has('cache-control')) relayed.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers: relayed });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return json({ error: 'upstream unavailable', detail: lastError }, 502);
};
```

dan

```ts
// Header yang tidak diteruskan balik ke browser.
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/user/indohome-mmk/Manga && npx bun test apps/web/test/bff-proxy.test.ts
```

Expected: PASS.

Kalau gagal pada `getSetCookie()` — Bun mungkin tidak dukung plural itu di `Headers`. Kalau begitu, ganti `relayHeaders` dan test-nya ke bentuk yang kompatibel: pakai array yang dikumpulkan manual lewat `headers.getSetCookie?.()` dengan fallback parse `set-cookie` gabungan. Test tetap sama.

- [ ] **Step 6: Wire the new test into the web test script**

`apps/web/package.json` sekarang menjalankan daftar file eksplisit. Tambahkan file baru:

```json
"test": "bun test test/canonical-url.test.ts test/admin-inventory.test.ts test/admin-storage-donut.test.ts test/route-type-guard.test.ts test/novel-route-guard.test.ts test/novel-neighbours.test.ts test/novel-chapter-page.test.ts test/novel-render.test.tsx test/bff-proxy.test.ts && bun test/round-robin.test.ts"
```

- [ ] **Step 7: Run the whole web suite**

```bash
cd /home/user/indohome-mmk/Manga && npm test --workspace apps/web 2>&1 | tail -20
```

Expected: semua hijau. Kalau `bff-proxy.test.ts` gagal karena `@/lib/api` tidak bisa di-resolve di luar konteks Astro, pindahkan helper murni (`ALLOWED_PREFIXES`, `isProxyAllowed`, `buildUpstreamHeaders`, `relayHeaders`) ke file baru `apps/web/src/lib/bff-proxy.ts` dan import dari sana — endpoint cuma memakainya. Itu juga batas yang lebih bersih: helper murni tanpa dependensi Astro bisa diuji.

- [ ] **Step 8: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/web/src/pages/api apps/web/src/lib/api.ts apps/web/test/bff-proxy.test.ts apps/web/package.json && git commit -m "feat(web): BFF proxy is now the only way into the API workers"
```

---

### Task 6: Client caller lewat same-origin

Semua request browser harus jadi same-origin. Ini menyentuh lebih dari 15 file dari yang diperkirakan: island seperti `ReaderShell`, `ChapterSection`, `NovelReader`, `NovelCatalog`, `NotFoundPage`, `SourceMonitorPage`, `StatusPage` memanggil helper `lib/api.ts` yang selama ini menembak worker API langsung. Setelah gate dikunci, semuanya 403 kecuali lewat proxy.

Kuncinya: perbaikannya di `lib/api.ts`, bukan di setiap komponen.

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: 11 komponen (lihat daftar di Interface)
- Test: `apps/web/test/browser-same-origin.test.ts`

**Interfaces:**
- Consumes: `getOrigins()` dari `src/lib/api.ts`
- Produces:
  - `export const BROWSER_API_BASE: string` — `''` (same-origin)
  - `export const SSR_API_BASE: string` — URL worker API dari `PUBLIC_API_URL`
  - Hapus: `getAuthApiUrl`, `setAuthOrigin`

- [ ] **Step 1: Write the failing test**

Buat `apps/web/test/browser-same-origin.test.ts`:

```ts
// Setelah gate token-only, tidak boleh ada helper client yang menembak worker
// API secara langsung — semuanya harus same-origin lewat proxy BFF.
// test ini menyimulasikan lingkungan browser (window + sessionStorage ada) dan
// memastikan tidak ada fetch lintas-origin yang dibangun.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync as readDirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fake browser environment SEBELUM import modul.
const store = new Map<string, string>();
(globalThis as any).window = globalThis;
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const api = await import('../../src/lib/api.ts');

test('BROWSER_API_BASE kosong — semua fetch client jadi relative', () => {
  assert.equal(api.BROWSER_API_BASE, '');
});

test('tidak ada lagi getAuthApiUrl / setAuthOrigin untuk dispersal', () => {
  assert.equal((api as any).getAuthApiUrl, undefined, 'getAuthApiUrl masih ada');
  assert.equal((api as any).setAuthOrigin, undefined, 'setAuthOrigin masih ada');
});

test('tidak ada komponen client yang memanggil getAuthApiUrl', () => {
  const dir = new URL('../../src/components/', import.meta.url);
  const files = [...listFiles(dir)].filter((f) => f.endsWith('.tsx'));
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/getAuthApiUrl|setAuthOrigin/.test(text)) offenders.push(f.pathname);
  }
  assert.deepEqual(offenders, [], `masih pakai getAuthApiUrl: ${offenders.join(', ')}`);
});

test('komponen auth tidak lagi membangun URL lintas-origin sendiri', () => {
  const authForm = readFileSync(
    fileURLToPath(new URL('../../src/components/AuthForm.tsx', import.meta.url)), 'utf8');
  // URL OAuth harus relative: /api/auth/google?...
  assert.ok(
    !/\$\{apiUrl\}\/api\/auth\/google/.test(authForm),
    'AuthForm masih merakit URL OAuth dari apiUrl'
  );
  assert.ok(/'\/api\/auth\/google\?/.test(authForm), 'AuthForm tidak memakai path relative');
});

function* listFiles(dir: URL): Generator<URL> {
  for (const entry of readDirSync(dir)) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) yield* listFiles(url);
    else yield url;
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga && npx bun test apps/web/test/browser-same-origin.test.ts
```

Expected: FAIL — `BROWSER_API_BASE` belum ada.

- [ ] **Step 3: Make API_URL polymorphic in lib/api.ts**

Di `apps/web/src/lib/api.ts`, ganti blok definisi base:

```ts
// API_URL: worker API utama. Production via PUBLIC_API_URL (Pages env).
export const API_URL = envPublic('PUBLIC_API_URL') || 'http://localhost:8787';
```

menjadi:

```ts
// Base URL untuk pemanggilan API, bergantung di mana kodenya berjalan.
//
// SSR (server) boleh menembak worker API langsung: kodenya ada di worker
// manga-web yang memegang SERVICE_TOKEN, dan lompatannya tidak menambah latency
// (permintaan tetap harus masuk worker API).
//
// Browser tidak boleh. Gate worker API kini token-only dan token itu tidak
// pernah sampai ke client, jadi satu-satunya jalur yang tersisa adalah proxy
// BFF di oktzz.xyz — yang persis sama dengan origin browser, makanya base-nya
// kosong dan semua fetch jadi relative.
//
// Ini juga menghapus kebutuhan load-balancer round-robin di browser: pendulum
// digeser ke server (proxy), yang bebas berotasi tiap request tanpa menyimpan
// state di sessionStorage.
const SSR_API_BASE = envPublic('PUBLIC_API_URL') || 'http://localhost:8787';
export const SSR_API_BASE_EXPORT = SSR_API_BASE;
export const BROWSER_API_BASE = '';

export const API_URL = typeof window !== 'undefined' ? BROWSER_API_BASE : SSR_API_BASE;
```

- [ ] **Step 4: Make apiWithFailover single-hop in the browser**

Ganti fungsi `apiWithFailover`:

```ts
export async function apiWithFailover<T>(path: string): Promise<T> {
  if (!ORIGIN_PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
    return api<T>(path); // non-publik → main API saja
  }
  const origins = await getOrigins();
  if (origins.length === 0) return api<T>(path);

  const now = Date.now();
  // Rotate across ALL origins (not a fixed 2-attempt cap) so load spreads.
  for (const origin of buildOriginOrder(origins)) {
    const state = failures.get(origin.url);
    if (state && state.until > now) continue; // circuit open → skip
    try {
      const res = await fetch(`${origin.url}${path}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        const f = failures.get(origin.url);
        const count = (f?.count ?? 0) + 1;
        failures.set(origin.url, { url: origin.url, count, until: count >= 2 ? now + 60000 : now + 5000 });
        continue;
      }
      failures.set(origin.url, { count: 0, until: 0 });
      if (!res.ok) throw new Error(`origin ${path} → ${res.status}`);
      return res.json() as Promise<T>;
    } catch {
      const f = failures.get(origin.url);
      const count = (f?.count ?? 0) + 1;
      failures.set(origin.url, { url: origin.url, count, until: count >= 2 ? now + 60000 : now + 5000 });
    }
  }
  return api<T>(path); // semua origin gagal → main API
}
```

menjadi:

```ts
export async function apiWithFailover<T>(path: string): Promise<T> {
  // Browser: satu hop ke proxy BFF. Proxy yang memutuskan worker mana yang
  // melayani — sehingga load-balancer pindah dari client (yang butuh state di
  // sessionStorage dan hanya bisa merotasi per tab) ke server (stateless, bisa
  // merotasi tiap request). Token juga ditambahkan oleh proxy, bukan di sini.
  if (typeof window !== 'undefined') return api<T>(path);

  if (!ORIGIN_PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
    return api<T>(path); // non-publik → main API saja
  }
  const origins = await getOrigins();
  if (origins.length === 0) return api<T>(path);

  const now = Date.now();
  // Rotate across ALL origins (not a fixed 2-attempt cap) so load spreads.
  for (const origin of buildOriginOrder(origins)) {
    const state = failures.get(origin.url);
    if (state && state.until > now) continue; // circuit open → skip
    try {
      const res = await fetch(`${origin.url}${path}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429 || res.status >= 500) {
        const f = failures.get(origin.url);
        const count = (f?.count ?? 0) + 1;
        failures.set(origin.url, { count, until: count >= 2 ? now + 60000 : now + 5000 });
        continue;
      }
      failures.set(origin.url, { count: 0, until: 0 });
      if (!res.ok) throw new Error(`origin ${path} → ${res.status}`);
      return res.json() as Promise<T>;
    } catch {
      const f = failures.get(origin.url);
      const count = (f?.count ?? 0) + 1;
      failures.set(origin.url, { count, until: count >= 2 ? now + 60000 : now + 5000 });
    }
  }
  return api<T>(path); // semua origin gagal → main API
}
```

- [ ] **Step 5: Make the auth helpers same-origin**

Ganti setiap `const base = await getAuthApiUrl();` dengan base kosong. Di `fetchMe`:

```ts
export const fetchMe = async (): Promise<AuthUser | null> => {
  try {
    const res = await fetch('/api/user/me', {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
```

Ulangi pola yang sama untuk `logout`, `patchMe`, `deleteMe`, `clearHistory`, `clearBookmarks`, `apiGet`, `apiPost`, `apiPatch` — semua `const base = await getAuthApiUrl();` diganti `const base = '';` dan template literal `${base}/api/...` tetap jalan sebagai path relative.

Lalu hapus definisi yang tak terpakai:

```ts
// Auth API: primary akun-2, fallback akun-3, last resort akun-1 (main).
// Sticky origin via sessionStorage — setelah login, semua /api/auth/* +
// /api/user/* calls ikut origin yang dipilih (D1 split per-akun, data user
// harus konsisten).
const AUTH_API_URL = envPublic('PUBLIC_AUTH_API_URL') || API_URL;
const AUTH_CACHE_KEY = 'auth_origin';
```

dan:

```ts
// Module-level cache (5 min): hindari health-check berulang tiap mount
// (BookmarkButton, Navbar, AuthForm, admin pages). Sticky sessionStorage
// tetap prioritas utama; cache ini hanya menutup window sebelum login.
let authOriginCache: { origin: string; at: number } | null = null;

export async function getAuthApiUrl(): Promise<string> {
  if (typeof sessionStorage !== 'undefined') {
    const cached = sessionStorage.getItem(AUTH_CACHE_KEY);
    if (cached) return cached;
  }
  if (authOriginCache && Date.now() - authOriginCache.at < 300000) {
    return authOriginCache.origin;
  }
  const candidate = AUTH_API_URL || API_URL;
  try {
    const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      authOriginCache = { origin: candidate, at: Date.now() };
      return candidate;
    }
  } catch {}
  authOriginCache = { origin: candidate, at: Date.now() };
  return candidate;
}

// Set sticky origin after successful login (called by AuthForm post-callback).
// MUST be called immediately after login so subsequent bookmark/me calls hit
// the cookie-bearing origin (avoids cross-origin cookie 401 + D1-split
// inconsistency).
export function setAuthOrigin(origin: string): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(AUTH_CACHE_KEY, origin);
  }
}
```

Hapus juga `getNextRrIndex` (sekarang tidak dipanggil dari mana pun di jalur browser) dan cabang `sessionStorage` di `buildOriginOrder`:

```ts
const buildOriginOrder = (origins: { url: string }[]): { url: string }[] => {
  const now = Date.now();
  const healthy = origins.filter((o) => !isCircuitOpen(o.url, now));
  const pool = healthy.length > 0 ? healthy : origins;
  if (healthy.length === 0) {
    console.warn('[apiWithFailover] all origins circuit-open — using full pool (may add latency)');
  }
  const start = Math.floor(Math.random() * pool.length);
  return [...pool.slice(start), ...pool.slice(0, start)];
};
```

- [ ] **Step 6: Update the 11 client components**

Hapus import dan panggilan `getAuthApiUrl` dari semua file ini:

| File | Yang diubah |
|---|---|
| `src/components/AuthForm.tsx` | Hapus `getAuthApiUrl, setAuthOrigin` dari import; hapus `useEffect` yang memanggilnya; `googleUrl` jadi `'/api/auth/google?origin=' + ...` |
| `src/components/BookmarkButton.tsx` | Hapus import + 2 pemanggilan |
| `src/components/ContinueReadingRail.tsx` | Hapus import + 1 pemanggilan |
| `src/components/Navbar.tsx` | Hapus import bila ada; `logout()` tetap dari lib |
| `src/components/pages/BookmarksPage.tsx` | Hapus import + 2 pemanggilan |
| `src/components/pages/HistoryPage.tsx` | Hapus import + 1 pemanggilan |
| `src/components/pages/AdminSettings.tsx` | Hapus import + 3 pemanggilan |
| `src/components/pages/AdminTopbar.tsx` | Hapus import bila ada |
| `src/components/pages/AdminDashboard.tsx` | Hapus import bila ada |
| `src/components/pages/AdminLog.tsx` | Hapus import bila ada |
| `src/components/pages/AdminMonitoring.tsx` | Hapus import bila ada |
| `src/components/pages/AdminSaved.tsx` | Hapus import bila ada |
| `src/components/pages/AdminUsers.tsx` | Hapus import bila ada |
| `src/components/pages/AdminUserDetail.tsx` | Hapus import bila ada |

Di `AuthForm.tsx`, ganti blok:

```tsx
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getAuthApiUrl().then((url) => {
      if (!alive) return;
      setApiUrl(url);
      setAuthOrigin(url);
    });
    return () => { alive = false; };
  }, []);

  // Build Google OAuth URL dynamically — pass origin + redirect for state cookie.
  // Turnstile token di-verify server-side sebelum redirect ke Google.
  const googleUrl = apiUrl
    ? `${apiUrl}/api/auth/google?origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}&redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}${token ? `&turnstile_token=${encodeURIComponent(token)}` : ''}`
    : '#';

  const gateLocked = TURNSTILE_SITE_KEY !== '' && !token;
```

menjadi:

```tsx
  const [token, setToken] = useState<string | null>(null);

  // URL OAuth relatif: masuk ke proxy BFF, yang menambah SERVICE_TOKEN sebelum
  // meneruskan ke worker API. Callback mendarat di oktzz.xyz juga, jadi cookie
  // session milik oktzz.xyz — satu-satunya domain yang dikenal browser.
  const googleUrl = `/api/auth/google?origin=${encodeURIComponent(
    typeof window !== 'undefined' ? window.location.origin : ''
  )}&redirect=${encodeURIComponent(
    typeof window !== 'undefined' ? window.location.pathname : '/'
  )}${token ? `&turnstile_token=${encodeURIComponent(token)}` : ''}`;

  const gateLocked = TURNSTILE_SITE_KEY !== '' && !token;
```

Lalu di `<a href={googleUrl} onClick={...}>` dan `aria-disabled`, hapus rujukan `apiUrl`:

```tsx
      <a
        href={googleUrl}
        onClick={(e) => { if (gateLocked) e.preventDefault(); }}
        aria-disabled={gateLocked}
        className={`btn w-full !min-h-[48px] border border-border-default bg-primary/[0.04] text-primary text-[15px] font-semibold hover:bg-elevated hover:border-border-strong ${
          gateLocked ? 'pointer-events-none opacity-50' : ''
        }`}
```

Di komponen lain, pola umumnya sama: hapus `import { getAuthApiUrl } from '@/lib/api';` dan ganti `const base = await getAuthApiUrl();` dengan `const base = '';`.

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd /home/user/indohome-mmk/Manga && npx bun test apps/web/test/browser-same-origin.test.ts apps/web/test/bff-proxy.test.ts
```

Expected: PASS.

- [ ] **Step 8: Wire the new test into the web test script**

Tambahkan `test/browser-same-origin.test.ts` ke script `test` di `apps/web/package.json`.

- [ ] **Step 9: Run the full web suite + typecheck**

```bash
cd /home/user/indohome-mmk/Manga && npm test --workspace apps/web 2>&1 | tail -20 && npm run lint --workspace apps/web
```

Expected: semua hijau, `astro check` tanpa error TypeScript.

Kalau `astro check` protes `getNextRrIndex` atau `AUTH_API_URL` masih/ruang, bersihkan sampai bersih.

- [ ] **Step 10: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/web && git commit -m "refactor(web): every browser call goes same-origin through the BFF, load balancing moves server-side"
```

---

### Task 7: `/api` masuk `NO_STORE`

Response per-user tidak boleh nyangkut di edge cache manga-web — pengulangan dari `noStoreMw` sisi worker API.

**Files:**
- Modify: `apps/web/src/middleware.ts`
- Test: `apps/web/test/api-no-store.test.ts`

**Interfaces:**
- Consumes: tidak ada
- Produces: tidak ada

- [ ] **Step 1: Write the failing test**

Buat `apps/web/test/api-no-store.test.ts`:

```ts
// Cache-Control: no-store untuk /api di sisi manga-web. Worker API sudah
//menuju noStoreMw untuk /api/user/*, /api/admin/*, /api/auth/*, /api/_internal/*,
// tapi sisi web tidak — dan middleware web punya cache edge sendiri (300s) yang
// akan menahan respons per-user antar-visitor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MW = readFileSync(
  fileURLToPath(new URL('../../src/middleware.ts', import.meta.url)), 'utf8');

test('NO_STORE mencakup /api', () => {
  const match = MW.match(/const NO_STORE = \[([^\]]*)\]/);
  assert.ok(match, 'NO_STORE tidak ditemukan');
  const entries = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.includes('/api'), `NO_STORE = ${JSON.stringify(entries)} — /api belum ada`);
});

test('NO_STORE tetap punya path halaman yang sudah ada', () => {
  const match = MW.match(/const NO_STORE = \[([^\]]*)\]/);
  const entries = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const p of ['/bookmark', '/history', '/profile', '/login', '/admin']) {
    assert.ok(entries.includes(p), `${p} hilang dari NO_STORE`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/user/indohome-mmk/Manga && npx bun test apps/web/test/api-no-store.test.ts
```

Expected: FAIL — `/api belum ada`.

- [ ] **Step 3: Add /api to NO_STORE**

Di `apps/web/src/middleware.ts`, ganti:

```ts
const NO_STORE = ['/bookmark', '/history', '/profile', '/login', '/admin'];
```

menjadi:

```ts
// /api ikut no-store: proxy BFF meneruskan respons per-user (bookmark, /me,
// admin) dan tanpa ini cache edge 300s di sini akan menahan satu respons untuk
// visitor berikutnya. Worker API sudah punya noStoreMw sendiri untuk prefix
// yang sama; ini lapisan kedua, di sisi yang berbeda.
const NO_STORE = ['/api', '/bookmark', '/history', '/profile', '/login', '/admin'];
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/user/indohome-mmk/Manga && npx bun test apps/web/test/api-no-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/user/indohome-mmk/Manga && git add apps/web/src/middleware.ts apps/web/test/api-no-store.test.ts apps/web/package.json && git commit -m "fix(web): per-user API responses were eligible for the edge cache"
```

---

### Task 8: Deploy + verifikasi

Task ini mengubah gate yang sedang hidup. Urutan API-lalu-web itu disengaja: begitu worker API di-deploy, semua request tanpa token ditolak, jadi web baru harus menyusul secepat mungkin.

**Files:** tidak ada perubahan kode

- [ ] **Step 1: Confirm the deploy toolchain**

```bash
cd /home/user/indohome-mmk/Manga && node -v && npx wrangler --version
```

Expected: Node ≥ 22 dan wrangler 3.114.x. Kalau Node < 22, export `PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH"` dulu.

- [ ] **Step 2: Baseline check — apa yang harus berubah**

```bash
cd /home/user/indohome-mmk/Manga
curl -s -o /dev/null -w "worker /api/series → %{http_code}\n" https://manga-api-2.tzok5555.workers.dev/api/series
curl -s -o /dev/null -w "worker /api/series (spoofed Origin) → %{http_code}\n" -H "Origin: https://oktzz.xyz" https://manga-api-2.tzok5555.workers.dev/api/series
curl -s -o /dev/null -w "oktzz /api/series → %{http_code}\n" https://oktzz.xyz/api/series
```

Catat hasilnya. Yang diharapkan **sebelum** deploy: 200 / 200 / (404 atau 200 — belum ada proxy). Yang diharapkan **sesudah**: 403 / 403 / 200.

- [ ] **Step 3: Deploy the four API workers**

```bash
cd /home/user/indohome-mmk/Manga && set -a && . .env && set +a
i=1
for cfg in wrangler.toml wrangler.origin.toml wrangler.origin3.toml wrangler.origin4.toml; do
  eval "tok=\${CF_TOKEN_AKUN$i}"; eval "aid=\${CF_ACCOUNT_ID_AKUN$i}"; eval "wn=\${WORKER_NAME_AKUN$i}"
  echo "=== deploy $wn (akun$i)"
  CLOUDFLARE_API_TOKEN="$tok" CLOUDFLARE_ACCOUNT_ID="$aid" npx wrangler deploy --config "apps/api-cf/$cfg" || echo "GAGAL: $wn"
  i=$((i+1))
done
```

Expected: keempatnya deploy sukses. Kalau ada yang gagal, **berhenti di sini** — jangan lanjut ke web, karena tanpa gate worker API masih terbuka dan user masih bisa masuk (lebih baik daripada mati total).

- [ ] **Step 4: Verify the lock took effect**

```bash
cd /home/user/indohome-mmk/Manga
for u in https://manga-api.oktz.workers.dev https://manga-api-2.tzok5555.workers.dev https://manga-api-3.dwikaoktyffan.workers.dev https://manga-api-4.oktznih.workers.dev; do
  printf "%-55s plain=%s spoofed=%s\n" "$u" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$u/api/series")" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -H 'Origin: https://oktzz.xyz' "$u/api/series")"
done
```

Expected: `plain=403 spoofed=403` untuk keempatnya.

- [ ] **Step 5: Deploy the web worker**

```bash
cd /home/user/indohome-mmk/Manga/apps/web && npm run deploy
```

Expected: build sukses, deploy sukses.

- [ ] **Step 6: Verify end-to-end**

```bash
cd /home/user/indohome-mmk/Manga
echo "-- public read via proxy"
curl -s -o /dev/null -w "oktzz /api/series     → %{http_code}\n" https://oktzz.xyz/api/series
curl -s -o /dev/null -w "oktzz /api/homepage   → %{http_code}\n" https://oktzz.xyz/api/homepage
echo "-- privileged path must NOT be reachable via proxy"
curl -s -o /dev/null -w "oktzz /api/_internal/db/exec → %{http_code}\n" -X POST https://oktzz.xyz/api/_internal/db/exec
curl -s -o /dev/null -w "oktzz /api/scrape           → %{http_code}\n" https://oktzz.xyz/api/scrape
echo "-- health + origins still public"
curl -s -o /dev/null -w "worker /api/health → %{http_code}\n" https://manga-api-2.tzok5555.workers.dev/api/health
```

Expected: 200 untuk public read, **404** untuk `_internal` dan `scrape` (proxy menolak, bukan worker yang menolak), 200 untuk `/api/health`.

- [ ] **Step 7: Verify pages render**

```bash
cd /home/user/indohome-mmk/Manga
for p in / /search?q=naruto /manga/one-piece /login; do
  printf "%-30s → %{http_code}\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://oktzz.xyz$p")"
done
```

Expected: semua 200. Halaman detail akan lewat SSR → worker API dengan token, jadi harus tetap jalan.

- [ ] **Step 8: Verify a signed image loads**

Buka satu chapter di browser, atau ambil URL gambar dari respons chapter-detail dan curl dengan signature-nya:

```bash
cd /home/user/indohome-mmk/Manga
curl -s https://oktzz.xyz/api/reader/komiku/chapter/<CHAPTER_ID> | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d); const u=j.data?.pages?.[0]?.imgUrl;
  console.log(u || 'tidak ada imgUrl — cek signature');
});"
```

Kalau dapat URL absolute ke worker API dengan `?exp=&sig=`, curl itu — harus 200. Tanpa signature harus 403:

```bash
curl -s -o /dev/null -w "unsigned /img → %{http_code}\n" "https://manga-api-2.tzok5555.workers.dev/img/komiku/<CHAPTER_ID>/1"
```

Expected: 403. Ini membuktikan fail-closed Task 3 aktif.

- [ ] **Step 9: Test login once, by hand**

Tidak bisa diotomatisasi (Turnstile + Google). Cek manual:

1. Buka `https://oktzz.xyz/login`
2. Selesaikan Turnstile
3. Klik "Masuk dengan Google"
4. Login harus sukses dan redirect ke halaman tujuan
5. Cek cookie di DevTools → `__Host-session` ada di domain `oktzz.xyz`, dengan `SameSite=Lax`
6. Buka `https://oktzz.xyz/bookmark` — harus tampil sebagai user yang login

Kalau gagal dengan `invalid or missing state cookie`, penyebabnya `__Host-oauth-state` tidak terkirim — periksa apakah `SameSite=Lax` sudah terpasang dan callback benar-benar lewat proxy.

- [ ] **Step 10: Commit any runbook updates**

Kalau ada yang perlu dikoreksi saat deploy (misal urutan langkah, atau secret yang ternyata kurang), update `docs/DEPLOY.md`:

```bash
cd /home/user/indohome-mmk/Manga && git add docs/DEPLOY.md && git commit -m "docs: BFF proxy rollout order and verification steps"
```

Kalau tidak ada yang berubah, skip commit ini.

---

## Self-Review

**1. Spec coverage:**

| Spec § | Task |
|---|---|
| §1a token-only gate | Task 1 |
| §1b hapus corsMw | Task 2 |
| §2 proxy + allowlist | Task 5 |
| §2a NO_STORE | Task 7 |
| §3 /img fail-closed | Task 3 |
| §4 cookie Lax | Task 4 |
| §5 kontrak tak berubah | Tidak ada task — memang tidak ada yang berubah |
| §6 redirect_uri | Task 4 |
| §7 sisi client | Task 6 |
| §8 urutan rollout | Task 8 |
| §10 test | Tersebar di setiap task |

**2. Placeholder:** tidak ada. Semua kode ditulis penuh.

**3. Type consistency:** `classifyServiceTier` mengembalikan `'exempt' | 'deny'` di Task 1, dan test di Task 1 asserting `'deny'`. `decideServiceGate({ hasServiceToken, isExempt })` konsisten antara middleware dan test. `isProxyAllowed`, `buildUpstreamHeaders`, `relayHeaders` punya nama yang sama di import test dan di Task 5. `BROWSER_API_BASE` didefinisikan dan diuji di Task 6.

**4. Review Focus:** kelima kelas input dipetakan ke test:
1. token client menimpa → `token milik client dibuang` (Task 5)
2. Set-Cookie relay → `relay membawa status-worthy headers` (Task 5)
3. path traversal → `prefix tidak boleh mencerna path di luar namespace` (Task 5)
4. /img fail-closed tanpa dev escape → `hasValidImgSignature tidak punya cabang fail-open` + `.dev.vars punya escape hatch` (Task 3)
5. respons non-JSON → `relay` + `redirect: 'manual'` di endpoint (Task 5)

**Catatan yang perlu diperhatikan saat eksekusi:**

- Task 5 Step 1 punya satu blok test yang perlu diganti (sudah ditulis perbaikannya di step yang sama) — jangan sempat pakai versi yang salah.
- Task 6 Step 1 butuh import `readdirSync as readDirSync` yang belum ada di blok import awal.
- Task 5 Step 5: `Headers.getSetCookie()` mungkin tidak tersedia di semua runtime Bun — test akan memberi tahu, dan rename ke `src/lib/bff-proxy.ts` adalah fallback yang lebih bersih.
