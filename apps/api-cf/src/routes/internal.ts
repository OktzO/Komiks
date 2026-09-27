import { Hono } from 'hono';
import { PeerInventorySchema, type PeerInventory } from '@manga-platform/shared/types';
import type { Env, Context } from '../lib/context';
import { getDb } from '../lib/context';
import { collectPeerInventory } from '../lib/adminInventory';
import { getTopology } from '../lib/peers';
import { writeLocal } from '../lib/dbWrite';
import { FILL_GAPS_SQL, NOVEL_DETAIL_COLUMNS, UPSERT_SERIES_SQL, type DetailColumn } from '../lib/novelIngest';
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
const INVENTORY_CACHE_TTL = 300;
const INVENTORY_MAX_BODY_BYTES = 1024;

const hasInternalAuth = (c: Context): boolean => {
  const forwardKey = c.req.header('x-db-forward-key');
  if (forwardKey && c.env.DB_FORWARD_KEY && constantTimeEqualStr(forwardKey, c.env.DB_FORWARD_KEY as string)) return true;
  const mirrorKey = c.req.header('x-db-mirror-key');
  return Boolean(
    mirrorKey
    && c.env.DB_MIRROR_KEY
    && c.req.header('x-db-mirror') === '1'
    && constantTimeEqualStr(mirrorKey, c.env.DB_MIRROR_KEY as string)
  );
};

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
  'db_usage_snapshot',
  'b2_usage',
  'b2_temp_objects',
  // The novel discovery crawl is owner-gated, so the crawler writes the series
  // it does not own into their owner's D1. Public catalogue rows, same as the
  // read allowlist below. Only the statements the ingest emits are accepted —
  // see NOVEL_SERIES_EXEC_ALLOW.
  'novel_series',
]);

const QUERY_ALLOWED_TABLES = new Set([
  'chapter_pages',
  'sessions',
  'bookmarks',
  'reading_history',
  'series',
  'chapters',
  'manga_source_link',
  'b2_temp_objects',
  'b2_usage',
  // Novel tables shard by series, so a series read has to be able to reach the
  // shard that owns it (lib/novelShard.ts). No user data: novel_series and
  // novel_chapters are public catalogue rows.
  'novel_series',
  'novel_chapters',
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

/** A statement as exact text, whitespace-insensitive. The novel allowlist is
 *  matched literally rather than by shape so that "which writes may cross this
 *  boundary" is answered by the writer's own source instead of by a regex
 *  someone has to keep in step with it. */
const literalStatement = (sql: string): RegExp =>
  new RegExp(`^${sql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}$`, 'i');

/** Every non-empty subset, in order. The gap fill is built from whichever of the
 *  four columns is still blank, so all 15 are statements it can emit. */
const columnSets = (columns: readonly string[]): string[][] =>
  columns.flatMap((col, i) => [[col], ...columnSets(columns.slice(i + 1)).map((rest) => [col, ...rest])]);

// novel_series was allowlisted for /db/exec so the catalogue crawl could reach a
// peer owner, but the table had no statement allowlist of its own — a holder of
// DB_FORWARD_KEY could send any single write against it, DELETE included. Built
// from lib/novelIngest's own constants, so it is exactly the ingest's two shapes:
// the upsert, and a gap fill over some subset of the four gap columns. A third
// write shape in the ingest is then refused (and caught by a test) instead of
// silently widening this boundary.
const NOVEL_SERIES_EXEC_ALLOW = [
  literalStatement(UPSERT_SERIES_SQL),
  ...columnSets(NOVEL_DETAIL_COLUMNS).map((cols) => literalStatement(FILL_GAPS_SQL(cols as DetailColumn[]))),
];

/** Tables whose writes are restricted to a fixed set of statements, not merely
 *  to the allowlisted-table check. */
const TABLE_EXEC_ALLOW: Record<string, RegExp[]> = {
  users: USERS_EXEC_ALLOW,
  sessions: SESSIONS_EXEC_ALLOW,
  novel_series: NOVEL_SERIES_EXEC_ALLOW,
};

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

router.post('/admin/inventory', async (c: Context) => {
  if (!hasInternalAuth(c)) return c.json({ error: 'forbidden' }, 403);

  const entries: [string, string][] = [];
  new URL(c.req.url).searchParams.forEach((value, key) => entries.push([key, value]));
  if (entries.some(([key, value]) => key !== 'refresh' || value !== '1') || entries.length > 1) {
    return c.json({ error: 'invalid query' }, 400);
  }
  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (contentLength > INVENTORY_MAX_BODY_BYTES) {
    return c.json({ error: 'payload too large' }, 413);
  }
  const body = c.req.raw.body;
  if (body) {
    const reader = body.getReader();
    const first = await reader.read();
    if (first.done) {
      reader.releaseLock();
    } else {
      await reader.cancel();
      return c.json({ error: 'body not allowed' }, 400);
    }
  }

  const topology = getTopology(c.env);
  const cacheKey = `peer:inventory:v2:${topology.hash}`;
  // A cached snapshot is only reusable when the hash AND the resolved self
  // still match. The hash covers URLs only, so a PEER_INDEX change (self
  // gained or lost) keeps the same key and would otherwise serve a stale self.
  const expectSelf = topology.peers.some((peer) => peer.self);
  if (entries.length === 0) {
    const cached = await c.env.CACHE_KV.get(cacheKey, 'json').catch(() => null) as { data?: unknown } | null;
    const parsed = PeerInventorySchema.safeParse(cached?.data);
    if (parsed.success && parsed.data.topologyHash === topology.hash && parsed.data.self === expectSelf) {
      return c.json({ data: parsed.data });
    }
  }

  let data: PeerInventory;
  try {
    data = await collectPeerInventory(c.env, getDb(c));
  } catch {
    return c.json({ error: 'inventory collection failed' }, 500);
  }
  await c.env.CACHE_KV.put(cacheKey, JSON.stringify({ data }), { expirationTtl: INVENTORY_CACHE_TTL }).catch(() => null);
  return c.json({ data });
});

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
  const statementAllow = TABLE_EXEC_ALLOW[table];
  if (statementAllow && !statementAllow.some((re) => re.test(sql.trim()))) {
    return c.json({ error: `forbidden ${table} statement` }, 403);
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
const KV_READ_ALLOW_PREFIXES = ['series:detail:', 'series:full:', 'chapters:list:', 'chapter:detail:', 'f:resolve:'];

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
