import type { MiddlewareHandler } from 'hono';
import type { Env } from './context';

const makeLimiter = (limit: number, window: number): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const key = `ratelimit:${ip}:${Math.floor(Date.now() / 1000 / window)}`;
    const raw = await c.env.CACHE_KV.get(key);
    const count = raw ? Number(raw) : 0;
    if (count >= limit) {
      return c.json({ error: 'rate limit exceeded', retry_after: window }, 429);
    }
    c.executionCtx.waitUntil(c.env.CACHE_KV.put(key, String(count + 1), { expirationTtl: window }).catch(() => {}));
    await next();
  };
};

export const rateLimitPublic = makeLimiter(60, 60);
export const rateLimitIdentify = makeLimiter(10, 60);
export const rateLimitAdmin = makeLimiter(600, 60);
