// Shard-aware read seam for the novel tables.
//
// novel_series and novel_chapters shard by series id (murmur3_32 % N, the same
// ring apps/api-cf/src/lib/peers.ts ownerFor already implements), so a read that
// only touched the local D1 would 404 a series owned by a peer. The forward is
// /api/_internal/db/query, which is read-only and table-allowlisted server-side.
//
// Why a D1-shaped facade instead of hand-written forwarded SQL: novelDb owns the
// column lists and predicates, so mirroring them here would be a second copy to
// keep in step. Wrapping the peer as a D1 means every novel read is shard-correct
// for free, including reads added later.
import type { D1Database, D1Result } from '@cloudflare/workers-types';
import { novelDb } from '@manga-platform/db';
import type { Env } from './context';
import { getPeers, internalQuery, ownerFor } from './peers';

// Only these may be forwarded. Anything else falls through to the local D1, so
// a future novelDb method cannot accidentally turn a read into a peer write.
const FORWARDABLE = new Set(['novel_series', 'novel_chapters']);
const TABLE_IN_SQL = /\bFROM\s+([a-z_][a-z0-9_]*)/i;

const D1_META = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
} as const;

/** Reads through the owner peer, falling back to the local D1 if the forward
 *  fails — a peer being down must not turn a stored series into a 404. */
const peerReadD1 = (env: Env, peerUrl: string): D1Database => {
  const local = <T>(sql: string, args: unknown[]) => {
    const stmt = env.DB.prepare(sql);
    const bound = args.length > 0 ? stmt.bind(...args) : stmt;
    return bound;
  };
  const runAll = async <T>(sql: string, args: unknown[]): Promise<T[]> => {
    const table = TABLE_IN_SQL.exec(sql)?.[1];
    if (table && FORWARDABLE.has(table)) {
      const rows = await internalQuery<T>(env, peerUrl, sql, args, table).catch(() => null);
      if (rows !== null) return rows;
    }
    const res = await local(sql, args).all<T>().catch(() => null);
    return res?.results ?? [];
  };
  const client: D1Database = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...values: unknown[]) { stmt.args = values; return stmt; },
        async first<T>(): Promise<T | null> {
          const rows = await runAll<T>(sql, stmt.args);
          return rows[0] ?? null;
        },
        async all<T>(): Promise<D1Result<T>> {
          return { success: true, meta: { ...D1_META }, results: await runAll<T>(sql, stmt.args) };
        },
        async run(): Promise<never> { throw new Error('novelShard: run() on a read-only facade'); },
        async raw(): Promise<never> { throw new Error('novelShard: raw() on a read-only facade'); },
      };
      return stmt;
    },
    async batch(): Promise<never> { throw new Error('novelShard: batch() on a read-only facade'); },
    async exec(): Promise<never> { throw new Error('novelShard: exec() on a read-only facade'); },
    async dump(): Promise<never> { throw new Error('novelShard: dump() on a read-only facade'); },
    withSession(): never { throw new Error('novelShard: withSession() on a read-only facade'); },
  };
  return client;
};

/** novelDb bound to the shard that owns `seriesId`. */
export const novelDbFor = (env: Env, seriesId: string) => {
  const owner = ownerFor(env, seriesId);
  return novelDb(owner.self ? env.DB : peerReadD1(env, owner.url));
};

/** novelDb bound to one specific peer's D1, for queries with no single owner. */
export const novelDbOn = (env: Env, peerUrl: string): ReturnType<typeof novelDb> =>
  novelDb(peerUrl === '' ? env.DB : peerReadD1(env, peerUrl));

/** Every shard except this one. The catalog is not sharded by key, so listing it
 *  means asking all of them. */
export const peerUrls = (env: Env): string[] =>
  getPeers(env).filter((p) => !p.self).map((p) => p.url);
