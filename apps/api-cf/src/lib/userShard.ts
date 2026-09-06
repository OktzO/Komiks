import type { Env } from './context';
import { db } from '@manga-platform/db';
import { ownerFor, internalExec, internalQuery } from './peers';
import { enqueueOutbox } from './dbWrite';

export const userOwner = (env: Env, userId: number) => ownerFor(env, String(userId));

export const execOnUserOwner = async (
  env: Env,
  userId: number,
  sql: string,
  params: unknown[],
  table: string
): Promise<boolean> => {
  const owner = userOwner(env, userId);
  if (owner.self) {
    try {
      const stmt = env.DB.prepare(sql);
      const bound = params.length > 0 ? stmt.bind(...(params as unknown[])) : stmt;
      const r = await bound.run();
      return !!r.success;
    } catch {
      return false;
    }
  }
  const ok = await internalExec(env, owner.url, { sql, params, table });
  if (!ok) {
    await enqueueOutbox(env, owner.url, table, sql, params).catch(() => {});
    try {
      const stmt = env.DB.prepare(sql);
      const bound = params.length > 0 ? stmt.bind(...(params as unknown[])) : stmt;
      const r = await bound.run();
      return !!r.success;
    } catch {
      return false;
    }
  }
  return true;
};

export const queryOnUserOwner = async <T>(
  env: Env,
  userId: number,
  sql: string,
  params: unknown[],
  table: string
): Promise<T[] | null> => {
  const owner = userOwner(env, userId);
  if (owner.self) {
    try {
      const stmt = env.DB.prepare(sql);
      const bound = params.length > 0 ? stmt.bind(...(params as unknown[])) : stmt;
      const { results } = await bound.all();
      return (results ?? []) as T[];
    } catch {
      return null;
    }
  }
  const rows = await internalQuery<T>(env, owner.url, sql, params, table).catch(() => null);
  if (rows !== null) return rows;
  try {
    const stmt = env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...(params as unknown[])) : stmt;
    const { results } = await bound.all();
    return (results ?? []) as T[];
  } catch {
    return null;
  }
};

export const localDb = (env: Env) => db(env.DB);
