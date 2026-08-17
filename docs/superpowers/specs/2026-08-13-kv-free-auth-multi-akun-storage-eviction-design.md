# Design: KV-free Auth + Multi-akun Round-Robin + 3-tier Storage Eviction

**Date**: 2026-08-13
**Status**: Draft (pending user review)
**Author**: opencode session (with brainstorming skill)

## Problem Statement

Akun-1 Cloudflare (main Worker `manga-api`) habis **KV write free-tier daily quota** (CF error code `10048`). Login Google OAuth butuh 1 `KV.put` per attempt (untuk `oauth:state:{state}`) → put reject → handler throw → HTTP 500 generik (`onError` mask message) → user gak bisa login sama sekali dari `oktzz.xyz`. Sekalian ada redirect bug: kalau `?origin=` query gak dikirim, user di-lempar ke `manga-web-d32.pages.dev` (urutan `ALLOWED_ORIGINS` menjadikan `pages.dev` fallback pertama).

User punya 3 akun CF + 2 akun Backblaze B2 + R2 ring (R2 cuma akun-1 sebab butuh CC verif). Mau:

1. Minim KV writes di path auth supaya login tahan quota.
2. Frontend round-robin prioritas akun-2 + akun-3 (akun-1 cuma fallback + host frontend).
3. Storage 3-tier (B2-A + B2-B + R2 ring) dgn round-robin upload + eviction LRU chapter lama.

## Architecture

### Topology

| Akun | id | Peran | KV namespace | D1 database | R2 | workers.dev subdomain |
|------|----|----|----|----|----|----|
| Akun-1 (main) | `4ce21aec2dd478bf380b7b59990a9165` | Fallback + Pages frontend | `6205fceab7b64f9d80f6f67e4189316b` | `76606365-0fa5-4c1e-9b55-18a8366ef92a` | `manga-assets` | `manga-api.oktz.workers.dev` (existing) |
| Akun-2 (A) | `6a0bdfb8bccff744bd738a57502d0380` (Tzok5555) | **Primary** | `cf560313c1204ec08f174c8924ad3118` | `61cbf1b1-508e-4b00-a0e6-dd68528e54ba` | none (by design) | `manga-api-2.tzok5555.workers.dev` (subdomain confirmed) |
| Akun-3 (B) | `ddc6f3527032c6e929fddb587f438ca4` (Dwikaoktyffan) | **Primary** | `0412740b508240e99f9b68dd51f3fba3` (created this session) | `160d0a4f-fcc1-4cb6-89e2-c65bcc93a340` (created this session) | none (CC required — skip) | `manga-api-3.dwikaoktyffan.workers.dev` (subdomain created this session) |

```
                ┌──────────────────────────────┐
                │ Cloudflare Pages frontend     │
                │ oktzz.xyz (akun-1)           │
                └──────────┬───────────────────┘
                           │ /api/origins + client-side round-robin
            ┌──────────────┼──────────────┬──────────────┐
            ▼              ▼              ▼              ▼
  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
  │ manga-api      │ │ manga-api-2    │ │ manga-api-3     │
  │ (akun-1 fallback)│ │ (akun-2 prim) │ │ (akun-3 prim)  │
  │ D1+KV+R2+B2use │ │ D1+KV+B2 use  │ │ D1+KV+B2 use   │
  │ origin:        │ │ origin:        │ │ origin:         │
  │ manga-api.oktz  │ │ manga-api-2.tz │ │ manga-api-3.dw  │
  │ .workers.dev   │ │ ok5555.workers │ │ ika.workers.dev │
  └────────┬───────┘ └────────┬───────┘ └────────┬───────┘
           ▼                   ▼                   ▼
       D1 (akun-1)         D1 (akun-2)         D1 (akun-3)
       users etc           users etc           users etc
       sessions            sessions            sessions
       │                   │                   │
       R2 (akun-1)         KV (akun-2)         KV (akun-3)
       │ ASSETS_R2          │ (general cache)   │ (general cache)
       │
       └─ bucket ring multi-domain (hash by slug)
       │
   B2-A (akun-1 primary) + B2-B (akun-2 spillover) + R2 ring (akun-1)
   Upload: round-robin B2-A → B2-B → R2-ring
   Fetch: chapter_pages.b2_account_idx:  -1=B2-A, -2=B2-B, >=0=R2 idx
   Eviction: 80% quota → delete LRU (>30d unaccessed) → turun ke 70%
```

### Branching per-endpoint class

| Class | Path | Worker priority | Reason |
|-------|------|-----------------|--------|
| Auth Google | `/api/auth/google`, `/google/callback` | akun-2 → akun-3 → akun-1 fallback | KV-free ngram, butuh state cookie |
| User | `/api/user/me`, `/bookmark`, `/history` | akun-2 → akun-3 → akun-1 fallback | signed-cookie, D1 read utk revocation |
| Search | `/api/search`, `/api/source-status`, `/api/health` | akun-2 → akun-3 → akun-1 fallback | existing round-robin (allowlist) |
| Reader | `/api/reader/*` | akun-2 → akun-3 → akun-1 fallback | D1 lookup butuh bv local D1 (each akun punya data sendiri) |
| Admin | `/api/admin/*` | akun-2 → akun-3 → akun-1 fallback | session role dari signed-cookie, D1 cross-account D1 is split (eksisting by design) |

> **Known limitation**: data D1 split across 3 akun tidak sinkron. User login via akun-2 = bookmark/history user itu di akun-2. Round-robin client-side会让 user kadang dapat worker lain → data spill. Frontend **sticky origin** setelah login: `setSessionStorage('auth_origin', origin)` dan ikat request `/api/user/*` ke origin tsb 7 hari. User login via akun-3 = stuck ke akun-3 sampai cookie expire/logout.

## Components

### 1. OAuth state — signed cookie (nol KV)

`__Host-oauth-state` cookie HttpOnly `SameSite=None; Secure; Path=/; Max-Age=600`. Payload: `{state, frontendOrigin, redirect, exp:600}` base64url + HMAC-SHA256 signature (`LB_ENCRYPTION_KEY`).

**Flow `/api/auth/google`**:
```ts
const state = crypto.randomUUID();
const payload = JSON.stringify({
  state,
  origin: resolveFrontendOrigin(...),
  redirect: safePath(...),
  exp: Math.floor(Date.now()/1000) + 600,
});
const sig = await hmacSha256(LB_ENCRYPTION_KEY, payload);
const b64 = b64url(payload) + '.' + b64url(sig);
c.header('Set-Cookie', `__Host-oauth-state=${b64}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=600`);
return c.redirect(googleUrl + `&state=${state}`, 302);
```

**Callback `/api/auth/google/callback`**:
```ts
const cookieVal = parseCookie(c.req.header('cookie'))['__Host-oauth-state'];
const [payloadB64, sigB64] = cookieVal.split('.');
const expectedSig = await hmacSha256(LB_ENCRYPTION_KEY, atob(payloadB64));
if (!constantTimeEqualStr(atob(sigB64), expectedSig))
  return c.json({ error: 'invalid state' }, 400);
const info = JSON.parse(atob(payloadB64));
if (info.exp <= Math.floor(Date.now()/1000))
  return c.json({ error: 'state expired' }, 400);
if (info.state !== c.req.query('state'))
  return c.json({ error: 'state mismatch' }, 400);
// clear cookie
c.header('Set-Cookie', clearOAuthStateCookie());
// proceed to exchange code, upsert user, set session cookie
```

**KV writes in `/google`: 0** (was 1 put + 1 get + 1 delete).

### 2. Signed-cookie session + D1 revocation

Cookie `__Host-session` = base64url payload + '.' + HMAC-SHA256 sig.

```ts
type SessionPayload = {
  sid: string;        // UUID, lookup D1 sessions(sid)
  uid: number;
  email: string;
  role: 'user'|'admin';
  iat: number;        // issued at (epoch sec)
  exp: number;        // iat + 7*86400
};
```

**Setelah upsert user Google**:
```ts
const sid = crypto.randomUUID();
const exp = iat + SESSION_TTL;
const payload = JSON.stringify({ sid, uid, email, role, iat, exp });
const sig = await hmacSha256(LB_ENCRYPTION_KEY, payload);
const token = b64url(payload) + '.' + b64url(sig);
// 1 D1 write (sessions INSERT)
await db(c.env.DB).insertSession({ sid, userId: uid, createdAt: iat, expiresAt: exp, ua, ip });
c.header('Set-Cookie', `__Host-session=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${exp - iat}`);
```

**`getSessionUser(c)`**:
```ts
const token = parseCookie(...)['__Host-session'];
const [pB64, sB64] = token.split('.');
const payload = JSON.parse(atob(pB64));
const expectedSig = await hmacSha256(LB_ENCRYPTION_KEY, atob(pB64));
if (!constantTimeEqualStr(atob(sB64), expectedSig)) return null;
if (payload.exp <= Date.now()/1000) return null;
// 1 D1 read (lazy revocation)
const row = await db(c.env.DB).getSession(payload.sid);
if (!row || row.revoked_at !== null) return null;
return { id: payload.uid, email: payload.email, role: payload.role };
```

**`/logout`**:
```ts
const { sid } = decodeSessionPayload(token);
await db(c.env.DB).revokeSession(sid);   // UPDATE sessions SET revoked_at = NOW WHERE sid = ?
c.header('Set-Cookie', clearSessionCookie());
return c.json({ ok: true });
```

**Sessions D1 table** (migration `0008_sessions.sql`, apply to 3 D1):
```sql
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ua TEXT,
  ip TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
-- Migration also cleans legacy KV-issued sessions (older sessions stored in KV, no D1 row — these stay valid-but-unchecked until natural TTL expiry 7d). No cleanup needed.
```

**`listSessionsForUser` / `revokeSessionForUser`** dipindahkan baca D1 `sessions WHERE user_id=? AND revoked_at IS NULL` (sebelumnya baca KV prefix scan).

**Sliding expiry**: gak dipakai — expiry fix di cookie payload `exp` 7 hari. Simpler. Sliding memerlukan re-sign cookie tiap request (overhead). User login ulang kalau expired.

### 3. Frontend changes

#### env vars baru

```
# apps/web/.env.production
NEXT_PUBLIC_API_URL=https://manga-api.oktz.workers.dev         # akun-1 fallback
NEXT_PUBLIC_AUTH_API_URL=https://manga-api-2.tzok5555.workers.dev   # akun-2 primary (auth + user)
NEXT_PUBLIC_AUTH_FALLBACK=https://manga-api-3.dwikaoktyffan.workers.dev  # akun-3 fallback
NEXT_PUBLIC_DATA_API_URL=https://manga-api.oktz.workers.dev
NEXT_PUBLIC_R2_DOMAINS=https://cdn1.oktz.qzz.io            # akun-1 R2 ring (only)
NEXT_PUBLIC_R2_VNODES=32
```

#### `getAuthApiUrl()` helper baru

```ts
const AUTH_CACHE = 'auth_origin';

export async function getAuthApiUrl(): Promise<string> {
  if (typeof sessionStorage !== 'undefined') {
    const cached = sessionStorage.getItem(AUTH_CACHE);
    if (cached) return cached;
  }
  const candidates = [
    process.env.NEXT_PUBLIC_AUTH_API_URL,
    process.env.NEXT_PUBLIC_AUTH_FALLBACK,
    process.env.NEXT_PUBLIC_API_URL,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const res = await fetch(`${c}/api/health`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        if (typeof sessionStorage !== 'undefined')
          sessionStorage.setItem(AUTH_CACHE, c), setTimeout(() => sessionStorage.removeItem(AUTH_CACHE), 60000);
        return c;
      }
    } catch {}
  }
  return process.env.NEXT_PUBLIC_API_URL!; // last resort
}
```

#### `AuthForm.tsx` — pass origin + redirect + pilih URL dynamic

```tsx
const [apiUrl, setApiUrl] = useState('');
useEffect(() => {
  getAuthApiUrl().then(setApiUrl);
}, []);
// Render: 
const googleUrl = apiUrl
  ? `${apiUrl}/api/auth/google?origin=${encodeURIComponent(window.location.origin)}&redirect=${encodeURIComponent(returnTo)}`
  : '#';
```

Sticky origin setelah login: post-callback, frontend tanam `sessionStorage('auth_origin', originFromCallback)` (frontend dapat via `?auth_origin` query param appended ke redirect by callback, atau infer via `document.referrer`).

#### `ORIGIN_PATH_ALLOWLIST` extend

Tambah `/api/auth`, `/api/user/me`, `/api/user/bookmark`, `/api/user/history`, `/api/admin`. Frontend `apiWithFailover` round-robin reader + search + auth endpoints ke akun-2/3 prioritas.

#### `fetchMe` + `logout` + `patchMe` + `deleteMe` + `bookmark` + `history` calls pakai `getAuthApiUrl()` bukan `API_URL`. Sessions admin revoke pakai `getAuthApiUrl()`.

### 4. Storage 3-tier + round-robin upload + eviction LRU

#### Spec secret baru

```
B2_ACCOUNTS=[
  {"name":"b2-a","keyId":"<existing-keyId-of-account-1>","appKey":"<existing-appKey>","bucket":"manga-oktz-assets","region":"us-east-005"},
  {"name":"b2-b","keyId":"005b86aeb2be76b0000000004","appKey":"K00<REDACTED>","bucket":"manga-oktz-assets-2","region":"us-east-005"}
]
```

Bucket `manga-oktz-assets-2` (akun-2 B2) **sudah dibuat** via B2 API (Bucket ID `ab68163a2ecbf2ab9ef7061b`), bucket type `allPrivate`, with lifecycle rule `komiku/` 30 hari. S3-compatible endpoint `s3.us-east-005.backblazeb2.com`.

Frontend? Nangkep `chapter_pages.b2_account_idx`:
- `-1` → B2-A primary (URL SigV4 presign GET, `keyId.from b2-a`)
- `-2` → B2-B spillover (URL SigV4 presign GET, `keyId.from b2-b`)
- `>=0` → R2 ring (CDN domain direct)

**Worker `b2Config.ts` rework**: parse `B2_ACCOUNTS` array (urutan = idx `-1, -2, ...`). Walau secret lama `B2_CONFIG` (single) tetap kompatibel (diconvert ke array 1-item).

#### Upload strategy round-robin (Komiku only)

```
Upload to B2-A first. Kalau 503/quota → persist as `b2_account_idx = -2` in B2-B. Kalau B2-B juga fail → R2 ring (akun-1) `>=0`. Kalau semua gagal → silent skip, page tetap proxy dari upstream.
```

Persist via `chapter_pages.b2_account_idx` value. Bila upload retry, idempoten.

#### Eviction LRU (lazy, no cron)

Setiap request reader chapter detail:
```ts
// Update last access in D1
await db(c.env.DB).touchPageLastAccess(chapterId, pageNo);  // UPDATE chapter_pages SET last_access = NOW() WHERE ...
// Increment counter
await c.env.CACHE_KV.put('eviction:tick', ++tick).catch(()=>{}); // counter
if (tick % 100 === 0) {
  c.executionCtx.waitUntil(evictStaleStorage(c.env));
}
```

`evictStaleStorage`:
1. SELECT B2-A bucket size via B2 API `b2_list_buckets`. Kalau >= 80% quota (8GB dari 10GB free tier B2) → proceed evict.
2. SELECT `chapter_pages WHERE last_access < NOW() - INTERVAL 30 DAY AND b2_account_idx = -1` ORDER BY last_access ASC LIMIT N
3. DELETE object B2-A via `b2_delete_file_version` API, UPDATE `chapter_pages.b2_account_idx = NULL`.
4. Loop sampai bucket size <= 70% quota.
5. Same utk B2-B (kalau setelah evict B2-A masih penuh, move ke B2-B, tak delete B2-B dulu).
6. R2 ring: lifecycle rule 30 hari prefix `komiku/` utk objects tidak diakses — pakai existing R2 bucket lifecycle rule.

**`chapter_pages.last_access` kolom** = tambah via migration `0009_chapter_pages_last_access.sql` (kalau belum ada):
```sql
ALTER TABLE chapter_pages ADD COLUMN last_access INTEGER;
CREATE INDEX idx_chapter_pages_last_access ON chapter_pages(last_access);
```

**B2 bucket quota detection**: B2 free tier 10GB. Query `b2_list_buckets` field `options.bucketInfo` tidak available di free tier. Lebih realibel: query `b2_list_file_names` total `contentLength` (iterate sample N pages) utk estimate; atau query c-point dari `accountsInfo` API. **Simpler: count row D1 `chapter_pages WHERE b2_account_idx=-1`, kalau > threshold (misal 5000 rows) → over assume 8GB (avg 1.6MB/obj)**.

### 5. D1 split konsekuensi (limitation)

- User login akun-2 → `users` row di D1 akun-2. Bookmark `/api/user/bookmark` round-robin → kalau kirim ke akun-3 → no user record → 401 invalid.
- Solution: **sticky origin via sessionStorage** — AuthForm pasca login tanam `auth_origin`, semua `/api/user/*` calls pakai URL itu. Cookie signed payload valid lintas-worker, admin revoke di D1 masing-masing akun.
- Admin monitoring 8 endpoint baca D1 akun tsb:
  - Admin Count bukan agregat 3-akun, cuma current akun. Limitation: admin lihat data akun yang dia round-robin- saat request. Praktis bagus admin bisa lihat subset data.
- Merge queue (`manga_merge_queue`) split per akun. Limitation: admin resolve queue di 1 akun + manual merge di sana.

## Migration plan

### Migrations

- `0008_sessions.sql`: tabel `sessions` + indexes. Apply ke 3 D1 (akun-1 main + akun-2 origin + akun-3 new).
- `0009_chapter_pages_last_access.sql`: tambah kolom `last_access` + index. Apply ke main D1 akun-1 (other akun cuma baca chapter untuk cache lookup, tak insert new chapter row; tapi apply juga utk safety).

### Worker code changes

1. `apps/api-cf/src/routes/auth.ts`:
   - Ganti `oauth:state` KV.put → signed cookie.
   - Ganti `setSessionCookie`/`clearSessionCookie` → signed cookie dengan payload + HMAC.
   - Callback: parse + verify state cookie.
   - Upsert user → INSERT ke `sessions(sid,...)`.
2. `apps/api-cf/src/lib/auth.ts`:
   - `createSession(c, uid, email, role)`: build signed cookie payload, INSERT D1 `sessions`.
   - `getSessionUser(c)`: parse + verify HMAC + cek expiry + cek D1 `sessions.revoked_at`.
   - `listSessionsForUser/revokeSessionForUser`: D1 read/update, no KV.
3. `apps/api-cf/src/lib/b2Config.ts`: parse `B2_ACCOUNTS` array, fallback ke `B2_CONFIG` lama.
4. `apps/api-cf/src/lib/s3Upload.ts`: `b2PutObject` dan `b2PresignedGet` menerima account idx `-1..-2`. Round-robin upload di `routes/reader.ts`.
5. `apps/api-cf/src/routes/reader.ts`: upload round-robin B2-A → B2-B → R2. Set `chapter_pages.b2_account_idx = -1|-2|N`. Update touchPageLastAccess di chapter detail response.
6. `apps/api-cf/src/lib/storageEviction.ts`: baru. `evictStaleStorage(env)` dipakai di reader.
7. `packages/db/index.ts`: `insertSession`, `getSession`, `revokeSession`, `listUserSessions`, `revokeUserSession`, `touchPageLastAccess` helpers baru.
8. `apps/web/components/AuthForm.tsx`: pakai `getAuthApiUrl()`.
9. `apps/web/lib/api.ts`: extend `ORIGIN_PATH_ALLOWLIST`, add `getAuthApiUrl()`, rewrite `fetchMe`/`logout`/etc utk pakai auth origin.
10. `apps/web/middleware.ts`: tetap no-op.
11. `apps/web/app/login/page.tsx`: pass through `AuthForm`.

### Wrangler configs baru

- `wrangler.origin.toml` (akun-2) sudah ada. Tambah `wrangler.origin3.toml` (akun-3) — binding DB baru, KV baru, browser binding, NO R2 (R2 only akun-1).
- `scripts/deploy-worker-api.sh`: tambah `akun3` branch.

### Cloudflare console manual steps

- Akun-3: create D1 database (via REST API auto), create KV namespace (via REST API auto), deploy Worker (via wrangler), enable `workers.dev` subdomain (via API). R2 diblok — skip R2 binding akun-3.
- Akun-2: ensure `workers.dev` subdomain enabled (kalau belum), deploy Worker baru dari bundle.
- Google Cloud Console OAuth client ID yang sama: add redirect URIs:
  - `https://manga-api-2.tzok5555.workers.dev/api/auth/google/callback`
  - `https://manga-api-3.dwikaoktyffan.workers.dev/api/auth/google/callback`
- B2 dashboard: create private bucket di akun-2 B2 (keyID `005b86aeb2be76b0000000004`), region unspecified → check via B2 API which region (B2 API call).
- Secrets sync: set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `LB_ENCRYPTION_KEY`, `ALLOWED_ORIGINS`, `ADMIN_EMAILS`, `B2_ACCOUNTS`, `B2_EVICTION_DAYS`, `R2_ACCOUNTS` (to akun-2/3 utk upload ke R2 akun-1 via S3 token), `SCRAPE_API_KEY`, `ADMIN_PASSWORD_HASH`.
- `ALLOWED_ORIGINS` value sama untuk semua akun:
  ```
  https://oktzz.xyz,https://www.oktzz.xyz,https://oktz.xyz,https://manga-web-d32.pages.dev,https://*.manga-web-d32.pages.dev,http://localhost:3000
  ```

## Risk / Limitations

1. **Cross-account session revocation tidak sync** (`sessions` tabel per-akun). User logout dari akun-2 → sessions(sid) revoked_at set di D1 akun-2; pas round-robin dapat akun-3 → session(sid) gak nemu → anggap valid (signed cookie OK, D1 no row = gak revoked). Mitigation: setelah login, frontend sticky_origin → sangat jarang round-robin. Penalti: admin revoke user gak lintas akun. User manually logout di semua akun session. Tolerance: 7 hari natural expiry.
2. **D1 data split** antar akun. Bookmark/history/admin monitoring each akun subset. Frontend sticky origin via sessionStorage mitigates user-facing churn. Admin: lihat per-akun 1 dashboard.
3. **B2 quota detection** fragil — free tier bucket size via `b2_list_buckets` field `options.bucketInfo` tak ada (premium-only). Approximation dipakai (row count D1 * avg 1.6MB). Bisa keliru kalau objek besar.
4. **R2 ini akun-1 only** — kalau bucket akun-1 R2 penuh, akun-2/3 worker tetap bisa upload via SigV4 S3 token (R2_ACCOUNTS punya credentials), tapi object `account_id` akun-1. R2 lifecycle rule prefix `komiku/` 30 hari tetap prune.
5. **Sticky sessionStorage origin** bisa di-clear user → reset ke fallback; gak fatal.
6. **Google OAuth state lewat top-level redirect** arus cross-site `accounts.google.com → worker.origin.dev`. Cookie `SameSite=None; Secure; HttpOnly` valid lewat top-level navigation. Verified OK di Chrome. Edge case Safari ITP akan block cookie SameSite=None first-party → Safari user tidackak bisa OAuth (limitation lama).
7. **B2 akun-2 bucket region** = `us-east-005` (confirmed via `b2_authorize_account` returning `api005.backblazeb2.com`). Bucket `manga-oktz-assets-2` dibuat dengan lifecycle rule `komiku/` 30 hari.

## Test plan

- Local: `wrangler dev` (akun-1 local config). Test login Google flow happy path dengan B2 write local bypassing. Validate cookie signature cek.
- Akun-2: deploy Worker `manga-api-2`, manually run smoke test login Google lewat `oktzz.xyz` (frontend sticky_akun-2). Validate session persisted, bookmark flow.
- Akun-3: same.
- Storage: manual upload 1 chapter komiku via reader → verify `chapter_pages.b2_account_idx` set. Trigger eviction via admin endpoint (baru) → verify delete.
- Quota simulation: rate-limit KV write via curl storm → failover scenario → verify akun-2/3 worker login tetep works.

## Open questions (none - all answered)
