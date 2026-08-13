import type { Env, Context } from './context';
import type { MiddlewareHandler } from 'hono';
import { db } from '@manga-platform/db';
import type { SessionMeta } from '@manga-platform/shared/types';

// ── Crypto helpers (HMAC-SHA256 via WebCrypto) ──────────────────────────────

const b64urlEncode = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const hmacSha256 = async (key: string, data: string): Promise<ArrayBuffer> => {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
};

const constantTimeEqualBuf = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

// ── Legacy password helpers (kept for any old rows, OAuth-only now) ─────────

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
  return constantTimeEqualBuf(new Uint8Array(hash), expected);
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

// ── Session config ──────────────────────────────────────────────────────────

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days, in seconds
const SESSION_COOKIE = '__Host-session';
const STATE_COOKIE = '__Host-oauth-state';
const STATE_TTL = 600; // 10 min

type SessionPayload = {
  sid: string;
  uid: number;
  email: string;
  role: string;
  iat: number;
  exp: number;
};

// ── Signed token helpers (payload + HMAC sig, separated by '.') ──────────────

async function signToken(env: Env, payloadStr: string): Promise<string> {
  const sig = await hmacSha256(env.LB_ENCRYPTION_KEY, payloadStr);
  return b64urlEncode(new TextEncoder().encode(payloadStr)) + '.' + b64urlEncode(sig);
}

async function verifyToken<T>(env: Env, token: string): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  let payloadStr: string;
  try {
    payloadStr = new TextDecoder().decode(b64urlDecode(payloadB64));
  } catch {
    return null;
  }
  const expectedSig = await hmacSha256(env.LB_ENCRYPTION_KEY, payloadStr);
  let providedSig: Uint8Array;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (!constantTimeEqualBuf(new Uint8Array(expectedSig), providedSig)) return null;
  try {
    return JSON.parse(payloadStr) as T;
  } catch {
    return null;
  }
}

// ── Session: create (INSERT D1) + verify (lazy D1 revocation check) ─────────

export async function createSession(
  c: Context,
  userId: number,
  user: { email: string; role: string }
): Promise<string> {
  const sid = crypto.randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_TTL;
  const payload: SessionPayload = { sid, uid: userId, email: user.email, role: user.role, iat, exp };
  const payloadStr = JSON.stringify(payload);
  const token = await signToken(c.env, payloadStr);
  // D1 INSERT — 1 write per login (was 2 KV.puts).
  const ua = c.req.header('user-agent') || null;
  const ip = c.req.header('cf-connecting-ip') || null;
  await db(c.env.DB).insertSession({ sid, userId, createdAt: iat, expiresAt: exp, ua, ip });
  return token;
}

export async function getSessionUser(c: Context): Promise<{ id: number; email: string; role: string } | null> {
  const token = parseCookie(c.req.header('cookie') || '')[SESSION_COOKIE];
  if (!token) return null;
  const payload = await verifyToken<SessionPayload>(c.env, token);
  if (!payload) return null;
  // Expiry check from cookie payload (no D1 read needed for expired sessions).
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  // Lazy revocation: 1 D1 read to check sessions(sid).revoked_at.
  const row = await db(c.env.DB).getSession(payload.sid);
  if (!row || row.revoked_at !== null) return null;
  return { id: payload.uid, email: payload.email, role: payload.role };
}

export function requireAuth(c: Context): { id: number; email: string; role: string } | null {
  return (c as unknown as { get: (k: string) => unknown }).get('user') as { id: number; email: string; role: string } | null;
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = v.join('=');
  }
  return out;
}

export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${SESSION_TTL}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
}

// ── OAuth state cookie (signed, nol KV) ─────────────────────────────────────

type OAuthStatePayload = {
  state: string;
  origin: string;
  redirect: string;
  exp: number;
};

export async function setStateCookie(
  c: Context,
  data: { state: string; origin: string; redirect: string }
): Promise<string> {
  const payload: OAuthStatePayload = {
    state: data.state,
    origin: data.origin,
    redirect: data.redirect,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL,
  };
  const token = await signToken(c.env, JSON.stringify(payload));
  return `${STATE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${STATE_TTL}`;
}

export async function verifyStateCookie(c: Context): Promise<OAuthStatePayload | null> {
  const token = parseCookie(c.req.header('cookie') || '')[STATE_COOKIE];
  if (!token) return null;
  const payload = await verifyToken<OAuthStatePayload>(c.env, token);
  if (!payload) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
}

// ── Sessions list/revoke (now D1-backed, no KV) ─────────────────────────────

export async function listSessionsForUser(env: Env, userId: number): Promise<SessionMeta[]> {
  const rows = await db(env.DB).listUserSessions(userId);
  return rows
    .filter((r) => r.revoked_at === null)
    .map((r) => ({
      token: r.sid,
      createdAt: r.created_at * 1000,
      lastSeen: r.created_at * 1000, // D1 doesn't track lastSeen; use createdAt
      ua: r.ua ?? '',
    }));
}

export async function revokeSessionForUser(env: Env, _userId: number, sid: string): Promise<{ success: boolean }> {
  return db(env.DB).revokeSession(sid);
}

// Constant-time string comparison — exported for use by admin step-up auth.
export const constantTimeEqualStr = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

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

export const requireAdminSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = await getSessionUser(c);
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'admin required' }, 403);
  }
  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', user);
  await next();
};
