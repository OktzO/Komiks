#!/usr/bin/env node
/**
 * Smoke test for /api/user/* routes.
 *
 * Requires `wrangler dev` to be running on localhost:8787 with a local D1 DB
 * seeded with schema + migrations. If the server is not reachable the script
 * reports the skips and exits 0 (per task: "bisa di-skip kalau wrangler dev
 * tidak run").
 */

const BASE = process.env.SMOKE_API_URL || 'http://localhost:8787';
const API = `${BASE}/api`;

let failures = 0;
const results = [];

function log(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  results.push({ label, pass, got, expect });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label} => got: ${JSON.stringify(got)}, expect: ${JSON.stringify(expect)}`);
}

async function post(path, body, cookie = '') {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  const setCookie = res.headers.get('Set-Cookie') || '';
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function get(path, cookie = '') {
  const res = await fetch(`${API}${path}`, { headers: { cookie } });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function patch(path, body, cookie = '') {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function del(path, body = undefined, cookie = '') {
  const opts = { method: 'DELETE', headers: { cookie } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ─── 1. Server reachable? ────────────────────────────────────────────────

console.log(`\n=== smoke-user.mjs — target: ${API} ===\n`);

let serverUp;
try {
  const health = await Promise.race([
    fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
  ]);
  serverUp = health.ok;
} catch {
  serverUp = false;
}

if (!serverUp) {
  console.log('SKIP: dev server not reachable at ' + BASE);
  console.log('  Start it with: cd apps/api-cf && npx wrangler dev --port 8787 --local');
  console.log('  Then run: node scripts/smoke-user.mjs');
  console.log('\nNo failures (server not running).');
  process.exit(0);
}

// ─── 2. Unauthenticated → 401 ──────────────────────────────────────────────

const meNoAuth = await get('/user/me');
log('GET /user/me (no auth → 401)', meNoAuth.status, 401);

const sessionsNoAuth = await get('/user/sessions');
log('GET /user/sessions (no auth → 401)', sessionsNoAuth.status, 401);

// ─── 3. Register + session ─────────────────────────────────────────────────

const ts = Date.now();
const email = `smoke-${ts}@example.com`;
const reg = await post('/auth/register', { email, password: 'testpass123' });
log('POST /auth/register (200/201)', reg.status >= 200 && reg.status < 300, true);

if (!reg.cookie || reg.cookie === '') {
  console.log('FAIL: no session cookie from register');
  process.exit(1);
}
const cookie = reg.cookie;

// ─── 4. GET /me ────────────────────────────────────────────────────────────

const me = await get('/user/me', cookie);
log('GET /user/me (200)', me.status, 200);
log('GET /user/me data.email', me.data?.data?.email, email);
log('GET /user/me data.preferences (object)', typeof me.data?.data?.preferences, 'object');

// ─── 5. PATCH /me ──────────────────────────────────────────────────────────

const patchRes = await patch('/user/me', {
  display_name: 'Smoke Tester',
  bio: 'Smoke test bio',
  preferences: { theme: 'dark', language: 'id', reader_mode: 'scroll' },
}, cookie);
log('PATCH /user/me (200)', patchRes.status, 200);

// verify persist
const me2 = await get('/user/me', cookie);
log('GET /user/me after PATCH display_name', me2.data?.data?.display_name, 'Smoke Tester');
log('GET /user/me after PATCH preferences.theme', me2.data?.data?.preferences?.theme, 'dark');
log('GET /user/me after PATCH preferences.language', me2.data?.data?.preferences?.language, 'id');
log('GET /user/me after PATCH preferences.reader_mode', me2.data?.data?.preferences?.reader_mode, 'scroll');

// Zod reject unknown
const patchBad = await patch('/user/me', { display_name: 'Bad', unknown_field: true }, cookie);
log('PATCH /user/me unknown field (400)', patchBad.status, 400);

// ─── 6. /sessions ──────────────────────────────────────────────────────────

const sessions = await get('/user/sessions', cookie);
log('GET /user/sessions (200)', sessions.status, 200);
log('GET /user/sessions has array', Array.isArray(sessions.data?.data), true);

// ─── 7. DELETE /history (clear) ───────────────────────────────────────────

const clearHist = await del('/user/history', undefined, cookie);
log('DELETE /user/history (200)', clearHist.status, 200);

// ─── 8. DELETE /bookmarks (clear) ─────────────────────────────────────────

const clearBks = await del('/user/bookmarks', undefined, cookie);
log('DELETE /user/bookmarks (200)', clearBks.status, 200);

// ─── 9. DELETE /me ─────────────────────────────────────────────────────────

const deleteRes = await del('/user/me', { confirm: 'DELETE' }, cookie);
log('DELETE /user/me with confirm (200)', deleteRes.status, 200);

// missing confirm
const deleteNoConfirm = await del('/user/me', {}, cookie);
log('DELETE /user/me without confirm (400)', deleteNoConfirm.status, 400);

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed, ${failures} failed.`);
process.exit(failures > 0 ? 1 : 0);
