// Cache-Control: no-store untuk /api di sisi manga-web.
//
// Worker API sudah punya noStoreMw untuk /api/user/*, /api/admin/*, /api/auth/*,
// /api/_internal/* — tapi sisi web tidak, dan middleware web punya cache edge
// sendiri dengan TTL 300s. Tanpa no-store di sini, respons per-user (bookmark,
// /api/user/me, dashboard admin) yang lewat proxy akan ditahan dan disajikan
// ke visitor berikutnya.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../src/middleware.ts', import.meta.url)), 'utf8');

const noStoreEntries = (): string[] => {
  const match = source.match(/const NO_STORE = \[([^\]]*)\]/);
  assert.ok(match, 'NO_STORE tidak ditemukan');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

test('NO_STORE mencakup /api', () => {
  assert.ok(noStoreEntries().includes('/api'), '/api belum ada di NO_STORE');
});

test('path halaman yang sudah ada tetap utuh', () => {
  const entries = noStoreEntries();
  for (const p of ['/bookmark', '/history', '/profile', '/login', '/admin']) {
    assert.ok(entries.includes(p), `${p} hilang dari NO_STORE`);
  }
});

test('pencocokan NO_STORE berbasis prefix dengan batas slash', () => {
  // Kalau match-nya startsWith('/api'), maka '/apixyz' ikut kena — bukan
  // masalah besar, tapi '/api' sendiri juga harus benar-benar ter-cover.
  const match = source.match(/NO_STORE\.some\(\(s\) => (p === s \|\| p\.startsWith\(s \+ '\/'\))\)/);
  assert.ok(match, 'pencocokan NO_STORE berubah bentuk');
});

test('cache edge tidak menyalakan diri untuk /api', () => {
  // cacheable wajib false kalau noStore true — kalau tidak, no-store hanya
  // sets header dan respons tetap tersimpan di cache.
  const cacheable = source.match(/const cacheable =([\s\S]*?);/);
  assert.ok(cacheable, 'blok cacheable tidak ditemukan');
  assert.ok(
    /!noStore/.test(cacheable[1]),
    'cacheable tidak memeriksa noStore — /api akan tetap masuk cache edge'
  );
});
