#!/usr/bin/env node
// Audit + cleanup baris series phantom (slug numerik, upstream 404).
// Usage:
//   node scripts/cleanup-phantom-series.mjs          # dry-run (default)
//   node scripts/cleanup-phantom-series.mjs --apply  # hapus + purge KV
// Kandidat = series.slug numeric-only DAN manga_source_link hanya bacakomik
// (semua kandidat laporan user berpola itu; verifikasi upstream per slug).
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }),
);

const DB_UUID = {
  1: '76606365-0fa5-4c1e-9b55-18a8366ef92a',
  2: '61cbf1b1-508e-4b00-a0e6-dd68528e54ba',
  3: '160d0a4f-fcc1-4cb6-89e2-c65bcc93a340',
  4: 'd2c207fd-4ff4-41ce-b954-760ac33da037',
};
const KV_ID = {
  1: '6205fceab', // diisi dari wrangler.toml bila perlu — KV purge lewat API per-namespace
};
const BACA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const accs = [1, 2, 3, 4].map((i) => ({
  i,
  token: env[`CF_TOKEN_AKUN${i}`],
  accountId: env[`CF_ACCOUNT_ID_AKUN${i}`],
  uuid: DB_UUID[i],
}));

const cfRaw = async (acc, sql, params = []) => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/d1/database/${acc.uuid}/raw`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const j = await res.json();
  if (!j.success) throw new Error(`D1 akun-${acc.i}: ${JSON.stringify(j.errors)}`);
  const r = j.result?.[0]?.results;
  if (!r || !Array.isArray(r.rows)) return [];
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
};

const upstream404 = async (slug) => {
  const res = await fetch(`https://bacakomik.my/komik/${slug}/`, {
    headers: { 'User-Agent': BACA_UA },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res) return false;
  await res.arrayBuffer().catch(() => {});
  return res.status === 404;
};

// 1. Kumpulkan kandidat: slug numeric-only
const kandidat = [];
for (const acc of accs) {
  const rows = await cfRaw(acc,
    `SELECT id, slug, title, type FROM series WHERE slug GLOB '[0-9]*' AND slug NOT GLOB '*[^0-9]*'`,
  );
  for (const r of rows) {
    const links = await cfRaw(acc,
      `SELECT source, source_slug, chapter_count FROM manga_source_link WHERE manga_id = ?1`, [r.id],
    );
    kandidat.push({ acc, series: r, links });
  }
}

console.log(`Kandidat numeric-slug: ${kandidat.length}`);
const phantom = [];
for (const k of kandidat) {
  const slug = k.links[0]?.source_slug ?? k.series.slug;
  const is404 = await upstream404(slug);
  const statuses = k.links.map((l) => `${l.source}:${l.chapter_count}`).join(',') || 'no-links';
  console.log(`  akun-${k.acc.i} series.id=${k.series.id} slug=${k.series.slug} title=${JSON.stringify(k.series.title)} links=[${statuses}] upstream=${is404 ? '404-PHANTOM' : 'ok/skip'}`);
  if (is404) phantom.push(k);
}

console.log(`\nPhantom terverifikasi (upstream 404): ${phantom.length}`);
if (!APPLY) {
  console.log('DRY-RUN — jalankan ulang dengan --apply untuk menghapus + purge KV.');
  process.exit(0);
}

// 2. Hapus: FK cascade akan ikut membersihkan manga_source_link/bookmarks/history
for (const k of phantom) {
  await cfRaw(k.acc, `DELETE FROM series WHERE id = ?1 AND slug = ?2`, [k.series.id, k.series.slug]);
  console.log(`  deleted akun-${k.acc.i} series.id=${k.series.id} slug=${k.series.slug}`);
}

// 3. Purge KV cache resolve (f:resolve:, resolve:, resolve404:, s:/f: resolve) di semua namespace
console.log('\nPurge KV resolve:*');
const namespaces = [];
for (const acc of accs) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces`, {
    headers: { Authorization: `Bearer ${acc.token}` },
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json()).catch(() => null);
  for (const ns of res?.result ?? []) namespaces.push({ acc, id: ns.id, title: ns.title });
}
let purged = 0;
for (const { acc, id, title } of namespaces) {
  for (const prefix of ['resolve:', 'f:resolve:', 'resolve404:', 's:resolve:', 'series:full:bacakomik:11', 'series:full:bacakomik:14', 'series:full:bacakomik:2', 'series:detail:bacakomik:11', 'series:detail:bacakomik:14', 'series:detail:bacakomik:2', 'chapters:list:bacakomik:11', 'chapters:list:bacakomik:14', 'chapters:list:bacakomik:2']) {
    // list keys by prefix, delete each
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces/${id}/keys?prefix=${encodeURIComponent(prefix)}&limit=100`, {
      headers: { Authorization: `Bearer ${acc.token}` },
      signal: AbortSignal.timeout(15000),
    }).then((r) => r.json()).catch(() => null);
    for (const key of listRes?.result ?? []) {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key.name)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${acc.token}` },
        signal: AbortSignal.timeout(15000),
      }).catch(() => {});
      purged++;
    }
  }
}
console.log(`Purged ${purged} keys dari ${namespaces.length} namespace.`);
