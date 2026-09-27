#!/usr/bin/env node
// One-off: null the author avatar novelid's search card stored as every novel
// catalog row's cover.
//
// Why a one-off and not a migration: the parser bug is fixed in
// packages/sources/novelid/rules.ts, but a stored row cannot self-heal. Two
// guards both refuse the write — syncCatalog only gap-fills columns the owner
// still has blank (novelIngest.ts `filter((c) => isBlank(existing[c]))`), and
// FILL_GAPS_SQL / upsertSeries both wrap the write in COALESCE(NULLIF(col,'')).
// So the next sync never re-reads the series page and never overwrites the
// avatar. Verified before writing this, not assumed.
//
// Why both cover columns: cover_ref points at novel/covers/{id} in B2, and
// those bytes are the avatar too. Nulling only cover_fallback leaves the signed
// /img path as the reader's first choice (NovelCatalog.tsx, [slug].astro), so
// the avatar keeps rendering.
//
// The discriminator is the host, and it is not cosmetic. A search card's <img>
// is an absolute Jetpack CDN URL (i2.wp.com/novelid.org/uploads/author/…), while
// the series page's real cover is a relative /uploads/… that absolute() prefixes
// with https://novelid.org. So a wp.com host can only have come from the card
// rule that caused this, and a novelid.org host is a real cover worth keeping.
// The /uploads/author/ path is NOT a discriminator: authors upload their novel
// cover into that folder, which is why the fixture shows a card image literally
// named "Halal tapi Asing cov.webp".
//
// After this runs, the next catalog sync sees both columns blank, so
// needsDetail() re-reads the series page and the real cover lands. cover_ref
// stays null for these rows — the existing-row path never calls
// uploadNovelCover — so the reader serves cover_fallback from novelid, which is
// the documented no-B2 fallback (novelCover.ts). The B2 avatar objects are left
// orphaned rather than deleted: nothing reads them once cover_ref is null.
//
// Usage:
//   node scripts/fix-novel-avatar-covers.mjs          # dry-run (default)
//   node scripts/fix-novel-avatar-covers.mjs --apply
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

const accs = [1, 2, 3, 4].map((i) => ({
  i,
  token: env[`CF_TOKEN_AKUN${i}`],
  accountId: env[`CF_ACCOUNT_ID_AKUN${i}`],
  uuid: DB_UUID[i],
})).filter((a) => a.token && a.accountId);

// The dot before wp.com is what keeps https://evilwp.com/ out: a GLOB host has
// to end at a wp.com label, not merely contain those characters.
const POISONED = "source = 'novelid' AND cover_fallback GLOB 'https://*.wp.com/*'";

// A statement's answer is two things, and a non-SELECT only has one of them.
// `results` carries rows and is absent for a write, so counting rows off an
// UPDATE reports 0 no matter how many it cleared; `meta.changes` is the write's
// row count (SQLite's sqlite3_total_changes), and it is the only place an UPDATE
// reports its size. Both are returned so each caller reads the one it needs.
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
  const r = j.result?.[0];
  if (!r) return { rows: [], changes: 0 };
  const rows = Array.isArray(r.results?.rows) ? r.results.rows : [];
  return {
    rows: rows.map((row) => Object.fromEntries((r.results.columns ?? []).map((c, i) => [c, row[i]]))),
    changes: Number(r.meta?.changes ?? 0),
  };
};

let total = 0;
for (const acc of accs) {
  const { rows } = await cfRaw(
    acc,
    `SELECT id, title, cover_ref, cover_fallback FROM novel_series WHERE ${POISONED} ORDER BY id`,
  );
  total += rows.length;
  console.log(`akun-${acc.i}: ${rows.length} poisoned row(s)`);
  for (const r of rows) {
    console.log(`  ${r.id} ${JSON.stringify(r.title)}`);
    console.log(`    cover_ref      = ${JSON.stringify(r.cover_ref)}`);
    console.log(`    cover_fallback = ${JSON.stringify(r.cover_fallback)}`);
  }
  if (APPLY && rows.length > 0) {
    const { changes } = await cfRaw(
      acc,
      `UPDATE novel_series SET cover_ref = NULL, cover_fallback = NULL WHERE ${POISONED}`,
    );
    console.log(`  cleared ${changes} row(s)`);
  }
}

console.log(`\ntotal: ${total}`);
if (APPLY) {
  console.log('Next catalog sync re-reads each series page and writes the real cover.');
  console.log('novel:series:* and novel:catalog:* KV keys hold a 600s payload, so they age out on their own.');
} else {
  console.log('DRY-RUN — jalankan ulang dengan --apply untuk men-null kedua kolom cover.');
}
