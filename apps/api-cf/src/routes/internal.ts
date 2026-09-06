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

router.use('/*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Vary', 'Authorization, Cookie');
});

const OVERFLOW_RESPONSE_STATUS = 503;

const ALLOWED_TABLES = new Set([
  'users',
  'bookmarks',
  'reading_history',
  'series',
  'series_search',
  'chapters',
  'chapter_pages',
  'manga_source_link',
  'manga_merge_queue',
  'source_health',
  'image_hashes',
  'sessions',
  'security_events',
  'db_usage_snapshot',
  'b2_usage',
  'b2_temp_objects',
]);

const QUERY_ALLOWED_TABLES = new Set([
  'chapter_pages',
  'sessions',
  'bookmarks',
  'reading_history',
  'series',
  'chapters',
  'b2_temp_objects',
  'b2_usage',
]);

const USERS_EXEC_ALLOW = [
  /^INSERT\s+INTO\s+users\s*\(\s*email\s*,\s*name\s*,\s*password_hash\s*,\s*role\s*,\s*avatar_url\s*\)\s*VALUES\s*\(\s*\?1\s*,\s*\?2\s*,\s*\?3\s*,\s*\?4\s*,\s*\?5\s*\)$/i,
  /^UPDATE\s+users\s+SET\s+avatar_url\s*=\s*\?1\s+WHERE\s+id\s*=\s*\?2\s+AND\s+\(avatar_url\s+IS\s+NULL\s+OR\s+avatar_url\s*=\s*\?3\)$/i,
  /^UPDATE\s+users\s+SET\s+role\s*=\s*\?1\s+WHERE\s+id\s*=\s*\?2$/i,
  /^UPDATE\s+users\s+SET\s+last_login_at\s*=\s*\?1\s+WHERE\s+id\s*=\s*\?2$/i,
];

const SESSIONS_EXEC_ALLOW = [
  /^INSERT\s+INTO\s+sessions\s*\(\s*sid\s*,\s*user_id\s*,\s*created_at\s*,\s*expires_at\s*,\s*ua\s*,\s*ip\s*\)\s*VALUES\s*\(\s*\?1\s*,\s*\?2\s*,\s*\?3\s*,\s*\?4\s*,\s*\?5\s*,\s*\?6\s*\)$/i,
  /^UPDATE\s+sessions\s+SET\s+revoked_at\s*=\s*\?1\s+WHERE\s+sid\s*=\s*\?2\s+AND\s+user_id\s*=\s*\?3\s+AND\s+revoked_at\s+IS\s+NULL$/i,
  /^UPDATE\s+sessions\s+SET\s+revoked_at\s*=\s*\?1\s+WHERE\s+user_id\s*=\s*\?2\s+AND\s+revoked_at\s+IS\s+NULL\s+AND\s+sid\s*!=\s*\?3$/i,
  /^UPDATE\s+sessions\s+SET\s+revoked_at\s*=\s*\?1\s+WHERE\s+user_id\s*=\s*\?2\s+AND\s+revoked_at\s+IS\s+NULL$/i,
];

const hasStackedStatements = (sql: string): boolean => {
  if (/--|\/\*/.test(sql)) return true;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { i += 2; continue; }
          break;
        }
        i++;
      }
    } else if (ch === ';') {
      return true;
    }
    i++;
  }
  return false;
};

const isWriteStatement = (sql: string): boolean =>
  /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

const containsDangerKeyword = (sql: string): boolean =>
  /\b(SELECT|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ALTER|DROP|TRUNCATE|WITH|UNION|JOIN|GLOB|LIKE\s*\(|LOAD_EXTENSION)\b/i.test(sql);

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
    return c.json({ error: 'forbidden' }, 403);
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

  if (hasStackedStatements(sql)) {
    return c.json({ error: 'forbidden statement' }, 403);
  }
  if (!isWriteStatement(sql) || containsDangerKeyword(sql)) {
    return c.json({ error: 'forbidden statement' }, 403);
  }
  const fromOk =
    table === 'series_search'
      ? true // FTS sync via trigger; jarang dipakai langsung
      : new RegExp(`\\b${table}\\b`, 'i').test(sql);
  if (!fromOk) {
    return c.json({ error: 'table mismatch' }, 403);
  }
  if (table === 'users' && !USERS_EXEC_ALLOW.some((re) => re.test(sql.trim()))) {
    return c.json({ error: 'forbidden users statement' }, 403);
  }
  if (table === 'sessions' && !SESSIONS_EXEC_ALLOW.some((re) => re.test(sql.trim()))) {
    return c.json({ error: 'forbidden sessions statement' }, 403);
  }

  // Pass the isMirror flag through to writeLocal via header on internal Request —
  // writeLocal checks c.req.header('x-db-mirror') which is preserved here.
  const result = await writeLocal(c, table, sql, params);
  if (result.ok) return c.json({ ok: true, target: 'local', mirror: isMirror, changes: result.changes ?? 0 });

  // If writeLocal returns ok=false because of size/limit, signal overflow
  if (result.error?.includes('RESOURCE_EXHAUSTED') || result.error?.includes('quota')) {
    return c.json({ error: 'overflow', detail: result.error }, OVERFLOW_RESPONSE_STATUS);
  }
  return c.json({ error: result.error ?? 'write failed' }, 500);
});

// Read-only SELECT exec for sharded reads (chapter_pages owner lookup).
// Same auth as /db/exec; enforced SELECT-only so the internal surface cannot
// be used to mutate via this path.
router.post('/db/query', async (c: Context) => {
  const forwardKey = c.req.header('x-db-forward-key');
  const mirrorKey = c.req.header('x-db-mirror-key');
  const isMirrorHeader = c.req.header('x-db-mirror') === '1';

  let authed = false;
  if (forwardKey && c.env.DB_FORWARD_KEY && constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) {
    authed = true;
  } else if (
    mirrorKey && c.env.DB_MIRROR_KEY && constantTimeEqualStr(mirrorKey, c.env.DB_MIRROR_KEY as string) && isMirrorHeader
  ) {
    authed = true;
  }
  if (!authed) return c.json({ error: 'forbidden' }, 403);

  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (contentLength > 64 * 1024) return c.json({ error: 'payload too large' }, 413);

  let payload: { sql: string; params: unknown[]; table?: string };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const { sql, params, table = 'chapter_pages' } = payload;
  if (typeof sql !== 'string' || !Array.isArray(params) || typeof table !== 'string') {
    return c.json({ error: 'missing sql/params/table' }, 400);
  }
  if (table.startsWith('_') || table === 'sqlite_sequence' || !QUERY_ALLOWED_TABLES.has(table)) {
    return c.json({ error: 'forbidden table' }, 403);
  }
  if (!/^\s*SELECT\b/i.test(sql)) {
    return c.json({ error: 'read-only endpoint' }, 403);
  }
  if (hasStackedStatements(sql)) {
    return c.json({ error: 'forbidden statement' }, 403);
  }
  if (/\b(ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ALTER|DROP|TRUNCATE|WITH|UNION|LOAD_EXTENSION)\b/i.test(sql)) {
    return c.json({ error: 'forbidden statement' }, 403);
  }
  if (/\b(users|sqlite_master|sqlite_sequence|_outbox|_migrations)\b/i.test(sql)) {
    return c.json({ error: 'forbidden table reference' }, 403);
  }
  if (table !== 'sessions' && /\bsessions\b/i.test(sql)) {
    return c.json({ error: 'forbidden table reference' }, 403);
  }
  if (table !== 'b2_temp_objects' && /\bb2_temp_objects\b/i.test(sql)) {
    return c.json({ error: 'forbidden table reference' }, 403);
  }
  if (table !== 'b2_usage' && /\bb2_usage\b/i.test(sql)) {
    return c.json({ error: 'forbidden table reference' }, 403);
  }
  if (!new RegExp(`FROM\\s+${table}\\b`, 'i').test(sql)) {
    return c.json({ error: 'table mismatch' }, 403);
  }
  try {
    const stmt = c.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const { results } = await bound.all();
    return c.json({ ok: true, results: results ?? [] });
  } catch (e) {
    return c.json({ error: 'query failed', detail: String(e) }, 500);
  }
});

// KV peer-read for cache fallback. Key allowlist enforced here (server side)
// so a leaked forward key can't dump arbitrary KV.
const KV_READ_ALLOW_PREFIXES = ['series:detail:', 'series:full:', 'chapters:list:', 'chapter:detail:'];

// Cross-account push of the 12h homepage feed. Key allowlist + forward-key
// auth, mirroring /kv/get.
const KV_WRITE_ALLOW_PREFIXES = ['homepage:feed'];

router.post('/kv/put', async (c: Context) => {
  const key = c.req.header('x-db-forward-key');
  if (!key || !c.env.DB_FORWARD_KEY || !constantTimeEqualStr(key, c.env.DB_FORWARD_KEY as string)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let payload: { key?: string; value?: string; expirationTtl?: number };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const { key: k, value, expirationTtl } = payload;
  if (typeof k !== 'string' || typeof value !== 'string' || !KV_WRITE_ALLOW_PREFIXES.some((p) => k.startsWith(p))) {
    return c.json({ error: 'key not allowed' }, 403);
  }
  if (value.length > 512 * 1024) return c.json({ error: 'payload too large' }, 413);
  await c.env.CACHE_KV.put(k, value, expirationTtl ? { expirationTtl } : undefined).catch(() => null);
  return c.json({ ok: true });
});

router.get('/kv/get', async (c: Context) => {
  const forwardKey = c.req.header('x-db-forward-key');
  const mirrorKey = c.req.header('x-db-mirror-key');
  const isMirrorHeader = c.req.header('x-db-mirror') === '1';

  let authed = false;
  if (forwardKey && c.env.DB_FORWARD_KEY && constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) {
    authed = true;
  } else if (
    mirrorKey && c.env.DB_MIRROR_KEY && constantTimeEqualStr(mirrorKey, c.env.DB_MIRROR_KEY as string) && isMirrorHeader
  ) {
    authed = true;
  }
  if (!authed) return c.json({ error: 'forbidden' }, 403);

  const key = c.req.query('key');
  if (!key || !KV_READ_ALLOW_PREFIXES.some((p) => key.startsWith(p))) {
    return c.json({ error: 'key not allowed' }, 403);
  }
  const raw = await c.env.CACHE_KV.get(key, 'json').catch(() => null);
  return c.json({ value: raw ?? null });
});
