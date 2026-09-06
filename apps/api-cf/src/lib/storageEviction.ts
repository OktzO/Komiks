// LRU storage eviction — usage-based, lazy (reader trigger) + cron (akun-1).
// Goal: hapus objek B2 yang last_access > N hari (default 30) ketika usage
// akun > 80% kuota. Turun ke 70% lalu stop.
//
// chapter_pages kini di-shard lintas 3 D1 (owner by chapterId), jadi query
// stale + clear row HARUS jalan ke owner D1 (self = local, peer = internal).
import type { Env } from './context';
import { db } from '@manga-platform/db';
import { resolveB2Accounts, b2AccountForIdx } from './b2Config';
import { b2DeleteObject } from './s3Upload';
import { getPeers, ownerFor, internalQuery, internalExec } from './peers';
import { getB2Usage, setB2Usage, quotaBytes } from './b2Usage';

const EVICT_THRESHOLD = 0.8;   // > 80% → evict
const EVICT_TARGET = 0.7;      // turun sampai ≤ 70%
const DEFAULT_EVICT_DAYS = 30;

const STALE_SELECT_SQL =
  'SELECT chapter_id, page_number, r2_key FROM chapter_pages WHERE r2_account_idx = ?1 AND (last_access IS NULL OR last_access < ?2) ORDER BY last_access ASC NULLS FIRST LIMIT ?3';
const CLEAR_SQL =
  'UPDATE chapter_pages SET r2_key = NULL, r2_account_idx = NULL WHERE chapter_id = ?1 AND page_number = ?2';

interface StaleRow { chapter_id: string; page_number: number; r2_key: string }

const clearRowOnOwner = async (env: Env, chapterId: string, pageNo: number): Promise<void> => {
  const owner = ownerFor(env, chapterId);
  if (owner.self) {
    await db(env.DB).clearPageStorage(chapterId, pageNo).catch(() => {});
  } else {
    await internalExec(env, owner.url, {
      sql: CLEAR_SQL,
      params: [chapterId, pageNo],
      table: 'chapter_pages',
    }).catch(() => {});
  }
  await env.CACHE_KV.delete(`imgrows:${chapterId}`).catch(() => {});
};

export const evictStaleStorage = async (env: Env): Promise<{ evicted: number }> => {
  const evictDays = Number(env.B2_EVICTION_DAYS) || DEFAULT_EVICT_DAYS;
  const staleBeforeTs = Math.floor(Date.now() / 1000) - evictDays * 86400;
  const b2Accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
  const peers = getPeers(env);
  let totalEvicted = 0;

  for (let i = 0; i < b2Accounts.length; i++) {
    const accountIdx = -(i + 1);
    const quota = quotaBytes(env);
    let used = await getB2Usage(env.CACHE_KV, i).catch(() => 0);
    if (quota > 0 && used / quota <= EVICT_THRESHOLD) continue;
    const target = Math.floor(quota * EVICT_TARGET);

    // Kumpulkan halaman stale dari SEMUA shard (owner D1). Self → db helper,
    // peer → internal /db/query.
    const stale: StaleRow[] = [];
    const limitPerPeer = 100;
    for (const peer of peers) {
      if (peer.self) {
        const rows = await db(env.DB).listStalePages(accountIdx, staleBeforeTs, limitPerPeer).catch(() => []);
        for (const r of rows) stale.push({ chapter_id: r.chapter_id, page_number: r.page_number, r2_key: r.r2_key });
      } else {
        const rows = await internalQuery<StaleRow>(env, peer.url, STALE_SELECT_SQL, [accountIdx, staleBeforeTs, limitPerPeer], 'chapter_pages').catch(() => null);
        for (const r of rows ?? []) stale.push(r);
      }
    }

    for (const page of stale) {
      if (quota > 0 && used <= target) break;
      const b2 = b2AccountForIdx(b2Accounts, accountIdx);
      if (!b2) break;
      const deleted = await b2DeleteObject(b2, page.r2_key).catch(() => false);
      if (!deleted) continue;
      await clearRowOnOwner(env, page.chapter_id, page.page_number);
      used = Math.max(0, used - 1000000); // approx 1MB/obj decrement
      totalEvicted++;
    }
    await setB2Usage(env.CACHE_KV, i, Math.max(0, used));
    console.log(`[evict] b2:${b2Accounts[i].name} evicted ${totalEvicted} (usage now ${used} bytes)`);
  }

  return { evicted: totalEvicted };
};
