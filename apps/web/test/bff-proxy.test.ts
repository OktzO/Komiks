// Proxy BFF manga-web → worker API. Tiga job yang harus benar, dan ketiganya
// adalah pembeda antara "API terkunci" dan "API terkunci yang bisa ditembus":
//   1. token milik client dibuang (kalau tidak, siapa pun bisa menyamar)
//   2. hanya path yang benar-benar diizinkan yang diteruskan
//   3. respons non-JSON (302 OAuth, 204, gambar) diteruskan apa adanya
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProxyAllowed, buildUpstreamHeaders, relayHeaders } from '../src/lib/bff-proxy';

// ── Allowlist ──────────────────────────────────────────────────────────────────
test('path data & auth diteruskan', () => {
  const ok = [
    '/api/health', '/api/origins', '/api/auth', '/api/auth/google',
    '/api/auth/google/callback', '/api/auth/logout', '/api/user/me',
    '/api/user/bookmark/naruto', '/api/series', '/api/search', '/api/homepage',
    '/api/reader/komiku/chapter/abc', '/api/manga/komiku/x', '/api/novel/catalog',
    '/api/resolve/komiku', '/api/identify', '/api/source-status',
  ];
  for (const p of ok) assert.equal(isProxyAllowed(p), true, `${p} harusnya boleh`);
});

test('admin baca tetap boleh — browser butuh untuk dashboard', () => {
  assert.equal(isProxyAllowed('/api/admin/monitoring'), true);
  assert.equal(isProxyAllowed('/api/admin/dashboard/storage'), true);
  assert.equal(isProxyAllowed('/api/admin/users'), true);
});

test('jalur privileged ditolak — proxy bukan jalan baru ke sana', () => {
  const no = [
    '/api/_internal/db/exec', '/api/_internal/db/query', '/api/_internal/kv/get',
    '/api/_internal/kv/put', '/api/scrape', '/api/scrape/job/1',
  ];
  for (const p of no) assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
});

test('prefix tidak boleh mencerna path di luar namespace', () => {
  // Naive startsWith('/api/user') ikut mencerna '/api/usersecret'. Ini yang
  // paling mudah lupa dan akan membuka prefix baru tanpa disadari.
  const sneaky = [
    '/api/_internalX', '/api/internal/db/exec', '/api/_internal',
    '/api/scraped', '/api/scraper', '/api/scrapeable', '/api/scrape',
    '/api/seriesXYZ', '/api/seriesfoo', '/api/userstuff', '/api/users',
    '/api/novels', '/api/searchable', '/api/readerX',
  ];
  for (const p of sneaky) assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
});

test('path di luar /api selalu ditolak', () => {
  for (const p of ['/', '/login', '/admin', '/img/komiku/x/1', '/api', '/api/', '/x/api/series', '']) {
    assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
  }
});

// ── Token stripping ────────────────────────────────────────────────────────────
test('token milik client dibuang, milik worker yang dikirim', () => {
  const req = new Request('https://oktzz.xyz/api/series', {
    headers: { 'x-service-token': 'ATTACKER-SUPPLIED', accept: 'application/json' },
  });
  const h = buildUpstreamHeaders(req, 'REAL-TOKEN');
  assert.equal(h.get('x-service-token'), 'REAL-TOKEN', 'token client menimpa token worker');
  assert.notEqual(h.get('x-service-token'), 'ATTACKER-SUPPLIED');
});

test('header identitas & koneksi tidak diteruskan', () => {
  const req = new Request('https://oktzz.xyz/api/series', {
    headers: {
      host: 'evil.example',
      origin: 'https://evil.example',
      referer: 'https://evil.example/page',
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8',
    },
  });
  const h = buildUpstreamHeaders(req, 'REAL-TOKEN');
  for (const k of ['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for']) {
    assert.equal(h.get(k), null, `${k} diteruskan ke worker`);
  }
  assert.equal(h.get('x-service-token'), 'REAL-TOKEN');
});

test('cookie diteruskan — session harus sampai ke worker API', () => {
  const req = new Request('https://oktzz.xyz/api/user/me', {
    headers: { cookie: '__Host-session=abc.def; other=1' },
  });
  assert.equal(buildUpstreamHeaders(req, 'T').get('cookie'), '__Host-session=abc.def; other=1');
});

test('header yang legitimately perlu tetap diteruskan', () => {
  const req = new Request('https://oktzz.xyz/api/user/bookmark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
  const h = buildUpstreamHeaders(req, 'T');
  assert.equal(h.get('content-type'), 'application/json');
  assert.equal(h.get('accept'), 'application/json');
});

// ── Relay ──────────────────────────────────────────────────────────────────────
test('relay membawa header yang dibutuhkan, terutama SEMUA Set-Cookie', () => {
  const up = new Headers();
  up.set('content-type', 'application/json');
  up.set('cache-control', 'no-store');
  up.append('set-cookie', '__Host-session=aaa; Path=/; HttpOnly; SameSite=Lax; Secure');
  up.append('set-cookie', '__Host-oauth-state=; Path=/; HttpOnly; Max-Age=0');
  const out = relayHeaders(up);
  assert.equal(out.get('content-type'), 'application/json');
  assert.equal(out.get('cache-control'), 'no-store');
  const cookies = out.getSetCookie();
  assert.equal(cookies.length, 2, `hanya ${cookies.length} Set-Cookie diteruskan`);
  assert.ok(cookies.some((c) => c.includes('__Host-session=aaa')));
  assert.ok(cookies.some((c) => c.includes('__Host-oauth-state=')));
});

test('relay meneruskan status-worthy header lain (redirect OAuth butuh Location)', () => {
  const up = new Headers();
  up.set('location', 'https://oktzz.xyz/bookmark');
  const out = relayHeaders(up);
  assert.equal(out.get('location'), 'https://oktzz.xyz/bookmark');
});

test('relay tidak membocorkan token ke browser', () => {
  const up = new Headers();
  up.set('x-service-token', 'REAL-TOKEN');
  up.set('cf-ray', 'abc');
  up.set('content-type', 'text/plain');
  const out = relayHeaders(up);
  assert.equal(out.get('x-service-token'), null, 'token bocor ke browser');
  assert.equal(out.get('cf-ray'), null);
  assert.equal(out.get('content-type'), 'text/plain');
});

test('relay menghasilkan header valid walau upstream kosong', () => {
  const out = relayHeaders(new Headers());
  assert.ok(out instanceof Headers);
  assert.equal([...out.keys()].length, 0);
});
