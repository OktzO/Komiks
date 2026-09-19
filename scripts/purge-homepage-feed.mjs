#!/usr/bin/env node
// Purge homepage feed KV + trigger cron refresh
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }),
);

const KEYS = ['homepage:feed', 'f:homepage:feed', 's:homepage:feed'];

for (const n of [1, 2, 3, 4]) {
  const token = env[`CF_TOKEN_AKUN${n}`];
  const accountId = env[`CF_ACCOUNT_ID_AKUN${n}`];
  if (!token || !accountId) continue;
  const headers = { Authorization: `Bearer ${token}` };

  const nsJson = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { headers }).then((r) => r.json()).catch(() => null);
  const ns = (nsJson?.result ?? []).find((x) => x.title.includes('CACHE_KV'));
  if (!ns) { console.log(`akun-${n}: no CACHE_KV namespace`); continue; }

  for (const k of KEYS) {
    const del = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${ns.id}/values/${encodeURIComponent(k)}`, { method: 'DELETE', headers });
    console.log(`akun-${n} ${k} -> ${del.status}`);
  }
  // Trigger cron manually: call the internal endpoint that does homepage refresh
  // POST /api/_internal/cron/homepage-refresh (if exists) or just wait for next cron
}
console.log('Done. Homepage feed purged. Next cron (hourly) will rebuild.');