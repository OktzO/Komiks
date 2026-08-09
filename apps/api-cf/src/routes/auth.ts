import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import { hashPassword, verifyPassword, createSession, getSessionUser, setSessionCookie, clearSessionCookie, isAdminEmail } from '../lib/auth';
import { writeWithFallback } from '../lib/dbWrite';

export const router = new Hono<{ Bindings: Env }>();

router.post('/register', async (c: Context) => {
  const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password || password.length < 8) {
    return c.json({ error: 'email + password (min 8 chars) required' }, 400);
  }
  const existing = await db(c.env.DB).getUserByEmail?.(email).catch(() => null);
  if (existing) return c.json({ error: 'email already registered' }, 409);
  const passwordHash = await hashPassword(password);
  const result = await db(c.env.DB).createUser({ email, passwordHash, role: 'user' });
  const token = await createSession(c, result!.id);
  c.header('Set-Cookie', setSessionCookie(token));
  return c.json({ data: { id: result!.id, email, role: 'user' } }, 201);
});

router.post('/login', async (c: Context) => {
  const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) return c.json({ error: 'email + password required' }, 400);
  const user = await db(c.env.DB).getUserByEmail?.(email).catch(() => null) as { id: number; email: string; password_hash: string; role: string } | null;
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  const token = await createSession(c, user.id);
  c.header('Set-Cookie', setSessionCookie(token));
  return c.json({ data: { id: user.id, email: user.email, role: user.role } });
});

router.post('/logout', async (c: Context) => {
  const token = c.req.header('authorization')?.replace('Bearer ', '') || parseCookie(c.req.header('cookie') || '').session;
  if (token) await c.env.CACHE_KV.delete(`session:${token}`).catch(() => {});
  c.header('Set-Cookie', clearSessionCookie());
  return c.json({ ok: true });
});

router.get('/me', async (c: Context) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ data: null }, 200);
  return c.json({ data: user });
});

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

// --- Google OAuth ---

// Initiate Google OAuth: frontend redirects here, we bounce to Google.
router.get('/google', (c: Context) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) return c.json({ error: 'google oauth not configured' }, 500);
  const base = new URL(c.req.url).origin;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
});

// Google OAuth callback — exchanges code for token, fetches user profile,
// upserts the user row (storing gUser.picture as avatar_url), and creates
// a session. Admin role is auto-assigned via email allowlist (ADMIN_EMAILS).
router.get('/google/callback', async (c: Context) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  if (error) return c.json({ error: `oauth error: ${error}` }, 400);
  if (!code) return c.json({ error: 'missing authorization code' }, 400);

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return c.json({ error: 'google oauth not configured' }, 500);

  const base = new URL(c.req.url).origin;

  // 1. Exchange code → access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${base}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return c.json({ error: 'google token exchange failed' }, 500);
  const tokenData = await tokenRes.json() as { access_token?: string; id_token?: string };

  // 2. Fetch user info (id, email, name, picture)
  // Prefer id_token if present (JWT, contains verified_email), else use access_token.
  let gUser: { id?: string; email: string; name?: string; picture?: string; verified_email?: boolean };
  if (tokenData.id_token) {
    const payload = JSON.parse(atob(tokenData.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as typeof gUser;
    gUser = payload;
  } else if (tokenData.access_token) {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) return c.json({ error: 'failed to fetch user info' }, 500);
    gUser = await userRes.json() as typeof gUser;
  } else {
    return c.json({ error: 'no token received' }, 500);
  }

  const email = gUser.email.toLowerCase().trim();
  if (!email || gUser.verified_email === false) return c.json({ error: 'email not verified' }, 400);

  // 3. Determine role from admin email allowlist
  const role = isAdminEmail(email, c.env) ? 'admin' : 'user';

  // 4. Check existing user
  const existing = await db(c.env.DB).getUserByEmail(email);

  // Store Google avatar as avatar_url. For new users (password_hash = NULL since
  // OAuth-only), and for existing users only if they don't already have one
  // (forward-compat: don't clobber a later custom avatar).
  const avatarUrl = gUser.picture ?? null;

  if (!existing) {
    // INSERT new user with avatar_url = gUser.picture ?? NULL
    // password_hash is NULL — OAuth users authenticate via session, not password.
    await writeWithFallback(c, 'users',
      'INSERT INTO users (email, name, password_hash, role, avatar_url) VALUES (?1, ?2, ?3, ?4, ?5)',
      [email, gUser.name ?? null, null, role, avatarUrl]);
  } else {
    // UPDATE existing user — set avatar_url only if NULL or empty (idempotent, safe).
    // Don't force-overwrite: user may later set a custom avatar.
    await writeWithFallback(c, 'users',
      'UPDATE users SET avatar_url = ?1 WHERE id = ?2 AND (avatar_url IS NULL OR avatar_url = ?3)',
      [avatarUrl, existing.id, '']);
    // Promote to admin if email is now in allowlist and user isn't admin yet.
    if (isAdminEmail(email, c.env) && existing.role !== 'admin') {
      await writeWithFallback(c, 'users',
        'UPDATE users SET role = ?1 WHERE id = ?2', ['admin', existing.id]);
    }
  }

  // 5. Create session — re-fetch to get the authoritative row (may have been
  //    written to peer DB via writeWithFallback, mirrored async).
  let userId: number;
  if (existing) {
    userId = existing.id;
  } else {
    const fresh = await db(c.env.DB).getUserByEmail(email);
    if (!fresh) return c.json({ error: 'user lookup failed after create' }, 500);
    userId = fresh.id;
  }
  const token = await createSession(c, userId);
  c.header('Set-Cookie', setSessionCookie(token));

  // Redirect to frontend (session cookie set).
  const redirectTarget = c.env.ALLOWED_ORIGINS?.split(',')[0]?.trim() ?? '/';
  return c.redirect(redirectTarget, 302);
});
