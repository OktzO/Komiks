import type { MiddlewareHandler } from 'hono';
import type { Env } from './context';
import { allowedOriginFor } from './context';
import { constantTimeEqualStr } from './auth';
import { verifyTurnstile } from './turnstile';

// ── BFF service-token gate (API hardening) ──────────────────────────────────
//
// Gap antara web SSR (manga-web) dan worker API: worker API melayani request
// ke luar (browser). Browser sah punya Origin allowlisted / session cookie;
// bot tidak. Web SSR memanggil /api/* dengan header `x-service-token` (secret
// bersama, nilai SAMA di web worker + semua worker API). Gate ini membaca
// header itu dan menolak request tanpa jalur sah:
//
//   EXEMPT      → /api/health, /api/origins, /api/auth/* (OAuth/login),
//                 /api/_internal/* (pk DB forward-key, worker-only),
//                 /api/scrape (sudah requireAdminKey), /img/* (hotlink guard
//                 sendiri), legacy page-proxy /api/reader/:source/page/...
//   PUBLIC-READ → /api/search*, /api/series*, /api/homepage, /api/reader*
//                 (non-page), /api/manga, /api/source-status, GET /api/user/*
//                 = service token ATAU Origin allowlisted ATAU session cookie
//   SENSITIVE   → /api/resolve, /api/identify, /api/admin/*, mutasi
//                 /api/user/*
//                 = service token ATAU session cookie ATAU Turnstile valid
//   DENY        → /api/* lain yang tidak dikenal → 403
//
// JANGAN diperlemah: corsMw (CSRF guard), rate limiters, AES-GCM, login
// Turnstile tetap jalan. OPTIONS preflight di-short-circuit corsMw sebelum
// sampai ke sini; /img/* & /api/_internal/* sudah ter-routing lebih dulu di
// index.ts sehingga tidak pernah masuk gate (classify tetap exempt sbg
// belt-and-suspenders).
//
// Fail-open saat SERVICE_TOKEN BELUM di-set (dev / sebelum secret deploy):
// sekresi belum ada → tidak ada yang bisa diverifikasi, gate dilewati dengan
// warning sekali per isolate. Konsisten dgn verifyTurnstile (unset → fail-open,
// dev-friendly). PRODUKSI WAJIB set SERVICE_TOKEN di semua worker API + web
// worker — kalau lupa, warning ini (dan deploy runbook) yang menandai.

export type ServiceTier = 'exempt' | 'public-read' | 'sensitive' | 'deny';

const LEGACY_PAGE_PROXY_RE = /^\/api\/reader\/[^/]+\/page\/[^/]+\/\d+$/;

// Pure classifier — dipakai unit test langsung (tanpa context).
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
    path.startsWith('/img/') ||
    (m === 'GET' && LEGACY_PAGE_PROXY_RE.test(path))
  ) {
    return 'exempt';
  }
  if (
    path.startsWith('/api/resolve') ||
    path.startsWith('/api/identify') ||
    path.startsWith('/api/admin') ||
    (path.startsWith('/api/user') && m !== 'GET' && m !== 'HEAD')
  ) {
    return 'sensitive';
  }
  if (
    path.startsWith('/api/search') ||
    path.startsWith('/api/series') ||
    path.startsWith('/api/reader') ||
    path.startsWith('/api/homepage') ||
    path.startsWith('/api/manga') ||
    path.startsWith('/api/source-status') ||
    (path.startsWith('/api/user') && m === 'GET')
  ) {
    return 'public-read';
  }
  return 'deny';
};

export interface ServiceGateInput {
  hasServiceToken: boolean;
  isExempt: boolean;
  hasValidOrigin: boolean;
  hasSessionCookie: boolean;
  requiresTurnstile: boolean;
  turnstileOk: boolean;
}

export type ServiceGateDecision = 'allow' | 'deny';

// Pure decision — dipakai unit test langsung.
export const decideServiceGate = (input: ServiceGateInput): ServiceGateDecision => {
  if (input.isExempt) return 'allow';
  if (input.hasServiceToken) return 'allow';
  if (!input.requiresTurnstile) {
    // public-read: Origin allowlist (browser tamu) ATAU session cookie.
    return input.hasValidOrigin || input.hasSessionCookie ? 'allow' : 'deny';
  }
  // sensitive: session cookie (login terbukti) ATAU Turnstile valid (tamu).
  return input.hasSessionCookie || input.turnstileOk ? 'allow' : 'deny';
};

let warnedUnsetToken = false;

export const serviceGateMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  try {
    const tier = classifyServiceTier(c.req.path, c.req.method);
    if (tier === 'exempt') return next();

    const expected = (c.env.SERVICE_TOKEN as string | undefined)?.trim() ?? '';
    const supplied = c.req.header('x-service-token');
    const hasServiceToken = !!expected && !!supplied && constantTimeEqualStr(supplied, expected);

    if (!expected) {
      if (!warnedUnsetToken) {
        warnedUnsetToken = true;
        console.warn(
          '[serviceGate] SERVICE_TOKEN belum di-set di worker ini — gate TIDAK AKTIF (fail-open, dev-friendly). ' +
            'PRODUKSI: set SERVICE_TOKEN (nilai sama di web + semua worker API) via `wrangler secret put` sebelum deploy.'
        );
      }
      return next();
    }

    const hasValidOrigin = tier === 'public-read' && allowedOriginFor(c.env, c.req.header('origin')) !== null;
    const hasSessionCookie = (c.req.header('cookie') ?? '').includes('__Host-session=');

    let turnstileOk = false;
    if (tier === 'sensitive' && !hasServiceToken && !hasSessionCookie) {
      const tok = c.req.query('turnstile_token') ?? c.req.header('x-turnstile-token') ?? undefined;
      // Tanpa token → jangan telepon siteverify (fail-closed utk tamu tanpa
      // token). Secret unset (dev) + token ada → verifyTurnstile return true.
      if (tok) turnstileOk = await verifyTurnstile(c, tok, c.req.header('cf-connecting-ip') ?? undefined);
    }

    const decision = decideServiceGate({
      hasServiceToken,
      isExempt: false,
      hasValidOrigin,
      hasSessionCookie,
      requiresTurnstile: tier === 'sensitive',
      turnstileOk,
    });

    if (decision === 'allow') return next();
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'forbidden' }, 403);
  } catch (e) {
    // Jangan pernah crash pipeline karena gate ini — log + fail OPEN.
    // Availability diutamakan; anti-abuse tetap dijaga corsMw/rate-limiter.
    console.error('[serviceGate] unexpected error, failing open:', e);
    return next();
  }
};