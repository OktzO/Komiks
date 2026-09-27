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
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

const NO_STORE = ['/bookmark', '/history', '/profile', '/login', '/admin'];

export const onRequest: MiddlewareHandler = async (context, next) => {
  // Expose SERVICE_TOKEN (secret binding worker) ke lib SSR via globalThis —
  // soal reading env runtime utk serviceHeaders() di api.ts. Astro>=6 tidak
  // menyediakan locals.runtime.env; pakai cloudflare:workers.
  const rt = runtimeEnv as { SERVICE_TOKEN?: string };
  (globalThis as { __SERVICE_TOKEN__?: string }).__SERVICE_TOKEN__ = rt.SERVICE_TOKEN;
  const res = await next();
  for (const [k, v] of Object.entries(SECURITY)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  const p = context.url.pathname;
  if (NO_STORE.some((s) => p === s || p.startsWith(s + '/'))) {
    res.headers.set('Cache-Control', 'no-store');
  }
  return res;
};
