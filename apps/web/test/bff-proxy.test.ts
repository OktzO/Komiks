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

test('dot-segment ditolak, baik ter-encode maupun tidak', () => {
  // Ini yang membuat allowlist benar-benar sebuah boundary. Pengecekan prefix
  // berjalan pada string mentah, tapi fetch() meneruskan path itu ke WHATWG
  // URL parser yang menghapus dot-segment. Jadi '/api/user/%2e%2e/scrape'
  // lolosAllowlist sementara URL upstream-nya menjadi '/api/scrape'.
  //
  // Produksi kebetulan aman sekarang karena runtime Workers menormalisasi
  // sebelum worker melihat path — tapi itu perilaku runtime, bukan jaminan
  // kode. Setiap proxy yang berdiri di belakang apa pun yang mempertahankan
  // path mentah (reverse proxy, service binding, dev server) langsung
  ///Askapas, jadi penolakan dilakukan di sini dan bukan hypocris pada runtime.
  const dotty = [
    '/api/user/../scrape',
    '/api/user/%2e%2e/scrape',
    '/api/user/%2E%2E/scrape',
    '/api/user/%2e%2E/scrape',
    '/api/user/%2E%2e/scrape',
    '/api/user/./../../scrape',
    '/api/series/../_internal/db/exec',
    '/api/series/%2e%2e/_internal/db/exec',
    '/api/user/..%2fscrape',
    '/api/user/%2f..%2fscrape',
    '/api/user/%252e%252e/scrape',
  ];
  for (const p of dotty) assert.equal(isProxyAllowed(p), false, `${p} jangan lolos`);
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

test('header credential lain milik client tidak diteruskan', () => {
  // Proxy tidak boleh menjadi jalan bagi browser yang entah memakai
  // admin key atau forward key milik worker. Ban-forward: hanya daftar putih
  // yang boleh lewat.
  const req = new Request('https://oktzz.xyz/api/scrape', {
    headers: {
      'x-admin-api-key': 'ADMIN-KEY-ATTEMPT',
      'x-db-forward-key': 'FORWARD-KEY-ATTEMPT',
      'x-db-mirror-key': 'MIRROR-KEY-ATTEMPT',
      authorization: 'Bearer SOMETHING',
    },
  });
  const h = buildUpstreamHeaders(req, 'REAL-TOKEN');
  for (const k of ['x-admin-api-key', 'x-db-forward-key', 'x-db-mirror-key', 'authorization']) {
    assert.equal(h.get(k), null, `${k} diteruskan ke worker`);
  }
  assert.equal(h.get('x-service-token'), 'REAL-TOKEN');
});

test('header yang legitimate perlu tetap diteruskan', () => {
  const req = new Request('https://oktzz.xyz/api/user/bookmark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'if-none-match': 'W/"x"' },
  });
  const h = buildUpstreamHeaders(req, 'T');
  assert.equal(h.get('content-type'), 'application/json');
  assert.equal(h.get('accept'), 'application/json');
  assert.equal(h.get('if-none-match'), 'W/"x"');
});

test('cookie diteruskan — session harus sampai ke worker API', () => {
  const req = new Request('https://oktzz.xyz/api/user/me', {
    headers: { cookie: '__Host-session=abc.def; other=1' },
  });
  assert.equal(buildUpstreamHeaders(req, 'T').get('cookie'), '__Host-session=abc.def; other=1');
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

test('relay membuang header encoding — byte yang di-decompress runtime dan header ini bisa tidak sinkron', () => {
  // Kalau upstream memampatkan karena proxy meneruskan accept-encoding, dan
  // runtime memberi proxy byte yang sudah di-decompress sementara header
  // content-encoding masih ada, browser akan gagal decode atau menggantung di
  // content-length yang salah. Proxy tidak memampatkan, jadi apa pun yang
  // sampai ke browser harus dalam bentuk yang runtime benar-benar Prenya.
  const up = new Headers();
  up.set('content-encoding', 'gzip');
  up.set('content-length', '1234');
  up.set('content-type', 'application/json');
  const out = relayHeaders(up);
  assert.equal(out.get('content-encoding'), null, 'content-encoding ikut relayed');
  assert.equal(out.get('content-length'), null, 'content-length ikut relayed');
  assert.equal(out.get('content-type'), 'application/json');
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