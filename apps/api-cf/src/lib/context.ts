import { Context as HonoContext } from 'hono';
import type { D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import { db } from '@manga-platform/db';
import type { Db } from '@manga-platform/db';

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  ASSETS_R2: R2Bucket;
  LB_ENCRYPTION_KEY: string;
  ALLOWED_ORIGINS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MANGADEX_API_KEY?: string;
  ADMIN_PASSWORD_HASH?: string;
  CF_ACCOUNT_ID?: string;
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
  const list = (raw ? raw.split(',') : ['http://localhost:3000'])
    .map((s) => s.trim())
    .filter(Boolean);
  return list;
};

export const sha256Hex = async (input: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
