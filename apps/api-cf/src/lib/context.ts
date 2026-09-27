import { Context as HonoContext } from 'hono';
import type { D1Database, KVNamespace, Fetcher } from '@cloudflare/workers-types';
import { db } from '@manga-platform/db';
import type { Db } from '@manga-platform/db';

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  MY_BROWSER: Fetcher;
  LB_ENCRYPTION_KEY: string;
  AUTH_SIGNING_KEY?: string;
  AUTH_PUBLIC_KEYS?: string;
  ALLOWED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  // BFF service-token (API hardening): secret yang sama juga di-set di worker
  // web (manga-web) supaya panggilan SSR manga-web ke /api/* dikenali gate
  // di lib/serviceGate.ts. Non-PUBLIC_ → tidak pernah di-inline ke bundle.
  SERVICE_TOKEN?: string;
  // Signed image URLs (anti-scraping /img/*): HMAC short-lived signature.
  // Satu nama secret utk semua worker — nilai boleh identik lintas akun supaya
  // signed URL dari worker mana pun valid di worker mana pun (hash-routing
  // worker non-deterministik vs worker yang mint). UNSET → /img fail-open tanpa
  // signature (dev) + warning sekali, konsisten dgn SERVICE_TOKEN/Turnstile.
  SIGNED_IMG_SECRET?: string;
  ADMIN_PASSWORD_HASH?: string;
   ADMIN_PASSWORD?: string;
   ADMIN_EMAILS?: string;
   SCRAPE_API_KEY?: string;
  B2_CONFIG?: string;
  B2_ACCOUNTS?: string;
  CF_ACCOUNT_ID?: string;
  CF_WORKER_NAME?: string;
  CF_D1_ID?: string;
  CF_KV_ID?: string;
  CF_INVENTORY_TOKEN?: string;
  PEER_URLS?: string;
  PEER_INDEX?: string;
  EVICTION_OWNER?: string;
  B2_QUOTA_BYTES?: string;
  B2_EVICTION_DAYS?: string;
  DB_FORWARD_KEY?: string;
  DB_FORWARD_ENDPOINT?: string;
  DB_MIRROR_KEY?: string;
  DB_MIRROR_ENDPOINT?: string;
  // Chapter-refresh budget. Absent → the free-plan-safe defaults in
  // novelIngest.ts; set both together when moving the Workers to a paid plan
  // (see refreshWindowFor for the arithmetic).
  NOVEL_REFRESH_BUDGET?: string;
  NOVEL_REFRESH_WINDOW?: string;
  [k: string]: unknown;
}

export type Context = HonoContext<{ Bindings: Env }>;

export const getDb = (c: Context): Db => db(c.env.DB);

export const json = <T>(
  c: Context,
  data: T,
  init?: number | ResponseInit
): Response => c.json(data as never, init as never);

export const parseAllowedOrigins = (env: Env): string[] => {
  const raw = env.ALLOWED_ORIGINS;
  if (!raw) {
    // Fail closed in production — never default to an origin when unset.
    // Local dev is expected to set ALLOWED_ORIGINS=http://localhost:3000.
    return [];
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

const originMatches = (allowed: string, origin: string): boolean => {
  const starIdx = allowed.indexOf('://*.');
  if (starIdx >= 0) {
    const scheme = allowed.slice(0, starIdx + 3); // "https://"
    const bare = allowed.slice(starIdx + 5); // "example.com" (tanpa dot)
    const suffix = `.${bare}`; // ".example.com" — boundary subdomain
    if (!origin.startsWith(scheme)) return false;
    const host = origin.slice(scheme.length);
    if (host.length <= bare.length) return false;
    return host.endsWith(suffix);
  }
  return allowed === origin;
};

// Returns the request's origin if allowed, else null.
// Use on response headers; omit A-C-Allow-Origin entirely when not allowed.
export const allowedOriginFor = (env: Env, requestOrigin: string | undefined): string | null => {
  if (!requestOrigin) return null;
  const allowed = parseAllowedOrigins(env);
  return allowed.some((a) => originMatches(a, requestOrigin)) ? requestOrigin : null;
};

export const sha256Hex = async (input: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
