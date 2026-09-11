import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Series, Chapter } from '@manga-platform/shared';
import { b2KeyFor } from '@manga-platform/shared/r2-routing';
import { drainResponse } from '@manga-platform/shared/http';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { allowedOriginFor } from '../lib/context';
import { retryUpstream } from '../lib/retry';
import { readThroughCache, matchEdgeCache, putEdgeCache, waitForLockClear } from '../lib/readThroughCache';
import { resolveB2Accounts, pickB2AccountIdx, b2AccountForIdx, type B2Account } from '../lib/b2Config.ts';
import { addB2Usage, addB2UsageGlobal, usageRatio } from '../lib/b2Usage';
import { enqueueOutbox } from '../lib/dbWrite';
import { ownerFor, internalExec, internalQuery, peerKvGet } from '../lib/peers';
import { b2PutObject, b2GetObject } from '../lib/s3Upload.ts';
import { parseSlugFromChapterId } from '../lib/komikuSlug.ts';
import { evictStaleStorage } from '../lib/storageEviction.ts';

export const router = new Hono<{ Bindings: Env }>();
// Router untuk /img/* (image proxy). Terpisah dari router utama supaya
// index.ts bisa mount di path sendiri sebelum rate limit (image = high volume).
export const imgRouter = new Hono<{ Bindings: Env }>();

// Race promise terhadap budget ms; timeout → resolve fallback (tidak reject).
// Dipakai untuk enrich background agar cold-open tidak blocking 20-30s.
export const withBudget = async <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Static priority fallback ketika tidak ada data chapter_count/recency
// (source yang belum pernah di-index → semua chapterCount 0).
export const SOURCE_WEIGHT: Record<string, number> = {
  komiku: 5, bacakomik: 4, thrive: 3, shinigami: 2, manhwaindo: 1,
};

export interface SourceLinkRow {
  source: string;
  sourceSlug: string;
  hasChapterList: boolean;
  chapterCount: number;
  lastScrapedAt?: number | null;
}

// Pick recommended (default) source: chapter terbanyak → tie-break last_scraped_at
// terbaru → tie-break priority statis. Source tanpa daftar chapter tidak eligible.
// Kalau semua chapterCount 0 (data belum pernah di-index) → priority statis.
// Murni & deterministik — di-test terpisah (test/source-pick.test.mjs).
export const pickRecommendedSource = (links: SourceLinkRow[]): string | null => {
  const eligible = links.filter((l) => l.hasChapterList);
  if (eligible.length === 0) return null;
  const withData = eligible.filter((l) => (l.chapterCount ?? 0) > 0);
  const pool = withData.length > 0 ? withData : eligible;
  pool.sort(
    (a, b) =>
      (b.chapterCount ?? 0) - (a.chapterCount ?? 0) ||
      (b.lastScrapedAt ?? 0) - (a.lastScrapedAt ?? 0) ||
      (SOURCE_WEIGHT[b.source] ?? 0) - (SOURCE_WEIGHT[a.source] ?? 0)
  );
  return pool[0].source;
};

// Fail-closed CORS origin for image responses. Returns null when no origin
// matches — callers should omit the header entirely in that case.
const corsOriginFor = (env: Env, requestOrigin: string | undefined): string | null =>
  allowedOriginFor(env, requestOrigin);

const setCorsHeaders = (env: Env, headers: Headers, requestOrigin?: string): void => {
  const o = corsOriginFor(env, requestOrigin);
  if (o) {
    headers.set('Access-Control-Allow-Origin', o);
    headers.set('Vary', 'Origin');
  }
};

const cacheGet = async <T>(c: Context, key: string): Promise<T | null> => {
  const raw = await c.env.CACHE_KV.get(key, 'json').catch(() => null);
  return (raw as T) ?? null;
};

const cachePut = (c: Context, key: string, value: unknown, ttl: number): void => {
  c.executionCtx.waitUntil(c.env.CACHE_KV.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {}));
};

// Passive source health: record outcome of user activity, no dedicated ping.
const recordHealth = (c: Context, source: string, start: number, ok: boolean, error?: string) => {
  c.executionCtx.waitUntil(
    getDb(c).recordSourceHealth({
      source,
      healthy: ok,
      latencyMs: Date.now() - start,
      error: ok ? null : (error ?? 'unknown error'),
    }).catch(() => {})
  );
};

// SSRF guard: allowlist of known image-host hostnames. Blocks proxying to
// arbitrary internal/private URLs that could be injected via scraped content.
const ALLOWED_IMAGE_HOSTS = new Set([
  'img.komiku.org',
  'komiku.org',
  // BacaKomik image hosts (chapter CDN rotates among these)
  'imageainewgeneration.lol',
  'himmga.lat',
  'gaimgame.pics',
  'komikcdn.me',
  'i0.wp.com',
  'i1.wp.com',
  'i2.wp.com',
  'i3.wp.com',
  // ManhwaIndo image hosts
  'kacu.gmbr.pro',
  'upload.gmbr.pro',
  // Thrive image hosts
  'cdn.thrive.moe',
  'backup.thrive.moe',
  'kuma.thrive.moe',
  // Shinigami image hosts
  'assets.shngm.id',
]);

const isPrivateIp = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === '169.254.169.254' || h === '0.0.0.0') return true;
  if (h.includes(':')) return true;
  if (/^\d+$/.test(h)) return true;
  if (/^0[xo]/i.test(h) || /(^|\.)0\d+/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.)/.test(h)) return true;
  return false;
};

const isAllowedImageUrl = (raw: string): boolean => {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (isPrivateIp(host)) return false;
  // Allow known image hosts outright.
  if (ALLOWED_IMAGE_HOSTS.has(host)) return true;
  return false;
};

const fetchUpstreamValidated = async (
  url: string,
  init: RequestInit,
  maxHops = 3
): Promise<Response | null> => {
  let cur = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!isAllowedImageUrl(cur)) return null;
    const r = await fetch(cur, { ...init, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      await drainResponse(r);
      if (!loc) return null;
      try {
        cur = new URL(loc, cur).toString();
      } catch {
        return null;
      }
      continue;
    }
    return r;
  }
  return null;
};

// Fetch page URLs with KV caching to avoid re-hitting the source CDN
// on every image request (prevents 429 rate-limit → 502 cascade).
// Singleflight via lock KV `pageslock:*`: concurrent miss untuk chapter yang
// sama coalesce — waiter tunggu max 3s (poll 150ms + re-check cache), lalu
// ikut fetch bila lock belum lepas. Lock TTL 15s agar tidak stuck.
const fetchPageUrlsWithCache = async (
  c: Context,
  source: string,
  chapterId: string
): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> => {
  const cacheKey = `pages:${source}:${chapterId}`;
  const cached = await cacheGet<{ url: string; proxyHeaders?: Record<string, string> }[]>(c, cacheKey);
  if (cached) return cached;
  const lockKey = `pageslock:${source}:${chapterId}`;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lock = await c.env.CACHE_KV.get(lockKey).catch(() => null);
    if (!lock) break;
    await new Promise((r) => setTimeout(r, 150));
    const raced = await cacheGet<{ url: string; proxyHeaders?: Record<string, string> }[]>(c, cacheKey);
    if (raced) return raced;
  }
  await c.env.CACHE_KV.put(lockKey, '1', { expirationTtl: 15 }).catch(() => {});
  try {
    const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
    if (!adapter) throw new Error('unknown source');
    const pages = await retryUpstream(() => adapter.fetchPageUrls(chapterId));
    cachePut(c, cacheKey, pages, 600);
    return pages;
  } finally {
    await c.env.CACHE_KV.delete(lockKey).catch(() => {});
  }
};

// Resolve slug manga dari chapterId: D1 dulu (akurat), cache KV 1 jam,
// fallback parse dari format '<slug>-chapter-<num>'. Source yang pakai
// chapter id UUID (thrive, shinigami) tidak bisa di-parse — fallback
// terakhir: adapter.getChapter → series_slug (shinigami API mengembalikan
// manga_id di chapter detail).
const resolveSlug = async (c: Context, source: string, chapterId: string): Promise<string | null> => {
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
  if (parsed) {
    cachePut(c, cacheKey, parsed, 3600);
    return parsed;
  }
  // UUID chapter id: tanya adapter (getChapter → series_slug). Best-effort,
  // gagal → null → image proxy-only (tanpa B2), konsisten dengan thrive.
  try {
    const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
    if (adapter) {
      const ch = await retryUpstream(() => adapter.getChapter(chapterId)).catch(() => null);
      if (ch?.series_slug) {
        cachePut(c, cacheKey, ch.series_slug, 3600);
        return ch.series_slug;
      }
    }
  } catch { /* fall through — proxy-only */ }
  return null;
};

const upsertPageRow = async (
  c: Context,
  chapterId: string,
  pageNo: number,
  imageUrl: string,
  b2Key: string,
  accountIdx: number
): Promise<void> => {
  const invalidateImgRows = (): void => {
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.delete(`imgrows:${chapterId}`).catch(() => {})
    );
  };
  const owner = ownerFor(c.env, chapterId);
  if (owner.self) {
    await getDb(c).markPageB2Uploaded({ chapterId, pageNumber: pageNo, imageUrl, b2Key, b2AccountIdx: accountIdx }).catch(() => {});
    invalidateImgRows();
    return;
  }
  const sql = `INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx, last_access)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx, image_url = excluded.image_url, last_access = strftime('%s','now')`;
  const ok = await internalExec(c.env, owner.url, { sql, params: [chapterId, pageNo, imageUrl, b2Key, accountIdx], table: 'chapter_pages' });
  if (!ok) {
    await getDb(c).markPageB2Uploaded({ chapterId, pageNumber: pageNo, imageUrl, b2Key, b2AccountIdx: accountIdx }).catch(() => {});
    c.executionCtx.waitUntil(enqueueOutbox(c.env, owner.url, 'chapter_pages', sql, [chapterId, pageNo, imageUrl, b2Key, accountIdx]));
  }
  invalidateImgRows();
};

// Read chapter_pages rows from the owner D1 (self → local; peer → internal
// /db/query). Empty array when owner read fails → frontend falls back to proxy
// (which re-uploads + heals the owner row).
const readStoredPageRows = async (
  c: Context,
  chapterId: string
): Promise<Array<{ page_number: number; r2_key: string; r2_account_idx: number }>> => {
  const owner = ownerFor(c.env, chapterId);
  const sql = 'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1';
  if (owner.self) {
    const res = await c.env.DB.prepare(sql).bind(chapterId).all<{ page_number: number; r2_key: string; r2_account_idx: number }>().catch(() => null);
    return res?.results ?? [];
  }
  return (await internalQuery<{ page_number: number; r2_key: string; r2_account_idx: number }>(
    c.env, owner.url, sql, [chapterId], 'chapter_pages'
  ).catch(() => null)) ?? [];
};

// Same as readStoredPageRows but KV-cached. Potong D1 read ketika Workers Cache
// masih dingin (tiap deploy cache key include version → reset). KV persist
// antar deploy, jadi chapter yang sudah hangat tidak lagi D1-read per /img miss.
// TTL pendek (600s): baris bertambah saat cache-aside upload page baru; KV lama
// yang ketinggalan halaman baru hanya bikin request itu fallback ke source CDN
// (re-upload + heal), tidak patah.
const readStoredPageRowsCached = async (
  c: Context,
  chapterId: string
): Promise<Array<{ page_number: number; r2_key: string; r2_account_idx: number }>> => {
  const cacheKey = `imgrows:${chapterId}`;
  const cached = await c.env.CACHE_KV.get(cacheKey, { type: 'json' }).catch(() => null);
  if (cached) return cached as Array<{ page_number: number; r2_key: string; r2_account_idx: number }>;
  const rows = await readStoredPageRows(c, chapterId);
  if (rows.length > 0) {
    c.executionCtx.waitUntil(
      c.env.CACHE_KV.put(cacheKey, JSON.stringify(rows), { expirationTtl: 600 }).catch(() => {})
    );
  }
  return rows;
};

// LRU touch per halaman (dipakai /img, disampling — lihat imgRouter). Best-effort.
const touchOwnerPage = async (c: Context, chapterId: string, pageNo: number): Promise<void> => {
  const owner = ownerFor(c.env, chapterId);
  if (owner.self) {
    await getDb(c).touchPageLastAccess(chapterId, pageNo).catch(() => {});
    return;
  }
  const sql = 'UPDATE chapter_pages SET last_access = ?1 WHERE chapter_id = ?2 AND page_number = ?3';
  const params = [Math.floor(Date.now() / 1000), chapterId, pageNo];
  const ok = await internalExec(c.env, owner.url, { sql, params, table: 'chapter_pages' }).catch(() => false);
  if (!ok) c.executionCtx.waitUntil(enqueueOutbox(c.env, owner.url, 'chapter_pages', sql, params));
};

// Batch LRU touch: 1 query untuk seluruh chapter (semua halaman 1 chapter
// pasti di owner D1 yang sama — sharding key = chapterId). Menggantikan
// loop per-halaman (N writes per chapter view → 1 write). Presisi LRU
// per-halaman dikorbankan ke per-chapter; eviction tetap benar karena yang
// diperhatikan hanyalah "kapan chapter terakhir dibaca".
const touchOwnerChapter = async (c: Context, chapterId: string): Promise<void> => {
  const sql = 'UPDATE chapter_pages SET last_access = ?1 WHERE chapter_id = ?2';
  const params = [Math.floor(Date.now() / 1000), chapterId];
  const owner = ownerFor(c.env, chapterId);
  if (owner.self) {
    await c.env.DB.prepare(sql).bind(...params).run().catch(() => {});
    return;
  }
  const ok = await internalExec(c.env, owner.url, { sql, params, table: 'chapter_pages' }).catch(() => false);
  if (!ok) c.executionCtx.waitUntil(enqueueOutbox(c.env, owner.url, 'chapter_pages', sql, params));
};

// Upload gambar ke B2 storage tier (background) + catat D1. Idempoten:
// key sama → overwrite sama. Race 2 request paralel aman.
// Hash-pick → mulai dari akun itu; gagal → fallback ke akun lain (wrapping).
// R2 path removed per projek: semua asset ke B2.
const uploadToStorage = async (c: Context, opts: { source: string; slug: string; chapterId: string; pageNo: number; imageUrl: string; contentType: string; body: ReadableStream | ArrayBuffer }): Promise<void> => {
  const b2Key = b2KeyFor(opts.source, opts.slug, opts.chapterId, opts.pageNo);
  const b2Accounts = resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS);

  if (b2Accounts.length === 0) return;
  const startIdx = pickB2AccountIdx(b2Accounts, b2Key);
  for (let k = 0; k < b2Accounts.length; k++) {
    const i = (startIdx + k) % b2Accounts.length;
    const b2 = b2Accounts[i];
    const accountIdx = -(i + 1);
    const ratio = await usageRatio(c.env, c.env.CACHE_KV, i).catch(() => 0);
    if (ratio > 0.9) {
      // Jangan upload ke akun nyaris penuh (B2 melewati 10GB free → kena tagih).
      // Trigger eviction di background, lalu coba akun berikutnya.
      c.executionCtx.waitUntil(evictStaleStorage(c.env).catch(() => {}));
      continue;
    }
    try {
      const res = await b2PutObject(b2, b2Key, opts.body as ArrayBuffer, opts.contentType);
      if (res.ok) {
        await upsertPageRow(c, opts.chapterId, opts.pageNo, opts.imageUrl, b2Key, accountIdx);
        const bytes = (opts.body as ArrayBuffer).byteLength || 0;
        if (bytes > 0) {
          c.executionCtx.waitUntil(addB2Usage(c.env.CACHE_KV, i, bytes));
          c.executionCtx.waitUntil(addB2UsageGlobal(c, b2.name, bytes));
        }
        return;
      }
      console.error(`[b2:${b2.name}] upload ${res.status} → next tier: ${opts.source}/${opts.slug}/${opts.chapterId}/${opts.pageNo}`);
    } catch (e) {
      console.error(`[b2:${b2.name}] upload failed → next tier: ${String(e)}`);
    }
  }

  // Semua B2 gagal → proxy-only mode (response user tetap jalan).
};

// Consolidated series detail + chapters in a single Worker invocation.
// GET /api/reader/:source/series/:sourceId/detail?lang=id
// Returns { data: { ...series, chapters: [...] } }.
//
// Cache strategy: two-tier (fresh 10min + stale 24h) with stale-while-revalidate
// + circuit breaker per source. When the upstream DDoS-guard 502s (Komiku),
// we serve last-known-good stale instead of failing the reader. This is the
// primary mitigation for the intermittent 502s on detail pages.
router.get('/:source/series/:sourceId/detail', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const lang = c.req.query('lang') || 'id';
  const cacheKey = `series:full:${source}:${sourceId}:${lang}`;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);

  const start = Date.now();
  try {
    const result = await readThroughCache<{ data: { chapters: Chapter[] } & Record<string, unknown> }>(
      c,
      cacheKey,
      async () => {
        // Prefer getSeriesDetail (single upstream fetch) — falls back to
        // Promise.all([getSeries, listChapters]) for adapters that don't implement it.
        // The single-fetch path avoids double-requesting the same detail-page URL,
        // which triggered intermittent 502s from Komiku's DDoS-guard edge.
        let r: { series: Series; chapters: Chapter[] };
        if (adapter.getSeriesDetail) {
          // Bind explicitly: thriveAdapter.getSeriesDetail internally calls
          // `this._fetchDetail`. Detaching (`const detail = adapter.getSeriesDetail`)
          // drops `this` → TypeError: Cannot read properties of undefined
          // (reading '_fetchDetail') → ~15% thrive "downtime" recorded as
          // healthCheck failures. Bind once, call via the bound ref.
          const detail = adapter.getSeriesDetail.bind(adapter);
          r = await retryUpstream(() => detail(sourceId, { lang }));
        } else {
          const [series, chapters] = await Promise.all([
            retryUpstream(() => adapter.getSeries(sourceId)),
            retryUpstream(() => adapter.listChapters(sourceId, { lang })),
          ]);
          r = { series, chapters };
        }
        const { series, chapters } = r;
        // Index chapterId → slug (KV 1 jam) supaya B2 cache-aside bisa resolve
        // slug dari chapterId (thrive pakai uuid yang tidak bisa di-parse).
        //
        // KV WRITE THROTTLE: Previously this loop wrote a KV key for EVERY chapter
        // in the series (e.g. 200 chapters = 200 KV writes). Now we batch-write
        // only the first 50 chapters — enough for the most-accessed recent
        // chapters, and the rest lazily resolve via D1 on first page proxy request.
        // This cuts KV writes by ~75% for large series.
        c.executionCtx.waitUntil(
          (async () => {
            const maxToIndex = Math.min(chapters.length, 50);
            for (let i = 0; i < maxToIndex; i++) {
              const ch = chapters[i];
              try { await cachePut(c, `slug:${ch.id}`, series.slug, 3600); } catch { /* best-effort */ }
            }
          })()
        );
        return { data: { ...series, chapters } };
      },
      { circuitKey: `reader:${source}:detail`, peerFallback: async () => {
          const v = await peerKvGet(c.env, cacheKey);
          return v as { data: { chapters: Chapter[] } & Record<string, unknown> } | null;
        } }
    );
    recordHealth(c, source, start, true);
    const maxAge = result.source === 'stale' ? 30 : 600;
    c.header('Cache-Control', `public, s-maxage=${maxAge}, stale-while-revalidate=1800`);
    if (result.source === 'stale') c.header('X-Cache', 'stale');
    return c.json(result.data);
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Series detail: GET /api/reader/:source/series/:sourceId
// Two-tier cache (fresh 10min + stale 24h) — serves last-known-good when
// the upstream DDoS-guard 502s instead of failing the reader.
router.get('/:source/series/:sourceId', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `series:detail:${source}:${sourceId}`;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const result = await readThroughCache<{ data: Series }>(
      c,
      cacheKey,
      async () => ({ data: await retryUpstream(() => adapter.getSeries(sourceId)) }),
      { circuitKey: `reader:${source}:detail`, peerFallback: async () => {
          const v = await peerKvGet(c.env, cacheKey);
          return v as { data: Series } | null;
        } }
    );
    recordHealth(c, source, start, true);
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(result.data);
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Chapter list for a series: GET /api/reader/:source/series/:sourceId/chapters?lang=id
router.get('/:source/series/:sourceId/chapters', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const lang = c.req.query('lang') || 'id';
  const cacheKey = `chapters:list:${source}:${sourceId}:${lang}`;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const result = await readThroughCache<{ data: Chapter[] }>(
      c,
      cacheKey,
      async () => ({ data: await retryUpstream(() => adapter.listChapters(sourceId, { lang })) }),
      { freshTtl: 300, circuitKey: `reader:${source}:detail`, peerFallback: async () => {
          const v = await peerKvGet(c.env, cacheKey);
          return v as { data: Chapter[] } | null;
        } }
    );
    recordHealth(c, source, start, true);
    return c.json(result.data);
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Enrich chapter counts for a manga's source links (inline, timeout 8s per
// source). Hit listChapters per (source, sourceSlug) concurrently → recommended
// dapat count real bahkan pada first visit ke manga. Gate KV `enrich:<id>` 6h
// mencegah repeat. Gagal/timeout → count 0 untuk source itu (skip, bukan abort).
// Ketika responden > 0, invalidate cache `/sources` agar response berikutnya
// baca dari D1 (aggregation path, cepat).
export const enrichChapterCounts = async (
  c: Context,
  mangaId: number,
  cacheKey: string
): Promise<void> => {
  const gateKey = `enrich:${mangaId}`;
  if (await c.env.CACHE_KV.get(gateKey).catch(() => null)) return;
  await c.env.CACHE_KV.put(gateKey, '1', { expirationTtl: 21600 }).catch(() => {});
  const db = getDb(c);
  const rows = await db.getSourceLinksByManga(mangaId).catch(() => []);
  const targets = rows.map((r) => ({ source: r.source, sourceSlug: r.source_slug }));
  if (targets.length === 0) return;
  const counted = await Promise.allSettled(
    targets.map(async (t): Promise<{ source: string; sourceSlug: string; count: number; lastScrapedAt: number }> => {
      const a = getAdapter(t.source, c.env as unknown as AdapterEnv);
      if (!a) throw new Error('no adapter');
      const chapters = await Promise.race([
        retryUpstream(() => a.listChapters(t.sourceSlug, { lang: 'id' }), 2),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('listChapters timeout')), 10000)),
      ]);
      return { source: t.source, sourceSlug: t.sourceSlug, count: chapters.length, lastScrapedAt: Math.floor(Date.now() / 1000) };
    })
  );
  // Batch upsert: env.DB.batch = 1 subrequest D1 (vs N upsert terpisah).
  // Penting di Workers Free (50 subrequest/invocation) — route /sources
  // sudah mahal karena live-resolve + auto-index.
  const upsertStmts = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const hit = counted[i];
    if (hit?.status === 'fulfilled') {
      upsertStmts.push(
        c.env.DB.prepare(
          `INSERT INTO manga_source_link (manga_id, source, source_slug, has_chapter_list, chapter_count, last_scraped_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(source, source_slug) DO UPDATE SET
             manga_id = excluded.manga_id,
             has_chapter_list = excluded.has_chapter_list,
             chapter_count = excluded.chapter_count,
             last_scraped_at = excluded.last_scraped_at`
        ).bind(mangaId, t.source, t.sourceSlug, 1, hit.value.count, hit.value.lastScrapedAt)
      );
    }
  }
  if (upsertStmts.length > 0) {
    await c.env.DB.batch(upsertStmts).catch(() => []);
    await c.env.CACHE_KV.delete(cacheKey).catch(() => {});
  }
};

// Aggregated sources for a manga: GET /api/reader/:source/series/:sourceId/sources
// 1) Uses manga_source_link aggregation (D1) when rows exist.
// 2) Fallback (live-resolve): searches the OTHER sources for the same title so
//    the source switcher works even before any scrape has persisted rows.
router.get('/:source/series/:sourceId/sources', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `sources:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(cached);
  }

  const db = getDb(c);
  try {
    // 1. Aggregated rows first.
    const manga = await db.getMangaBySource(source, sourceId).catch(() => null);
    let canonicalId: number | null = null;
    if (manga) {
      canonicalId = manga.id;
    } else {
      const row = await c.env.DB.prepare('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(sourceId).first<{ id: number }>();
      canonicalId = row?.id ?? null;
    }

    let links: SourceLinkRow[] = [];
    let canonicalSlug: string | null = null;
    if (canonicalId) {
      const rows = await db.getSourceLinksByManga(canonicalId);
      links = rows.map((l) => ({
        source: l.source,
        sourceSlug: l.source_slug,
        hasChapterList: l.has_chapter_list === 1,
        chapterCount: l.chapter_count,
        lastScrapedAt: l.last_scraped_at ?? null,
      }));
      const canonicalRow = await c.env.DB.prepare('SELECT slug FROM series WHERE id = ?1').bind(canonicalId).first<{ slug: string }>();
      canonicalSlug = canonicalRow?.slug ?? null;
      // Data lama (auto-index sebelum fitur count) semua chapter_count = 0 →
      // recommendedSource tak punya sinyal. Enrich inline (concurrent listChapters
      // per source, gate 6h) → request berikutnya dapat count real.
      // Waktu parallel dengan detail fetch, jadi tidak menambah latency total.
      if (links.length > 0 && links.every((l) => (l.chapterCount ?? 0) === 0)) {
        c.executionCtx.waitUntil(
          withBudget(enrichChapterCounts(c, canonicalId, cacheKey), 4000, undefined).catch(() => {})
        );
        // Re-read from D1 in case enrich populated counts.
        const rows2 = await db.getSourceLinksByManga(canonicalId).catch(() => null);
        if (rows2) {
          links = rows2.map((l) => ({
            source: l.source,
            sourceSlug: l.source_slug,
            hasChapterList: l.has_chapter_list === 1,
            chapterCount: l.chapter_count,
            lastScrapedAt: l.last_scraped_at ?? null,
          }));
        }
      }
    }

    // 2. Live-resolve when aggregation is empty (or missing current source).
    const hasCurrent = links.some((l) => l.source === source);
    if (links.length === 0 || !hasCurrent) {
      const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
      if (adapter) {
        const series = await adapter.getSeries(sourceId).catch(() => null);
        if (series?.title) {
          const norm = series.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const resolved: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }> = [];
          const all = await Promise.all(
            (['komiku', 'bacakomik', 'manhwaindo', 'thrive', 'shinigami'] as const)
              .filter((s) => s !== source)
              .map(async (s) => {
                const a = getAdapter(s, c.env as unknown as AdapterEnv);
                if (!a) return null;
                const results = await a.search({ q: series!.title.slice(0, 60), limit: 10 }).catch(() => []);
                // Prefer exact normalized title match; fallback to prefix match.
                const exact = results.find((r) => {
                  const n = r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                  return n === norm;
                });
                const hit = exact ?? results.find((r) => {
                  const n = r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                  return norm.length > 10 && n.startsWith(norm.slice(0, 20));
                });
                return hit ? { source: s, sourceSlug: hit.slug, hasChapterList: true, chapterCount: 0 } : null;
              })
          );
          for (const r of all) {
            if (r) resolved.push(r);
          }
          // Merge with any aggregated links (dedupe by source).
          const seen = new Set(resolved.map((r) => r.source));
          for (const l of links) {
            if (!seen.has(l.source)) {
              resolved.push(l);
              seen.add(l.source);
            }
          }
          links = resolved;

          // Auto-index (inline pada cache-miss): persist resolved links ke D1 +
          // enrich real counts (concurrent listChapters per source) sehingga
          // response pertama sudah punya recommendedSource akurat — detail page
          // server bisa redirect sebelum render (tanpa blink). dedupeOnIndex
          // berat → background (tidak mempengaruhi response).
          const row = await (async () => {
            try {
              const slug = series!.slug || sourceId;
              const altTitles = (series as unknown as Record<string, unknown>).alt_titles as string[] | undefined;
              await db.upsertSeries({
                slug,
                title: series!.title,
                external_id: series!.external_id ?? sourceId,
                source,
                synopsis: series!.synopsis ?? null,
                type: series!.type,
                status: series!.status ?? 'ongoing',
                author: series!.author ?? null,
                artist: series!.artist ?? null,
                cover_image: series!.cover_image ?? null,
                genres: series!.genres,
                alt_titles: altTitles?.length ? JSON.stringify(altTitles) : null,
                source_url: (series as unknown as Record<string, unknown>).source_url as string ?? null,
                language: (series as unknown as Record<string, unknown>).language as string ?? null,
              });
              const r = await c.env.DB.prepare('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(slug).first<{ id: number }>();
              if (!r) return null;
              // Seed link rows (count 0 dulu), lalu enrich real counts (gate KV).
              // Batch: N link = 1 subrequest (bukan N) — jaga bawah 50/invocation.
              const now = Math.floor(Date.now() / 1000);
              const seedRows = [
                { src: source, slug: sourceId, hasList: 1, count: 0 },
                ...resolved.map((rl) => ({ src: rl.source, slug: rl.sourceSlug, hasList: rl.hasChapterList ? 1 : 0, count: rl.chapterCount })),
              ];
              await c.env.DB.batch(
                seedRows.map((row) =>
                  c.env.DB.prepare(
                    `INSERT INTO manga_source_link (manga_id, source, source_slug, has_chapter_list, chapter_count, last_scraped_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(source, source_slug) DO UPDATE SET
                       manga_id = excluded.manga_id,
                       has_chapter_list = excluded.has_chapter_list,
                       chapter_count = excluded.chapter_count,
                       last_scraped_at = excluded.last_scraped_at`
                  ).bind(r.id, row.src, row.slug, row.hasList, row.count, now)
                )
              ).catch(() => []);
              c.executionCtx.waitUntil(
                withBudget(enrichChapterCounts(c, r.id, cacheKey), 4000, undefined).catch(() => {})
              );
              c.executionCtx.waitUntil(
                db.dedupeOnIndex({
                  source,
                  sourceSlug: sourceId,
                  title: series!.title,
                  altTitles,
                }).catch(() => {})
              );
              return r;
            } catch (e) {
              console.error('[sources] auto-index failed:', String(e));
              return null;
            }
          })();
          if (row) {
            const rows2 = await db.getSourceLinksByManga(row.id).catch(() => null);
            if (rows2) {
              links = rows2.map((l) => ({
                source: l.source,
                sourceSlug: l.source_slug,
                hasChapterList: l.has_chapter_list === 1,
                chapterCount: l.chapter_count,
                lastScrapedAt: l.last_scraped_at ?? null,
              }));
            }
          }
        }
      }
    }

    const data = {
      sources: links.map((l) => ({
        source: l.source,
        sourceSlug: l.sourceSlug,
        hasChapterList: l.hasChapterList,
        chapterCount: l.chapterCount,
      })),
      canonicalSlug,
      recommendedSource: pickRecommendedSource(links),
    };
    cachePut(c, cacheKey, { data }, 600);
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json({ data });
  } catch {
    return c.json({ data: { sources: [], canonicalSlug: null } });
  }
});

// Chapter detail + proxy page URLs: GET /api/reader/:source/chapter/:chapterId
router.get('/:source/chapter/:chapterId', async (c: Context) => {
  const { source, chapterId } = c.req.param();
  const cacheKey = `chapter:detail:${source}:${chapterId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    return c.json(cached);
  }

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const chapter = await retryUpstream(() => adapter.getChapter(chapterId));
    const pages = await fetchPageUrlsWithCache(c, source, chapterId);
    const proxyBase = `/api/reader/${source}/page/${encodeURIComponent(chapterId)}`;
    const imgBase = `/img/${source}/${encodeURIComponent(chapterId)}`;
    const data = {
      ...chapter,
      // imgUrl → proxy /img/* (B2-first, server-side). b2Url dihapus: presigned
      // URL ke browser membocorkan bucket/keyId B2 + nol cache di zone. Klien
      // lama yang masih kirim b2Url:null → fallback ke proxyUrl (proxy CDN).
      pages: pages.map((_, i) => {
        const pageNo = i + 1;
        return { proxyUrl: `${proxyBase}/${pageNo}`, imgUrl: `${imgBase}/${pageNo}`, b2Url: null };
      }),
    };
    // LRU touch: 1 write batch untuk seluruh chapter (bukan loop per halaman —
    // N writes/view menguras kuota D1 write 100rb/hari di free tier).
    c.executionCtx.waitUntil((async () => {
      await touchOwnerChapter(c, chapterId).catch(() => {});
      // Eviction trigger: every 100th chapter detail request, run LRU evict.
      // eviction:tick gets a 24h TTL so the key doesn't persist forever.
      const tickRaw = await c.env.CACHE_KV.get('eviction:tick').catch(() => '0');
      const tick = (Number(tickRaw) || 0) + 1;
      c.executionCtx.waitUntil(c.env.CACHE_KV.put('eviction:tick', String(tick), { expirationTtl: 86400 }).catch(() => {}));
      if (tick % 100 === 0) {
        c.executionCtx.waitUntil(evictStaleStorage(c.env).catch(() => {}));
      }
    })());
    cachePut(c, cacheKey, { data }, 300);
    c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    recordHealth(c, source, start, true);
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Lenient hotlink guard: reject only referers from a non-allowlisted origin.
// Missing/malformed referer is allowed — the site sets Referrer-Policy:
// no-referrer, so legit requests arrive without a referer.
const refererAllowed = (env: Env, referer: string | undefined): boolean => {
  if (!referer) return true;
  try { return allowedOriginFor(env, new URL(referer).origin) !== null; }
  catch { return true; }
};

// Core source-CDN image proxy (shared by /api/reader/*/page/* and /img/*).
// fetchPageUrls → SSRF guard → edge cache → retry fetch → B2 cache-aside upload.
const servePageImage = async (
  c: Context,
  source: string,
  chapterId: string,
  n: number,
  retry: number
): Promise<Response> => {
  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);

  let pages: { url: string; proxyHeaders?: Record<string, string> }[];
  try {
    pages = await fetchPageUrlsWithCache(c, source, chapterId);
  } catch (e) {
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }

  const page = pages[n - 1];
  if (!page) return c.json({ error: 'page not found' }, 404);

  // SSRF guard: block proxying to untrusted/non-image hosts.
  if (!isAllowedImageUrl(page.url)) {
    return c.json({ error: 'upstream image host not allowed' }, 403);
  }

  // Check Cloudflare Cache API first — avoids re-fetching from source CDN
  // and reduces Worker execution cost.
  let cachedImg: Response | null = null;
  if (typeof caches !== 'undefined') {
    const cache = (caches as unknown as { default: Cache }).default;
    cachedImg = (await cache.match(c.req.raw)) ?? null;
  }
  if (cachedImg) {
    const h = new Headers(cachedImg.headers);
    setCorsHeaders(c.env, h, c.req.header('origin'));
    return new Response(cachedImg.body, { status: 200, headers: h });
  }

  // Stampede protection: when many concurrent requests fetch the SAME upstream
  // image URL (popular chapter page), Cloudflare coalesces identical
  // cache.match() calls. We key the upstream URL itself (not our proxy URL
  // which differs per request via `retry` query param).
  const upstreamReq = new Request(page.url, {
    headers: { 'User-Agent': 'manga-platform/1.0', 'Referer': 'https://komiku.org/', ...(page.proxyHeaders || {}) },
  });
  const edgeHit = await matchEdgeCache(upstreamReq);
  if (edgeHit && edgeHit.status === 200) {
    const h = new Headers(edgeHit.headers);
    h.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    setCorsHeaders(c.env, h, c.req.header('origin'));
    const resp = new Response(edgeHit.body, { status: 200, headers: h });
    // Mirror to proxy cache for next request.
    if (typeof caches !== 'undefined') {
      const cache = (caches as unknown as { default: Cache }).default;
      c.executionCtx.waitUntil(cache.put(c.req.raw, resp.clone()).catch(() => {}));
    }
    return resp;
  }

  // Source CDNs occasionally fail transiently (502/503/connection reset).
  // reset). Retry up to 2 times (reduced from 3 to cap CPU time) before
  // surfacing the error. Only accept HTTP 200.
  let upstream: Response | null = null;
  const retryCount = retry;
  for (let attempt = 0; attempt < 2 + retryCount; attempt++) {
    try {
      const r = await fetchUpstreamValidated(page.url, {
        headers: {
          'User-Agent': 'manga-platform/1.0',
          'Referer': 'https://komiku.org/',
          ...(page.proxyHeaders || {})
        },
        signal: AbortSignal.timeout(10000),
        // Hint Cloudflare CDN to cache this response at the edge so
        // subsequent identical requests skip Worker execution entirely.
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      if (r && r.status === 200) { upstream = r; break; }
      if (r === null) break;
      if (r) await drainResponse(r);
    } catch {
      // network error → retry
    }
    if (attempt < 1) await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
  }

  if (!upstream) {
    const h = new Headers();
    h.set('Content-Type', 'application/json');
    h.set('Cache-Control', 'no-store');
    setCorsHeaders(c.env, h, c.req.header('origin'));
    return new Response(JSON.stringify({ error: 'upstream image fetch failed after retries', detail: page.url }), { status: 502, headers: h });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
  // Long edge cache: images are immutable chapter pages. CDN edge serves
  // subsequent hits without invoking the Worker.
  headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  setCorsHeaders(c.env, headers, c.req.header('origin'));

  // Cache-aside B2 (semua source — komiku + bacakomik + thrive + manhwaindo + shinigami):
  // clone stream SEBELUM Response dibuat — setelah `new Response(upstream.body)`
  // stream terkunci dan clone() melempar "ReadableStream locked to a reader".
  // Upload di background; request berikutnya diserve langsung dari B2 tanpa
  // lewat Worker. Upload idempoten (key sama → overwrite).
  // Buffer body (bukan stream): PUT stream tanpa Content-Length ditolak B2
  // (411 Length Required) untuk sebagian upstream — gambar chapter kecil,
  // buffer aman di limit 128MB.
  const slug = await resolveSlug(c, source, chapterId);
  let bgUpload: Promise<void> | null = null;
  if (slug) {
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = await new Response(upstream.clone().body).arrayBuffer();
    if (buf.byteLength > 0) {
      bgUpload = uploadToStorage(c, { source, slug, chapterId, pageNo: n, imageUrl: page.url, contentType, body: buf }).catch(() => {});
    }
  }

  const response = new Response(upstream.body, { status: 200, headers });

  // Store in Cloudflare edge cache for subsequent requests. We populate
  // BOTH the proxy-keyed cache (for next /api/reader/*/page/* hit) AND the
  // upstream-URL-keyed cache (for stampede coalescing on concurrent fetches
  // of the same source CDN URL).
  if (typeof caches !== 'undefined') {
    const cache = (caches as unknown as { default: Cache }).default;
    c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()).catch(() => {}));
    c.executionCtx.waitUntil(cache.put(upstreamReq, response.clone()).catch(() => {}));
  }

  if (bgUpload) c.executionCtx.waitUntil(bgUpload);

  return response;
};

// Image proxy (legacy path): GET /api/reader/:source/page/:chapterId/:pageNo
router.get('/:source/page/:chapterId/:pageNo', async (c: Context) => {
  const { source, chapterId, pageNo } = c.req.param();
  const n = Number(pageNo);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return c.json({ error: 'bad page number' }, 400);

  // Clamp: untrusted query param directly sized the upstream retry loop.
  const retry = Math.min(Math.max(Number(c.req.query('retry')) || 0, 0), 2);

  return servePageImage(c, source, chapterId, n, retry);
});

// Image proxy: GET /img/:source/:chapterId/:pageNo
// B2-first: object yang sudah di-upload diserve dari B2 dengan signed request
// server-side (credential tidak pernah ke browser). Miss / B2 down → fallback
// ke servePageImage (source CDN + cache-aside upload). Digunakan frontend
// (oktzz.xyz/img/*) sehingga lewat zone → Cloudflare cache rules bisa bekerja.
imgRouter.get('/:source/:chapterId/:pageNo', async (c: Context) => {
  const { source, chapterId, pageNo } = c.req.param();
  const n = Number(pageNo);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return c.json({ error: 'bad page number' }, 400);
  const retry = Math.min(Math.max(Number(c.req.query('retry')) || 0, 0), 2);

  if (!refererAllowed(c.env, c.req.header('referer'))) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  // B2-first: baca row dari owner D1 (sharded); row ada → serve dari B2.
  const slug = await resolveSlug(c, source, chapterId);
  if (slug) {
    const b2Key = b2KeyFor(source, slug, chapterId, n);
    const rows = await readStoredPageRowsCached(c, chapterId);
    const row = rows.find((r) => r.page_number === n);
    if (row && row.r2_key === b2Key && row.r2_account_idx < 0) {
      const b2 = b2AccountForIdx(resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS), row.r2_account_idx);
      if (b2) {
        try {
          const res = await b2GetObject(b2, row.r2_key);
          if (res.ok) {
            const h = new Headers();
            h.set('Content-Type', res.headers.get('content-type') || 'image/jpeg');
            // Immutable: chapter yang sudah publish tidak berubah. Edge cache
            // (cache rule /img/*) menyerap request berikutnya tanpa Worker.
            h.set('Cache-Control', 'public, max-age=31536000, immutable');
            setCorsHeaders(c.env, h, c.req.header('origin'));
            const resp = new Response(res.body, { status: 200, headers: h });
            if (typeof caches !== 'undefined') {
              const cache = (caches as unknown as { default: Cache }).default;
              c.executionCtx.waitUntil(cache.put(c.req.raw, resp.clone()).catch(() => {}));
            }
            // Sampling 1/10: LRU last_access tidak butuh presisi per hit;
            // 1 write per ~10 view gambar cukup untuk tujuan eviction.
            if (Math.random() < 0.1) {
              c.executionCtx.waitUntil(touchOwnerPage(c, chapterId, n).catch(() => {}));
            }
            return resp;
          }
        } catch { /* B2 down/limit → fallback ke source proxy */ }
      }
    }
  }

  return servePageImage(c, source, chapterId, n, retry);
});
