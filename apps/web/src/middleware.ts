import type { MiddlewareHandler } from 'astro';
import { env as runtimeEnv } from 'cloudflare:workers';
import { apiCspHosts } from './lib/api';

// _headers file hanya diproses lapisan static assets — response SSR (worker)
// butuh header di-set sendiri. Middleware ini jalan utk SEMUA request SSR;
// asset statis tetap pakai public/_headers. (Duplikasi CSP keduanya = by design,
// jangan disatukan — layer beda.)
//
// connect-src API derived dari PUBLIC_API_ORIGINS (lib/api). public/_headers
// adalah static (tidak bisa template) → HARUS di-sync manual saat var berubah.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  `connect-src 'self' ${apiCspHosts().join(' ')} https://cloudflareinsights.com https://challenges.cloudflare.com`,
  "frame-src https://challenges.cloudflare.com",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': CSP,
};

// /api ikut no-store: proxy BFF meneruskan respons per-user (bookmark, /me,
// admin) dan cache edge 300s di sini akan menahan satu respons untuk visitor
// berikutnya. Worker API punya noStoreMw sendiri untuk prefix yang sama; ini
// lapisan kedua, di sisi yang berbeda.
const NO_STORE = ['/api', '/bookmark', '/history', '/profile', '/login', '/admin'];

// Edge cache for the anonymous read paths. Every SSR page pays two sequential
// upstream round trips (origins lookup, then the payload), which is where the
// 1.1s TTFB came from; upstream is already KV-cached for 12-24h, so serving the
// rendered HTML from the edge for a few minutes costs nothing in freshness and
// takes the origin out of the read path entirely.
//
// Cookie-bearing requests are never cached: the detail/reader routes read the
// `src-prefs` cookie to pick a source, so one visitor's HTML is not another's.
// Same rule as `Vary: Cookie` — which the Workers cache does not implement, so
// it is enforced here instead.
const EDGE_TTL_S = 300;
// `caches.default` only exists in the Workers runtime; guarded so a non-Worker
// target (dev server, tests) renders uncached instead of throwing.
const edgeCache = (): Cache | null => {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
};

export const onRequest: MiddlewareHandler = async (context, next) => {
  // Expose SERVICE_TOKEN (secret binding worker) ke lib SSR via globalThis —
  // soal reading env runtime utk serviceHeaders() di api.ts. Astro>=6 tidak
  // menyediakan locals.runtime.env; pakai cloudflare:workers.
  const rt = runtimeEnv as { SERVICE_TOKEN?: string };
  (globalThis as { __SERVICE_TOKEN__?: string }).__SERVICE_TOKEN__ = rt.SERVICE_TOKEN;

  const p = context.url.pathname;
  const noStore = NO_STORE.some((s) => p === s || p.startsWith(s + '/'));
  const cacheable =
    context.request.method === 'GET' &&
    !noStore &&
    !context.request.headers.has('cookie') &&
    context.url.search.length > 0 === false; // query pages vary by query string

  const cache = cacheable ? edgeCache() : null;
  if (cache) {
    const hit = await cache.match(context.request).catch(() => undefined);
    if (hit) return hit;
  }

  const res = await next();
  for (const [k, v] of Object.entries(SECURITY)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  if (noStore) {
    res.headers.set('Cache-Control', 'no-store');
  } else if (!res.headers.has('cache-control')) {
    res.headers.set('Cache-Control', `public, s-maxage=${EDGE_TTL_S}, stale-while-revalidate=86400`);
  }
  // Only a complete, cacheable answer goes in: a 404 or a 5xx is this origin's
  // state right now, not the next five minutes'.
  if (cache && res.status === 200 && !res.headers.has('set-cookie')) {
    const stored = new Response(res.body, res);
    stored.headers.set('Cache-Control', `public, s-maxage=${EDGE_TTL_S}, stale-while-revalidate=86400`);
    // Kegagalan cache.put tidak boleh menggagalkan render — respons sudah
    // benar, hanya saja tidak akan tersimpan untuk kunjungan berikutnya.
    await cache.put(context.request, stored).catch(() => {});
  }
  return res;
};