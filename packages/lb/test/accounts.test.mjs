// Self-check: verifyAccountToken against stubbed global.fetch (CF + Vercel).
// Run: node packages/lb/test/accounts.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { verifyAccountToken } = await import('../accounts.ts');

// ---- stub fetch: routes keyed by URL substring ---------------------------
const fixtures = new Map();
const route = (key, status, body) => fixtures.set(key, { status, body });

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, _init) => {
  const u = String(url);
  for (const [key, fx] of fixtures) {
    if (u.includes(key)) {
      return {
        ok: fx.status >= 200 && fx.status < 300,
        status: fx.status,
        json: async () => fx.body
      };
    }
  }
  return new Response('not found', { status: 404 });
};

// ---- Cloudflare fixtures --------------------------------------------------
route('/client/v4/user/tokens/verify', 200, {
  success: true,
  result: { id: 'tok_1', status: 'active' }
});

// 1. CF active token → ok.
{
  const r = await verifyAccountToken('cloudflare', 'cf-active-token');
  assert.equal(r.ok, true, 'CF active token ok');
  assert.equal(r.err, undefined, 'no err on success');
  console.log('ok 1 CF active');
}

// 2. CF inactive token → not ok.
route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'expired' } });
{
  const r = await verifyAccountToken('cloudflare', 'cf-inactive');
  assert.equal(r.ok, false, 'CF inactive not ok');
  assert.ok(r.err, 'err message present');
  console.log('ok 2 CF inactive');
}

// 3. CF HTTP 401 → not ok.
route('/client/v4/user/tokens/verify', 401, { success: false });
{
  const r = await verifyAccountToken('cloudflare', 'cf-bad');
  assert.equal(r.ok, false, 'CF 401 not ok');
  assert.match(r.err ?? '', /401/, 'err mentions status');
  console.log('ok 3 CF 401');
}

// ---- Vercel fixtures ------------------------------------------------------
route('/api.vercel.com/v2/user', 200, { user: { uid: 'u_1', email: 'a@b.c' } });

// 4. Vercel valid token → ok.
{
  const r = await verifyAccountToken('vercel', 'vrc-valid');
  assert.equal(r.ok, true, 'Vercel valid ok');
  console.log('ok 4 Vercel valid');
}

// 5. Vercel empty user → not ok.
route('/api.vercel.com/v2/user', 200, {});
{
  const r = await verifyAccountToken('vercel', 'vrc-empty');
  assert.equal(r.ok, false, 'Vercel empty user not ok');
  console.log('ok 5 Vercel empty');
}

// 6. Vercel HTTP 403 → not ok.
route('/api.vercel.com/v2/user', 403, {});
{
  const r = await verifyAccountToken('vercel', 'vrc-403');
  assert.equal(r.ok, false, 'Vercel 403 not ok');
  assert.match(r.err ?? '', /403/);
  console.log('ok 6 Vercel 403');
}

globalThis.fetch = origFetch;
console.log('ALL PASS');
