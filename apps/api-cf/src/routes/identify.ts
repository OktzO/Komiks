import { Hono } from 'hono';
import { identifyImage } from '@manga-platform/vision';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';
import { resolveB2Accounts, pickB2Account, type B2Account } from '../lib/b2Config.ts';
import { b2PutObject } from '../lib/s3Upload.ts';

export const router = new Hono<{ Bindings: Env }>();

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

const getB2Accounts = (env: Env): B2Account[] => resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);

// KV-cached image-hash set. Loading the full image_hashes table on every
// /identify request was an O(n) DoS vector (unbounded table scan + JS loop).
// Cache the snapshot in KV for 5 minutes; only the first miss per window
// hits D1.
const HASH_SET_KEY = 'identify:hashes:snapshot';
const HASH_SET_TTL = 300;

type HashSet = Array<{ series_slug: string; hash: string; r2_key: string | null }>;

const getHashSet = async (c: Context): Promise<HashSet> => {
  const cached = await c.env.CACHE_KV.get(HASH_SET_KEY, { type: 'json' }).catch(() => null);
  if (cached) return cached as HashSet;
  const db = getDb(c);
  const allHashes = await db.getAllImageHashes();
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(HASH_SET_KEY, JSON.stringify(allHashes), { expirationTtl: HASH_SET_TTL }).catch(() => {})
  );
  return allHashes;
};

router.post('/identify', async (c: Context) => {
  // Result cache by computed-hash prefix — short-circuits the D1+CPU work
  // for repeated uploads of the same image.
  const formData = await c.req.formData();
  const file = formData.get('image');
  if (!(file instanceof File)) {
    return json(c, { error: 'image field required (multipart/form-data)' }, 400);
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return json(c, { error: 'image too large (max 10MB)' }, 413);
  }
  if (!file.type.startsWith('image/')) {
    return json(c, { error: 'file must be image/*' }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Upload ke B2 (temporary — lifecycle rule hapus setelah 1h)
  const uploadKey = `uploads/${crypto.randomUUID()}.${file.type.split('/')[1] || 'jpg'}`;
  const b2Accounts = getB2Accounts(c.env);
  if (b2Accounts.length > 0) {
    const arrBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const b2 = pickB2Account(b2Accounts, uploadKey);
    if (b2) c.executionCtx.waitUntil(b2PutObject(b2, uploadKey, arrBuf, file.type).catch(() => {}));
  }

  const allHashes = await getHashSet(c);

  const { candidates, computedHash } = await identifyImage(bytes, file.type, allHashes);

  // Cache identify result by hash prefix (10min)
  const cacheKey = `identify:${computedHash.slice(0, 8)}`;
  const payload = { candidates, uploaded_key: uploadKey, computed_hash: computedHash };
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 }).catch(() => {})
  );

  return json(c, payload);
});
