import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { db } from '@manga-platform/db';
import { hashPassword, verifyPassword, createSession, getSessionUser, setSessionCookie, clearSessionCookie } from '../lib/auth';

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
