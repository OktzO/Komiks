import { Hono } from 'hono';
import type { Env, Context } from '../lib/context';
import { getDb, json } from '../lib/context';

export const router = new Hono<{ Bindings: Env }>();

type Check = { healthy: boolean; latency_ms: number | null; error: string | null; checked_at: number };

const HISTORY_LIMIT = 40;

// Status + riwayat pengecekan terakhir per sumber. `history` diurutkan
// terbaru dulu (DESC); uptime_pct dihitung dari window riwayat tsb.
router.get('/source-status', async (c: Context) => {
  const db = getDb(c);
  const sources: {
    source: string;
    healthy: boolean;
    latency_ms: number | null;
    last_checked_at: number;
    error: string | null;
    uptime_pct: number | null;
    history: Check[];
  }[] = [];

  for (const key of ['komiku', 'bacakomik', 'thrive', 'shinigami', 'manhwaindo', 'webtoon'] as const) {
    const row = await db.getLatestSourceHealth(key);
    const history = await db.getSourceHistory(key, HISTORY_LIMIT);
    const uptime = history.length > 0
      ? Math.round((history.filter((h) => h.healthy).length / history.length) * 1000) / 10
      : null;
    sources.push({
      source: row?.source ?? key,
      healthy: row?.healthy ?? false,
      latency_ms: row?.latency_ms ?? 0,
      last_checked_at: row?.checked_at ?? 0,
      error: row?.error ?? (row ? null : 'no activity recorded yet'),
      uptime_pct: uptime,
      history,
    });
  }

  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return json(c, { data: sources });
});