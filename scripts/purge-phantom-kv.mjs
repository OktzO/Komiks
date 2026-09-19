#!/usr/bin/env node
// Purge KV cache resolve/series terkait phantom series. Config read-only dari .env.
// Hanya menyentuh namespace berjudul *CACHE_KV milik API workers.
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }),
);

const PREFIXES = [
  'resolve:', 'f:resolve:', 'resolve404:', 's:resolve:',
  'series:full:bacakomik:11', 'series:full:bacakomik:14', 'series:full:bacakomik:2',
  'series:detail:bacakomik:11', 'series:detail:bacakomik:14', 'series:detail:bacakomik:2',
  'chapters:list:bacakomik:11', 'chapters:list:bacakomik:14', 'chapters:list:bacakomik:2',
  'sources:bacakomik:11', 'sources:bacakomik:14', 'sources:bacakomik:2',
  'slug:11', 'slug:14',
];

let purged = 0;
for (const n of [1, 2, 3, 4]) {
  const token = env[`CF_TOKEN_AKUN${n}`];
  const accountId = env[`CF_ACCOUNT_ID_AKUN${n}`];
  if (!token || !accountId) continue;
  const headers = { Authorization: `Bearer ${token}` };

  const nsJson = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { headers }).then((r) => r.json()).catch(() => null);
  const namespaces = (nsJson?.result ?? []).filter((ns) => ns.title.includes('CACHE_KV'));
  for (const ns of namespaces) {
    for (const prefix of PREFIXES) {
      const listJson = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns.id}/keys?prefix=${encodeURIComponent(prefix)}&limit=100`, { headers }).then((r) => r.json()).catch(() => null);
      for (const key of listJson?.result ?? []) {
        const del = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns.id}/values/${encodeURIComponent(key.name)}`, { method: 'DELETE', headers });
        if (del.ok) purged++;
      }
    }
  }
}
console.log(`purged: ${purged}`);
