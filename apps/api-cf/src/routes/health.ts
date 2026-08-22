import { Hono } from 'hono';
import { Env } from '../lib/context';
import { json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/health', (c) => {
  // no-store: /api/health dipakai frontend untuk failover detection
  // (getAuthApiUrl, apiWithFailover). Kalau Workers Cache menyimpan ini,
  // origin yang sudah mati tetap terlihat sehat → routing salah.
  c.header('Cache-Control', 'no-store');
  return json(c, { status: 'ok' as const, ts: Math.floor(Date.now() / 1000) });
});
