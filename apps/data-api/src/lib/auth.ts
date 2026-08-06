import type { MiddlewareHandler } from 'hono';
import type { Env, Context } from './context';

// Constant-time compare to prevent timing attacks on admin key.
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const requireAdminKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const supplied = c.req.header('x-admin-api-key');
  const expected = c.env.SCRAPE_API_KEY;
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    return c.json({ error: 'admin api key required' }, 401);
  }
  await next();
};
