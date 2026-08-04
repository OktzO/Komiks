import type { MiddlewareHandler } from 'hono';
import type { Env, Context } from './context';

const LIMIT = 60;
const WINDOW = 60;

export const rateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const key = `ratelimit:${ip}:${Math.floor(Date.now() / 1000 / WINDOW)}`;
  const raw = await c.env.CACHE_KV.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= LIMIT) {
    return c.json({ error: 'rate limit exceeded', retry_after: WINDOW }, 429);
  }
  c.executionCtx.waitUntil(c.env.CACHE_KV.put(key, String(count + 1), { expirationTtl: WINDOW }).catch(() => {}));
  await next();
};
