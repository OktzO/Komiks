import type { MiddlewareHandler } from 'hono';
import type { Env } from './context';
import { constantTimeEqualStr } from './auth';

// ── Token-only service gate (API hardening) ───────────────────────────────────
//
// Supersedes versi 2026-09 yang membiarkan tiga jalur lain (Origin allowlist,
// session cookie, Turnstile). Semuanya gagal di depan serangan Origin: header
// itu bisa dipalsuin curl/Postman tanpa alat apa pun — `curl -H "Origin:
// https://oktzz.xyz"` lolos persis seperti browser sungguhan. Header yang bisa
// ditulis siapa saja bukan bukti asal request. Cookie session juga cuma "ada"
// (bukan "valid") di titik ini, dan hanya verifier ECDSA di requireSession yang
// bisa membuktikannya.
//
// Satu-satunya jalur sah selain exempt: `x-service-token`, secret yang hanya
// dimiliki worker manga-web. Browser tidak pernah memegang token — semua
// panggilan browser masuk lewat proxy BFF di manga-web (`/api/[...path].ts`).
//
// EXEMPT (sudah punya credential sendiri, bukan butuh token web):
//   /api/_internal/*  → x-db-forward-key / x-db-mirror-key
//   /api/scrape*      → requireAdminKey (x-admin-api-key)
//   /img/*            → signature HMAC; tag <img> tak bisa membawa header
//   /api/health       → health-check load balancer, bukan data
//   /api/origins      → daftar origin publik, bukan data
//   /api/auth/*       → OAuth: state cookie ECDSA + Turnstile, callback dari Google
//   OPTIONS           → preflight
//
// Fail-open saat SERVICE_TOKEN belum di-set: dev lokal tidak boleh rusak. Semua
// worker produksi sudah terpasang (diverifikasi 2026-10-02).

export type ServiceTier = 'exempt' | 'deny';

export const classifyServiceTier = (path: string, method: string): ServiceTier => {
  const m = method.toUpperCase();
  // HEAD tidak dikecualikan. Dulu ia bersama OPTIONS karena corsMw
  // menyingkat preflight; middleware itu sudah dihapus (2026-10-02) jadi tidak
  // ada lagi alasan, dan Hono tetap menjalankan handler GET untuk HEAD: body-nya
  // dibuang tapi status dan efek sampingnya jalan, sehingga ia berubah dari
  // keputusan gate jadi oracle otorisasi level route.
  if (m === 'OPTIONS') return 'exempt';
  if (
    path === '/api/health' ||
    path === '/api/origins' ||
    path === '/api/auth' ||
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/_internal') ||
    path.startsWith('/api/scrape') ||
    path === '/img' ||
    path.startsWith('/img/')
  ) {
    return 'exempt';
  }
  return 'deny';
};

export interface ServiceGateInput {
  hasServiceToken: boolean;
  isExempt: boolean;
}

export type ServiceGateDecision = 'allow' | 'deny';

// Pure decision — dipakai unit test langsung.
export const decideServiceGate = (input: ServiceGateInput): ServiceGateDecision => {
  if (input.isExempt) return 'allow';
  return input.hasServiceToken ? 'allow' : 'deny';
};

let warnedUnsetToken = false;

export const serviceGateMw: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  try {
    if (classifyServiceTier(c.req.path, c.req.method) === 'exempt') return next();

    const expected = (c.env.SERVICE_TOKEN as string | undefined)?.trim() ?? '';
    if (!expected) {
      if (!warnedUnsetToken) {
        warnedUnsetToken = true;
        console.warn(
          '[serviceGate] SERVICE_TOKEN belum di-set di worker ini — gate TIDAK AKTIF (fail-open). ' +
            'PRODUKSI: set SERVICE_TOKEN (nilai sama di web + semua worker API) via `wrangler secret put`.'
        );
      }
      return next();
    }

    const supplied = c.req.header('x-service-token');
    const hasServiceToken = !!supplied && constantTimeEqualStr(supplied, expected);
    const decision = decideServiceGate({ hasServiceToken, isExempt: false });

    if (decision === 'allow') return next();
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'forbidden' }, 403);
  } catch (e) {
    // Jangan pernah crash pipeline karena gate ini — log + fail OPEN.
    console.error('[serviceGate] unexpected error, failing open:', e);
    return next();
  }
};
