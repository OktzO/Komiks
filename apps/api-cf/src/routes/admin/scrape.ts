import { Hono } from 'hono';
import { getAdapter, type AdapterEnv } from '@manga-platform/sources';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminKey } from '../../lib/auth';
import { retryUpstream } from '../../lib/retry';
import { resolveB2Accounts, pickB2Account } from '../../lib/b2Config.ts';
import { b2PutObject } from '../../lib/s3Upload.ts';

export const router = new Hono<{ Bindings: Env }>();

// All scrape endpoints require admin key (applied per-route below).
// Previously used router.use('*', requireAdminKey) but the wildcard matched
// unrelated paths under the mount point — scrape is mounted at /api so the
// middleware ran for /api/admin/* too. Per-route is precise.

router.post('/scrape', requireAdminKey, async (c: Context) => {
  const body = await c.req.json().catch(() => null) as {
    source: 'komiku';
    url?: string;
    query?: string;
  } | null;
  if (!body || !body.source) {
    return json(c, { error: 'source required (komiku), plus url or query' }, 400);
  }

  const adapter = getAdapter(body.source, c.env as unknown as AdapterEnv);
  if (!adapter) return json(c, { error: 'unknown source' }, 400);

  // Create job
  const jobId = crypto.randomUUID();
  const db = getDb(c);
  await db.createScrapeJob({
    id: jobId,
    source: body.source,
    sourceUrl: body.url ?? null,
    query: body.query ?? null,
  });

  // Run async
  c.executionCtx.waitUntil((async () => {
    const startedAt = Math.floor(Date.now() / 1000);
    try {
      await db.updateScrapeJob(jobId, { status: 'running', seriesSlug: null, error: null, completedAt: null });
      // TODO(admin-monitoring): call db.upsertProviderAccount({ provider: body.source, label: body.source, status: 'healthy' }) + logScrapeJob start
      // TODO(admin-monitoring): resolve provider_account_id from lb_accounts if linked

      // Check robots.txt for URL-based scrape
      if (body.url && adapter.checkRobots) {
        const robots = await adapter.checkRobots(body.url);
        if (!robots.allowed) {
          await db.updateScrapeJob(jobId, { status: 'skipped_robots', seriesSlug: null, error: null, completedAt: Math.floor(Date.now() / 1000) });
          return;
        }
      }

      let result;
      if (body.url && adapter.scrapeUrl) {
        result = await retryUpstream(() => adapter.scrapeUrl!(body.url!));
      } else if (body.query) {
        const results = await retryUpstream(() => adapter.search({ q: body.query! }));
        if (results.length === 0) {
          await db.updateScrapeJob(jobId, { status: 'completed', seriesSlug: null, error: null, completedAt: Math.floor(Date.now() / 1000) });
          return;
        }
        const sourceId = results[0].slug || results[0].external_id;
        result = {
          series: results[0],
          chapters: await retryUpstream(() => adapter.listChapters(sourceId!, { lang: 'id' })),
          coverImageUrl: results[0].cover_image,
        };
      } else {
        await db.updateScrapeJob(jobId, { status: 'failed', seriesSlug: null, error: 'url or query required', completedAt: Math.floor(Date.now() / 1000) });
        return;
      }

      // ---- Aggregation: dedup against existing canonical series ----
      const { matchCandidate } = await import('@manga-platform/db/src/matching');
      const srcSlug = result.series.slug;

      // 1. Existing link for (source, source_slug)? → reuse canonical, skip match.
      const existing = await db.getMangaBySource(body.source, srcSlug);
      let canonicalSlug = existing?.slug ?? null;

      if (!canonicalSlug) {
        // 2. Match against all series titles.
        //    exact → auto-merge (reuse canonical row, link source to it)
        //    fuzzy ≥ 0.92 → queue for admin (row kept, admin merges manually)
        const all = await db.getAllSeriesTitles();
        const match = matchCandidate(result.series.title, all.map((s) => ({
          id: s.id,
          title: s.title,
          alt_titles: s.alt_titles ? JSON.parse(s.alt_titles) as string[] : undefined,
        })));
        if (match.type === 'exact') {
          const matched = await db.getSeriesById(match.id);
          if (matched) canonicalSlug = matched.slug;
        } else if (match.type === 'fuzzy' || match.type === 'queue') {
          await db.addMergeQueue({
            source: body.source,
            sourceSlug: srcSlug,
            title: result.series.title,
            candidateIds: match.type === 'fuzzy' ? [match.id] : match.candidateIds,
            confidence: match.type === 'fuzzy' ? match.score : match.confidence,
          });
        }
      }

      const finalSlug = canonicalSlug ?? srcSlug;
      const isNew = !canonicalSlug;

      // Upsert canonical series (keep the FIRST source's row as canonical when new).
      const altTitles = (result.series as unknown as Record<string, unknown>).alt_titles as string[] | undefined;
      await db.upsertSeries({
        slug: finalSlug,
        external_id: result.series.external_id ?? (isNew ? srcSlug : null),
        source: body.source,
        title: result.series.title,
        synopsis: result.series.synopsis ?? null,
        type: result.series.type,
        status: result.series.status ?? 'ongoing',
        author: result.series.author ?? null,
        artist: result.series.artist ?? null,
        cover_image: result.series.cover_image ?? null,
        genres: result.series.genres,
        alt_titles: altTitles?.length ? JSON.stringify(altTitles) : null,
        source_url: ((result.series as Record<string, unknown>).source_url as string) ?? null,
        language: ((result.series as Record<string, unknown>).language as string) ?? null,
      });

      // Record source link (source → canonical manga).
      const canonicalRow = await db.getSeriesBySlug(finalSlug);
      if (canonicalRow?.id) {
        await db.upsertSourceLink({
          mangaId: canonicalRow.id,
          source: body.source,
          sourceSlug: srcSlug,
          hasChapterList: result.chapters.length > 0 ? 1 : 0,
          chapterCount: result.chapters.length,
          lastScrapedAt: Math.floor(Date.now() / 1000),
        });
      }

      // Migrate chapter rows to the canonical slug when merged.
      if (!isNew && finalSlug !== srcSlug) {
        await c.env.DB.prepare('UPDATE chapters SET series_slug = ?1 WHERE series_slug = ?2')
          .bind(finalSlug, srcSlug).run();
      }

      // Fetch cover image → R2 → pHash → image_hashes
      if (result.coverImageUrl) {
        try {
          // SSRF + content-type guard: validate host is a known image CDN and
          // the response is actually an image before storing to R2.
          const coverUrl = result.coverImageUrl;
          const allowedHosts = ['img.komiku.org', 'komiku.org'];
          let coverOk = false;
          try {
            const u = new URL(coverUrl);
            const host = u.hostname.toLowerCase();
            coverOk = allowedHosts.includes(host) || host.endsWith('.komiku.org');
          } catch { coverOk = false; }
          if (!coverOk) throw new Error(`cover host not allowed: ${coverUrl}`);
          const imgRes = await retryUpstream(() => fetch(coverUrl, {
            signal: AbortSignal.timeout(10000),
          }));
          const ct = imgRes.headers.get('content-type') || '';
          if (imgRes.ok && ct.startsWith('image/')) {
            const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
            const b2Key = `covers/${result.series.slug}.jpg`;
            const b2Accounts = resolveB2Accounts(c.env.B2_CONFIG, c.env.B2_ACCOUNTS);
            if (b2Accounts.length > 0) {
              const arrBuf = imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength) as ArrayBuffer;
              const b2 = pickB2Account(b2Accounts, b2Key);
              if (b2) await b2PutObject(b2, b2Key, arrBuf, ct).catch((e) => { console.error('[scrape] cover upload failed:', String(e)); });
            }
            const { hashImage } = await import('@manga-platform/vision');
            const hash = await hashImage(imgBytes, ct);
            await db.addImageHash({ seriesSlug: result.series.slug, hash, r2Key: b2Key, imageType: 'cover' });
          } else {
            await imgRes.body?.cancel().catch(() => {});
          }
        } catch (e) {
          console.error('[scrape] cover hash failed:', e);
        }
      }

      await db.updateScrapeJob(jobId, {
        status: 'completed',
        seriesSlug: result.series.slug,
        error: null,
        completedAt: Math.floor(Date.now() / 1000),
      });
      // TODO(admin-monitoring): call db.logScrapeJob({ source: body.source, providerAccountId, status: 'success', itemsScraped: result.chapters.length, durationMs: Date.now() - startedAt*1000, startedAt, finishedAt: Math.floor(Date.now()/1000) })
    } catch (e) {
      await db.updateScrapeJob(jobId, {
        status: 'failed',
        seriesSlug: null,
        error: String(e).slice(0, 500),
        completedAt: Math.floor(Date.now() / 1000),
      });
      // TODO(admin-monitoring): call db.logScrapeJob({ source: body.source, providerAccountId, status: 'failed', errorMessage: String(e).slice(0,200), startedAt, finishedAt: Math.floor(Date.now()/1000) })
    }
  })());

  return json(c, { job_id: jobId, status: 'running' });
});

router.get('/scrape/:job_id', requireAdminKey, async (c: Context) => {
  const job = await getDb(c).getScrapeJob(c.req.param('job_id'));
  if (!job) return json(c, { error: 'job not found' }, 404);
  return json(c, { data: job });
});

router.get('/scrape', requireAdminKey, async (c: Context) => {
  const jobs = await getDb(c).listScrapeJobs(50);
  return json(c, { data: jobs });
});
