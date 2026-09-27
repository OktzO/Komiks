// Novel covers ride the existing R2/B2 + signed /img pipeline (spec 6.8: no new
// image path). The bytes live in B2, the credential stays server-side, and a
// reader's IP and UA never reach the source.
//
// The key is defined here and nowhere else, the way b2KeyFor is for chapter
// pages: the ingest that writes it and the /img route that reads it must agree.
import { resolveB2Accounts, pickB2AccountIdx } from './b2Config.ts';
import type { B2Account } from './b2Config.ts';
import { b2PutObject } from './s3Upload.ts';
import { addB2Usage, addB2UsageGlobal } from './b2Usage';
import { retryUpstream } from './retry';
import type { Context, Env } from './context';

export const novelCoverKey = (seriesId: string): string => `novel/covers/${seriesId}`;

// The URL comes out of a scraped page, so the fetch is host-checked before it
// runs — the same guard admin/scrape.ts applies to a manga cover. novelid
// serves its uploads through Jetpack's CDN rather than its own host.
const COVER_HOST_SUFFIXES = ['novelid.org', 'wp.com'];

const hostAllowed = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return COVER_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
};

const accountsFor = (env: Env): B2Account[] =>
  resolveB2Accounts(env.B2_CONFIG as string | undefined, env.B2_ACCOUNTS as string | undefined);

/**
 * Fetches a series cover and stores it, returning the B2 key or null.
 *
 * Null is every failure — no B2 account, a host that is not a novelid CDN, a
 * non-image response, an upload that did not land. The caller keeps
 * `cover_fallback` in every one of those cases, so the reader always has a cover;
 * what changes is only whether the reader's request reaches the source.
 */
export const uploadNovelCover = async (
  env: Env,
  seriesId: string,
  coverUrl: string | null | undefined
): Promise<string | null> => {
  if (!coverUrl?.trim() || !hostAllowed(coverUrl)) return null;
  const accounts = accountsFor(env);
  if (accounts.length === 0) return null;

  let contentType: string;
  let bytes: Uint8Array;
  try {
    const res = await retryUpstream(() => fetch(coverUrl, { signal: AbortSignal.timeout(10000) }));
    contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.startsWith('image/')) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.error(`[novel] cover fetch failed for ${seriesId}: ${e}`);
    return null;
  }
  if (bytes.byteLength === 0) return null;

  const key = novelCoverKey(seriesId);
  const idx = pickB2AccountIdx(accounts, key);
  const account = accounts[idx];
  if (!account) return null;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const res = await b2PutObject(account, key, body, contentType).catch((e) => {
    console.error(`[novel] cover upload failed for ${seriesId}: ${e}`);
    return null;
  });
  if (!res?.ok) return null;

  // Same accounting admin/scrape.ts does. addB2UsageGlobal wants a Context and
  // the cron has none, so it gets the same stand-in index.ts:snapshotUsage uses.
  await addB2Usage(env.CACHE_KV, idx, bytes.byteLength).catch(() => {});
  const fakeCtx = { env, executionCtx: { waitUntil: (p: Promise<unknown>) => void p } } as unknown as Context;
  await addB2UsageGlobal(fakeCtx, account.name, bytes.byteLength).catch(() => {});
  return key;
};
