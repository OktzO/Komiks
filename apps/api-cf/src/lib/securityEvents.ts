import type { Context } from './context';
import { writeWithFallback } from './dbWrite';

// Best-effort security event logging. Never blocks the request path — any
// failure is swallowed. Writes go through writeWithFallback so events land on
// the primary DB (akun-2) where the admin dashboard reads them.
export const recordSecurityEvent = (
  c: Context,
  p: { type: string; severity?: 'low' | 'medium' | 'high' | 'critical'; message?: string | null }
): void => {
  try {
    c.executionCtx.waitUntil(
      writeWithFallback(c, 'security_events',
        'INSERT INTO security_events (type, severity, message, ip, path) VALUES (?1, ?2, ?3, ?4, ?5)',
        [p.type, p.severity ?? 'low', p.message ?? null,
         c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
         c.req.path]).catch(() => {})
    );
  } catch {
    // no-op
  }
};
