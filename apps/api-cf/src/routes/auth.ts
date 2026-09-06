import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import {
  createSession,
  getSessionUser,
  revokeSessionForUser,
  setSessionCookie,
  clearSessionCookie,
  isAdminEmail,
  setStateCookie,
  verifyStateCookie,
  clearStateCookie,
} from '../lib/auth';
import { allowedOriginFor } from '../lib/context';
import { writeWithFallback } from '../lib/dbWrite';

export const router = new Hono<{ Bindings: Env }>();

router.post('/logout', async (c: Context) => {
  let revoked = false;
  const user = await getSessionUser(c).catch(() => null);
  if (user) {
    // Extract sid from cookie payload for shard revoke.
    const cookieVal = parseCookie(c.req.header('cookie') || '')['__Host-session'];
    if (cookieVal) {
      const [payloadB64] = cookieVal.split('.');
      try {
        const payloadStr = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(payloadStr) as { sid?: string };
        if (payload.sid) {
          const r = await revokeSessionForUser(c.env, user.id, payload.sid).catch(() => ({ success: false }));
          revoked = r.success;
        }
      } catch {}
    }
  }
  c.header('Set-Cookie', clearSessionCookie());
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, revoked });
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

// Validate redirect path — only allow relative paths to prevent open-redirect.
function safePath(p: string | undefined): string {
  if (!p) return '/';
  if (!p.startsWith('/') || p.startsWith('//')) return '/';
  // Allowlist of safe prefixes.
  const allowed = ['/admin', '/history', '/bookmarks', '/profile', '/settings', '/search'];
  if (p === '/' || allowed.some((a) => p.startsWith(a))) return p;
  return '/';
}

// Resolve frontend origin from ?origin= query or ALLOWED_ORIGINS first entry.
function resolveFrontendOrigin(c: Context): string {
  const qOrigin = c.req.query('origin');
  if (qOrigin && allowedOriginFor(c.env, qOrigin)) return qOrigin;
  return c.env.ALLOWED_ORIGINS?.split(',')[0]?.trim() ?? '/';
}

// --- Google OAuth ---

// Initiate Google OAuth: frontend redirects here, we set a signed state cookie
// (nol KV) and bounce to Google.
router.get('/google', async (c: Context) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) return c.json({ error: 'google oauth not configured' }, 500);
  const base = new URL(c.req.url).origin;
  const state = crypto.randomUUID();
  const origin = resolveFrontendOrigin(c);
  const redirect = safePath(c.req.query('redirect'));
  // Set signed state cookie — replaces KV.put('oauth:state:{state}').
  c.header('Set-Cookie', await setStateCookie(c, { state, origin, redirect }));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
});

// Google OAuth callback — verify state cookie (nol KV), exchange code, upsert user,
// INSERT D1 session, set signed session cookie, redirect to frontend.
router.get('/google/callback', async (c: Context) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const queryState = c.req.query('state');
  if (error) return c.json({ error: `oauth error: ${error}` }, 400);
  if (!code) return c.json({ error: 'missing authorization code' }, 400);

  // 1. Verify state cookie (signed HMAC, no KV read).
  const stateInfo = await verifyStateCookie(c);
  if (!stateInfo) return c.json({ error: 'invalid or missing state cookie' }, 400);
  if (!queryState || queryState !== stateInfo.state) return c.json({ error: 'state mismatch' }, 400);
  // Clear state cookie.
  c.header('Set-Cookie', clearStateCookie());

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return c.json({ error: 'google oauth not configured' }, 500);

  const base = new URL(c.req.url).origin;

  // 2. Exchange code → access token
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

  // 3. Fetch user info
  let gUser: { id?: string; email: string; name?: string; picture?: string; verified_email?: boolean };
  if (tokenData.id_token) {
    const payload = JSON.parse(atob(tokenData.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as typeof gUser & { aud?: string; iss?: string; exp?: number };
    // Token came straight from googleapis.com over TLS, but still bound it
    // to our client + issuer before trusting identity claims.
    if (payload.aud !== clientId || (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') || (payload.exp ?? 0) < Math.floor(Date.now() / 1000)) {
      return c.json({ error: 'invalid id_token' }, 400);
    }
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

  const role = isAdminEmail(email, c.env) ? 'admin' : 'user';
  const existing = await db(c.env.DB).getUserByEmail(email);
  const avatarUrl = gUser.picture ?? null;

  // Moderated accounts cannot sign in. Sessions are already revoked on ban;
  // this blocks re-login until the admin restores the account.
  if (existing && (existing.status === 'banned' || existing.status === 'suspended')) {
    return c.json({ error: 'account suspended', reason: existing.status }, 403);
  }

  if (!existing) {
    await writeWithFallback(c, 'users',
      'INSERT INTO users (email, name, password_hash, role, avatar_url) VALUES (?1, ?2, ?3, ?4, ?5)',
      [email, gUser.name ?? null, null, role, avatarUrl]);
  } else {
    await writeWithFallback(c, 'users',
      'UPDATE users SET avatar_url = ?1 WHERE id = ?2 AND (avatar_url IS NULL OR avatar_url = ?3)',
      [avatarUrl, existing.id, '']);
    if (isAdminEmail(email, c.env) && existing.role !== 'admin') {
      await writeWithFallback(c, 'users',
        'UPDATE users SET role = ?1 WHERE id = ?2', ['admin', existing.id]);
    }
  }

  let userId: number;
  if (existing) {
    userId = existing.id;
  } else {
    const fresh = await db(c.env.DB).getUserByEmail(email);
    if (!fresh) return c.json({ error: 'user lookup failed after create' }, 500);
    userId = fresh.id;
  }

  // 4. Create signed-cookie session (D1 INSERT, no KV).
  const token = await createSession(c, userId, { email, role });
  c.header('Set-Cookie', setSessionCookie(token));
  await writeWithFallback(c, 'users', 'UPDATE users SET last_login_at = ?1 WHERE id = ?2', [Math.floor(Date.now() / 1000), userId]);

  // 5. Redirect to frontend origin + redirect path from state cookie.
  const target = stateInfo.origin !== '/' ? `${stateInfo.origin}${stateInfo.redirect}` : stateInfo.redirect;
  return c.redirect(target, 302);
});
