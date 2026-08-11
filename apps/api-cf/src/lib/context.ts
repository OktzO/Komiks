import { Context as HonoContext } from 'hono';
import type { D1Database, KVNamespace, R2Bucket, Fetcher } from '@cloudflare/workers-types';
import { db } from '@manga-platform/db';
import type { Db } from '@manga-platform/db';

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  ASSETS_R2: R2Bucket;
  MY_BROWSER: Fetcher;
  LB_ENCRYPTION_KEY: string;
  ALLOWED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ADMIN_PASSWORD_HASH?: string;
   ADMIN_PASSWORD?: string;
   ADMIN_EMAILS?: string;
   SCRAPE_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  R2_ACCOUNTS?: string;
  R2_RING_VNODES?: string;
  R2_EVICTION_DAYS?: string;
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

// Match origin against allowlist. Entries may use a `*.` prefix to allow any
// subdomain (e.g. `https://*.manga-web-d32.pages.dev` — CF Pages preview URLs).
const originMatches = (allowed: string, origin: string): boolean => {
  const starIdx = allowed.indexOf('://*.');
  if (starIdx >= 0) {
    const scheme = allowed.slice(0, starIdx + 3); // "https://"
    const suffix = allowed.slice(starIdx + 5); // ".example.com"
    if (!origin.startsWith(scheme) || origin.length <= scheme.length + suffix.length) return false;
    return origin.endsWith(suffix);
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
