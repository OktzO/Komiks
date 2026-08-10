import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { writeLocal } from '../lib/dbWrite';
import { constantTimeEqualStr } from '../lib/auth';

// Internal endpoint for cross-account D1 write forwarding.
//
// Two auth modes:
//   1. Primary write: x-db-forward-key = DB_FORWARD_KEY (one account writes
//      to the other as primary storage)
//   2. Mirror write: x-db-mirror-key = DB_MIRROR_KEY + x-db-mirror: 1
//      (read-consistency replication; receiver does NOT mirror back)
//
// Body: { sql: string, params: unknown[], table: string, bytes: number }
//
// Returns 200 on success, 503 on overflow (caller should fall back to its
// own DB), 401/400 on auth/validation errors.

export const router = new Hono<{ Bindings: Env }>();

const OVERFLOW_RESPONSE_STATUS = 503;

// Tables the cross-account forward is allowed to write to. Anything else
// (especially users.role updates) requires going through the public API
// which has its own auth + audit trail.
const ALLOWED_TABLES = new Set([
  'users',
  'bookmarks',
  'reading_history',
  'series',
  'series_search',
  'chapters',
  'chapter_pages',
  'source_link',
  'source_health',
  'image_hashes',
]);

router.post('/db/exec', async (c: Context) => {
  const forwardKey = c.req.header('x-db-forward-key');
  const mirrorKey = c.req.header('x-db-mirror-key');
  const isMirrorHeader = c.req.header('x-db-mirror') === '1';

  let isPrimary = false;
  let isMirror = false;

  if (forwardKey && c.env.DB_FORWARD_KEY && constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) {
    isPrimary = true;
  } else if (
    mirrorKey && c.env.DB_MIRROR_KEY && constantTimeEqualStr(mirrorKey, c.env.DB_MIRROR_KEY as string) && isMirrorHeader
  ) {
    isMirror = true;
  }

  if (!isPrimary && !isMirror) {
    return c.json({ error: 'invalid forward key' }, 401);
  }

  // Cap payload size to prevent memory exhaustion (Worker 128MB limit)
  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (contentLength > 64 * 1024) {
    return c.json({ error: 'payload too large' }, 413);
  }

  let payload: { sql: string; params: unknown[]; table: string; bytes?: number };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }

  const { sql, params, table } = payload;
  if (typeof sql !== 'string' || !Array.isArray(params) || typeof table !== 'string') {
    return c.json({ error: 'missing sql/params/table' }, 400);
  }

  // Refuse writes to internal/unallowed tables
  if (table.startsWith('_') || table === 'sqlite_sequence' || !ALLOWED_TABLES.has(table)) {
    return c.json({ error: 'forbidden table' }, 403);
  }

  // Pass the isMirror flag through to writeLocal via header on internal Request —
  // writeLocal checks c.req.header('x-db-mirror') which is preserved here.
  const result = await writeLocal(c, table, sql, params);
  if (result.ok) return c.json({ ok: true, target: 'local', mirror: isMirror });

  // If writeLocal returns ok=false because of size/limit, signal overflow
  if (result.error?.includes('RESOURCE_EXHAUSTED') || result.error?.includes('quota')) {
    return c.json({ error: 'overflow', detail: result.error }, OVERFLOW_RESPONSE_STATUS);
  }
  return c.json({ error: result.error ?? 'write failed' }, 500);
});
