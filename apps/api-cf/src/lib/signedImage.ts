import { webcrypto } from 'node:crypto';
import { constantTimeEqualStr } from './auth';

// ── HMAC-SHA256 short-lived signed image URLs (anti-scraping) ──────────────
//
// SIGNED_IMG_SECRET (fail-open saat belum di-set — konsisten dgn SERVICE_TOKEN
// dan TURNSTILE_SECRET_KEY): secret hanya hidup server-side. Worker yang
// menjawab chapter-detail mem-mint imgUrl `/img/...?exp=..&sig=..` (TTL ~25
// menit) dan route `/img/*` mem-verify sebelum menyerve. Browser tidak pernah
// memegang secret — URL yang bocor otomatis mati setelah exp.
//
// Path yang di-sign adalah RAW pathname (bagian sebelum `?`), persis string
// yang `c.req.path` kembalikan pada route /img (Hono memberi raw encoded path,
// bukan decode param). Karena mint dibangun dari template encodeURIComponent
// chapterId yang sama, keduanya selalu cocok — idempoten thd `?retry=N` dan
// chapterId ber-spasi (`chapter%20id` dst).

const enc = new TextEncoder();

// importKey sekali per secret lalu reuse (key HMAC cache per isolate).
const hmacKeyCache = new Map<string, CryptoKey>();
const getHmacKey = async (secret: string): Promise<CryptoKey> => {
  const cached = hmacKeyCache.get(secret);
  if (cached) return cached;
  const key = await webcrypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  hmacKeyCache.set(secret, key);
  return key;
};

const hmacHex = async (secret: string, msg: string): Promise<string> => {
  const key = await getHmacKey(secret);
  const sig = await webcrypto.subtle.sign({ name: 'HMAC' }, key, enc.encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

export type SignedImg = { exp: number; sig: string };

// Mint: sig = HMAC-SHA256(secret, `${path}|${exp}`) hex. TTL dihitung dari
// `nowSec` (dipisah utk testability; pemakai production pass Math.floor(Date.now()/1000)).
export const signImgPath = async (
  secret: string,
  path: string,
  ttlSeconds: number,
  nowSec: number
): Promise<SignedImg> => {
  const exp = Math.floor(nowSec) + Math.floor(ttlSeconds);
  const sig = await hmacHex(secret, `${path}|${exp}`);
  return { exp, sig };
};

// Verify: recompute HMAC + constant-time compare, dan tolak exp yang (a) bukan
// integer positif, atau (b) sudah lewat lebih dari graceSeconds (clock skew).
export const verifyImgSig = async (
  secret: string,
  path: string,
  exp: number,
  sig: string,
  nowSec: number,
  graceSeconds: number
): Promise<boolean> => {
  if (!secret) return false; // secret kosong → jangan pernah loloskan apa pun
  const e = Number(exp);
  if (!Number.isInteger(e) || e <= 0) return false;
  if (e < Math.floor(nowSec) - Math.floor(graceSeconds)) return false; // expired
  const expected = await hmacHex(secret, `${path}|${e}`);
  if (typeof sig !== 'string') return false;
  return constantTimeEqualStr(sig, expected);
};