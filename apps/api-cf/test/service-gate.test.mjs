// Token-only service gate. Test lama menguji jalur Origin/cookie/Turnstile yang
// sengaja dihapus: Origin bisa dipalsuin curl/Postman tanpa alat apa pun, jadi
// tidak pernah jadi bukti asal request. Satu-satunya jalur sah selain exempt =
// x-service-token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { classifyServiceTier, decideServiceGate, serviceGateMw } from '../src/lib/serviceGate.ts';

const stubEnv = (over = {}) => ({
  ALLOWED_ORIGINS: 'https://oktzz.xyz, http://localhost:3000',
  SERVICE_TOKEN: 'test-service-token',
  ...over,
});

// Mini-app: hanya serviceGateMw + catch-all, supaya menguji gate apa adanya
// (index.ts asli juga akan menaruh gate sebelum rute publik).
const app = new Hono();
app.use('*', serviceGateMw);
app.all('*', (c) => c.json({ path: c.req.path, method: c.req.method }));

const go = (path, init = {}, env = stubEnv()) => app.request(path, init, env);
const TOKEN = { headers: { 'x-service-token': 'test-service-token' } };
const SPOOFED = { headers: { origin: 'https://oktzz.xyz' } };

// ── Tier classifier ────────────────────────────────────────────────────────────
test('classifyServiceTier: hanya yang punya credential sendiri yang exempt', () => {
  // Secret/credential sendiri, bukan butuh token web.
  assert.equal(classifyServiceTier('/api/_internal/db/exec', 'POST'), 'exempt');
  assert.equal(classifyServiceTier('/api/scrape', 'GET'), 'exempt');
  // Image: signature HMAC, bukan header (tag <img> tak bisa membawa header).
  assert.equal(classifyServiceTier('/img/komiku/x.webp', 'GET'), 'exempt');
  // Dipanggil client-side lewat proxy (publik, bukan data pengguna).
  assert.equal(classifyServiceTier('/api/health', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/origins', 'GET'), 'exempt');
  // OAuth: state cookie ECDSA + Turnstile, callback dari Google.
  assert.equal(classifyServiceTier('/api/auth/google', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/auth/google/callback', 'GET'), 'exempt');
  // Preflight. HEAD sengaja TIDAK exempt — Hono menjalankan handler GET untuk
  // HEAD, jadi membiarkannya lewat menjadikan keputusan gate sia-sia.
  assert.equal(classifyServiceTier('/anything', 'OPTIONS'), 'exempt');
  assert.equal(classifyServiceTier('/api/series', 'HEAD'), 'deny');
});

test('classifyServiceTier: semua data pengguna butuh token', () => {
  assert.equal(classifyServiceTier('/api/series', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/search?q=x', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/homepage', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/reader/komiku/chapter/abc', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/novel/catalog', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/resolve/komiku', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/identify', 'POST'), 'deny');
  assert.equal(classifyServiceTier('/api/user/me', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/admin/monitoring', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api/user/bookmark/naruto', 'POST'), 'deny');
  // Legacy page proxy juga butuh token — ia melayani data, bukan cuma gambar.
  assert.equal(classifyServiceTier('/api/reader/komiku/page/1234/1', 'GET'), 'deny');
});

test('classifyServiceTier: path tak dikenal ditolak, bukan lolos diam-diam', () => {
  assert.equal(classifyServiceTier('/api/unknown-thing', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/', 'GET'), 'deny');
});

// ── Pure decision ──────────────────────────────────────────────────────────────
test('decideServiceGate: token adalah satu-satunya jalan', () => {
  const decide = (o) => decideServiceGate({ isExempt: false, hasServiceToken: false, ...o });
  assert.equal(decide({ isExempt: true }), 'allow');
  assert.equal(decide({ hasServiceToken: true }), 'allow');
  assert.equal(decide({}), 'deny');
});

// ── E2E middleware ─────────────────────────────────────────────────────────────
test('E2E: exempt lolos tanpa kredensial', async () => {
  assert.equal((await go('/api/health')).status, 200);
  assert.equal((await go('/api/origins')).status, 200);
  assert.equal((await go('/api/auth/google')).status, 200);
  assert.equal((await go('/api/_internal/db/exec', { method: 'POST' })).status, 200);
  assert.equal((await go('/img/komiku/x.webp')).status, 200);
  assert.equal((await go('/anywhere', { method: 'OPTIONS' })).status, 200);
});

test('E2E: tanpa token DITOLAK — termasuk walau Origin di-allowlist', async () => {
  // Regresi yang paling penting. Origin dipalsuin curl/Postman sesuka hati;
  // kalau ia masih memberi akses, penguncian ini tidak berarti apa-apa.
  assert.equal((await go('/api/series')).status, 403);
  assert.equal((await go('/api/series', SPOOFED)).status, 403);
  assert.equal((await go('/api/search', SPOOFED)).status, 403);
  assert.equal((await go('/api/homepage', SPOOFED)).status, 403);
  assert.equal((await go('/api/source-status', SPOOFED)).status, 403);
  assert.equal((await go('/api/user/me', SPOOFED)).status, 403);
  assert.equal((await go('/api/resolve/komiku', SPOOFED)).status, 403);
  assert.equal((await go('/api/novel/catalog', SPOOFED)).status, 403);
});

test('E2E: cookie session palsu bukan kredensial', async () => {
  // Gate tidak lagi menebak "ada cookie = user sah". Session diverifikasi ECDSA
  // di dalam requireSession; gate cuma butuh token.
  const fake = { headers: { cookie: '__Host-session=abc.def.ghi' } };
  assert.equal((await go('/api/user/me', fake)).status, 403);
  assert.equal((await go('/api/admin/monitoring', fake)).status, 403);
});

test('E2E: Turnstile bukan lagi kredensial di gate', async () => {
  // Turnstile tetap ngecek /api/auth/google di routes/auth.ts, tapi gate tidak
  // lagi memanggil siteverify untuk tamu — request-nya tidak pernah sampai.
  assert.equal((await go('/api/resolve/komiku', { headers: { 'x-turnstile-token': '0.abc' } })).status, 403);
  assert.equal((await go('/api/resolve/komiku?turnstile_token=dummy')).status, 403);
});

test('E2E: token benar lolos semua path', async () => {
  assert.equal((await go('/api/series', TOKEN)).status, 200);
  assert.equal((await go('/api/search', TOKEN)).status, 200);
  assert.equal((await go('/api/resolve/komiku', TOKEN)).status, 200);
  assert.equal((await go('/api/user/bookmark/naruto', { ...TOKEN, method: 'POST' })).status, 200);
  assert.equal((await go('/api/admin/monitoring', TOKEN)).status, 200);
  assert.equal((await go('/api/reader/komiku/page/1234/1', TOKEN)).status, 200);
});

test('E2E: token salah ditolak (constant-time compare)', async () => {
  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'wrong' } })).status, 403);
  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'test-service-toke' } })).status, 403);
  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'test-service-tokenx' } })).status, 403);
});

test('E2E: respons 403 tidak ke-cache', async () => {
  const res = await go('/api/series', SPOOFED);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('E2E: SERVICE_TOKEN kosong → gate TIDAK AKTIF (fail-open, dev-friendly)', async () => {
  const env = stubEnv({ SERVICE_TOKEN: '' });
  // Fail-open saat secret kosong menjaga alur dev lokal tetap jalan. Semua
  // worker produksi sudah punya secret terpasang (2026-10-02), jadi cabang ini
  // hanya menyala di mesin tanpa secret.
  assert.equal((await go('/api/series', {}, env)).status, 200);
  assert.equal((await go('/api/admin/monitoring', {}, env)).status, 200);
});
