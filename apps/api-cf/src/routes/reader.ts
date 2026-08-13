import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import { buildRing, accountFor, r2KeyFor } from '@manga-platform/shared/r2-routing';
import { drainResponse } from '@manga-platform/shared/http';
import { getDb } from '../lib/context';
import type { Env, Context } from '../lib/context';
import { allowedOriginFor } from '../lib/context';
import { retryUpstream } from '../lib/retry';
import { parseR2Accounts } from '../lib/r2Accounts.ts';
import { s3PutObject } from '../lib/s3Upload.ts';
import { parseB2Accounts, b2AccountForIdx, type B2Account } from '../lib/b2Config.ts';
import { b2PutObject, b2PresignedGet } from '../lib/s3Upload.ts';
import { parseSlugFromChapterId } from '../lib/komikuSlug.ts';
import { evictStaleStorage } from '../lib/storageEviction.ts';

export const router = new Hono<{ Bindings: Env }>();

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
]);

const isPrivateIp = (host: string): boolean => {
  // Block RFC1918, loopback, link-local, metadata endpoint.
  if (host === 'localhost' || host === '169.254.169.254') return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.)/.test(host)) return true;
  return false;
};

const isAllowedImageUrl = (raw: string): boolean => {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (isPrivateIp(host)) return false;
  // Allow known image hosts outright.
  if (ALLOWED_IMAGE_HOSTS.has(host)) return true;
  return false;
};

// Fetch page URLs with KV caching to avoid re-hitting the source CDN
// on every image request (prevents 429 rate-limit → 502 cascade).
const fetchPageUrlsWithCache = async (
  c: Context,
  source: string,
  chapterId: string
): Promise<{ url: string; proxyHeaders?: Record<string, string> }[]> => {
  const cacheKey = `pages:${source}:${chapterId}`;
  const cached = await cacheGet<{ url: string; proxyHeaders?: Record<string, string> }[]>(c, cacheKey);
  if (cached) return cached;

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) throw new Error('unknown source');

  const pages = await retryUpstream(() => adapter.fetchPageUrls(chapterId));
  cachePut(c, cacheKey, pages, 600);
  return pages;
};

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

// Update chapter:detail KV cache setelah upload sukses — biar request
// berikutnya dapat b2Url/r2Url langsung (KV TTL 300s, tanpa refresh).
const touchChapterDetailKv = async (
  c: Context,
  source: string,
  chapterId: string,
  pageNo: number,
  b2Accounts: B2Account[],
  r2cfg: ReturnType<typeof r2RingFor>,
  r2Key: string,
  accountIdx: number
): Promise<void> => {
  const key = `chapter:detail:${source}:${chapterId}`;
  const raw = await c.env.CACHE_KV.get(key).catch(() => null);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { data?: { pages?: Array<{ proxyUrl: string; b2Url?: string | null; r2Url?: string | null }> } };
    if (!parsed.data?.pages) return;
    const idx = pageNo - 1;
    if (idx < 0 || idx >= parsed.data.pages.length) return;
    if (accountIdx < 0) {
      const b2 = b2AccountForIdx(b2Accounts, accountIdx);
      if (b2) parsed.data.pages[idx].b2Url = await b2PresignedGet(b2, r2Key).catch(() => null);
    } else if (accountIdx >= 0 && r2cfg && r2cfg.accounts[accountIdx]) {
      parsed.data.pages[idx].r2Url = `https://${r2cfg.accounts[accountIdx].public_domain}/${r2Key}`;
    }
    await c.env.CACHE_KV.put(key, JSON.stringify(parsed), { expirationTtl: 300 }).catch(() => {});
  } catch { /* corrupt cache → ignore, next refresh repopulates */ }
};

// Upload gambar ke storage tier (background) + catat D1. Idempoten:
// key sama → overwrite sama. Race 2 request paralel aman.
// Tier: B2-A (idx=-1) → B2-B (idx=-2) → R2 ring (idx>=0).
// Round-robin: coba B2-A dulu, kalau fail → B2-B, kalau fail → R2.
// Semua gagal → response user tetap jalan (proxy only).
const uploadToStorage = async (c: Context, opts: { source: string; slug: string; chapterId: string; pageNo: number; imageUrl: string; contentType: string; body: ReadableStream | ArrayBuffer }): Promise<void> => {
  const r2Key = r2KeyFor(opts.source, opts.slug, opts.chapterId, opts.pageNo);
  const b2Accounts = parseB2Accounts(c.env.B2_CONFIG ?? c.env.B2_ACCOUNTS);
  const cfg = r2RingFor(c);

  // Try B2 accounts in order (B2-A → B2-B → ...).
  for (let i = 0; i < b2Accounts.length; i++) {
    const b2 = b2Accounts[i];
    const accountIdx = -(i + 1); // -1, -2, ...
    try {
      const res = await b2PutObject(b2, r2Key, opts.body as ArrayBuffer, opts.contentType);
      if (res.ok) {
        await getDb(c).markPageR2Uploaded({
          chapterId: opts.chapterId,
          pageNumber: opts.pageNo,
          imageUrl: opts.imageUrl,
          r2Key,
          r2AccountIdx: accountIdx,
        });
        await touchChapterDetailKv(c, opts.source, opts.chapterId, opts.pageNo, b2Accounts, cfg, r2Key, accountIdx);
        return;
      }
      console.error(`[b2:${b2.name}] upload ${res.status} → next tier: ${opts.source}/${opts.slug}/${opts.chapterId}/${opts.pageNo}`);
    } catch (e) {
      console.error(`[b2:${b2.name}] upload failed → next tier: ${String(e)}`);
    }
  }

  // R2 ring fallback.
  try {
    if (!cfg) return; // tidak ada R2 juga → proxy-only mode
    const idx = accountFor(opts.slug, cfg.ring);
    const account = cfg.accounts[idx];
    const res = await s3PutObject(account, r2Key, opts.body, opts.contentType);
    await drainResponse(res);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`r2 upload ${res.status} ${detail.slice(0, 200)}`);
    }
    await getDb(c).markPageR2Uploaded({
      chapterId: opts.chapterId,
      pageNumber: opts.pageNo,
      imageUrl: opts.imageUrl,
      r2Key,
      r2AccountIdx: idx,
    });
    await touchChapterDetailKv(c, opts.source, opts.chapterId, opts.pageNo, b2Accounts, cfg, r2Key, idx);
  } catch (e) {
    console.error(`[r2] upload failed [${opts.source}/${opts.slug}/${opts.chapterId}/${opts.pageNo}]:`, String(e));
  }
};

// Consolidated series detail + chapters in a single Worker invocation.
// GET /api/reader/:source/series/:sourceId/detail?lang=id
// Returns { data: { ...series, chapters: [...] } } cached under one KV key,
// halving the Worker + KV-read cost vs separate getSeries + getChapters calls.
router.get('/:source/series/:sourceId/detail', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const lang = c.req.query('lang') || 'id';
  const cacheKey = `series:full:${source}:${sourceId}:${lang}`;
  const cached = await cacheGet<{ data: { chapters: unknown[] } & Record<string, unknown> }>(c, cacheKey);
  if (cached) {
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    return c.json(cached);
  }

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const [series, chapters] = await Promise.all([
      retryUpstream(() => adapter.getSeries(sourceId)),
      retryUpstream(() => adapter.listChapters(sourceId, { lang })),
    ]);
    const data = { ...series, chapters };
    cachePut(c, cacheKey, { data }, 600);
    recordHealth(c, source, start, true);
    c.header('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    // Index chapterId → slug (KV 1 jam) supaya R2 cache-aside bisa resolve
    // slug dari chapterId (thrive pakai uuid yang tidak bisa di-parse).
    c.executionCtx.waitUntil(
      (async () => {
        for (const ch of chapters) {
          try { await cachePut(c, `slug:${ch.id}`, series.slug, 3600); } catch { /* best-effort */ }
        }
      })()
    );
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Series detail: GET /api/reader/:source/series/:sourceId
router.get('/:source/series/:sourceId', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `series:detail:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const data = await retryUpstream(() => adapter.getSeries(sourceId));
    cachePut(c, cacheKey, { data }, 600);
    recordHealth(c, source, start, true);
    return c.json({ data });
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
  const cached = await cacheGet<{ data: unknown[] }>(c, cacheKey);
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const data = await retryUpstream(() => adapter.listChapters(sourceId, { lang }));
    cachePut(c, cacheKey, { data }, 300);
    recordHealth(c, source, start, true);
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Aggregated sources for a manga: GET /api/reader/:source/series/:sourceId/sources
// 1) Uses manga_source_link aggregation (D1) when rows exist.
// 2) Fallback (live-resolve): searches the OTHER sources for the same title so
//    the source switcher works even before any scrape has persisted rows.
router.get('/:source/series/:sourceId/sources', async (c: Context) => {
  const { source, sourceId } = c.req.param();
  const cacheKey = `sources:${source}:${sourceId}`;
  const cached = await cacheGet<{ data: unknown }>(c, cacheKey);
  if (cached) return c.json(cached);

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

    let links: Array<{ source: string; sourceSlug: string; hasChapterList: boolean; chapterCount: number }> = [];
    let canonicalSlug: string | null = null;
    if (canonicalId) {
      const rows = await db.getSourceLinksByManga(canonicalId);
      links = rows.map((l) => ({ source: l.source, sourceSlug: l.source_slug, hasChapterList: l.has_chapter_list === 1, chapterCount: l.chapter_count }));
      const canonicalRow = await c.env.DB.prepare('SELECT slug FROM series WHERE id = ?1').bind(canonicalId).first<{ slug: string }>();
      canonicalSlug = canonicalRow?.slug ?? null;
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
            (['komiku', 'bacakomik', 'manhwaindo', 'thrive'] as const)
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

          // Auto-index (background, best-effort): persist resolved links to D1
          // so the aggregation index builds itself from user activity without
          // needing manual scrape jobs. The current source's series row is the
          // canonical entry.
          c.executionCtx.waitUntil((async () => {
            try {
              const slug = series!.slug || sourceId;
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
                source_url: (series as unknown as Record<string, unknown>).source_url as string ?? null,
                language: (series as unknown as Record<string, unknown>).language as string ?? null,
              });
              const row = await c.env.DB.prepare('SELECT id FROM series WHERE slug = ?1 LIMIT 1').bind(slug).first<{ id: number }>();
              if (!row) return;
              await db.upsertSourceLink({
                mangaId: row.id,
                source,
                sourceSlug: sourceId,
                hasChapterList: 1,
                chapterCount: 0,
                lastScrapedAt: Math.floor(Date.now() / 1000),
              });
              for (const r of resolved) {
                await db.upsertSourceLink({
                  mangaId: row.id,
                  source: r.source,
                  sourceSlug: r.sourceSlug,
                  hasChapterList: r.hasChapterList ? 1 : 0,
                  chapterCount: r.chapterCount,
                  lastScrapedAt: Math.floor(Date.now() / 1000),
                });
              }
            } catch (e) { console.error('[sources] auto-index failed:', String(e)); }
          })());
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
    };
    cachePut(c, cacheKey, { data }, 600);
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
  if (cached) return c.json(cached);

  const adapter = getAdapter(source, c.env as unknown as AdapterEnv);
  if (!adapter) return c.json({ error: 'unknown source' }, 404);
  const start = Date.now();
  try {
    const chapter = await retryUpstream(() => adapter.getChapter(chapterId));
    const pages = await fetchPageUrlsWithCache(c, source, chapterId);
    const proxyBase = `/api/reader/${source}/page/${encodeURIComponent(chapterId)}`;
    // Storage lookup: object yang sudah di-upload → URL langsung (B2 presigned
    // atau R2 public domain) biar serve tidak lewat Worker. r2_account_idx=-1
    // = B2, >=0 = akun R2 ring. Object new → null → frontend pakai proxy
    // (yang sekaligus meng-upload → request berikutnya dapat URL langsung).
    const stored = await c.env.DB.prepare(
      'SELECT page_number, r2_key, r2_account_idx FROM chapter_pages WHERE chapter_id = ?1'
    ).bind(chapterId).all<{ page_number: number; r2_key: string; r2_account_idx: number }>().catch(() => null);
    const storedByPage = new Map<number, { r2Key: string; accountIdx: number }>();
    for (const row of stored?.results ?? []) storedByPage.set(row.page_number, { r2Key: row.r2_key, accountIdx: row.r2_account_idx });
    const b2Accounts = parseB2Accounts(c.env.B2_CONFIG ?? c.env.B2_ACCOUNTS);
    const r2cfg = r2RingFor(c);
    const data = {
      ...chapter,
      // B2 presign & R2 domain resolve per page — Promise.all biar paralel.
      pages: await Promise.all(pages.map(async (_, i) => {
        const pageNo = i + 1;
        const row = storedByPage.get(pageNo);
        let b2Url: string | null = null;
        let r2Url: string | null = null;
        if (row) {
          if (row.accountIdx < 0) {
            const b2 = b2AccountForIdx(b2Accounts, row.accountIdx);
            if (b2) b2Url = await b2PresignedGet(b2, row.r2Key).catch(() => null);
          } else if (row.accountIdx >= 0 && r2cfg && r2cfg.accounts[row.accountIdx]) {
            r2Url = `https://${r2cfg.accounts[row.accountIdx].public_domain}/${row.r2Key}`;
          }
        }
        return { proxyUrl: `${proxyBase}/${pageNo}`, b2Url, r2Url };
      })),
    };
    // LRU touch: update last_access untuk pages yang diakses (background).
    c.executionCtx.waitUntil((async () => {
      for (let i = 0; i < pages.length; i++) {
        await getDb(c).touchPageLastAccess(chapterId, i + 1).catch(() => {});
      }
      // Eviction trigger: every 100th chapter detail request, run LRU evict.
      const tickRaw = await c.env.CACHE_KV.get('eviction:tick').catch(() => '0');
      const tick = (Number(tickRaw) || 0) + 1;
      c.executionCtx.waitUntil(c.env.CACHE_KV.put('eviction:tick', String(tick)).catch(() => {}));
      if (tick % 100 === 0) {
        c.executionCtx.waitUntil(evictStaleStorage(c.env).catch(() => {}));
      }
    })());
    cachePut(c, cacheKey, { data }, 300);
    recordHealth(c, source, start, true);
    return c.json({ data });
  } catch (e) {
    recordHealth(c, source, start, false, String(e));
    return c.json({ error: 'upstream resolve failed', detail: String(e) }, 502);
  }
});

// Image proxy: GET /api/reader/:source/page/:chapterId/:pageNo
router.get('/:source/page/:chapterId/:pageNo', async (c: Context) => {
  const { source, chapterId, pageNo } = c.req.param();
  const n = Number(pageNo);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return c.json({ error: 'bad page number' }, 400);

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

  // Source CDNs occasionally fail transiently (502/503/connection reset).
  // reset). Retry up to 2 times (reduced from 3 to cap CPU time) before
  // surfacing the error. Only accept HTTP 200.
  let upstream: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(page.url, {
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
      if (r.status === 200) { upstream = r; break; }
      // Non-2xx: drain the body before retrying so the subrequest (bounded by
      // the 6-concurrent-fetch limit) is released. Un-drained bodies keep the
      // fetch "in flight" and can trip CF's deadlock-avoidance cancellation.
      await drainResponse(r);
      // 3xx/4xx/5xx → retry
    } catch {
      // network error → retry
    }
    if (attempt < 1) await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
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

  // Cache-aside R2 (semua source — komiku + bacakomik + thrive + manhwaindo):
  // clone stream SEBELUM Response dibuat — setelah `new Response(upstream.body)`
  // stream terkunci dan clone() melempar "ReadableStream locked to a reader".
  // Upload di background; request berikutnya diserve langsung dari R2 tanpa
  // lewat Worker. Upload idempoten (key sama → overwrite).
  // Buffer body (bukan stream): PUT stream tanpa Content-Length ditolak R2
  // (411 Length Required) untuk sebagian upstream — gambar chapter kecil,
  // buffer aman di limit 128MB.
  const slug = await resolveKomikuSlug(c, chapterId);
  let r2Upload: Promise<void> | null = null;
  if (slug) {
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = await new Response(upstream.clone().body).arrayBuffer();
    if (buf.byteLength > 0) {
      r2Upload = uploadToStorage(c, { source, slug, chapterId, pageNo: n, imageUrl: page.url, contentType, body: buf }).catch(() => {});
    }
  }

  const response = new Response(upstream.body, { status: 200, headers });

  // Store in Cloudflare edge cache for subsequent requests
  if (typeof caches !== 'undefined') {
    const cache = (caches as unknown as { default: Cache }).default;
    c.executionCtx.waitUntil(cache.put(c.req.raw, response.clone()).catch(() => {}));
  }

  if (r2Upload) c.executionCtx.waitUntil(r2Upload);

  return response;
});
