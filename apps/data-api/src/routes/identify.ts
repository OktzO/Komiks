import { Hono } from 'hono';
import { identifyImage } from '@manga-platform/vision';
import type { Env, Context } from '../lib/context';
import { getDb, json, sha256Hex } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

router.post('/identify', async (c: Context) => {
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

  // Upload to R2 (temporary, lifecycle rule deletes after 1h)
  const uploadKey = `uploads/${crypto.randomUUID()}.${file.type.split('/')[1] || 'jpg'}`;
  await c.env.ASSETS_R2.put(uploadKey, bytes);

  // Get all image hashes from D1 (small table, acceptable for MVP)
  const db = getDb(c);
  const allHashes = await db.getAllImageHashes();

  const { candidates, computedHash } = await identifyImage(bytes, file.type, allHashes);

  // Cache identify result by hash prefix (10min)
  const cacheKey = `identify:${computedHash.slice(0, 8)}`;
  const payload = { candidates, uploaded_key: uploadKey, computed_hash: computedHash };
  c.executionCtx.waitUntil(
    c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 600 }).catch(() => {})
  );

  return json(c, payload);
});
