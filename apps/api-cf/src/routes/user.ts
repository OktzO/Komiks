import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import { rateLimitMutate } from '../lib/rateLimit';
import { execOnUserOwner, queryOnUserOwner } from '../lib/userShard';
import {
  getSessionUser,
  listSessionsForUser,
  revokeSessionForUser,
  revokeAllSessionsForUser,
  getSessionRowForUser,
  clearSessionCookie,
} from '../lib/auth';

export const router = new Hono<{ Bindings: Env }>();

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

function getSessionSid(c: Context): string | undefined {
  const cookieVal = parseCookie(c.req.header('cookie') || '')['__Host-session'];
  if (!cookieVal) return undefined;
  const [payloadB64] = cookieVal.split('.');
  try {
    const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadStr) as { sid?: string };
    return payload.sid;
  } catch {
    return undefined;
  }
}

function getSessionUserFromContext(c: Context): { id: number; email: string; role: string } {
  return (
    c as unknown as { get: (k: string) => { id: number; email: string; role: string } }
  ).get('user');
}

// Zod: PATCH /me body — reject unknown keys at both levels.
const updateProfileSchema = z
  .object({
    display_name: z.string().max(50).nullable().optional(),
    bio: z.string().max(280).nullable().optional(),
    preferences: z
      .object({
        theme: z.enum(['dark', 'light', 'system']).optional(),
        language: z.enum(['id', 'en']).optional(),
        reader_mode: z.enum(['scroll', 'page']).optional(),
        default_source: z.enum(['komiku', 'bacakomik', 'thrive', 'shinigami', 'manhwaindo']).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Zod: DELETE /me body — must be exactly { confirm: 'DELETE' }
const deleteMeSchema = z.object({ confirm: z.literal('DELETE') }).strict();

// ─── Auth middleware: getSessionUser → 401, set user in context ────────────

// requireSession middleware: applied inline to auth-required routes.
// GET /me is guest-friendly (returns {data:null} for unauthenticated visitors) —
// registered separately below without a guard.

async function requireSession(c: Context, next: () => Promise<void>) {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  try {
    const row = await db(c.env.DB).getUserStatusAdmin(user.id);
    if (row && row.status !== 'active') {
      return c.json({ error: 'account suspended', reason: row.status }, 403);
    }
  } catch {}

  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', user);
  await next();
}

router.post('/bookmark', requireSession, rateLimitMutate);
router.get('/bookmark/:slug', requireSession);
router.delete('/bookmark/:slug', requireSession, rateLimitMutate);
router.get('/bookmarks', requireSession);
router.delete('/bookmarks', requireSession, rateLimitMutate);
router.use('/history', requireSession);
router.use('/sessions', requireSession);
router.use('/sessions/:token', requireSession);
router.use('/sessions/revoke-all', requireSession);

// ─── Existing routes: bookmark & history CRUD ────────────────────────────────

router.post('/bookmark', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const { seriesSlug, source, source_url, title, cover_image } = await c.req.json() as { seriesSlug?: string; source?: string; source_url?: string; title?: string; cover_image?: string };
  if (!seriesSlug) return c.json({ error: 'seriesSlug required' }, 400);
  // Stub series di owner yang sama agar JOIN listBookmarks jalan di owner.
  await execOnUserOwner(c.env, user.id,
    `INSERT INTO series (slug, source, title, type, status, cover_image, updated_at)
     VALUES (?1, ?2, ?3, 'manga', 'ongoing', ?4, unixepoch())
     ON CONFLICT(slug) DO UPDATE SET cover_image = COALESCE(excluded.cover_image, series.cover_image), updated_at = unixepoch()`,
    [seriesSlug, source ?? 'local', title ?? seriesSlug, cover_image ?? null], 'series');
  await execOnUserOwner(c.env, user.id,
    'INSERT OR IGNORE INTO bookmarks (user_id, series_slug, source, source_url) VALUES (?1, ?2, ?3, ?4)',
    [user.id, seriesSlug, source ?? null, source_url ?? null], 'bookmarks');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { ok: true } });
});

router.delete('/bookmark/:slug', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  await execOnUserOwner(c.env, user.id,
    'DELETE FROM bookmarks WHERE user_id = ?1 AND series_slug = ?2',
    [user.id, c.req.param('slug')], 'bookmarks');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { ok: true } });
});

router.get('/bookmark/:slug', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const rows = await queryOnUserOwner<{ ['1']: number }>(c.env, user.id,
    'SELECT 1 FROM bookmarks WHERE user_id = ?1 AND series_slug = ?2',
    [user.id, c.req.param('slug')], 'bookmarks');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { bookmarked: !!rows && rows.length > 0 } });
});

router.get('/bookmarks', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const rows = await queryOnUserOwner<Record<string, unknown>>(c.env, user.id,
    `SELECT s.*, b.source AS bookmark_source, b.source_url AS bookmark_url, b.created_at AS bookmark_created_at
     FROM bookmarks b JOIN series s ON s.slug = b.series_slug
     WHERE b.user_id = ?1 ORDER BY b.created_at DESC`,
    [user.id], 'bookmarks');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: rows ?? [] });
});

router.post('/history', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const { chapterId, lastPage } = await c.req.json() as { chapterId?: string; lastPage?: number };
  if (!chapterId) return c.json({ error: 'chapterId required' }, 400);
  await execOnUserOwner(c.env, user.id,
    `INSERT INTO reading_history (user_id, chapter_id, last_page)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id, chapter_id) DO UPDATE SET last_page = excluded.last_page, updated_at = unixepoch()`,
    [user.id, chapterId, lastPage ?? 0], 'reading_history');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { ok: true } });
});

router.get('/history', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const rows = await queryOnUserOwner<Record<string, unknown>>(c.env, user.id,
    `SELECT c.*, COALESCE(s2.type, s3.type) AS type
     FROM reading_history rh
     JOIN chapters c ON c.id = rh.chapter_id
     LEFT JOIN series s2 ON s2.slug = c.series_slug
     LEFT JOIN manga_source_link msl ON msl.source_slug = c.series_slug
     LEFT JOIN series s3 ON s3.id = msl.manga_id
     WHERE rh.user_id = ?1 ORDER BY rh.updated_at DESC LIMIT 50`,
    [user.id], 'reading_history');
  c.header('Cache-Control', 'no-store');
  return c.json({ data: rows ?? [] });
});

// ─── Profile: GET /me ──────────────────────────────────────────────────────

router.get('/me', async (c: Context) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ data: null });
  const profile = await db(c.env.DB).getUserProfileById(user.id);
  if (!profile) return c.json({ error: 'user not found' }, 404);
  return c.json({ data: profile });
});

// ─── Profile: PATCH /me ────────────────────────────────────────────────────

router.patch('/me', requireSession, async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid json body' }, 400);

  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid input', details: parsed.error.issues }, 400);
  }

  const { display_name, bio, preferences } = parsed.data;
  // preferences is stringified to JSON TEXT by db.updateUserProfile internally.
  await db(c.env.DB).updateUserProfile(user.id, {
    displayName: display_name,
    bio,
    preferences: preferences as Record<string, unknown> | undefined,
  });
  return c.json({ data: { ok: true } });
});

// ─── Profile: DELETE /me ───────────────────────────────────────────────────

router.delete('/me', requireSession, async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const body = (await c.req.json().catch(() => null)) as { confirm?: string } | null;

  const parsed = deleteMeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json(
      { error: 'confirmation required: send { confirm: "DELETE" }', details: parsed.error.issues },
      400
    );
  }

  await db(c.env.DB).deleteUserAccount(user.id);

  await revokeAllSessionsForUser(c.env, user.id).catch(() => {});

  c.header('Set-Cookie', clearSessionCookie());
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { deleted: true } });
});

// ─── Sessions: GET /sessions ───────────────────────────────────────────────

router.get('/sessions', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const sessions = await listSessionsForUser(c.env, user.id);
  return c.json({ data: sessions });
});

// ─── Sessions: DELETE /sessions/:token ─────────────────────────────────────

router.delete('/sessions/:token', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const sid = c.req.param('token');

  // Verify ownership on the session's owner shard (sessions are sharded by
  // user_id — a forged sid from another user would fail this read).
  const row = await getSessionRowForUser(c.env, user.id, sid);
  if (!row || row.user_id !== user.id) return c.json({ error: 'session not found' }, 404);

  await revokeSessionForUser(c.env, user.id, sid);
  return c.json({ data: { revoked: true } });
});

// ─── Sessions: POST /sessions/revoke-all ─────────────────────────────────

router.post('/sessions/revoke-all', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const currentSid = getSessionSid(c);

  const result = await revokeAllSessionsForUser(c.env, user.id, currentSid);
  return c.json({ data: { revoked: result.revoked } });
});

// ─── History: DELETE /history (clear all) ────────────────────────────────

router.delete('/history', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const rows = await queryOnUserOwner<{ c: number }>(c.env, user.id,
    'SELECT COUNT(*) AS c FROM reading_history WHERE user_id = ?1', [user.id], 'reading_history');
  const deleted = rows?.[0]?.c ?? 0;
  await execOnUserOwner(c.env, user.id,
    'DELETE FROM reading_history WHERE user_id = ?1', [user.id], 'reading_history');
  return c.json({ data: { success: true, deleted } });
});

// ─── Bookmarks: DELETE /bookmarks (clear all) ──────────────────────────────

router.delete('/bookmarks', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const rows = await queryOnUserOwner<{ c: number }>(c.env, user.id,
    'SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?1', [user.id], 'bookmarks');
  const deleted = rows?.[0]?.c ?? 0;
  await execOnUserOwner(c.env, user.id,
    'DELETE FROM bookmarks WHERE user_id = ?1', [user.id], 'bookmarks');
  return c.json({ data: { success: true, deleted } });
});
