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
import { getB2Usage, setB2Usage, quotaBytes, decB2UsageGlobal } from './b2Usage';

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
    const global = await env.DB.prepare('SELECT bytes FROM b2_usage WHERE account_name = ?1')
      .bind(b2Accounts[i].name).first<{ bytes: number }>().catch(() => null);
    if (global && typeof global.bytes === 'number') used = global.bytes;
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

    let decBytes = 0;
    for (const page of stale) {
      if (quota > 0 && used <= target) break;
      const b2 = b2AccountForIdx(b2Accounts, accountIdx);
      if (!b2) break;
      const deleted = await b2DeleteObject(b2, page.r2_key).catch(() => false);
      if (!deleted) continue;
      await clearRowOnOwner(env, page.chapter_id, page.page_number);
      used = Math.max(0, used - 1000000);
      decBytes += 1000000;
      totalEvicted++;
    }
    await setB2Usage(env.CACHE_KV, i, Math.max(0, used));
    if (decBytes > 0) await decB2UsageGlobal(env, b2Accounts[i].name, decBytes).catch(() => {});
    console.log(`[evict] b2:${b2Accounts[i].name} evicted ${totalEvicted} (usage now ${used} bytes)`);
  }

  return { evicted: totalEvicted };
};

interface TempRow { key: string; account_idx: number; bytes: number }

export const cleanupTempObjects = async (env: Env): Promise<{ cleaned: number }> => {
  const cutoff = Math.floor(Date.now() / 1000) - 7200;
  const b2Accounts = resolveB2Accounts(env.B2_CONFIG, env.B2_ACCOUNTS);
  const peers = getPeers(env);
  const perPeer = 100;
  const stale: Array<TempRow & { peer: (typeof peers)[number] }> = [];
  for (const peer of peers) {
    if (peer.self) {
      const found = await env.DB.prepare(
        'SELECT key, account_idx, bytes FROM b2_temp_objects WHERE created_at < ?1 LIMIT ?2'
      ).bind(cutoff, perPeer).all<TempRow>().catch(() => null);
      for (const r of found?.results ?? []) stale.push({ ...r, peer });
    } else {
      const rows = await internalQuery<TempRow>(env, peer.url,
        'SELECT key, account_idx, bytes FROM b2_temp_objects WHERE created_at < ?1 LIMIT ?2',
        [cutoff, perPeer], 'b2_temp_objects').catch(() => null);
      for (const r of rows ?? []) stale.push({ ...r, peer });
    }
  }
  const delSql = 'DELETE FROM b2_temp_objects WHERE key = ?1';
  let cleaned = 0;
  const decByAccount = new Map<string, number>();
  for (const row of stale) {
    const b2 = b2AccountForIdx(b2Accounts, row.account_idx);
    const deleted = b2 ? await b2DeleteObject(b2, row.key).catch(() => false) : false;
    if (!deleted) continue;
    if (row.peer.self) {
      await env.DB.prepare(delSql).bind(row.key).run().catch(() => {});
    } else {
      await internalExec(env, row.peer.url, { sql: delSql, params: [row.key], table: 'b2_temp_objects' }).catch(() => {});
    }
    const arrIdx = row.account_idx < 0 ? -(row.account_idx + 1) : row.account_idx;
    if (arrIdx >= 0 && arrIdx < b2Accounts.length && row.bytes > 0) {
      const used = await getB2Usage(env.CACHE_KV, arrIdx).catch(() => 0);
      await setB2Usage(env.CACHE_KV, arrIdx, Math.max(0, used - row.bytes)).catch(() => {});
      const name = b2Accounts[arrIdx].name;
      decByAccount.set(name, (decByAccount.get(name) ?? 0) + row.bytes);
    }
    cleaned++;
  }
  for (const [name, bytes] of decByAccount) {
    await decB2UsageGlobal(env, name, bytes).catch(() => {});
  }
  return { cleaned };
};
