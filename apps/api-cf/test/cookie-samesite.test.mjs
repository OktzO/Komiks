// Setelah semua trafik same-origin (proxy BFF), SameSite=None tidak lagi
// dibutuhkan — dan justru berbahaya: None membuat cookie ikut terkirim pada
// request lintas site, yaitu surface CSRF yang sedang ditutup. Lax cukup karena
// satu-satunya request lintas-site yang ada (callback OAuth) adalah top-level
// GET navigation, dan Lax memang dikirim pada navigasi tersebut.
//
// Dan redirect_uri harus menunjuk FRONTEND, bukan worker API: cookie
// __Host-session itu host-only, jadi hanya bisa disetel oleh domain yang
// mengirim respons. Kalau callback mendarat di worker API, cookie-nya hidup di
// domain worker — dan proxy di oktzz.xyz tidak akan pernah menerimanya, sehingga
// setiap request terautentikasi jadi 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const authLib = readFileSync(
  fileURLToPath(new URL('../src/lib/auth.ts', import.meta.url)), 'utf8');
const authRoutes = readFileSync(
  fileURLToPath(new URL('../src/routes/auth.ts', import.meta.url)), 'utf8');

// Ekstrak body sebuah helper cookie. Body diambil dari baris `function <nama>`
// sampai baris yang penutup dengan `}` di kolom 0 — bukan indexOf('}') pertama,
// karena `}` di dalam template literal (`${SESSION_COOKIE}`) akan terminates
// pencarian lebih dulu dan menghasilkan potongan yang salah.
const cookieHelperBody = (name) => {
  const at = authLib.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'));
  assert.ok(at > -1, `${name} tidak ditemukan`);
  const end = authLib.indexOf('\n}', at);
  assert.ok(end > at, `body ${name} tidak menemukan penutup`);
  return authLib.slice(at, end);
};

test('tidak ada cookie helper yang lagi memakai SameSite=None', () => {
  assert.ok(!/SameSite=None/.test(authLib), 'masih ada SameSite=None');
});

test('keempat cookie helper memakai SameSite=Lax', () => {
  for (const name of ['setSessionCookie', 'clearSessionCookie', 'setStateCookie', 'clearStateCookie']) {
    const body = cookieHelperBody(name);
    assert.ok(/SameSite=Lax/.test(body), `${name} tidak memakai SameSite=Lax`);
  }
});

test('cookie tetap HttpOnly + Secure + __Host- prefix', () => {
  // SameSite=Lax tidak boleh kita tukar dengan privilege lain yang membuat
  // cookie bisa dibaca skrip atau dikirim lewat http.
  assert.ok(/SESSION_COOKIE = '__Host-session'/.test(authLib), 'prefix __Host-session hilang');
  assert.ok(/STATE_COOKIE = '__Host-oauth-state'/.test(authLib), 'prefix __Host-oauth-state hilang');
  const body = cookieHelperBody('setSessionCookie');
  for (const attr of ['HttpOnly', 'Secure', 'Path=/']) {
    assert.ok(body.includes(attr), `setSessionCookie kehilangan ${attr}`);
  }
});

test('redirect_uri OAuth berasal dari frontend, bukan dari request URL', () => {
  // base = new URL(c.req.url).origin menunjuk domain worker API, karena proxy
  // meneruskan ke worker. Cookie akan mendarat di sana dan proxy tidak pernah
  // menerimanya.
  assert.ok(
    !/redirect_uri: `\$\{base\}\/api\/auth\/google\/callback`/.test(authRoutes),
    'redirect_uri masih diturunkan dari base (origin request)'
  );
  assert.ok(
    /const oauthRedirectUri = \(c: Context\): string/.test(authRoutes),
    'helper oauthRedirectUri belum ada'
  );
  // Dipakai di KEDUA tempat: authorize URL dan token exchange. Google mencocokkan
  // string redirect_uri secara persis — kalau hanya salah satu yang diganti,
  // token exchange ditolak dengan redirect_uri_mismatch.
  const uses = (authRoutes.match(/oauthRedirectUri\(c\)/g) ?? []).length;
  assert.equal(uses, 2, `oauthRedirectUri dipakai ${uses}×, harus 2 (authorize + exchange)`);
});

test('redirect_uri tidak lagi memakai base dari request URL sama sekali', () => {
  assert.ok(
    !/const base = new URL\(c\.req\.url\)\.origin;/.test(authRoutes),
    'base dari request URL masih ada — itu akar masalahnya'
  );
});
