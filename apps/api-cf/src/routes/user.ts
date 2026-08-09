import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import {
  getSessionUser,
  listSessionsForUser,
  revokeSessionForUser,
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

function getSessionToken(c: Context): string | undefined {
  return (
    c.req.header('authorization')?.replace('Bearer ', '') ||
    parseCookie(c.req.header('cookie') || '').session
  );
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
        default_source: z.enum(['komiku', 'bacakomik', 'thrive', 'manhwaindo']).nullable().optional(),
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
  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', user);
  await next();
}

router.use('/bookmark', requireSession);
router.use('/bookmark/:slug', requireSession);
router.use('/bookmarks', requireSession);
router.use('/history', requireSession);
router.use('/sessions', requireSession);
router.use('/sessions/:token', requireSession);
router.use('/sessions/revoke-all', requireSession);

// ─── Existing routes: bookmark & history CRUD ────────────────────────────────

router.post('/bookmark', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const { seriesSlug } = await c.req.json() as { seriesSlug?: string };
  if (!seriesSlug) return c.json({ error: 'seriesSlug required' }, 400);
  await db(c.env.DB).addBookmark({ userId: user.id, seriesSlug });
  return c.json({ data: { ok: true } });
});

router.delete('/bookmark/:slug', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  await db(c.env.DB).removeBookmark({ userId: user.id, seriesSlug: c.req.param('slug') });
  return c.json({ data: { ok: true } });
});

router.get('/bookmarks', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const results = await db(c.env.DB).listBookmarks(user.id);
  return c.json({ data: results });
});

router.post('/history', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const { chapterId, lastPage } = await c.req.json() as { chapterId?: string; lastPage?: number };
  if (!chapterId) return c.json({ error: 'chapterId required' }, 400);
  await db(c.env.DB).upsertHistory({ userId: user.id, chapterId, lastPage: lastPage ?? 0 });
  return c.json({ data: { ok: true } });
});

router.get('/history', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const results = await db(c.env.DB).listHistory(user.id);
  return c.json({ data: results });
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

  const token = getSessionToken(c);
  if (token) {
    await Promise.allSettled([
      c.env.CACHE_KV.delete(`session:${token}`),
      c.env.CACHE_KV.delete(`session-user:${user.id}:${token}`),
    ]);
  }

  c.header('Set-Cookie', clearSessionCookie());
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
  const token = c.req.param('token');

  // Verify ownership: the secondary KV key embeds the userId, so it only
  // exists if this token belongs to this user.
  const exists = await c.env.CACHE_KV.get(`session-user:${user.id}:${token}`);
  if (!exists) return c.json({ error: 'session not found' }, 404);

  await revokeSessionForUser(c.env, user.id, token);
  return c.json({ data: { revoked: true } });
});

// ─── Sessions: POST /sessions/revoke-all ─────────────────────────────────

router.post('/sessions/revoke-all', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const currentToken = getSessionToken(c);

  const sessions = await listSessionsForUser(c.env, user.id);
  const toRevoke = currentToken
    ? sessions.filter((s) => s.token !== currentToken)
    : sessions;

  await Promise.all(
    toRevoke.map((s) =>
      Promise.allSettled([
        c.env.CACHE_KV.delete(`session:${s.token}`),
        c.env.CACHE_KV.delete(`session-user:${user.id}:${s.token}`),
      ])
    )
  );

  return c.json({ data: { revoked: toRevoke.length } });
});

// ─── History: DELETE /history (clear all) ────────────────────────────────

router.delete('/history', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const result = await db(c.env.DB).clearUserHistory(user.id);
  return c.json({ data: result });
});

// ─── Bookmarks: DELETE /bookmarks (clear all) ──────────────────────────────

router.delete('/bookmarks', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const result = await db(c.env.DB).clearUserBookmarks(user.id);
  return c.json({ data: result });
});
