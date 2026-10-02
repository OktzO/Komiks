// corsMw hanya menambah header CORS ke respons; request tetap dieksekusi
// server-side. Setelah semua trafik browser lewat proxy same-origin,
// middleware itu jadi sia-sia — dan menghapusnya yang benar-benar mematikan
// kelas serangan CSRF, bukan hanya menyembunyikan gejalanya.
//
// Test ini mengunci ketiadaannya di source, dengan pola yang sama seperti
// rate-limit-mount.test.mjs: substring search tidak bisa membedakan bentuk
// mount yang benar dari yang salah, jadi bentuknya diperiksa lewat regex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX = new URL('../src/index.ts', import.meta.url);
const source = readFileSync(fileURLToPath(INDEX), 'utf8');

test('index.ts tidak mendefinisikan middleware CORS', () => {
  assert.ok(!/const\s+corsMw/.test(source), 'corsMw masih didefinisikan');
  assert.ok(!/SAFE_METHODS/.test(source), 'SAFE_METHODS masih ada');
});

test('index.ts tidak me-mount middleware CORS', () => {
  assert.ok(!/app\.use\('\*',\s*corsMw\)/.test(source), 'corsMw masih di-mount');
});

test('index.ts tidak menulis header CORS ke respons', () => {
  for (const header of [
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Credentials',
    'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers',
    'Access-Control-Max-Age',
  ]) {
    assert.ok(!source.includes(header), `header ${header} masih ditulis`);
  }
});

test('token gate dipasang SETELAH router bercredential sendiri, SEBELUM route data', () => {
  const gateAt = source.indexOf("app.use('*', serviceGateMw)");
  assert.ok(gateAt > -1, 'serviceGateMw tidak ter-mount');
  const internal = source.indexOf("app.route('/api/_internal', internalRouter)");
  const img = source.indexOf("app.route('/img', imgRouter)");
  const health = source.indexOf("app.route('/api', healthRouter)");
  const series = source.indexOf("app.route('/api', seriesRouter)");
  // /api/_internal (x-db-forward-key) dan /img (signature HMAC) punya
  // credential sendiri dan harus TIDAK melewati token gate — kalau tidak, worker
  // API tidak akan pernah bisa bicara dengan peer-nya sendiri.
  assert.ok(gateAt > internal, 'gate dipasang sebelum /api/_internal — peer DB forward akan ditolak');
  assert.ok(gateAt > img, 'gate dipasang sebelum /img — gambar bertanda tangan akan ditolak');
  // Tapi tetap sebelum route data, atau gate tidakmenjaga apa pun.
  assert.ok(gateAt < health, 'gate dipasang setelah route health');
  assert.ok(gateAt < series, 'gate dipasang setelah route series');
});

test('index.ts masih memasang security headers di semua respons', () => {
  assert.ok(/app\.use\('\*',\s*securityHeadersMw\)/.test(source));
});
