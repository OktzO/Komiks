import type { Env, Context } from './context';
import type { MiddlewareHandler } from 'hono';
import { db } from '@manga-platform/db';
import type { SessionMeta } from '@manga-platform/shared/types';

const PBKDF2_ITER = 100000;
const SALT_LEN = 16;
const KEY_LEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await deriveKey(password, salt);
  const hash = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
  return `pbkdf2:${PBKDF2_ITER}:${toHex(salt)}:${toHex(new Uint8Array(hash))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  const key = await deriveKey(password, salt, iter);
  const hash = await crypto.subtle.exportKey('raw', key) as ArrayBuffer;
  return constantTimeEqual(new Uint8Array(hash), expected);
}

async function deriveKey(password: string, salt: Uint8Array, iter = PBKDF2_ITER): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const algo = { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: iter, hash: 'SHA-256' } as Pbkdf2Params;
  const bits = await crypto.subtle.deriveBits(algo, baseKey, KEY_LEN * 8);
  return crypto.subtle.importKey('raw', bits, 'HMAC', false, ['sign']);
}

const toHex = (arr: Uint8Array): string => Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

const SESSION_TTL = 60 * 60 * 24 * 7;

export async function createSession(c: Context, userId: number): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  const ua = c.req.header('user-agent') || '';
  const secondary = JSON.stringify({ token, createdAt: now, lastSeen: now, ua });
  await Promise.all([
    c.env.CACHE_KV.put(`session:${token}`, JSON.stringify({ userId, createdAt: now }), { expirationTtl: SESSION_TTL }),
    c.env.CACHE_KV.put(`session-user:${userId}:${token}`, secondary, { expirationTtl: SESSION_TTL }),
  ]);
  return token;
}

export async function getSessionUser(c: Context): Promise<{ id: number; email: string; role: string } | null> {
  const token = c.req.header('authorization')?.replace('Bearer ', "") || parseCookie(c.req.header('cookie') || '').session;
  if (!token) return null;
  const raw = await c.env.CACHE_KV.get(`session:${token}`);
  if (!raw) return null;
  const { userId, createdAt } = JSON.parse(raw) as { userId: number; createdAt: number };
  const user = await db(c.env.DB).getUserById(userId);
  if (user) {
    // Fire-and-forget: refresh lastSeen + TTL on the secondary index key.
    // Must not block the response path; swallow errors.
    const now = Date.now();
    void c.env.CACHE_KV
      .put(`session-user:${userId}:${token}`,
        JSON.stringify({ token, createdAt: createdAt ?? now, lastSeen: now, ua: c.req.header('user-agent') || '' }),
        { expirationTtl: SESSION_TTL })
      .catch(() => undefined);
  }
  return user;
}

export function requireAuth(c: Context): { id: number; email: string; role: string } | null {
  return (c as unknown as { get: (k: string) => unknown }).get('user') as { id: number; email: string; role: string } | null;
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

export function setSessionCookie(token: string): string {
  // SameSite=None + Secure required for cross-origin cookie (frontend on
  // oktz.qzz.io, API on manga-api.oktz.workers.dev). Lax would block XHR
  // cross-origin, leaving frontend unable to read the session.
  return `session=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `session=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
}

export async function listSessionsForUser(env: Env, userId: number): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];
  const prefix = `session-user:${userId}:`;
  let cursor: string | undefined;
  do {
    const res = await env.CACHE_KV.list({ prefix, cursor });
    for (const k of res.keys) {
      const val = await env.CACHE_KV.get(k.name);
      if (!val) continue;
      try {
        const m = JSON.parse(val) as Partial<SessionMeta>;
        if (m.token && typeof m.createdAt === 'number' && typeof m.lastSeen === 'number') {
          sessions.push({ token: m.token, createdAt: m.createdAt, lastSeen: m.lastSeen, ua: typeof m.ua === 'string' ? m.ua : '' });
        }
      } catch {
        continue;
      }
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  sessions.sort((a, b) => b.lastSeen - a.lastSeen);
  return sessions;
}

export async function revokeSessionForUser(env: Env, userId: number, token: string): Promise<{ success: boolean }> {
  await Promise.allSettled([
    env.CACHE_KV.delete(`session:${token}`),
    env.CACHE_KV.delete(`session-user:${userId}:${token}`),
  ]);
  return { success: true };
}

// Constant-time string comparison — exported for use by admin step-up auth
// to avoid timing side-channels on password/key comparisons.
export const constantTimeEqualStr = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// Admin email allowlist (comma-separated in ADMIN_EMAILS env). Default: none.
// Used by OAuth callback to auto-assign role='admin'.
export const isAdminEmail = (email: string, env: Env): boolean => {
  const raw = env.ADMIN_EMAILS;
  if (!raw) return false;
  return raw.split(',').map((s) => s.trim().toLowerCase()).includes(email.toLowerCase());
};

export const requireAdminKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const supplied = c.req.header('x-admin-api-key');
  const expected = c.env.SCRAPE_API_KEY;
  if (!expected || !supplied || !constantTimeEqualStr(supplied, expected)) {
    return c.json({ error: 'admin api key required' }, 401);
  }
  await next();
};

// Session-based admin gate for read-only monitoring endpoints (/api/admin/*).
// Distinct from requireAdminKey (scrape) and requireAdminStepUp (LB mutations).
// Verifies session cookie/Bearer against KV session store + users.role === 'admin'.
export const requireAdminSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = await getSessionUser(c);
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'admin required' }, 403);
  }
  // Hono's c.set typing is strict; cast to satisfy the generic key constraint.
  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', user);
  await next();
};
