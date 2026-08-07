import { Hono } from 'hono';
import { getAdapter } from '@manga-platform/sources';
import type { Env, Context } from '../../lib/context';
import { getDb, json } from '../../lib/context';
import { requireAdminKey } from '../../lib/auth';
import { retryUpstream } from '../../lib/retry';

export const router = new Hono<{ Bindings: Env }>();

// All scrape endpoints require admin key
router.use('*', requireAdminKey);

router.post('/scrape', async (c: Context) => {
  const body = await c.req.json().catch(() => null) as {
    source: 'komiku';
    url?: string;
    query?: string;
  } | null;
  if (!body || !body.source) {
    return json(c, { error: 'source required (komiku), plus url or query' }, 400);
  }

  const adapter = getAdapter(body.source, c.env);
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
    try {
      await db.updateScrapeJob(jobId, { status: 'running', seriesSlug: null, error: null, completedAt: null });

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

      // Upsert series + chapters to D1
      await db.upsertSeries({
        slug: result.series.slug,
        external_id: result.series.external_id ?? null,
        source: body.source,
        title: result.series.title,
        synopsis: result.series.synopsis ?? null,
        type: result.series.type,
        status: result.series.status ?? 'ongoing',
        author: result.series.author ?? null,
        artist: result.series.artist ?? null,
        cover_image: result.series.cover_image ?? null,
        genres: result.series.genres,
        source_url: ((result.series as Record<string, unknown>).source_url as string) ?? null,
        language: ((result.series as Record<string, unknown>).language as string) ?? null,
      });

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
            const r2Key = `covers/${result.series.slug}.jpg`;
            await c.env.ASSETS_R2.put(r2Key, imgBytes);
            const { hashImage } = await import('@manga-platform/vision');
            const hash = await hashImage(imgBytes, ct);
            await db.addImageHash({ seriesSlug: result.series.slug, hash, r2Key, imageType: 'cover' });
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
    } catch (e) {
      await db.updateScrapeJob(jobId, {
        status: 'failed',
        seriesSlug: null,
        error: String(e).slice(0, 500),
        completedAt: Math.floor(Date.now() / 1000),
      });
    }
  })());

  return json(c, { job_id: jobId, status: 'running' });
});

router.get('/scrape/:job_id', async (c: Context) => {
  const job = await getDb(c).getScrapeJob(c.req.param('job_id'));
  if (!job) return json(c, { error: 'job not found' }, 404);
  return json(c, { data: job });
});

router.get('/scrape', async (c: Context) => {
  const jobs = await getDb(c).listScrapeJobs(50);
  return json(c, { data: jobs });
});
