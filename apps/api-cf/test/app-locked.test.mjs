// Theorem of the whole change, diuji terhadap app NYATA (bukan mini-app
// rekonstruksi): GET /api/series tanpa token harus 403.
//
// Test suite lain sengaja memakai mini-app supaya tidak perlu stubbing D1/KV.
// Konsekuensinya mount order di index.ts hanya pernah dicek sebagai teks source.
// Test ini yang menutup celah itu — dia mengimpor app apa adanya.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { app } = await import('../src/index.ts');

const env = (over = {}) => ({
  DB: {
    prepare: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }),
    batch: async () => [],
  },
  CACHE_KV: {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  },
  ALLOWED_ORIGINS: 'https://oktzz.xyz, http://localhost:3000',
  SERVICE_TOKEN: 'test-service-token',
  PEER_URLS: '',
  ...over,
});

const TOKEN = { headers: { 'x-service-token': 'test-service-token' } };
const SPOOFED = { headers: { origin: 'https://oktzz.xyz' } };

test('app nyata: /api/series tanpa token → 403', async () => {
  assert.equal((await app.request('/api/series', {}, env())).status, 403);
});

test('app nyata: spoofed Origin tetap 403', async () => {
  assert.equal((await app.request('/api/series', SPOOFED, env())).status, 403);
  assert.equal((await app.request('/api/homepage', SPOOFED, env())).status, 403);
  assert.equal((await app.request('/api/user/me', SPOOFED, env())).status, 403);
});

test('app nyata: token benar → 200 di endpoint yang tidak butuh DB', async () => {
  // /api/health exempt, jadi tidak membuktikan apa pun soal token. Yang benar-benar butuh token adalah
  // /api/homepage, tapi ia menyentuh KV+upstream, jadi diuji di route lain.
  // Yang dijaga di sini: token tidak merusak jalur exempt yang memang bebas.
  assert.equal((await app.request('/api/health', TOKEN, env())).status, 200);
});

test('app nyata: OPTIONS tidak lagi di-short-circuit corsMw', async () => {
  // corsMw dulu menjawab OPTIONS dengan 204 sebelum gate. Sekarang ia hilang,
  // jadi OPTIONS jatuh ke router dan tidak ada handler-nya → 404. Yang penting
  // di sini: tidak ada 403, jadi preflight tidak tersangkut di gate.
  const res = await app.request('/api/series', { method: 'OPTIONS' }, env());
  assert.notEqual(res.status, 403, 'OPTIONS di-block gate — preflight rusak');
});

test('app nyata: /api/health tetap terbuka tanpa token', async () => {
  assert.equal((await app.request('/api/health', {}, env())).status, 200);
});

test('app nyata: respons tidak menulis header CORS apa pun', async () => {
  // corsMw dihapus; tidak boleh ada Access-Control-* yang tersisa di respons
  // mana pun, kalau tidak ada yang mengadd-nya lagi.
  const res = await app.request('/api/health', {}, env());
  for (const h of [
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-max-age',
  ]) {
    assert.equal(res.headers.get(h), null, `${h} masih ada`);
  }
});

