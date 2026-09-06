import type { Env, Context } from './context';
import type { MiddlewareHandler } from 'hono';
import { db } from '@manga-platform/db';
import type { SessionMeta } from '@manga-platform/shared/types';
import { ownerFor, internalExec, internalQuery } from './peers';

// ── ECDSA P-256 session signing (cross-account asymmetric auth) ─────────────
//
// Setiap worker punya private key sendiri (secret AUTH_SIGNING_KEY, JWK).
// Public key semua worker di-share via [vars] AUTH_PUBLIC_KEYS (bukan secret,
// bisa di-commit). Cookie bawa `kid` → worker mana pun bisa verify cookie
// buatan worker mana pun. Nol secret yang perlu di-sync lintas akun.

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

const enc = new TextEncoder();

type PubJwk = { kid: string; key: JsonWebKey };
let pubKeyCache: { raw: string; keys: Map<string, CryptoKey> } | null = null;

const getPublicKeys = async (env: Env): Promise<Map<string, CryptoKey> | null> => {
  const raw = (env.AUTH_PUBLIC_KEYS as string | undefined)?.trim();
  if (!raw) return null;
  if (pubKeyCache?.raw === raw) return pubKeyCache.keys;
  try {
    const arr = JSON.parse(raw) as PubJwk[];
    const map = new Map<string, CryptoKey>();
    for (const { kid, key } of arr) {
      map.set(kid, await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
    }
    pubKeyCache = { raw, keys: map };
    return map;
  } catch {
    return null;
  }
};

let privKeyCache: { raw: string; kid: string; key: CryptoKey } | null = null;

// AUTH_SIGNING_KEY = JSON { kid, ...JWK private } (single object, worker-local).
const getPrivateKey = async (env: Env): Promise<{ kid: string; key: CryptoKey } | null> => {
  const raw = (env.AUTH_SIGNING_KEY as string | undefined)?.trim();
  if (!raw) return null;
  if (privKeyCache?.raw === raw) return { kid: privKeyCache.kid, key: privKeyCache.key };
  try {
    const obj = JSON.parse(raw) as { kid: string } & JsonWebKey;
    const { kid, ...jwk } = obj;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    privKeyCache = { raw, kid, key };
    return { kid, key };
  } catch {
    return null;
  }
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
  kid: string;
  iat: number;
  exp: number;
};

// ── Sign/verify: b64url(payload).b64url(ECDSA-sig) ──────────────────────────

async function signToken(env: Env, payloadStr: string): Promise<string> {
  const priv = await getPrivateKey(env);
  if (!priv) throw new Error('AUTH_SIGNING_KEY not configured');
  const payloadB64 = b64urlEncode(enc.encode(payloadStr));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv.key, enc.encode(payloadStr));
  return `${payloadB64}.${b64urlEncode(sig)}`;
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
  let payload: T & { kid?: string };
  try {
    payload = JSON.parse(payloadStr) as T & { kid?: string };
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !payload.kid) return null;
  const keys = await getPublicKeys(env);
  const pub = keys?.get(payload.kid);
  if (!pub) return null;
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig as unknown as BufferSource, enc.encode(payloadStr)).catch(() => false);
  return ok ? payload : null;
}

// ── Sharded sessions: owner = murmur3(userId) → sessions per-user colocated ─
// All session ops (insert/revoke/list) are user-scoped, so keying the shard on
// userId keeps every user's sessions on one owner D1 — single read per verify,
// no fan-out for list/revoke-all. sid format "{uid}:{rand}" stays globally
// unique; uid prefix lets logout resolve the owner from the cookie alone.

const sessionOwner = (env: Env, userId: number) => ownerFor(env, String(userId));

const insertSessionSharded = async (
  env: Env,
  p: { sid: string; userId: number; createdAt: number; expiresAt: number; ua: string | null; ip: string | null }
): Promise<boolean> => {
  const owner = sessionOwner(env, p.userId);
  if (owner.self) return (await db(env.DB).insertSession(p)).success;
  const sql = 'INSERT INTO sessions (sid, user_id, created_at, expires_at, ua, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6)';
  const ok = await internalExec(env, owner.url, { sql, params: [p.sid, p.userId, p.createdAt, p.expiresAt, p.ua, p.ip], table: 'sessions' });
  if (!ok) {
    // Row-healing fallback: land locally so revocation has something to check
    // until the owner is reachable again.
    const local = await db(env.DB).insertSession(p).catch(() => ({ success: false }));
    return local.success;
  }
  return true;
};

const getSessionSharded = async (env: Env, userId: number, sid: string) => {
  const owner = sessionOwner(env, userId);
  type Row = { sid: string; user_id: number; created_at: number; expires_at: number; revoked_at: number | null; ua: string | null; ip: string | null };
  if (owner.self) return db(env.DB).getSession(sid);
  const sql = 'SELECT sid, user_id, created_at, expires_at, revoked_at, ua, ip FROM sessions WHERE sid = ?1 AND user_id = ?2 LIMIT 1';
  const rows = await internalQuery<Row>(env, owner.url, sql, [sid, userId], 'sessions').catch(() => null);
  if (!rows || rows.length === 0) return null;
  return rows[0];
};

const revokeSessionSharded = async (env: Env, userId: number, sid: string): Promise<{ success: boolean }> => {
  const owner = sessionOwner(env, userId);
  const sql = 'UPDATE sessions SET revoked_at = ?1 WHERE sid = ?2 AND user_id = ?3 AND revoked_at IS NULL';
  const now = Math.floor(Date.now() / 1000);
  if (owner.self) return db(env.DB).revokeSession(sid);
  const ok = await internalExec(env, owner.url, { sql, params: [now, sid, userId], table: 'sessions' });
  if (!ok) {
    await db(env.DB).revokeSession(sid).catch(() => {});
    return { success: false };
  }
  return { success: true };
};

const listSessionsSharded = async (env: Env, userId: number) => {
  const owner = sessionOwner(env, userId);
  type Row = { sid: string; created_at: number; expires_at: number; revoked_at: number | null; ua: string | null };
  if (owner.self) return db(env.DB).listUserSessions(userId);
  const sql = 'SELECT sid, created_at, expires_at, revoked_at, ua FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50';
  const rows = await internalQuery<Row>(env, owner.url, sql, [userId], 'sessions').catch(() => null);
  return (rows ?? []) as Array<{ sid: string; created_at: number; expires_at: number; revoked_at: number | null; ua: string | null }>;
};

const revokeAllSharded = async (env: Env, userId: number, exceptSid: string | undefined): Promise<{ revoked: number }> => {
  const owner = sessionOwner(env, userId);
  const now = Math.floor(Date.now() / 1000);
  if (owner.self) return db(env.DB).revokeAllUserSessions(userId, exceptSid);
  const sql = exceptSid
    ? 'UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND sid != ?3'
    : 'UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL';
  const params = exceptSid ? [now, userId, exceptSid] : [now, userId];
  const ok = await internalExec(env, owner.url, { sql, params, table: 'sessions' });
  if (!ok) {
    await db(env.DB).revokeAllUserSessions(userId, exceptSid).catch(() => {});
    return { revoked: 0 };
  }
  // changes count unavailable over the exec channel; report -1 as "done, count unknown".
  return { revoked: -1 };
};

// ── Session: create + verify ────────────────────────────────────────────────

export async function createSession(
  c: Context,
  userId: number,
  user: { email: string; role: string }
): Promise<string> {
  const priv = await getPrivateKey(c.env);
  if (!priv) throw new Error('AUTH_SIGNING_KEY not configured');
  const rand = crypto.randomUUID().replace(/-/g, '');
  const sid = `${userId}:${rand}`;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_TTL;
  const payload: SessionPayload = { sid, uid: userId, email: user.email, role: user.role, kid: priv.kid, iat, exp };
  const payloadStr = JSON.stringify(payload);
  const token = await signToken(c.env, payloadStr);
  const ua = c.req.header('user-agent') || null;
  const ip = c.req.header('cf-connecting-ip') || null;
  // Best-effort row write — cookie is valid from its own signature + exp;
  // row absence only fails the revocation check (fail-closed) until healed.
  await insertSessionSharded(c.env, { sid, userId, createdAt: iat, expiresAt: exp, ua, ip }).catch(() => {});
  return token;
}

export async function getSessionUser(c: Context): Promise<{ id: number; email: string; role: string } | null> {
  const token = parseCookie(c.req.header('cookie') || '')[SESSION_COOKIE];
  if (!token) return null;
  const payload = await verifyToken<SessionPayload>(c.env, token);
  if (!payload) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  // Revocation check on the session's owner shard. Fail-closed: if the shard
  // row is missing/unreachable, the session is treated as revoked.
  const row = await getSessionSharded(c.env, payload.uid, payload.sid);
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
  const priv = await getPrivateKey(c.env);
  if (!priv) throw new Error('AUTH_SIGNING_KEY not configured');
  const payload: OAuthStatePayload & { kid: string } = {
    state: data.state,
    origin: data.origin,
    redirect: data.redirect,
    kid: priv.kid,
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

// ── Sessions list/revoke (sharded) ──────────────────────────────────────────

export async function listSessionsForUser(env: Env, userId: number): Promise<SessionMeta[]> {
  const rows = await listSessionsSharded(env, userId);
  return rows
    .filter((r) => r.revoked_at === null)
    .map((r) => ({
      token: r.sid,
      createdAt: r.created_at * 1000,
      lastSeen: r.created_at * 1000, // D1 doesn't track lastSeen; use createdAt
      ua: r.ua ?? '',
    }));
}

export async function revokeSessionForUser(env: Env, userId: number, sid: string): Promise<{ success: boolean }> {
  return revokeSessionSharded(env, userId, sid);
}

export async function getSessionRowForUser(env: Env, userId: number, sid: string) {
  return getSessionSharded(env, userId, sid);
}

export async function revokeAllSessionsForUser(env: Env, userId: number, exceptSid?: string): Promise<{ revoked: number }> {
  return revokeAllSharded(env, userId, exceptSid);
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
  if (!user) {
    return c.json({ error: 'admin required' }, 403);
  }
  try {
    const row = await db(c.env.DB).getUserStatusAdmin(user.id);
    if (!row || row.status !== 'active' || row.role !== 'admin') {
      return c.json({ error: 'admin required' }, 403);
    }
  } catch {
    return c.json({ error: 'admin required' }, 403);
  }
  (c as unknown as { set: (k: string, v: unknown) => void }).set('user', user);
  await next();
};
