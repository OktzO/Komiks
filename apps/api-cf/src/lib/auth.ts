import type { Env, Context } from './context';
import type { MiddlewareHandler } from 'hono';
import { db } from '@manga-platform/db';

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
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, baseKey, KEY_LEN * 8);
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
  await c.env.CACHE_KV.put(`session:${token}`, JSON.stringify({ userId, createdAt: Date.now() }), { expirationTtl: SESSION_TTL });
  return token;
}

export async function getSessionUser(c: Context): Promise<{ id: number; email: string; role: string } | null> {
  const token = c.req.header('authorization')?.replace('Bearer ', "") || parseCookie(c.req.header('cookie') || '').session;
  if (!token) return null;
  const raw = await c.env.CACHE_KV.get(`session:${token}`);
  if (!raw) return null;
  const { userId } = JSON.parse(raw) as { userId: number };
  const user = await db(c.env.DB).getUserById(userId);
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
  // Secure flag ensures the cookie is only sent over HTTPS in production.
  // Local dev over HTTP must tolerate this — browsers will simply not persist
  // the cookie over http, which is acceptable for local testing (use wrangler
  // dev which serves HTTPS, or set a separate non-Secure cookie for localhost).
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

// Constant-time string comparison — exported for use by admin step-up auth
// to avoid timing side-channels on password/key comparisons.
export const constantTimeEqualStr = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const requireAdminKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const supplied = c.req.header('x-admin-api-key');
  const expected = c.env.SCRAPE_API_KEY;
  if (!expected || !supplied || !constantTimeEqualStr(supplied, expected)) {
    return c.json({ error: 'admin api key required' }, 401);
  }
  await next();
};
