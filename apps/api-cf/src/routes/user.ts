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

router.get('/bookmark/:slug', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const bookmarked = await db(c.env.DB).isBookmarked({ userId: user.id, seriesSlug: c.req.param('slug') });
  return c.json({ data: { bookmarked } });
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

  const sid = getSessionSid(c);
  if (sid) {
    await db(c.env.DB).revokeSession(sid).catch(() => {});
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
  const sid = c.req.param('token');

  // Verify ownership: D1 session must belong to this user.
  const row = await db(c.env.DB).getSession(sid);
  if (!row || row.user_id !== user.id) return c.json({ error: 'session not found' }, 404);

  await revokeSessionForUser(c.env, user.id, sid);
  return c.json({ data: { revoked: true } });
});

// ─── Sessions: POST /sessions/revoke-all ─────────────────────────────────

router.post('/sessions/revoke-all', async (c: Context) => {
  const user = getSessionUserFromContext(c);
  const currentSid = getSessionSid(c);

  const result = await db(c.env.DB).revokeAllUserSessions(user.id, currentSid);
  return c.json({ data: { revoked: result.revoked } });
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
