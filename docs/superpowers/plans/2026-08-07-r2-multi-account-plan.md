# R2 Multi-Account Storage & Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gambar chapter Komiku di-upload ke R2 multi-akun (consistent hashing by manga slug), diserve langsung dari R2 custom domain, dengan cache-aside fallback saat miss.

**Architecture:** Scraper/reader Worker di primary account upload via S3-compatible API ke bucket R2 milik akun lain (hash ring, shared package `@manga-platform/shared/r2-routing`). Frontend Pages hitung hash yang sama, fetch gambar langsung dari `https://cdnN.dom/komiku/{slug}/{chapterId}/{pageNo}` tanpa lewat Worker. Miss (404) → fallback proxy path lama → Worker serve + upload background (`waitUntil`). D1 metadata + KV cache tetap satu di primary. MangaDex tetap 100% proxy. Upload gambar asli (tanpa kompresi — Free plan CPU 10ms, lihat spec).

**Tech Stack:** Cloudflare Workers (Hono), Next.js 14 Pages (runtime edge), D1, KV, R2 (S3-compatible API, SigV4), node:test untuk test tanpa framework.

## Global Constraints

- Nol hardcode konfigurasi: semua di env var/secret (`R2_ACCOUNTS`, `R2_EVICTION_DAYS`, `R2_RING_VNODES`, `NEXT_PUBLIC_R2_DOMAINS`).
- Kredensial R2 hanya di secret Worker (`R2_ACCOUNTS`), tidak pernah di source/commit/bundle frontend.
- Urutan daftar domain = index akun; `R2_ACCOUNTS` (Worker) dan `NEXT_PUBLIC_R2_DOMAINS` (web) WAJIB urutan sama.
- Key R2 deterministik, tanpa lookup table: `komiku/{slug}/{chapterId}/{pageNo}` (tanpa extension).
- Hash key = slug manga (semua chapter 1 manga → 1 akun).
- MangaDex tidak pernah di-upload ke R2.
- Bundle Worker tetap di bawah 3MB gzip — jangan tambah dependency berat (no `@aws-sdk`).
- Test tanpa framework: node:test + node:sqlite (pattern `scripts/smoke-db.mjs`).
- Migration baru = `packages/db/migrations/0002_r2_storage.sql`; `schema.sql` ikut di-update agar fresh install konsisten.

---

### Task 1: Consistent hashing ring (shared package)

**Files:**
- Create: `packages/shared/src/r2-routing.ts`
- Modify: `packages/shared/package.json` (exports), `packages/shared/tsconfig.json` (include)
- Test: `packages/shared/test/r2-routing.test.mjs`

**Interfaces:**
- Produces (dipakai Task 4, 6, 7):
  - `murmur3_32(key: string, seed?: number): number`
  - `buildRing(accounts: readonly string[], vnodes?: number): RingNode[]` — `RingNode = { pos: number; accountIndex: number }`
  - `accountFor(key: string, ring: RingNode[]): number`
  - `generateRemapReport(keys: readonly string[], oldAccounts: readonly string[], newAccounts: readonly string[], vnodes?: number): Array<{ key: string; from: number; to: number }>`

- [ ] **Step 1: Tulis failing test**

`packages/shared/test/r2-routing.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { murmur3_32, buildRing, accountFor, generateRemapReport } from '../src/r2-routing.ts';

test('murmur3_32 known vector (seed 0)', () => {
  assert.equal(murmur3_32('hello'), 613153351);
});

test('murmur3_32 deterministic', () => {
  assert.equal(murmur3_32('naruto-chapter-1'), murmur3_32('naruto-chapter-1'));
});

test('buildRing throws on empty accounts', () => {
  assert.throws(() => buildRing([]), /no accounts/);
});

test('single account routes everything to index 0', () => {
  const ring = buildRing(['cdn1.example.com'], 32);
  for (const k of ['naruto', 'one-piece', 'boruto']) {
    assert.equal(accountFor(k, ring), 0);
  }
});

test('accountFor deterministic across repeated calls', () => {
  const ring = buildRing(['cdn1.example.com', 'cdn2.example.com'], 32);
  const keys = Array.from({ length: 2000 }, (_, i) => `slug-${i}`);
  for (const k of keys) {
    assert.equal(accountFor(k, ring), accountFor(k, ring));
  }
});

test('distribution roughly balanced across 2 accounts', () => {
  const ring = buildRing(['cdn1.example.com', 'cdn2.example.com'], 32);
  const keys = Array.from({ length: 2000 }, (_, i) => `manga-${i}`);
  const counts = [0, 0];
  for (const k of keys) counts[accountFor(k, ring)]++;
  for (const c of counts) {
    assert.ok(c > keys.length * 0.2, `count ${c} too low`);
    assert.ok(c < keys.length * 0.8, `count ${c} too high`);
  }
});

test('remap 2→3 accounts moves a minority of keys', () => {
  const oldA = ['cdn1.example.com', 'cdn2.example.com'];
  const newA = ['cdn1.example.com', 'cdn2.example.com', 'cdn3.example.com'];
  const keys = Array.from({ length: 2000 }, (_, i) => `manga-${i}`);
  const report = generateRemapReport(keys, oldA, newA, 32);
  assert.ok(report.length > keys.length * 0.1, `moved ${report.length}`);
  assert.ok(report.length < keys.length * 0.75, `moved ${report.length}`);
  for (const r of report) {
    assert.notEqual(r.from, r.to);
    assert.ok(r.to >= 0 && r.to < newA.length);
  }
});
```

- [ ] **Step 2: Run test, pastikan FAIL**

Run: `node packages/shared/test/r2-routing.test.mjs`
Expected: FAIL — `Cannot find module '../src/r2-routing.ts'`

- [ ] **Step 3: Implementasi**

`packages/shared/src/r2-routing.ts`:

```ts
// R2 multi-account routing — satu sumber kebenaran untuk hash, dipakai oleh
// scraper Worker (apps/api-cf) DAN frontend Pages (apps/web). JANGAN
// re-implement di sisi lain; import dari sini agar tidak drift.

export interface RingNode {
  pos: number;
  accountIndex: number;
}

// MurmurHash3 x86_32, pure JS, tanpa dependency. Deterministik lintas runtime
// (Worker + browser). seed default 0.
export function murmur3_32(key: string, seed = 0): number {
  const data = new TextEncoder().encode(key);
  const len = data.length;
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let i = 0;
  const blocks = len - (len % 4);
  for (; i < blocks; i += 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0;
  const tail = len - blocks;
  if (tail >= 3) k ^= data[blocks + 2] << 16;
  if (tail >= 2) k ^= data[blocks + 1] << 8;
  if (tail >= 1) {
    k ^= data[blocks];
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// Consistent hashing ring: tiap akun diwakili `vnodes` titik di ring 2^32.
// Trade-off vs modulo polos: nambah/kurang akun cuma meremap key antara node
// baru dan tetangganya (~1/N bagian), bukan hampir semua. Harga: sedikit CPU
// + distribusi bergantung vnodes (semakin besar semakin merata, makin besar
// juga struktur ring).
export function buildRing(accounts: readonly string[], vnodes = 32): RingNode[] {
  if (accounts.length === 0) throw new Error('no accounts configured');
  const ring: RingNode[] = [];
  for (let a = 0; a < accounts.length; a++) {
    for (let v = 0; v < vnodes; v++) {
      ring.push({ pos: murmur3_32(`${accounts[a]}#${v}`), accountIndex: a });
    }
  }
  return ring.sort((x, y) => x.pos - y.pos);
}

// Key → index akun. Bangun ring sekali per request/halaman, lalu panggil ini
// per key — jangan panggil buildRing per key.
export function accountFor(key: string, ring: RingNode[]): number {
  if (ring.length === 0) throw new Error('empty ring');
  const h = murmur3_32(key);
  // Binary search node pertama >= h; wrap ke node pertama kalau lewat ujung.
  let lo = 0;
  let hi = ring.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].pos >= h) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ring[found === -1 ? 0 : found].accountIndex;
}

// Utilitas migrasi manual: daftar key yang pindah akun saat jumlah akun
// berubah. Jalankan offline (script), bukan runtime. Key yang pindah akan
// di-re-fetch otomatis via cache-aside — tidak perlu aksi manual.
export function generateRemapReport(
  keys: readonly string[],
  oldAccounts: readonly string[],
  newAccounts: readonly string[],
  vnodes = 32
): Array<{ key: string; from: number; to: number }> {
  const oldRing = buildRing(oldAccounts, vnodes);
  const newRing = buildRing(newAccounts, vnodes);
  const report: Array<{ key: string; from: number; to: number }> = [];
  for (const key of keys) {
    const from = accountFor(key, oldRing);
    const to = accountFor(key, newRing);
    if (from !== to) report.push({ key, from, to });
  }
  return report;
}
```

- [ ] **Step 4: Update package exports + tsconfig**

`packages/shared/package.json` — exports jadi:

```json
  "exports": {
    ".": "./types.ts",
    "./types": "./types.ts",
    "./r2-routing": "./src/r2-routing.ts"
  },
```

`packages/shared/tsconfig.json` — `"include": ["types.ts", "src"]`

- [ ] **Step 5: Run test, pastikan PASS**

Run: `node packages/shared/test/r2-routing.test.mjs`
Expected: semua test PASS (termasuk murmur vector `613153351`)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p packages/shared`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/r2-routing.ts packages/shared/test/r2-routing.test.mjs packages/shared/package.json packages/shared/tsconfig.json
git commit -m "feat(shared): consistent hashing ring for R2 multi-account routing"
```

---

### Task 2: D1 migration + helpers (r2 storage, last access, quota)

**Files:**
- Create: `packages/db/migrations/0002_r2_storage.sql`
- Modify: `packages/db/schema.sql`, `packages/db/index.ts`
- Test: `scripts/smoke-r2-db.mjs`

**Interfaces:**
- Consumes: —
- Produces (dipakai Task 4, 5):
  - `db.markPageR2Uploaded(params: { chapterId: string; pageNumber: number; imageUrl: string; r2Key: string; r2AccountIdx: number }): Promise<{ success: boolean }>`
  - `db.touchLastAccess(params: { r2Keys: string[]; accountIdx: number }): Promise<{ success: boolean }>`
  - `db.incrementLbUsage(params: { originUrl: string; dateKey: string }): Promise<{ success: boolean }>`

- [ ] **Step 1: Tulis migration**

`packages/db/migrations/0002_r2_storage.sql`:

```sql
-- R2 multi-account storage: r2 key per halaman + last-access + LB quota.

ALTER TABLE chapter_pages ADD COLUMN r2_key TEXT;
ALTER TABLE chapter_pages ADD COLUMN r2_account_idx INTEGER;

-- Last-accessed per R2 object (chapter-view granularity, bukan per-page-view).
CREATE TABLE IF NOT EXISTS r2_last_access (
  r2_key       TEXT PRIMARY KEY,
  account_idx  INTEGER NOT NULL,
  last_viewed  INTEGER NOT NULL,   -- unix ms
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_r2_last_access_view ON r2_last_access(last_viewed);

-- Quota tracking round-robin API: 1 baris per origin per hari.
-- Composite PK (bukan account_id tunggal) supaya 1 origin punya 1 baris/hari.
CREATE TABLE IF NOT EXISTS lb_usage (
  origin_url   TEXT NOT NULL,
  date_key     TEXT NOT NULL,      -- 'YYYY-MM-DD'
  req_count    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (origin_url, date_key)
);
```

- [ ] **Step 2: Update `schema.sql`** — tambahkan blok yang sama (tanpa `ALTER`; kolom langsung di `CREATE TABLE chapter_pages`). Di `CREATE TABLE chapter_pages` (baris 44-50) tambah `r2_key TEXT,` dan `r2_account_idx INTEGER,` setelah `image_url`. Lalu di akhir file (sebelum FTS5/trigger jika ada) tambahkan dua `CREATE TABLE` + index dari migration. Baca file dulu untuk posisi tepat.

- [ ] **Step 3: Tulis failing smoke test**

`scripts/smoke-r2-db.mjs` (ikuti pattern `scripts/smoke-db.mjs` — `node:sqlite` in-memory):

```js
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const schema = fs.readFileSync(path.resolve(here, '../packages/db/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.resolve(here, '../packages/db/migrations/0002_r2_storage.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
db.exec(schema);
db.exec(migration);

let ok = true;
const check = (name, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} => ${JSON.stringify(got)}`);
};

// Seed minimal: series + chapter (FK chapter_pages → chapters → series)
db.prepare(`INSERT INTO series (slug, title, type, status, language) VALUES ('smoke-r2', 'Smoke', 'manga', 'ongoing', 'id')`).run();
db.prepare(`INSERT INTO chapters (id, series_slug, chapter_number, language) VALUES ('smoke-r2-chapter-1', 'smoke-r2', 1, 'id')`).run();

// markPageR2Uploaded: insert + upsert ulang (idempoten)
db.prepare(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
  VALUES ('smoke-r2-chapter-1', 1, 'https://img.komiku.org/x.jpg', 'komiku/smoke-r2/smoke-r2-chapter-1/1', 0)
  ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`).run();
db.prepare(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
  VALUES ('smoke-r2-chapter-1', 1, 'https://img.komiku.org/x.jpg', 'komiku/smoke-r2/smoke-r2-chapter-1/1', 1)
  ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`).run();
check('markPageR2Uploaded upsert idempoten (1 row)',
  db.prepare('SELECT COUNT(*) c FROM chapter_pages WHERE chapter_id = ?').get('smoke-r2-chapter-1').c, 1);
check('r2_account_idx ter-update ke 1',
  db.prepare('SELECT r2_account_idx FROM chapter_pages WHERE chapter_id = ? AND page_number = 1').get('smoke-r2-chapter-1').r2_account_idx, 1);

// touchLastAccess: insert lalu update
db.prepare(`INSERT INTO r2_last_access (r2_key, account_idx, last_viewed, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(r2_key) DO UPDATE SET last_viewed = excluded.last_viewed, account_idx = excluded.account_idx`)
  .run('komiku/smoke-r2/smoke-r2-chapter-1/1', 1, 1000, 1000);
db.prepare(`INSERT INTO r2_last_access (r2_key, account_idx, last_viewed, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(r2_key) DO UPDATE SET last_viewed = excluded.last_viewed, account_idx = excluded.account_idx`)
  .run('komiku/smoke-r2/smoke-r2-chapter-1/1', 1, 2000, 1000);
check('touchLastAccess update last_viewed',
  db.prepare('SELECT last_viewed FROM r2_last_access WHERE r2_key = ?').get('komiku/smoke-r2/smoke-r2-chapter-1/1').last_viewed, 2000);

// incrementLbUsage: insert + increment
db.prepare(`INSERT INTO lb_usage (origin_url, date_key, req_count, updated_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(origin_url, date_key) DO UPDATE SET req_count = req_count + 1, updated_at = excluded.updated_at`)
  .run('https://api1.example.com', '2026-08-07', 1234);
db.prepare(`INSERT INTO lb_usage (origin_url, date_key, req_count, updated_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(origin_url, date_key) DO UPDATE SET req_count = req_count + 1, updated_at = excluded.updated_at`)
  .run('https://api1.example.com', '2026-08-07', 1234);
check('incrementLbUsage bertambah',
  db.prepare('SELECT req_count FROM lb_usage WHERE origin_url = ? AND date_key = ?').get('https://api1.example.com', '2026-08-07').req_count, 2);

if (ok) {
  console.log('smoke-r2-db: ALL PASS');
  process.exit(0);
} else {
  console.error('smoke-r2-db: FAILED');
  process.exit(1);
}
```

- [ ] **Step 4: Run test, pastikan FAIL**

Run: `node scripts/smoke-r2-db.mjs`
Expected: FAIL — `no such table: r2_last_access` (kolom `r2_key` belum ada di schema)

- [ ] **Step 5: Implementasi helpers di `packages/db/index.ts`**

Tambahkan ke interface `Db` (setelah `listChapterPages`):

```ts
  markPageR2Uploaded: (params: { chapterId: string; pageNumber: number; imageUrl: string; r2Key: string; r2AccountIdx: number }) => Promise<{ success: boolean }>;
  touchLastAccess: (params: { r2Keys: string[]; accountIdx: number }) => Promise<{ success: boolean }>;
  incrementLbUsage: (params: { originUrl: string; dateKey: string }) => Promise<{ success: boolean }>;
```

Tambahkan ke object `db` (di dekat helper lain, lihat pola `updateScrapeJob`):

```ts
    markPageR2Uploaded: async (p) => {
      await prep(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`)
        .bind(p.chapterId, p.pageNumber, p.imageUrl, p.r2Key, p.r2AccountIdx).run();
      return { success: true };
    },
    touchLastAccess: async (p) => {
      const now = Date.now();
      const stmts = p.r2Keys.map((k) =>
        prep(`INSERT INTO r2_last_access (r2_key, account_idx, last_viewed, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(r2_key) DO UPDATE SET last_viewed = excluded.last_viewed, account_idx = excluded.account_idx`)
          .bind(k, p.accountIdx, now, now)
      );
      if (stmts.length > 0) await client.batch(stmts);
      return { success: true };
    },
    incrementLbUsage: async (p) => {
      await prep(`INSERT INTO lb_usage (origin_url, date_key, req_count, updated_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(origin_url, date_key) DO UPDATE SET req_count = req_count + 1, updated_at = excluded.updated_at`)
        .bind(p.originUrl, p.dateKey, Date.now()).run();
      return { success: true };
    },
```

Cek `prep`/`client` tersedia di scope object (lihat implementasi `upsertSeries` di `packages/db/index.ts:262` — pakai `prep(...).bind(...).run()`).

- [ ] **Step 6: Run smoke test, pastikan PASS**

Run: `node scripts/smoke-r2-db.mjs`
Expected: `smoke-r2-db: ALL PASS`

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit -p packages/db`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0002_r2_storage.sql packages/db/schema.sql packages/db/index.ts scripts/smoke-r2-db.mjs
git commit -m "feat(db): r2 storage migration (r2_key, last_access, lb_usage) + helpers"
```

---

### Task 3: S3 SigV4 client minimal + R2 account config parser

**Files:**
- Create: `apps/api-cf/src/lib/r2Accounts.ts`, `apps/api-cf/src/lib/s3Upload.ts`
- Test: `apps/api-cf/test/r2-upload.test.mjs`

**Interfaces:**
- Produces (dipakai Task 4):
  - `parseR2Accounts(raw: string | undefined): R2Account[]` — throw pada JSON invalid / field kurang; `[]` saat undefined
  - `R2Account = { account_id: string; access_key_id: string; secret_access_key: string; public_domain: string; bucket?: string }`
  - `DEFAULT_BUCKET = 'manga-images'`
  - `s3SignedHeaders(opts: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; key: string; contentType: string; dateISO?: string }): Record<string, string>`
  - `s3PutObject(opts: R2Account & { bucket?: string; key: string; contentType: string }, body: ReadableStream | ArrayBuffer): Promise<Response>`

- [ ] **Step 1: Tulis failing test**

`apps/api-cf/test/r2-upload.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseR2Accounts } from '../src/lib/r2Accounts.ts';
import { s3SignedHeaders } from '../src/lib/s3Upload.ts';

const validJson = JSON.stringify([
  { account_id: 'acc1', access_key_id: 'AK1', secret_access_key: 'SK1', public_domain: 'cdn1.example.com' },
  { account_id: 'acc2', access_key_id: 'AK2', secret_access_key: 'SK2', public_domain: 'cdn2.example.com', bucket: 'custom-bucket' },
]);

test('parseR2Accounts valid', () => {
  const accs = parseR2Accounts(validJson);
  assert.equal(accs.length, 2);
  assert.equal(accs[0].public_domain, 'cdn1.example.com');
  assert.equal(accs[1].bucket, 'custom-bucket');
});

test('parseR2Accounts undefined → []', () => {
  assert.deepEqual(parseR2Accounts(undefined), []);
});

test('parseR2Accounts invalid JSON throws', () => {
  assert.throws(() => parseR2Accounts('not-json'), /invalid R2_ACCOUNTS/);
});

test('parseR2Accounts missing field throws', () => {
  assert.throws(() => parseR2Accounts('[{"account_id":"a"}]'), /missing field/);
});

test('s3SignedHeaders deterministic + structure', async () => {
  const opts = {
    accountId: 'acc1', accessKeyId: 'AK1', secretAccessKey: 'SK1',
    bucket: 'manga-images', key: 'komiku/naruto/naruto-chapter-1/1', contentType: 'image/jpeg',
  };
  const h1 = await s3SignedHeaders(opts);
  const h2 = await s3SignedHeaders(opts);
  assert.deepEqual(h1, h2, 'same inputs → same headers');
  assert.match(h1.Authorization, /^AWS4-HMAC-SHA256 Credential=AK1\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;content-type;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(h1['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.ok(h1['x-amz-date'], 'has x-amz-date');
  assert.ok(h1.Host.startsWith('acc1.r2.cloudflarestorage.com'), `host ${h1.Host}`);
  assert.match(h1.Authorization, /Signature=[0-9a-f]{64}$/, 'signature 64 hex');
});
```

- [ ] **Step 2: Run test, pastikan FAIL**

Run: `node apps/api-cf/test/r2-upload.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implementasi parser**

`apps/api-cf/src/lib/r2Accounts.ts`:

```ts
// Konfigurasi akun R2 multi-account. Satu secret JSON (R2_ACCOUNTS) — bukan
// 3 env var per akun (batas 64 env var/Worker). Urutan array = index akun,
// HARUS sama dengan NEXT_PUBLIC_R2_DOMAINS di frontend.
export interface R2Account {
  account_id: string;
  access_key_id: string;
  secret_access_key: string;
  public_domain: string;
  bucket?: string;
}

export const DEFAULT_BUCKET = 'manga-images';

export const parseR2Accounts = (raw: string | undefined): R2Account[] => {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error('invalid R2_ACCOUNTS JSON');
  }
  if (!Array.isArray(arr)) throw new Error('invalid R2_ACCOUNTS: expected array');
  return arr.map((a) => {
    if (typeof a !== 'object' || a === null) throw new Error('invalid R2_ACCOUNTS entry');
    const o = a as Record<string, unknown>;
    for (const f of ['account_id', 'access_key_id', 'secret_access_key', 'public_domain'] as const) {
      if (typeof o[f] !== 'string' || (o[f] as string).length === 0) throw new Error(`invalid R2_ACCOUNTS: missing field ${f}`);
    }
    return {
      account_id: o.account_id as string,
      access_key_id: o.access_key_id as string,
      secret_access_key: o.secret_access_key as string,
      public_domain: o.public_domain as string,
      bucket: typeof o.bucket === 'string' && o.bucket.length > 0 ? o.bucket : DEFAULT_BUCKET,
    };
  });
};
```

- [ ] **Step 4: Implementasi S3 SigV4 upload**

`apps/api-cf/src/lib/s3Upload.ts`:

```ts
// S3-compatible upload minimal ke R2 (AWS SigV4) — tanpa @aws-sdk (bundle
// Worker 3MB gzip limit, dan bundle ini di-deploy ke banyak akun via
// auto-provision). Cukup untuk PUT object; fitur S3 lain (multipart, dll)
// ditambah belakangan kalau dibutuhkan.

import type { R2Account } from './r2Accounts';

const REGION = 'auto';
const SERVICE = 's3';

const hmac = async (key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> => {
  const cryptoObj = globalThis.crypto as Crypto;
  return cryptoObj.subtle.importKey(
    'raw',
    key instanceof Uint8Array ? key : new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  ).then((k) => cryptoObj.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
};

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

// derive signing key: HMAC chain (AWS SigV4)
const signingKey = async (secret: string, dateStamp: string): Promise<Uint8Array> => {
  const kDate = await hmac(`AWS4${secret}`, dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, 'aws4_request');
  return new Uint8Array(kSigning);
};

const encodePath = (key: string): string =>
  key.split('/').map((seg) => encodeURIComponent(seg)).join('/');

export const s3SignedHeaders = async (opts: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  contentType: string;
  dateISO?: string;
}): Promise<Record<string, string>> => {
  const dateISO = opts.dateISO ?? new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const path = `/${opts.bucket}/${encodePath(opts.key)}`;
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalHeaders =
    `content-type:${opts.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;content-type;x-amz-content-sha256;x-amz-date';
  const canonicalRequest =
    `PUT\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const key = await signingKey(opts.secretAccessKey, dateStamp);
  const signature = hex(await hmac(key, stringToSign));

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'content-type': opts.contentType,
    Host: host,
  };
};

// Upload stream/bytes ke R2 bucket milik akun lain. Pakai UNSIGNED-PAYLOAD
// supaya body bisa di-stream tanpa buffer penuh di memori (128MB limit).
export const s3PutObject = async (
  account: R2Account,
  key: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string
): Promise<Response> => {
  const bucket = account.bucket ?? DEFAULT_BUCKET;
  const headers = await s3SignedHeaders({
    accountId: account.account_id,
    accessKeyId: account.access_key_id,
    secretAccessKey: account.secret_access_key,
    bucket,
    key,
    contentType,
  });
  return fetch(`https://${headers.Host}/${bucket}/${encodePath(key)}`, {
    method: 'PUT',
    headers,
    body,
  });
};
```

Catatan: `hmac` + `signingKey` perlu `export` bila test perlu — test cukup struktur + determinism (signature diharapkan beda per tanggal, itu normal). Verifikasi integrasi nyata: manual smoke ke bucket dev (langkah di Task 7 docs).

- [ ] **Step 5: Run test, pastikan PASS**

Run: `node apps/api-cf/test/r2-upload.test.mjs`
Expected: PASS semua

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p apps/api-cf`
Expected: error pre-existing yang diketahui saja (auth.ts/crypto.ts/caches.default — lihat skill manga section 9)

- [ ] **Step 7: Commit**

```bash
git add apps/api-cf/src/lib/r2Accounts.ts apps/api-cf/src/lib/s3Upload.ts apps/api-cf/test/r2-upload.test.mjs
git commit -m "feat(api): S3 SigV4 minimal client + R2_ACCOUNTS parser"
```

---

### Task 4: Cache-aside fallback upload di reader route

**Files:**
- Modify: `apps/api-cf/src/lib/context.ts` (Env), `apps/api-cf/src/routes/reader.ts` (page proxy route)
- Test: `apps/api-cf/test/reader-slug.test.mjs` (resolve slug helper)

**Interfaces:**
- Consumes: Task 1 (`buildRing`, `accountFor` dari `@manga-platform/shared/r2-routing`), Task 2 (`markPageR2Uploaded`, `touchLastAccess`), Task 3 (`parseR2Accounts`, `s3PutObject`)
- Produces:
  - `resolveKomikuSlug(c: Context, chapterId: string): Promise<string | null>` — D1 `getChapter` → `series_slug`, KV cache 1h, fallback parse `split('-chapter-')[0]`
  - Env tambahan: `R2_ACCOUNTS?: string`, `R2_RING_VNODES?: string`, `R2_EVICTION_DAYS?: string`

- [ ] **Step 1: Tulis failing test untuk resolve slug**

`apps/api-cf/test/reader-slug.test.mjs` — test fungsi parse murni. Ekstrak `parseSlugFromChapterId` ke `apps/api-cf/src/lib/r2Upload.ts`? Tidak — tempat logis: `apps/api-cf/src/lib/komikuSlug.ts` (pure, tanpa hono — supaya testable):

```ts
// Resolve slug manga dari chapter id Komiku. Format: '<slug>-chapter-<num>'.
export const parseSlugFromChapterId = (chapterId: string): string | null => {
  const m = chapterId.split('-chapter-');
  if (m.length < 2) return null;
  const slug = m[0];
  return slug.length > 0 ? slug : null;
};
```

Test:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlugFromChapterId } from '../src/lib/komikuSlug.ts';

test('parses standard komiku chapter id', () => {
  assert.equal(parseSlugFromChapterId('naruto-chapter-123'), 'naruto');
});
test('parses slug with dashes', () => {
  assert.equal(parseSlugFromChapterId('one-piece-chapter-1089'), 'one-piece');
});
test('returns null on malformed', () => {
  assert.equal(parseSlugFromChapterId('not-a-chapter'), null);
});
test('returns null on empty slug', () => {
  assert.equal(parseSlugFromChapterId('-chapter-1'), null);
});
```

- [ ] **Step 2: Run test, pastikan FAIL**

Run: `node apps/api-cf/test/reader-slug.test.mjs` → FAIL (module not found)

- [ ] **Step 3: Implementasi `komikuSlug.ts`** (code di Step 1)

- [ ] **Step 4: Update `context.ts` Env**

Tambah ke interface `Env` (setelah `CF_ACCOUNT_ID`):

```ts
  R2_ACCOUNTS?: string;
  R2_RING_VNODES?: string;
  R2_EVICTION_DAYS?: string;
```

- [ ] **Step 5: Update `reader.ts` page proxy route**

Tambahkan import di `apps/api-cf/src/routes/reader.ts`:

```ts
import { buildRing, accountFor } from '@manga-platform/shared/r2-routing';
import { parseR2Accounts } from '../lib/r2Accounts';
import { s3PutObject } from '../lib/s3Upload';
import { parseSlugFromChapterId } from '../lib/komikuSlug';
```

Tambahkan helper di dalam file (setelah `fetchPageUrlsWithCache`):

```ts
// Resolve slug manga dari chapterId: D1 dulu (akurat), cache KV 1 jam,
// fallback parse dari format '<slug>-chapter-<num>'.
const resolveKomikuSlug = async (c: Context, chapterId: string): Promise<string | null> => {
  const cacheKey = `slug:${chapterId}`;
  const cached = await cacheGet<string>(c, cacheKey);
  if (cached) return cached;
  try {
    const ch = await getDb(c).getChapter(chapterId);
    if (ch?.series_slug) {
      cachePut(c, cacheKey, ch.series_slug, 3600);
      return ch.series_slug;
    }
  } catch { /* fall through to parse */ }
  const parsed = parseSlugFromChapterId(chapterId);
  if (parsed) cachePut(c, cacheKey, parsed, 3600);
  return parsed;
};

// R2 config dibangun sekali per request — murah (2 akun × 32 vnodes).
const r2RingFor = (c: Context): { accounts: ReturnType<typeof parseR2Accounts>; ring: ReturnType<typeof buildRing> } | null => {
  const accounts = parseR2Accounts(c.env.R2_ACCOUNTS);
  if (accounts.length === 0) return null;
  const vnodes = Number(c.env.R2_RING_VNODES) || 32;
  return { accounts, ring: buildRing(accounts.map((a) => a.public_domain), vnodes) };
};

// Upload gambar ke R2 target account (background) + catat D1. Idempoten:
// key sama → overwrite sama. Race 2 request paralel aman (R2 1 write/s/key).
const uploadToR2 = async (c: Context, opts: { slug: string; chapterId: string; pageNo: number; imageUrl: string; contentType: string; body: ReadableStream }): Promise<void> => {
  try {
    const cfg = r2RingFor(c);
    if (!cfg) return; // R2 belum dikonfigurasi → proxy-only mode (old behavior)
    const idx = accountFor(opts.slug, cfg.ring);
    const account = cfg.accounts[idx];
    const r2Key = `komiku/${opts.slug}/${opts.chapterId}/${opts.pageNo}`;
    const res = await s3PutObject(account, r2Key, opts.body, opts.contentType);
    if (!res.ok) throw new Error(`r2 upload ${res.status}`);
    await getDb(c).markPageR2Uploaded({
      chapterId: opts.chapterId,
      pageNumber: opts.pageNo,
      imageUrl: opts.imageUrl,
      r2Key,
      r2AccountIdx: idx,
    });
  } catch (e) {
    console.error('[r2] upload failed:', String(e)); // jangan gagalkan response user
  }
};
```

Di route `/:source/page/:chapterId/:pageNo` (hanya untuk `source === 'komiku'`), setelah blok `if (!upstream)` error handling, dan SEBELUM `return response` — tambahkan (setelah `response` dibuat):

```ts
  // Cache-aside: simpan ke R2 target (hash slug) di background supaya
  // request berikutnya diserve langsung dari R2 tanpa lewat Worker.
  if (source === 'komiku') {
    const slug = await resolveKomikuSlug(c, chapterId);
    if (slug) {
      const page = pages[n - 1];
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const body = upstream.body;
      c.executionCtx.waitUntil(
        uploadToR2(c, { slug, chapterId, pageNo: n, imageUrl: page.url, contentType, body }).catch(() => {})
      );
    }
  }
```

Catatan: `upstream.body` dibaca saat streaming ke client — R2 upload pakai body stream yang sama: browser dan R2 menerima stream — harus `upstream.clone()`? Tidak — `response` dibuat dari `upstream.body`, body stream hanya bisa dikonsumsi sekali. Solusi: gunakan `upstream.clone().body` untuk upload (stream duplikat). Jadi panggil `uploadToR2` dengan `body: upstream.clone().body`.

- [ ] **Step 5: Run tests**

Run: `node apps/api-cf/test/reader-slug.test.mjs` → PASS
Run: `npx tsc --noEmit -p apps/api-cf` → hanya error pre-existing

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/lib/komikuSlug.ts apps/api-cf/src/lib/context.ts apps/api-cf/src/routes/reader.ts apps/api-cf/test/reader-slug.test.mjs
git commit -m "feat(api): cache-aside R2 upload on reader miss (komiku)"
```

---

### Task 5: Quota tracking LB di D1

**Files:**
- Modify: `apps/api-cf/src/routes/origins.ts`, `apps/api-cf/src/routes/admin/lb.ts`

**Interfaces:**
- Consumes: Task 2 `incrementLbUsage`
- Produces: `GET /api/admin/lb/usage` — `{ data: [{ origin_url, date_key, req_count }] }` (admin step-up, hari ini)

- [ ] **Step 1: Modify `origins.ts`** — setelah payload dibangun, sebelum return:

```ts
  // Quota tracking (approximation): tiap pengambilan daftar origin = 1
  // cycle round-robin klien. Exact per-request count butuh telemetri
  // per-browser atau Durable Object — out of scope (lihat spec section 7).
  const today = new Date().toISOString().slice(0, 10);
  c.executionCtx.waitUntil(
    (async () => {
      const db = getDb(c);
      for (const o of enabled) {
        await db.incrementLbUsage({ originUrl: o.url, dateKey: today }).catch(() => {});
      }
    })()
  );
```

- [ ] **Step 2: Tambah route `GET /api/admin/lb/usage`** di `apps/api-cf/src/routes/admin/lb.ts` (ikuti pola route admin existing — cek file untuk guard step-up yang dipakai):

```ts
router.get('/lb/usage', async (c: Context) => {
  const db = getDb(c);
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.listLbUsage(today);
  return json(c, { data: rows });
});
```

- [ ] **Step 3: Tambah helper `listLbUsage` di `packages/db/index.ts`** (interface + implementasi, pola sama Task 2):

```ts
  listLbUsage: (dateKey: string) => Promise<Array<{ origin_url: string; req_count: number }>>;
```

```ts
    listLbUsage: async (dateKey) => {
      const { results } = await client.prepare(
        'SELECT origin_url, req_count FROM lb_usage WHERE date_key = ? ORDER BY req_count DESC'
      ).bind(dateKey).all<{ origin_url: string; req_count: number }>();
      return results;
    },
```

Cek pola `.all()` di index.ts (lihat `listScrapeJobs`).

- [ ] **Step 4: Perluas smoke test** `scripts/smoke-r2-db.mjs` — tambah check:

```js
const usageRow = db.prepare('SELECT origin_url, req_count FROM lb_usage WHERE date_key = ?').all('2026-08-07');
check('listLbUsage shape', usageRow, [{ origin_url: 'https://api1.example.com', req_count: 2 }]);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `node scripts/smoke-r2-db.mjs` → ALL PASS
Run: `npx tsc --noEmit -p packages/db` → clean

- [ ] **Step 6: Commit**

```bash
git add apps/api-cf/src/routes/origins.ts apps/api-cf/src/routes/admin/lb.ts packages/db/index.ts scripts/smoke-r2-db.mjs
git commit -m "feat(api): LB quota tracking via D1 (origins + admin usage endpoint)"
```

---

### Task 6: Frontend R2-first fetch + fallback proxy

**Files:**
- Modify: `apps/web/package.json`, `apps/web/next.config.mjs`, `apps/web/lib/api.ts`, `apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx`, `apps/web/components/Reader.tsx`

**Interfaces:**
- Consumes: Task 1 (`buildRing`, `accountFor`)
- Produces: `r2UrlFor(slug: string, chapterId: string, pageNo: number): string | null` di `lib/api.ts`; `pages: { proxyUrl: string; r2Url?: string | null }[]` ke Reader

- [ ] **Step 1: Tambah dependency workspace**

`apps/web/package.json` dependencies tambah: `"@manga-platform/shared": "*"`. Lalu run `npm install` di root (update lockfile + node_modules symlink).

- [ ] **Step 2: `next.config.mjs`** — tambah ke `nextConfig`:

```js
  transpilePackages: ['@manga-platform/shared'],
```

- [ ] **Step 3: `lib/api.ts`** — tambah di akhir file:

```ts
// ---- R2 multi-account direct serving (komiku) --------------------------
// Domain R2 dari env build-time; urutan = index akun, HARUS sama dengan
// R2_ACCOUNTS di Worker. Ring di-build sekali per proses (pure).
import { buildRing, accountFor } from '@manga-platform/shared/r2-routing';

export const R2_DOMAINS = (process.env.NEXT_PUBLIC_R2_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const R2_VNODES = Number(process.env.NEXT_PUBLIC_R2_VNODES) || 32;
const r2Ring = R2_DOMAINS.length > 0 ? buildRing(R2_DOMAINS, R2_VNODES) : null;

// Key deterministik: komiku/{slug}/{chapterId}/{pageNo} (tanpa ext — sama
// dengan sisi Worker). null saat R2 belum dikonfigurasi → proxy-only.
export const r2UrlFor = (slug: string, chapterId: string, pageNo: number): string | null => {
  if (!r2Ring || !slug) return null;
  const idx = accountFor(slug, r2Ring);
  return `https://${R2_DOMAINS[idx]}/komiku/${slug}/${chapterId}/${pageNo}`;
};
```

- [ ] **Step 4: `page.tsx` (chapter reader)** — bangun r2Url per page. Ubah:

```ts
import { getChapter, API_URL, r2UrlFor } from '@/lib/api';
```

dan setelah `const pages = chapter.pages || [];` tambah:

```ts
  const r2Pages = pages.map((p, i) => ({
    ...p,
    r2Url: r2UrlFor(params.slug, params.chapterId, i + 1),
  }));
```

lalu `<Reader pages={r2Pages} apiUrl={API_URL} />`.

- [ ] **Step 5: `components/Reader.tsx`** — R2-first, proxy fallback on error. Ubah tipe + urls:

```ts
export function Reader({ pages, apiUrl }: { pages: { proxyUrl: string; r2Url?: string | null }[]; apiUrl: string }) {
```

Ganti `const urls = pages.map((p) => `${apiUrl}${p.proxyUrl}`);` dengan:

```ts
  // R2-first: coba domain R2 langsung (hash slug). 404/error → retry logic
  // existing mengalihkan ke proxy (yang sekaligus meng-upload ke R2 di
  // background) → request berikutnya dari R2 lagi.
  const urls = pages.map((p) => p.r2Url ?? `${apiUrl}${p.proxyUrl}`);
  const fallbackUrls = pages.map((p) => `${apiUrl}${p.proxyUrl}`);
```

dan ganti kedua pemakaian `src={r > 0 ? `${u}?retry=${r}` : u}` menjadi:

```tsx
src={r > 0 ? `${fallbackUrls[i]}?retry=${r}` : u}
```

(pemakaian pertama di scroll mode — key `i`; pemakaian kedua di page mode — key `idx`: `fallbackUrls[idx]`).

- [ ] **Step 6: `lib/api.ts` — round-robin health-aware failover** (gap dari spec Section 8 — fungsi `apiWithFailover` belum ada di file ini). Tambahkan di akhir file:

```ts
// ---- Round-robin origin failover (LB multi-account) --------------------
// Health-aware: skip origin yang 429/5xx/timeout (circuit breaker 60s per
// origin setelah 2 gagal beruntun). Retry max 2x, bukan coba semua akun.
// Hanya path publik yang boleh dipanggil ke origin — allowlist eksplisit.
const ORIGIN_PATH_ALLOWLIST = [
  '/api/health',
  '/api/search',
  '/api/series',
  '/api/manga/',
  '/api/reader/',
  '/api/source-status',
];

export const getOrigins = async (): Promise<{ url: string }[]> => {
  const cached = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('origins') : null;
  if (cached) return JSON.parse(cached) as { url: string }[];
  try {
    const res = await fetch(`${API_URL}/api/origins`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const json = await res.json() as { data: { url: string }[] };
    const data = json.data || [];
    if (typeof sessionStorage !== 'undefined' && data.length > 0) {
      sessionStorage.setItem('origins', JSON.stringify(data));
      setTimeout(() => sessionStorage.removeItem('origins'), 60000);
    }
    return data;
  } catch {
    return [];
  }
};

// Circuit state per origin: gagal beruntun → skip 60s.
const failures = new Map<string, { count: number; until: number }>();

export async function apiWithFailover<T>(path: string): Promise<T> {
  if (!ORIGIN_PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
    return api<T>(path); // non-publik → main API saja
  }
  const origins = await getOrigins();
  const now = Date.now();
  let attempts = 0;
  for (const origin of origins) {
    if (attempts >= 2) break; // retry terbatas, bukan loop semua akun
    const state = failures.get(origin.url);
    if (state && state.until > now) continue;
    attempts++;
    try {
      const res = await fetch(`${origin.url}${path}`, {
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

Perbaiki `api()` dan `dataApi()` (yang belum failover) untuk pakai `apiWithFailover` pada path publik: `searchMerged`, `getSourceStatus` tetap ke `DATA_API_URL`; ganti pemanggil reader (getSeriesDetail/getSeries/getChapters/getChapter/getSeriesList) dari `api(...)` ke `apiWithFailover(...)` — path tersebut masuk allowlist.

- [ ] **Step 7: Typecheck + build**

Run: `npx tsc --noEmit -p apps/web`
Run: `cd apps/web && npx next build` (harus tanpa error)

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/next.config.mjs apps/web/lib/api.ts "apps/web/app/[source]/s/[slug]/[chapterId]/page.tsx" apps/web/components/Reader.tsx package-lock.json
git commit -m "feat(web): R2-first image serving, proxy fallback + round-robin failover"
```

---

### Task 7: Setup script akun + dokumentasi

**Files:**
- Create: `scripts/setup-r2-account.mjs`, `docs/ADDING-ACCOUNT.md`, `docs/TOS-REVIEW.md`
- Modify: `scripts/build-worker-bundle.mjs` (seed migration 0002)

- [ ] **Step 1: Setup script**

`scripts/setup-r2-account.mjs` — interaktif, print langkah + generate konfigurasi:

```js
#!/usr/bin/env node
// Setup akun R2 baru untuk multi-account storage.
// Jalankan: node scripts/setup-r2-account.mjs
// Output: langkah manual + JSON snippet untuk R2_ACCOUNTS + NEXT_PUBLIC_R2_DOMAINS.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const envFile = process.argv[2] || '.dev.vars';
console.log(`[setup-r2-account] membaca akun existing dari ${envFile} ...`);

let existing = [];
try {
  const raw = readFileSync(path.resolve(here, `../apps/api-cf/${envFile}`), 'utf8');
  const m = raw.match(/R2_ACCOUNTS=(\{.*)/s);
  if (m) existing = JSON.parse(m[1]);
} catch { /* belum ada — akun pertama */ }

const index = existing.length + 1; // 1-based untuk penamaan domain
const domain = `cdn${index}.example.com`; // ← GANTI ke domain milikmu

console.log(`
== LANGKAH SETUP AKUN R2 #${index} ==

1. Dashboard akun Cloudflare baru → R2 → buat bucket "manga-images"
2. R2 → Manage R2 API Tokens → Create API token:
   - Permission: Object Read & Write
   - Scope: bucket manga-images
   - Simpan Access Key ID + Secret Access Key (hanya tampil sekali!)
3. Buat R2 API token untuk bucket manga-images
4. Custom domain: bucket → Settings → Custom Domains → Add
   domain: ${domain} (butuh zone ${domain.split('.').slice(-2).join('.')} di akun tsb)
5. Lifecycle rule (jalankan dari akun tsb, wrangler login akun tsb):
   npx wrangler r2 bucket lifecycle set manga-images --file - <<'EOF'
   { "Rules": [ { "ID": "evict-komiku", "Status": "Enabled",
       "Filter": { "Prefix": "komiku/" },
       "Expiration": { "Days": 30 } } ] }
   EOF
   (ganti Days sesuai R2_EVICTION_DAYS)

6. Tambahkan entry ke secret Worker (primary account):
   echo -n '<R2_ACCOUNTS-lengkap-JSON>' | npx wrangler secret put R2_ACCOUNTS --config apps/api-cf/wrangler.toml
7. Tambahkan domain ke frontend env:
   NEXT_PUBLIC_R2_DOMAINS='${[...existing.map((a) => a.public_domain), domain].join(',')}'
8. Verifikasi: curl -I https://${domain}/komiku/test-obj → 200
9. Jalankan remap report (migrasi otomatis via cache-aside):
   node -e "import('./packages/shared/src/r2-routing.ts').then(m => {
     const oldA = ${JSON.stringify(existing.map((a) => a.public_domain))};
     const newA = [...oldA, '${domain}'];
     const keys = ['naruto','one-piece','boruto','jujutsu-kaisen','chainsaw-man','spy-x-family']; // ganti list slug asli
     console.log(m.generateRemapReport(keys, oldA, newA, 32));
   })"

Entry JSON untuk R2_ACCOUNTS (tambahkan ke array):
  {"account_id": "<ACCOUNT_ID>", "access_key_id": "<ACCESS_KEY_ID>", "secret_access_key": "<SECRET>", "public_domain": "${domain}"}
`);
```

Jalankan: `node scripts/setup-r2-account.mjs` → output langkah tampil (tidak ada akun existing → index 1).

- [ ] **Step 2: `docs/ADDING-ACCOUNT.md`** — tulis dari langkah di atas + CORS checklist:

```markdown
# Menambah Akun R2 Baru (dan Akun Worker API)

## R2 storage (gambar komiku)
1. Buat bucket `manga-images` di akun baru
2. R2 API token: permission Object Read & Write, scope bucket tsb
3. Custom domain `cdnN.example.com` → bucket (butuh zone di akun)
4. Lifecycle rule `komiku/` → `Expiration.Days = R2_EVICTION_DAYS`
5. Update secret `R2_ACCOUNTS` (Worker primary) + `NEXT_PUBLIC_R2_DOMAINS` (web) — urutan sama!
6. Jalankan `node scripts/setup-r2-account.mjs` untuk panduan + remap report
7. Verifikasi: `curl -I https://cdnN.example.com/<key>` → 200

## Akun Worker API (origin round-robin)
- Provision via panel admin LB (auto-provision) atau manual
- Verifikasi CORS per akun baru:
  - [ ] `ALLOWED_ORIGINS` = `https://manga-web-d32.pages.dev,http://localhost:3000`
  - [ ] OPTIONS preflight → 204 + echo `Access-Control-Allow-Origin`
  - [ ] Header `x-admin-*` TIDAK boleh di-allow dari browser
  - [ ] `curl -H "Origin: https://manga-web-d32.pages.dev" -I <origin>/api/health` → header CORS ada
  - [ ] `curl -I <origin>/api/health` tanpa Origin → TIDAK ada header CORS (fail-closed)
- Endpoint publik yang dipakai frontend (allowlist path di `apps/web/lib/api.ts`):
  `/api/health`, `/api/search`, `/api/series`, `/api/series/:slug`, `/api/manga/:id`,
  `/api/reader/*`, `/api/source-status`, `/api/origins`
```

- [ ] **Step 3: `docs/TOS-REVIEW.md`**:

```markdown
# ToS / Acceptable Use Policy Review (WAJIB sebelum production live)

- [ ] Review Acceptable Use Policy Cloudflare terkini:
      https://www.cloudflare.com/terms/ + https://www.cloudflare.com/trust-hub/
- [ ] Multi-account untuk melipatgandakan free tier — pastikan sesuai kebijakan
      penggunaan yang wajar; verifikasi ulang tiap ada perubahan ToS
- [ ] Rehost gambar Komiku — keputusan user (MangaDex tetap proxy, tidak rehost)
- [ ] Cache: lifecycle 30 hari mencegah storage menumpuk (10GB/akun free tier)
- [ ] Catat tanggal review + hasil di bawah ini:
  Tanggal: ___
  Hasil: ___
```

- [ ] **Step 4: Update `scripts/build-worker-bundle.mjs`** — seed print migration 0002:

Setelah baris migration 0001, tambah:

```js
const migration2Sql = readFileSync('packages/db/migrations/0002_r2_storage.sql', 'utf8');
```

dan di console.log seed:

```js
console.log(`  npx wrangler kv key put --namespace-id=<KV_ID> "provision:migration2:latest" --path=- < packages/db/migrations/0002_r2_storage.sql`);
```

- [ ] **Step 5: Verifikasi**

Run: `node scripts/setup-r2-account.mjs` → langkah tampil tanpa error
Run: `node scripts/build-worker-bundle.mjs` → bundle ter-build + seed print baru muncul

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-r2-account.mjs scripts/build-worker-bundle.mjs docs/ADDING-ACCOUNT.md docs/TOS-REVIEW.md
git commit -m "chore: R2 account setup script + docs (adding account, ToS review)"
```

---

### Task 8: Verifikasi akhir

- [ ] **Step 1: Jalankan semua test**

```bash
node packages/shared/test/r2-routing.test.mjs
node apps/api-cf/test/r2-upload.test.mjs
node apps/api-cf/test/reader-slug.test.mjs
node scripts/smoke-r2-db.mjs
node scripts/smoke-db.mjs
```

Expected: semua PASS

- [ ] **Step 2: Typecheck semua package**

```bash
npx tsc --noEmit -p packages/shared
npx tsc --noEmit -p packages/db
npx tsc --noEmit -p apps/api-cf    # hanya error pre-existing (auth.ts/crypto.ts/caches.default)
npx tsc --noEmit -p apps/web
npx tsc --noEmit -p packages/sources
npx tsc --noEmit -p packages/lb
npx tsc --noEmit -p packages/vision
```

- [ ] **Step 3: Build worker bundle + web**

```bash
node scripts/build-worker-bundle.mjs
cd apps/web && npx next build
```

- [ ] **Step 4: Verifikasi konsistensi hash lintas sisi** — jalankan sekali dari kedua bundel:

```bash
node -e "import('./packages/shared/src/r2-routing.ts').then(m => { const ring = m.buildRing(['cdn1.example.com','cdn2.example.com'],32); console.log('naruto →', m.accountFor('naruto', ring)); console.log('one-piece →', m.accountFor('one-piece', ring)); })"
```

Fungsi yang sama (import sama) → otomatis konsisten. Smoke ini sekadar konfirmasi import jalan di Node.

- [ ] **Step 5: Review diff + commit sisa**

```bash
git status && git diff --stat
```

- [ ] **Step 6: Update plan status** — semua checkbox selesai, laporkan ke user.

---

## Self-Review Notes

- Spec Section 6 `lb_usage` PK: spec asli pakai `account_id TEXT PRIMARY KEY` (1 baris selamanya) — dikoreksi di plan jadi composite `(origin_url, date_key)` (1 baris per origin per hari). Migration + smoke test mengikuti koreksi ini.
- Spec Section 5 "upload saat scrape job": disederhanakan — upload terjadi on-demand di fallback path (per page, 2 subrequests), bukan bulk di `/api/scrape` (30 pages = 60 subrequests > 50 limit Free). Scrape job tetap metadata-only (existing behavior). Ini sejalan dengan tujuan "upload cuma yang diminta" + constraint subrequest.
- Key R2 tanpa extension (spec Section 5 bilang `{pageNo}.{ext}`): dikoreksi jadi `{pageNo}` tanpa ext — ext tidak diketahui deterministik di dua sisi tanpa lookup; content-type disimpan di object metadata saat upload. Migration + frontend mengikuti.
