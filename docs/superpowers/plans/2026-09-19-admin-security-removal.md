# Admin v2 — Plan A: Hapus Fitur Security Alerts (End-to-End)

> **Untuk agentic workers:** SUB-SKILL WAJIB: pakai `superpowers:subagent-driven-development` untuk implementasi task-by-task. Steps pakai checkbox (`- [ ]`).

**Goal:** Hapus fitur security alerts sepenuhnya — tabel DB, penulis, pembaca API, UI dashboard+settings — plus bersihkan data tersimpan, tanpa menyakiti endpoint admin lain.

**Architecture:** Hapus bertingkat dari leaf ke root pemanggil, tiap task berakhir hijau (`tsc` api-cf lulus; UI lulus `astro check`). Migrasi `0019_drop_security_events.sql` dijalankan terakhir setelah semua kode tak lagi menyentuh tabel, lalu deploy 4 worker API + web.

**Tech Stack:** TypeScript (Hono worker api-cf), Astro + React island (web), SQL/SQLite D1, Cloudflare Workers.

**Spec:** `docs/superpowers/specs/2026-09-19-admin-redesign-design.md` (bagian C).

## Global Constraints

- Versi/platform: Node ≥ 22.12 untuk build web; web deploy wajib wrangler 4 nested (`apps/web/node_modules/.bin/wrangler`) + PATH node22;
- api-cf deploy pakai wrangler root 3.114 (`node_modules/.bin/wrangler`) + `--config` per akun + token `CF_TOKEN_AKUN{1..4}` dari `.env` (`set -a && source .env && set +a`).
- Skill `manga` wajib dibaca (via tools skill) sebelum mulai edit.
- `astro check`: SATU-SATUNYA error yang ditolerir `apps/web/src/components/reader/PreferencesSection.tsx:121 ts(2345)`. Error baru dihapus sampai bersih.
- Test: `apps/web` `npm test` (bun, canonical-url + round-robin) harus tetap lulus; `apps/api-cf` `npm run build` (tsc) wajib lulus di tiap task.
- Bahasa UI admin: Indonesia. Warna hanya token oklch yang ada. `text-base` jangan dipakai sebagai warna.
- Migrasi lama DILARANG diedit. Migrasi baru = `packages/db/migrations/0019_drop_security_events.sql`.
- Git: branch `main`, commit per task, gaya `fix(area): deskripsi`, stage hanya file relevan.

---

## Task 1: Hapus penulis security events (lib + rate limiter + CORS + internal allowlist)

**Files:**
- Delete: `apps/api-cf/src/lib/securityEvents.ts`
- Modify: `apps/api-cf/src/lib/rateLimit.ts`
- Modify: `apps/api-cf/src/index.ts`
- Modify: `apps/api-cf/src/routes/internal.ts`

**Interfaces:**
- Consumes: tidak ada dari task lain.
- Produces: penulis security_events hilang total; Task 2 otomatis kompilasi tanpa `securityEvents.ts`.

- [ ] **Step 1: Hapus file `apps/api-cf/src/lib/securityEvents.ts`**
  `rm apps/api-cf/src/lib/securityEvents.ts` (modul yang berisi `recordSecurityEvent` + import `writeWithFallback`).

- [ ] **Step 2: `apps/api-cf/src/lib/rateLimit.ts` — hapus import + panggilan**

  Hapus baris 3:
  ```ts
  import { recordSecurityEvent } from './securityEvents';
  ```
  Dalam `makeLimiter`, blok 429 (sekarang baris 48-58). Dari:
  ```ts
      const bucket = rateBuckets.get(key);
      if (bucket && bucket.expires > now) {
        if (bucket.count >= limit) {
          const retryAfter = Math.ceil((bucket.expires - now) / 1000);
          c.header('Retry-After', String(retryAfter));
          recordSecurityEvent(c, {
            type: 'rate_limit',
            severity: 'medium',
            message: `rate limit exceeded (${limit}/${window}s) on ${c.req.path}`,
          });
          return c.json({ error: 'rate limit exceeded', retry_after: retryAfter }, 429);
        }
  ```
  Menjadi:
  ```ts
      const bucket = rateBuckets.get(key);
      if (bucket && bucket.expires > now) {
        if (bucket.count >= limit) {
          const retryAfter = Math.ceil((bucket.expires - now) / 1000);
          c.header('Retry-After', String(retryAfter));
          return c.json({ error: 'rate limit exceeded', retry_after: retryAfter }, 429);
        }
  ```

- [ ] **Step 3: `apps/api-cf/src/index.ts` — hapus import + panggilan CORS**

  Hapus baris 26: `import { recordSecurityEvent } from './lib/securityEvents';`
  Dalam `corsMw` (sekarang baris 45-52), dari:
  ```ts
    if (origin && !SAFE_METHODS.has(c.req.method) && !allowedOriginFor(c.env, origin)) {
      recordSecurityEvent(c, {
        type: 'blocked_origin',
        severity: 'high',
        message: `forbidden origin on ${c.req.method} ${c.req.path}`,
      });
      return c.json({ error: 'forbidden origin' }, 403);
    }
  ```
  menjadi:
  ```ts
    if (origin && !SAFE_METHODS.has(c.req.method) && !allowedOriginFor(c.env, origin)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
  ```

- [ ] **Step 4: `apps/api-cf/src/routes/internal.ts` — buang dari allowlist**

  Hapus baris `'security_events',` dari `ALLOWED_TABLES` (harus tetap daftar alfabetis antara `'sessions',` dan `'db_usage_snapshot',`).

- [ ] **Step 5: Verifikasi compile api-cf**

  Run (dari repo root, PATH node22):
  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
  # Cek tidak ada sisa referensi:
  grep -rn "recordSecurityEvent\|securityEvents" apps/api-cf/src || true
  ```
  Expected: tsc PASS; grep kosong (tidak ada output).
  Catatan: `grep security_events` di api-cf masih akan muncul bila Task 2 belum jalan (dashboard.ts reader) — itu wajar, bukan kegagalan Task 1.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/api-cf/src/lib/securityEvents.ts apps/api-cf/src/lib/rateLimit.ts apps/api-cf/src/index.ts apps/api-cf/src/routes/internal.ts
  git commit -m "fix(api): remove security-event writers (rateLimit, cors, internal allowlist)"
  ```

---

## Task 2: Hapus lapisan DB + pembaca API

**Files:**
- Modify: `packages/db/index.ts` (interface + impl + import type)
- Modify: `apps/api-cf/src/routes/admin/dashboard.ts`

**Interfaces:**
- Consumes: tidak ada dari task lain.
- Produces: tidak ada sisa `addSecurityEvent`/`listSecurityEvents`/`resolveSecurityEvent` di mana pun; GET+PATCH `/api/admin/security-events` hilang (UI jadi 404 — dirapikan di Task 4/5).

- [ ] **Step 1: `packages/db/index.ts` — hapus 3 member dari interface `Db`**

  Hapus baris (persis, tanpa menggeser baris lain):
  ```ts
    addSecurityEvent: (params: { type: string; severity?: string; message?: string | null; ip?: string | null; path?: string | null }) => Promise<{ id: number }>;
    listSecurityEvents: (params: { resolved?: boolean; page?: number; limit?: number }) => Promise<{ data: Array<{ id: number; type: string; severity: string; message: string | null; ip: string | null; path: string | null; resolved: number; created_at: number; resolved_at: number | null }>; total: number; page: number }>;
    resolveSecurityEvent: (id: number) => Promise<{ success: boolean }>;
  ```
  Ini members ke-104-106. Biarkan komentar `// ── Admin dashboard (0013) — moderation + security feed ──` ikut berubah jadi `// ── Admin dashboard (0013) — moderation ──`.

- [ ] **Step 2: `packages/db/index.ts` — hapus 3 implementasi**

  Hapus blok implementasi persis (dari baris 875 sampai sebelum `getSourceHealthSummary`), yaitu `addSecurityEvent`, `listSecurityEvents`, `resolveSecurityEvent`:
  ```ts
    addSecurityEvent: async (p) => {
      ...
    },

    listSecurityEvents: async (p) => {
      ...
    },

    resolveSecurityEvent: async (id) => {
      const res = await prep('UPDATE security_events SET resolved = 1, resolved_at = ?1 WHERE id = ?2 AND resolved = 0')
        .bind(Math.floor(Date.now() / 1000), id).run();
      return { success: res.success };
    },
  ```
  Implementasi `getSourceHealthSummary` di bawahnya TIDAK boleh ikut tersentuh.

- [ ] **Step 3: `apps/api-cf/src/routes/admin/dashboard.ts` — hapus GET + PATCH**

  Hapus seluruh blok (sekarang baris 80-98) termasuk komentar:
  ```ts
  // ---- security events feed ----------------------------------------------------
  router.get('/security-events', async (c: Context) => {
    const d = getDb(c);
    const resolved = c.req.query('resolved');
    const data = await d.listSecurityEvents({
      resolved: resolved === undefined ? undefined : resolved === '1' || resolved === 'true',
      page: c.req.query('page') ? Number(c.req.query('page')) : 1,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : 20,
    });
    return json(c, data);
  });

  router.patch('/security-events/:id', async (c: Context) => {
    const d = getDb(c);
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return json(c, { error: 'invalid id' }, 400);
    await d.resolveSecurityEvent(id);
    return json(c, { ok: true });
  });
  ```
  `dashboard.ts` import yang tersisa (Hono, Env/Context, getDb/json, auth, b2) semua masih dipakai endpoint lain — jangan hapus.

- [ ] **Step 4: Verifikasi compile api-cf**

  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
  ```
  Expected: PASS. Ini tsc typecheck penuh — memvalidasi interface `Db` dan panggilannya konsisten setelah penghapusan.
  Sanity:
  ```bash
  grep -rn "security_events\|SecurityEvent" packages/db apps/api-cf || true
  ```
  Expected: tanpa output (hanya `server` internal.ts sudah tak ada).

- [ ] **Step 5: Commit**

  ```bash
  git add packages/db/index.ts apps/api-cf/src/routes/admin/dashboard.ts
  git commit -m "fix(db,api): drop security_events data layer + admin reader endpoints"
  ```

---

## Task 3: Migrasi DB + skema + skrip aplikasi

**Files:**
- Create: `packages/db/migrations/0019_drop_security_events.sql`
- Modify: `packages/db/schema.sql` (hapus blok tabel)
- Modify: `scripts/migrate-all-4.sh` (daftar 0019)
- Test: tidak ada unit test — verifikasi via skema + loop migrasi (Task 6).

**Interfaces:**
- Consumes: tidak ada.
- Produces: `0019_drop_security_events.sql` dijalankan Task 6 ke 4 D1, menghapus tabel + data tersimpan.

- [ ] **Step 1: Buat migrasi `packages/db/migrations/0019_drop_security_events.sql`**

  Isi persis:
  ```sql
  -- 0019: hapus fitur security alerts sepenuhnya (tabel + index + data).
  -- Penulis/pembaca sudah dihapus dari kode (api-cf, admin UI).
  DROP INDEX IF EXISTS idx_security_events_created;
  DROP INDEX IF EXISTS idx_security_events_resolved;
  DROP TABLE IF EXISTS security_events;
  ```

- [ ] **Step 2: `packages/db/schema.sql` — hapus blok tabel**

  Hapus seluruh blok (baris 294-310), termasuk komentar:
  ```sql
  ---------------------------------------------------------------------
  -- security events (admin dashboard abuse feed)
  ---------------------------------------------------------------------
  CREATE TABLE security_events (
    ...
  );
  CREATE INDEX idx_security_events_created ON security_events(created_at DESC);
  CREATE INDEX idx_security_events_resolved ON security_events(resolved, created_at DESC);
  ```
  (schema.sql = dokumen kanonikal instalasi fresh; TIDAK boleh bertabrakan dengan migrasi lama yang pernah dijalankan.)

- [ ] **Step 3: `scripts/migrate-all-4.sh` — tambah 0019 ke daftar**

  Setelah baris 21 (`for f in packages/db/migrations/0018_*.sql; do apply ...`), tambah:
  ```bash
    for f in packages/db/migrations/0019_*.sql; do apply "$cfg" "$f"; done
  ```

- [ ] **Step 4: Sampel verifikasi SQL**

  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" node -e "
  const fs=require('fs');
  const m=fs.readFileSync('packages/db/migrations/0019_drop_security_events.sql','utf8');
  if(!/DROP TABLE IF EXISTS security_events;/.test(m)) throw new Error('migration content wrong');
  const s=fs.readFileSync('packages/db/schema.sql','utf8');
  if(/security_events/.test(s) && !/-- (tersisa|histori)/.test(s.slice(0,100))) throw new Error('schema still mentions security_events');
  console.log('ok');
  "
  ```
  Expected: `ok`.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/db/migrations/0019_drop_security_events.sql packages/db/schema.sql scripts/migrate-all-4.sh
  git commit -m "chore(db): add 0019_drop_security_events.sql, update schema + migrate-all-4"
  ```

---

## Task 4: UI AdminDashboard — buang security

**Files:**
- Modify: `apps/web/src/components/pages/AdminDashboard.tsx`

**Interfaces:**
- Consumes: endpoint security hilang (Task 2) → UI tak boleh lagi memanggilnya.
- Produces: dashboard tanpa referensi security; 5 KPI (grid dibiarkan xl:grid-cols-6 dengan 5 item — rapikan visual di Plan B).

- [ ] **Step 1: Hapus `type SecEvent`**

  Hapus baris 40-50:
  ```ts
  type SecEvent = {
    id: number;
    type: string;
    severity: string;
    message: string | null;
    ip: string | null;
    path: string | null;
    resolved: number;
    created_at: number;
    resolved_at: number | null;
  };
  ```

- [ ] **Step 2: Hapus state + fetch + resolve**

  - Hapus state baris 334-335:
    ```ts
    const [secEvents, setSecEvents] = useState<SecEvent[]>([]);
    const [secTotal, setSecTotal] = useState(0);
    ```
  - Hapus state baris 341: `const [resolving, setResolving] = useState<number | null>(null);`
  - `loadAll`: destructure `Promise.all([...])` baris 358 — hapus elemen `se`; panggilnya baris 363:
    ```ts
    apiGet<{ data: SecEvent[]; total: number }>('/api/admin/security-events?limit=10'),
    ```
    dan set-nya baris 372-373:
    ```ts
    setSecEvents(se.data || []);
    setSecTotal(se.total);
    ```
  - Hapus `resolveEvent` baris 395-404 (seluruh `useCallback`).

- [ ] **Step 3: Hapus `severityColor` + KPI security + feed**

  - Hapus baris 465-470:
    ```ts
    const severityColor: Record<string, string> = {
      low: 'text-secondary border-border-default',
      medium: 'text-[oklch(70%_0.12_75)] border-[oklch(70%_0.12_75)]/30 bg-[oklch(70%_0.12_75)]/10',
      high: 'text-error border-error/30 bg-error/10',
      critical: 'text-error border-error/40 bg-error/15',
    };
    ```
  - Hapus kartu KPI ke-6 baris 502-515 (blok `<div className="admin-card p-4 flex flex-col gap-1 min-h-[104px]">` sampai `</div>` penutup StatCard security). Grid KPI baris 490 DIBIARKAN `xl:grid-cols-6`.
  - Hapus section "Security feed" baris 655-689 (seluruh `<section className="admin-card overflow-hidden">` yang berisi `SectionHead title="Security feed"` sampai penutup `</section>`). Sisakan section "Users terbaru" + grid `lg:grid-cols-2` (baris 627) — dengan 1 anak, render normal.

- [ ] **Step 4: Bersihkan import**

  Baris 3: dari `import { fetchMe, apiGet, apiPatch, roleLabel, type AuthUser } from '@/lib/api';` menjadi `import { fetchMe, apiGet, roleLabel, type AuthUser } from '@/lib/api';` (`apiPatch` kini tak terpakai).

- [ ] **Step 5: Verifikasi**

  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
  ```
  Expected: hanya error yang ditolerir `PreferencesSection.tsx:121`.
  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
  ```
  Expected: 2 bun test file PASS (canonical-url, round-robin).

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web/src/components/pages/AdminDashboard.tsx
  git commit -m "fix(web): remove security alerts UI from admin dashboard"
  ```

---

## Task 5: UI AdminSettings — buang security

**Files:**
- Modify: `apps/web/src/components/pages/AdminSettings.tsx`

**Interfaces:**
- Consumes: endpoint security hilang (Task 2).
- Produces: settings tanpa `SecurityCard`, tanpa bell badge, tanpa `SecEvent`.

- [ ] **Step 1: Hapus `type SecEvent` + header comment menyebutnya**

  - Hapus baris 44-54:
    ```ts
    type SecEvent = {
      id: number;
      type: string;
      severity: string;
      message: string | null;
      ip: string | null;
      path: string | null;
      resolved: number;
      created_at: number;
      resolved_at: number | null;
    };
    ```
  - Baris 8-11: komentar envelope, dari:
    ```
     * (no `{ data }` wrapper): lb/settings, lb/accounts, lb/origins,
     * scrape-jobs, security-events, users. Others ARE wrapped.
    ```
    menjadi:
    ```
     * (no `{ data }` wrapper): lb/settings, lb/accounts, lb/origins,
     * scrape-jobs, users. Others ARE wrapped.
    ```

- [ ] **Step 2: Hapus `SecurityCard` + ikon**shing**

  - Hapus `function SecurityCard` baris 734-772 (blok + komentar `Security events — real feed...` baris 729-732).
  - Hapus `function IconShield` baris 230-236:
    ```tsx
    function IconShield({ className }: IconProps) {
      return (
        <svg {...iconBase} className={className} aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    }
    ```
  - Hapus `function IconBell` baris 204-211:
    ```tsx
    function IconBell({ className }: IconProps) {
      return (
        <svg {...iconBase} className={className} aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    }
    ```

- [ ] **Step 3: Hapus state + fetch**

  - Baris 801-802:
    ```ts
    const [secEvents, setSecEvents] = useState<SecEvent[]>([]);
    const [secTotal, setSecTotal] = useState(0);
    ```
  - `loadAll` destructure baris 826: hapus elemen `se`; panggil baris 831:
    ```ts
    apiGet<{ data: SecEvent[]; total: number }>('/api/admin/security-events?limit=5&resolved=0').catch(() => null),
    ```
    dan set baris 843-844:
    ```ts
    setSecEvents(se?.data ?? []);
    setSecTotal(se?.total ?? 0);
    ```

- [ ] **Step 4: Hapus bell badge + bento entry**

  - Hapus blok badge baris 1127-1140 (seluruh `<div className="relative w-9 h-9 flex items-center justify-center rounded-full ...">` yang mengandung `IconBell` sampai `</div>` penutupnya) — item header di antara tombol refresh dan avatar.
  - Baris 1242: hapus `<SecurityCard events={secEvents} total={secTotal} />` dari bento grid.

- [ ] **Step 5: Verifikasi**

  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run lint --prefix apps/web
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm test --prefix apps/web
  ```
  Expected: lint hanya PreferencesSection:121; bun tests PASS.
  Sanity: `grep -rn "secTotal\|secEvents\|SecurityCard\|IconShield\|IconBell\|security-events" apps/web/src || true` → tak ada output.

- [ ] **Step 6: Commit**

  ```bash
  git add apps/web/src/components/pages/AdminSettings.tsx
  git commit -m "fix(web): remove security alerts UI from admin settings"
  ```

---

## Task 6: Terapkan migrasi + deploy + verifikasi live

**Files:**
- Modify: tidak ada file — eksekusi `scripts/migrate-all-4.sh`, deploy 4 API worker + web.

**Interfaces:**
- Consumes: semua task 1-5 (kode bersih). Tabel `security_events` masih ada di production sampai langkah ini.
- Produces: fitur security benar-benar hilang di production + data lama terhapus.

- [ ] **Step 1: Terapkan migrasi ke 4 D1**

  ```bash
  set -a && source .env && set +a
  ./scripts/migrate-all-4.sh
  ```
  Expected: 0019 dieksekusi (dengan `--config` tiap toml) ke 4 D1; output `wrangler d1 execute` sukses; `_migrations` mencatat `0019_drop_security_events.sql`; TIDAK ada baris `FAILED`. (Pastikan terlebih dahulu token `CF_TOKEN_AKUN1..4` ter-set di `.env`.)

- [ ] **Step 2: Verifikasi tak ada tabel security_events**

  ```bash
  set -a && source .env && set +a
  node_modules/.bin/wrangler d1 execute manga-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='security_events';" --config apps/api-cf/wrangler.toml
  ```
  Expected: hasil kosong / `[]`.

- [ ] **Step 3: Build + deploy API 4 worker**

  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/api-cf
  set -a && source .env && set +a
  CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN1" node_modules/.bin/wrangler deploy --config apps/api-cf/wrangler.toml
  CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN2" node_modules/.bin/wrangler deploy --config apps/api-cf/wrangler.origin.toml
  CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN3" node_modules/.bin/wrangler deploy --config apps/api-cf/wrangler.origin3.toml
  CLOUDFLARE_API_TOKEN="$CF_TOKEN_AKUN4" node_modules/.bin/wrangler deploy --config apps/api-cf/wrangler.origin4.toml
  ```
  Expected: tsc PASS; 4 deploy sukses. (Token akun2-4 = `CF_TOKEN_AKUN2..4`. Warning "wrangler out-of-date" normal + boleh diabaikan.)

- [ ] **Step 4: Build + deploy web (wrangler 4 nested, node22)**

  ```bash
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" npm run build --prefix apps/web
  set -a && source .env && set +a
  PATH="/nix/store/b3x7xvp565xqlj0whi2giwgbrplfwfpb-nodejs-22.16.0/bin:$PATH" apps/web/node_modules/.bin/wrangler deploy --config apps/web/wrangler.toml
  ```
  Expected: build lulus (astro check satu error tolerir); deploy worker `manga-web` — verifikasi `WORKER_NAME_WEB` di `.env` bila nama worker berbeda. WARNA: deploy web JANGAN pakai wrangler root 3.114 (error `kv_namespaces[0] binding SESSION` tanpa id) — wajib nested v4.

- [ ] **Step 5: Verifikasi live**

  ```bash
  # Endpoint security-events harus 404 (endpoint admin diceks tanpa cookie → 401 auth, yang penting BUKAN 200 data):
  curl -s -o /dev/null -w "%{http_code}\n" https://oktzz.xyz/api/admin/security-events
  curl -s -o /dev/null -w "%{http_code}\n" https://oktzz.xyz/api/admin/security-events/1
  curl -s -o /dev/null -w "%{http_code}\n" https://oktzz.xyz/
  ```
  Expected: dua endpoint admin bukan 200 (401/403/404 wajar — tanpa session admin); home `200`. Verifikasi interaktif via browser: login admin → buka `/admin` & `/admin/settings` → tak ada "Security alerts", "Security feed", badge lonceng, kartu "Keamanan"; tiap halaman tetap render.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/migrate-all-4.sh docs/  # hanya jika ada perubahan yang muncul; biasanya tidak (migrasi bukan file repo)
  git log --oneline -6
  ```
  Bila tidak ada diff baru, cukup `git log` untuk catatan. Jangan ciptakan commit kosong.

---

## Self-Review verifikasi

1. **Spesifikasi bagian C** (security removal, 17 touchpoint 9 file dari `/tmp/admin-surface.md`): semua → Task 1 (lib/rateLimit/index/internal), Task 2 (db+dashboard), Task 3 (migration+schema+script), Task 4 (dashboard UI), Task 5 (settings UI). Titik touchpoint terdaftar di spec baris "API writer"/"API reader"/"UI" ter-cover; migration `0019_drop_security_events.sql` → Task 3. Menjalankan data → Task 6 Step 1.
2. **Placeholder scan**: tak ada "TBD"/"implement later". Semua langkah punya kode atau perintah persis kecuali langkah "hapus implementasi db" Task 2 Step 2 yang sengaja memakai elipsis (blok 3 fungsi identik dengan task greppable `addSecurityEvent|listSecurityEvents|resolveSecurityEvent`) — anchor disebutkan eksplisit.
3. **Konsistensi tipe**: `SecEvent` (Task 1-5 semua menyebut nama yang sama), `security_events` konsisten, `db.add/list/resolveSecurityEvent` hapus di Task 2 dan tak dipakai lagi Task 4/5. `apiPatch` dihapus import (Task 4) — tidak dipakai tempat lain. `fmtRel` tetap dipakai (users/origins) → tidak dihapus.
4. **Ketergantungan**: tiap task berakhir green — Task 1 & 2 cek `tsc`; Task 4/5 cek `astro check` + bun; Task 3 murni SQL/script; Task 6 eksekusi + verifikasi live. Urutan wajib: Task 2 sebelum Task 4/5 (readers dulu hilang), Task 6 di paling akhir (migrasi setelah kode bersih).