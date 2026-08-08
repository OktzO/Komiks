import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

router.get('/source-status', async (c: Context) => {
  const db = getDb(c);
  const sources: { source: string; healthy: boolean; latency_ms: number | null; last_checked_at: number; error?: string | null }[] = [];

  for (const key of ['komiku', 'bacakomik', 'manhwaindo'] as const) {
    const row = await db.getLatestSourceHealth(key);
    if (row) {
      sources.push({
        source: row.source,
        healthy: row.healthy,
        latency_ms: row.latency_ms ?? 0,
        last_checked_at: row.checked_at,
        error: row.error,
      });
    } else {
      sources.push({ source: key, healthy: false, latency_ms: 0, last_checked_at: 0, error: 'no activity recorded yet' });
    }
  }

  return json(c, { data: sources });
});
