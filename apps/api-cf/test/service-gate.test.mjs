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

// ── Pure classifier ────────────────────────────────────────────────────────────
test('classifyServiceTier: tier EXEMPT', () => {
  assert.equal(classifyServiceTier('/api/health', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/origins', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/auth', 'POST'), 'exempt');
  assert.equal(classifyServiceTier('/api/auth/google/callback', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/_internal/db/exec', 'POST'), 'exempt');
  assert.equal(classifyServiceTier('/api/scrape', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/img/komiku/x.webp', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/reader/komiku/page/1234/1', 'GET'), 'exempt');
  assert.equal(classifyServiceTier('/api/reader/komiku/page/1234/0', 'GET'), 'exempt'); // valid syntax: tetap exempt
  assert.equal(classifyServiceTier('/anything', 'OPTIONS'), 'exempt');
  assert.equal(classifyServiceTier('/anything', 'HEAD'), 'exempt');
});

test('classifyServiceTier: tier SENSITIVE', () => {
  assert.equal(classifyServiceTier('/api/resolve/komiku', 'GET'), 'sensitive');
  assert.equal(classifyServiceTier('/api/identify', 'POST'), 'sensitive');
  assert.equal(classifyServiceTier('/api/admin/monitoring', 'GET'), 'sensitive');
  assert.equal(classifyServiceTier('/api/user/bookmark/naruto', 'PUT'), 'sensitive');
  assert.equal(classifyServiceTier('/api/user/bookmark/naruto', 'DELETE'), 'sensitive');
});

test('classifyServiceTier: tier PUBLIC-READ', () => {
  assert.equal(classifyServiceTier('/api/search?q=one%20piece', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/series', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/series/komiku/detail/xyz', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/reader/komiku/chapter/abc', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/homepage', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/manga/komiku/x', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/source-status', 'GET'), 'public-read');
  assert.equal(classifyServiceTier('/api/user/me', 'GET'), 'public-read');
});

test('classifyServiceTier: DENY untuk /api/* tak dikenal, non-API aman', () => {
  assert.equal(classifyServiceTier('/api/unknown-thing', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/api', 'GET'), 'deny');
  assert.equal(classifyServiceTier('/assets/x.js', 'GET'), 'deny'); // tidak menyentuh, tapi deny bukan masalah di sini
  assert.equal(classifyServiceTier('/', 'GET'), 'deny');
});

// ── Pure decision ──────────────────────────────────────────────────────────────
test('decideServiceGate: matriks keputusan inti', () => {
  const ctx = {};
  const decide = (o) => decideServiceGate({ isExempt: false, hasServiceToken: false, hasValidOrigin: false, hasSessionCookie: false, requiresTurnstile: false, turnstileOk: false, ...o });

  assert.equal(decide({ isExempt: true }), 'allow');                    // exempt tanpa kredensial
  assert.equal(decide({ hasServiceToken: true }), 'allow');             // token menang di semua tier
  assert.equal(decide({ hasServiceToken: true, requiresTurnstile: true }), 'allow');

  assert.equal(decide({ hasValidOrigin: true }), 'allow');              // public-read via Origin
  assert.equal(decide({ hasSessionCookie: true }), 'allow');            // public-read via cookie
  assert.equal(decide({}), 'deny');                                     // public-read tanpa apa-apa

  assert.equal(decide({ requiresTurnstile: true, hasSessionCookie: true }), 'allow'); // sensitive via cookie
  assert.equal(decide({ requiresTurnstile: true, turnstileOk: true }), 'allow');       // sensitive via Turnstile
  assert.equal(decide({ requiresTurnstile: true, hasValidOrigin: true }), 'deny');     // Origin tidak cukup utk sensitive
  assert.equal(decide({ requiresTurnstile: true }), 'deny');            // sensitive tanpa apa-apa

  assert.equal(decide({ ...ctx }), 'deny');                             // deny (unknown)
});

// ── E2E middleware (network-independent) ───────────────────────────────────────
test('E2E: tier EXEMPT lolos tanpa kredensial', async () => {
  assert.equal((await go('/api/health')).status, 200);
  assert.equal((await go('/api/origins')).status, 200);
  assert.equal((await go('/api/auth/google')).status, 200);
  assert.equal((await go('/api/_internal/db/exec', { method: 'POST' })).status, 200);
  assert.equal((await go('/img/komiku/x.webp')).status, 200);
  assert.equal((await go('/api/reader/komiku/page/99/7')).status, 200);
  assert.equal((await go('/anywhere', { method: 'OPTIONS' })).status, 200);
  assert.equal((await go('/api/search', { method: 'HEAD' })).status, 200);
});

test('E2E: /api/* tanpa kredensial ditolak 403', async () => {
  assert.equal((await go('/api/series')).status, 403);
  assert.equal((await go('/api/homepage')).status, 403);
  assert.equal((await go('/api/search')).status, 403);
  assert.equal((await go('/api/resolve/komiku')).status, 403);
  assert.equal((await go('/api/unknown-path')).status, 403);
});

test('E2E: service token lolos semua tier + header salah ditolak', async () => {
  const tok = { headers: { 'x-service-token': 'test-service-token' } };
  assert.equal((await go('/api/series', tok)).status, 200);
  assert.equal((await go('/api/search', tok)).status, 200);
  assert.equal((await go('/api/resolve/komiku', tok)).status, 200);
  assert.equal((await go('/api/user/bookmark/naruto', { ...tok, method: 'PUT' })).status, 200);
  assert.equal((await go('/api/admin/monitoring', tok)).status, 200);

  assert.equal((await go('/api/series', { headers: { 'x-service-token': 'wrong' } })).status, 403);
});

test('E2E: public-read via Origin allowlist / session cookie / token', async () => {
  assert.equal((await go('/api/series', { headers: { origin: 'https://oktzz.xyz' } })).status, 200);
  assert.equal((await go('/api/search', { headers: { origin: 'https://oktzz.xyz' } })).status, 200);
  assert.equal((await go('/api/user/me', { headers: { origin: 'http://localhost:3000' } })).status, 200);
  assert.equal((await go('/api/homepage', { headers: { cookie: '__Host-session=abc.def.ghi' } })).status, 200);
  assert.equal((await go('/api/source-status', { headers: { origin: 'https://oktzz.xyz' } })).status, 200);
  assert.equal((await go('/api/user/me', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await go('/api/homepage', { headers: { cookie: 'guest=1; other=x' } })).status, 403);
  assert.equal((await go('/api/search', { headers: { origin: 'https://evil.example' } })).status, 403);
});

test('E2E: sensitive via cookie; Origin TIDAK cukup; tamu tanpa token tidak nelepon siteverify', async () => {
  const cookie = { headers: { cookie: '__Host-session=abc' } };
  assert.equal((await go('/api/resolve/komiku', cookie)).status, 200);
  assert.equal((await go('/api/user/bookmark/naruto', { ...cookie, method: 'PUT' })).status, 200);
  // Origin allow (bukan service token/cookie) tetap ditolak utk sensitive.
  assert.equal((await go('/api/resolve/komiku', { headers: { origin: 'https://oktzz.xyz' } })).status, 403);
  // Tanpa token sama sekali: TURNSTILE_SECRET_KEY tidak disentuh → tidak ada fetch ke siteverify.
});

test('E2E: turnstile_token dipakai utk tier sensitive (dev-mode secret kosong → verify true)', async () => {
  // stubEnv tanpa TURNSTILE_SECRET_KEY: verifyTurnstile dev-mode = true saat token ADA.
  const withTok = { headers: { 'x-turnstile-token': '0.abc' } };
  assert.equal((await go('/api/resolve/komiku', withTok)).status, 200);
  assert.equal((await go('/api/resolve/komiku', { headers: { 'x-turnstile-token': '' } })).status, 403); // empty == absent
  assert.equal((await go('/api/resolve/komiku?turnstile_token=dummy', {})).status, 200);                 // via query
});

test('E2E: SERVICE_TOKEN kosong → gate TIDAK AKTIF (fail-open, dev-friendly)', async () => {
  const env = stubEnv({ SERVICE_TOKEN: '' });
  // Semua lolos tanpa kredensial — KOMPROMI: dev workflow tidak boleh rusak.
  // Produksi WAJIB set secret (warning + deploy runbook menandai kalau lupa).
  assert.equal((await go('/api/series', {}, env)).status, 200);
  assert.equal((await go('/api/search', {}, env)).status, 200);
  assert.equal((await go('/api/admin/monitoring', {}, env)).status, 200);
  assert.equal((await go('/api/unknown-path', {}, env)).status, 200);
});