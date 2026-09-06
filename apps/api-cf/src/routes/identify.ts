import { Hono } from 'hono';
import { identifyImage } from '@manga-platform/vision';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';
import { resolveB2Accounts, pickB2AccountIdx, type B2Account } from '../lib/b2Config.ts';
import { b2PutObject } from '../lib/s3Upload.ts';
import { addB2Usage, addB2UsageGlobal } from '../lib/b2Usage';

export const router = new Hono<{ Bindings: Env }>();

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

const getB2Accounts = (env: Env): B2Account[] => resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);

// Magic-byte sniff: JPEG FF D8 FF, PNG 89 50 4E 47, WebP RIFF....WEBP.
const sniffImageExt = (b: Uint8Array): 'jpg' | 'png' | 'webp' | null => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
};

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
  const cl = c.req.header('content-length');
  if (cl && Number(cl) > 11 * 1024 * 1024) {
    return json(c, { error: 'image too large (max 10MB)' }, 413);
  }
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
  const ext = sniffImageExt(bytes);
  if (!ext) {
    return json(c, { error: 'unsupported image type (jpg/png/webp only)' }, 400);
  }
  const contentType = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/webp';

  const uploadKey = `uploads/${crypto.randomUUID()}.${ext}`;
  const b2Accounts = getB2Accounts(c.env);
  if (b2Accounts.length > 0) {
    const arrBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const idx = pickB2AccountIdx(b2Accounts, uploadKey);
    const b2 = b2Accounts[idx] ?? null;
    if (b2) {
      const accountIdx = -(idx + 1);
      const size = arrBuf.byteLength;
      c.executionCtx.waitUntil((async () => {
        const res = await b2PutObject(b2, uploadKey, arrBuf, contentType);
        if (!res.ok) return;
        await addB2Usage(c.env.CACHE_KV, idx, size).catch(() => {});
        await addB2UsageGlobal(c, b2.name, size).catch(() => {});
        await c.env.DB.prepare('INSERT INTO b2_temp_objects (key, account_idx, bytes, created_at) VALUES (?1, ?2, ?3, ?4)').bind(uploadKey, accountIdx, size, Math.floor(Date.now() / 1000)).run().catch(() => {});
      })().catch(() => {}));
    }
  }

  const allHashes = await getHashSet(c);

  const { candidates, computedHash } = await identifyImage(bytes, contentType, allHashes);

  // Cache identify result by hash prefix (10min)
  const cacheKey = `identify:${computedHash.slice(0, 8)}`;
  const payload = { candidates, uploaded_key: uploadKey, computed_hash: computedHash };
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 }).catch(() => {})
  );

  return json(c, payload);
});
