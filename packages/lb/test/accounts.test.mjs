// Self-check: verifyAccountToken + account discovery/selection/persistence.
// Run: npx tsx --test packages/lb/test/accounts.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  verifyAccountToken,
  discoverCloudflareAccounts,
  resolveCloudflareAccount,
  AccountSelectionRequiredError,
  AccountNotAccessibleError,
  NoCloudflareAccountsError,
  AccountDiscoveryError,
  createAccount,
  testAccount,
} = await import('../accounts.ts');
const { encryptToken, decryptToken } = await import('../crypto.ts');

const CF_A = 'a'.repeat(32);
const CF_B = 'b'.repeat(32);
const CF_C = 'c'.repeat(32);

// ---- stub fetch: routes keyed by URL substring ---------------------------
const fixtures = new Map();
const route = (key, status, body) => fixtures.set(key, { status, body });
const routeThrows = (key, message) => fixtures.set(key, { throws: message });
const asBuffer = (view) => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
const authOf = (init) =>
  String(init?.headers?.Authorization ?? init?.headers?.authorization ?? '').replace(/^Bearer\s+/, '');
const lastUrl = { value: '' };

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  lastUrl.value = u;
  for (const [key, fx] of fixtures) {
    if (!u.includes(key)) continue;
    if (fx.throws) throw new Error(fx.throws);
    const body = typeof fx.body === 'function' ? await fx.body(u, init) : fx.body;
    return {
      ok: fx.status >= 200 && fx.status < 300,
      status: fx.status,
      json: async () => body,
    };
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

// 3b. Provider error bodies are never echoed into the error string.
{
  const r = await verifyAccountToken('cloudflare', 'cf-bad');
  assert.doesNotMatch(r.err ?? '', /[{}"]/, 'verify err carries no raw provider body');
  console.log('ok 3b CF verify err sanitized');
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
  assert.ok(r.err, 'Vercel empty user err present');
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

// ---- account discovery ----------------------------------------------------
const ACCOUNTS_BY_TOKEN = {
  'one-token': [{ id: CF_A, name: 'Oktz', type: 'standard' }],
  'multi-token': [
    { id: CF_A, name: 'Oktz', type: 'standard' },
    { id: CF_B, name: 'Account Two', type: null },
  ],
  'empty-token': [],
};
const accountsRoute = (u, init) => ({
  success: true,
  result: ACCOUNTS_BY_TOKEN[authOf(init)] ?? [],
});
route('/client/v4/accounts', 200, accountsRoute);

// 7. Discovery returns an allowlisted shape only.
{
  lastUrl.value = '';
  const accounts = await discoverCloudflareAccounts('multi-token');
  assert.deepEqual(accounts, [
    { id: CF_A, name: 'Oktz', type: 'standard' },
    { id: CF_B, name: 'Account Two', type: null },
  ], 'only id/name/type exposed');
  assert.match(lastUrl.value, /\/client\/v4\/accounts\?/, 'list endpoint used');
  assert.match(lastUrl.value, /per_page=50/, 'page size 50');
  console.log('ok 7 discover allowlist');
}

// 7b. Provider fields beyond the allowlist never reach the caller.
{
  route('/client/v4/accounts', 200, {
    success: true,
    result: [
      {
        id: CF_A,
        name: 'Oktz',
        type: 'standard',
        settings: { encloses_all_caches: true },
        legacy_flags: { can_use_kv_namespace_api: true },
        entitlements: { can_purchase: true },
      },
    ],
  });
  const accounts = await discoverCloudflareAccounts('one-token');
  assert.deepEqual(Object.keys(accounts[0]).sort(), ['id', 'name', 'type'], 'no extra keys');
  assert.doesNotMatch(JSON.stringify(accounts), /encloses_all_caches|can_purchase/, 'no provider extras');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 7b discover strips provider extras');
}

// 7c. Accounts past the first page are reachable.
{
  const firstPage = Array.from({ length: 50 }, (_, i) => ({ id: i.toString(16).padStart(32, '0'), name: `P1-${i}`, type: 'standard' }));
  const requested = [];
  route('/client/v4/accounts', 200, (u) => {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    requested.push(page);
    return { success: true, result: page === 1 ? firstPage : [{ id: CF_C, name: 'Page Two Account', type: 'standard' }] };
  });
  const accounts = await discoverCloudflareAccounts('paged-token');
  assert.equal(accounts.length, 51, 'both pages collected');
  assert.deepEqual(requested, [1, 2], 'exactly two pages fetched');
  const selected = await resolveCloudflareAccount('paged-token', CF_C);
  assert.equal(selected.id, CF_C, 'page-2 account selectable');
  assert.equal(selected.name, 'Page Two Account', 'page-2 name kept');
  console.log('ok 7c discover paginates');
}

// 7d. Pagination stops at the bound instead of looping.
{
  const requested = [];
  route('/client/v4/accounts', 200, (u) => {
    requested.push(Number(new URL(u).searchParams.get('page') ?? '1'));
    return { success: true, result: Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`.padEnd(32, '0'), name: `P${i}` })) };
  });
  const accounts = await discoverCloudflareAccounts('huge-token');
  assert.equal(accounts.length, 500, 'ten pages collected');
  assert.deepEqual(requested.length, 10, 'pagination bounded to 10 pages');
  assert.equal(requested.at(-1), 10, 'last fetched page is 10');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 7d discover page bound');
}

// 8. Exactly one account → auto-select, no ambiguity.
{
  const selected = await resolveCloudflareAccount('one-token');
  assert.equal(selected.id, CF_A, 'single account auto-selected');
  assert.equal(selected.name, 'Oktz', 'selected carries real name');
  console.log('ok 8 single account auto-select');
}

// 9. Multiple accounts and no selection → explicit ambiguity, safe choices.
{
  let caught = null;
  try {
    await resolveCloudflareAccount('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AccountSelectionRequiredError, 'ambiguity error class');
  assert.match(caught.message, /account selection required/, 'stable message');
  assert.deepEqual(caught.accounts, [
    { id: CF_A, name: 'Oktz', type: 'standard' },
    { id: CF_B, name: 'Account Two', type: null },
  ], 'safe account choices only');
  assert.doesNotMatch(JSON.stringify(caught.accounts), /multi-token/, 'no token in choices');
  console.log('ok 9 ambiguous selection');
}

// 10. Explicit requested id wins over the ambiguity error.
{
  const selected = await resolveCloudflareAccount('multi-token', CF_B);
  assert.equal(selected.id, CF_B, 'requested account selected');
  assert.equal(selected.name, 'Account Two', 'requested account name');
  console.log('ok 10 explicit account select');
}

// 10b. Requested id outside the token's accounts → distinct error, sanitized.
{
  let caught = null;
  try {
    await resolveCloudflareAccount('multi-token', CF_C);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AccountNotAccessibleError, 'AccountNotAccessibleError raised');
  assert.ok(!(caught instanceof AccountSelectionRequiredError), 'not an ambiguity error');
  assert.equal(caught.message, 'account not accessible', 'stable message');
  assert.doesNotMatch(String(caught.stack ?? ''), /multi-token/, 'no token in stack');
  console.log('ok 10b unknown account id refused');
}

// 11. No accessible account → dedicated error, never an empty choice list.
{
  let caught = null;
  try {
    await resolveCloudflareAccount('empty-token');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof NoCloudflareAccountsError, 'NoCloudflareAccountsError raised');
  assert.ok(!(caught instanceof AccountSelectionRequiredError), 'not an empty selection error');
  assert.equal(caught.message, 'no accessible cloudflare accounts', 'stable message');
  console.log('ok 11 no accounts');
}

// 12. Provider failure during discovery → typed discovery error, no payload.
{
  route('/client/v4/accounts', 403, {
    success: false,
    errors: [{ code: 10000, message: 'MARKER-PROVIDER-LEAK' }],
  });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AccountDiscoveryError, 'AccountDiscoveryError raised');
  assert.equal(caught.code, 'cloudflare_token_rejected', 'auth failure code');
  assert.doesNotMatch(caught.message, /MARKER-PROVIDER-LEAK/, 'no raw provider error');
  assert.doesNotMatch(caught.message, /multi-token/, 'no token in error');
  console.log('ok 12 discovery auth failure typed');
}

// 12b. 401 is also an auth failure, not a provider outage.
{
  route('/client/v4/accounts', 401, { success: false });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.code, 'cloudflare_token_rejected', '401 auth code');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12b discovery 401 typed');
}

// 12c. Transport failure → provider outage code.
{
  routeThrows('/client/v4/accounts', 'MARKER-TRANSPORT-LEAK');
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AccountDiscoveryError, 'AccountDiscoveryError raised');
  assert.equal(caught.code, 'cloudflare_unavailable', 'transport code');
  assert.doesNotMatch(caught.message, /MARKER-TRANSPORT-LEAK/, 'no transport detail');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12c discovery transport typed');
}

// 12d. Unusable success payload → provider outage code, not a silent empty list.
{
  route('/client/v4/accounts', 200, { success: true, result: 'not-an-array' });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.code, 'cloudflare_invalid_response', 'invalid payload code');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12d discovery invalid payload typed');
}

// 12e. A 5xx listing is an outage, not a rejected token.
{
  route('/client/v4/accounts', 503, { success: false });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.code, 'cloudflare_unavailable', '5xx outage code');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12e discovery 5xx typed');
}

// 12f. 403 on the listing after the token verified → missing account-read permission.
{
  route('/client/v4/accounts', 403, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token', { tokenVerified: true });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AccountDiscoveryError, 'AccountDiscoveryError raised');
  assert.equal(caught.code, 'cloudflare_account_read_forbidden', 'account-read permission code');
  assert.doesNotMatch(caught.message, /MARKER-PROVIDER-LEAK/, 'no raw provider error');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12f discovery 403 after verify');
}

// 12g. 401 stays a rejected token even after the token verified.
{
  route('/client/v4/accounts', 401, { success: false });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token', { tokenVerified: true });
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.code, 'cloudflare_token_rejected', '401 stays token rejected');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12g discovery 401 after verify');
}

// 12h. Without a prior verify, 403 has no proof the token itself is bad.
{
  route('/client/v4/accounts', 403, { success: false });
  let caught = null;
  try {
    await discoverCloudflareAccounts('multi-token');
  } catch (e) {
    caught = e;
  }
  assert.equal(caught.code, 'cloudflare_token_rejected', 'unverified 403 stays token rejected');
  route('/client/v4/accounts', 200, accountsRoute);
  console.log('ok 12h discovery 403 without verify');
}

// ---- createAccount --------------------------------------------------------
const makeDb = () => {
  const writes = { accounts: [], audits: [], status: [], deleted: [] };
  return {
    writes,
    addAccount: async (params) => {
      writes.accounts.push(params);
      return { id: 'lb-created-1' };
    },
    addAuditLog: async (params) => {
      writes.audits.push(params);
      return { success: true };
    },
    updateAccountCredentialStatus: async (id, status, testedAt) => {
      writes.status.push([status, testedAt, id]);
      return { success: true };
    },
  };
};

const ENC_KEY = 'test-key-32-bytes-long-aaaaaaaaa';
const makeEnv = () => ({ LB_ENCRYPTION_KEY: ENC_KEY, DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } });

// 13. Blank label falls back to the discovered real account name.
route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'active' } });
{
  const db = makeDb();
  const res = await createAccount(makeEnv(), db, {
    label: '   ',
    provider: 'cloudflare',
    rawToken: 'one-token',
    created_by: 42,
  });
  assert.equal(res.status, 'verified', 'verified on active token');
  assert.equal(db.writes.accounts.length, 1, 'one account row written');
  const row = db.writes.accounts[0];
  assert.equal(row.label, 'Oktz', 'label falls back to discovered name');
  assert.equal(row.account_ref, CF_A, 'discovered account_ref persisted');
  assert.equal(row.status, 'verified', 'status persisted');
  assert.equal(row.created_by, 42, 'created_by from admin session');
  assert.equal(row.token_last4, 'oken', 'token_last4 derived server-side');
  assert.ok(row.encrypted_token instanceof ArrayBuffer, 'token stored encrypted');
  const stored = new Uint8Array(row.encrypted_token);
  assert.equal(await decryptToken(ENC_KEY, stored), 'one-token', 'stored blob decrypts to the token');
  assert.deepEqual(Object.keys(res).sort(), ['err', 'id', 'status'], 'result carries no token field');
  assert.doesNotMatch(JSON.stringify(res), /one-token/, 'no token in result');
  assert.deepEqual(db.writes.audits, [{ accountId: 'lb-created-1', action: 'account.create.verified', userId: 42 }], 'audit written');
  console.log('ok 13 createAccount label fallback + account_ref');
}

// 13b. Explicit label wins over the discovered name.
{
  const db = makeDb();
  await createAccount(makeEnv(), db, {
    label: '  Production  ',
    provider: 'cloudflare',
    rawToken: 'one-token',
  });
  assert.equal(db.writes.accounts[0].label, 'Production', 'trimmed explicit label kept');
  assert.equal(db.writes.accounts[0].created_by, null, 'created_by defaults to null');
  console.log('ok 13b explicit label kept');
}

// 14. Ambiguous account selection writes nothing and surfaces safe choices.
{
  const db = makeDb();
  let caught = null;
  try {
    await createAccount(makeEnv(), db, {
      label: 'Oktz',
      provider: 'cloudflare',
      rawToken: 'multi-token',
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AccountSelectionRequiredError, 'ambiguity propagated');
  assert.equal(db.writes.accounts.length, 0, 'no row written on ambiguity');
  assert.equal(db.writes.audits.length, 0, 'no audit on ambiguity');
  console.log('ok 14 createAccount ambiguity');
}

// 14b. Rejected Cloudflare token stores no claimed account identity.
{
  const db = makeDb();
  route('/client/v4/user/tokens/verify', 401, { success: false });
  const res = await createAccount(makeEnv(), db, {
    provider: 'cloudflare',
    accountId: CF_B,
    rawToken: 'rejected-cf-token',
  });
  route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'active' } });
  assert.equal(res.status, 'failed', 'stored as failed');
  const row = db.writes.accounts[0];
  assert.equal(row.account_ref, null, 'account_ref null even when an id was claimed');
  assert.equal(row.label, 'Cloudflare (unverified)', 'explicit unverified label');
  assert.equal(row.status, 'failed', 'failed status persisted');
  assert.equal(row.token_last4, 'oken', 'token_last4 derived from the token');
  assert.deepEqual(db.writes.audits, [{ accountId: 'lb-created-1', action: 'account.create.failed', userId: null }], 'failed audit');
  console.log('ok 14b failed cloudflare token claims nothing');
}

// 14c. A labelled failed Cloudflare token keeps the operator label.
{
  const db = makeDb();
  route('/client/v4/user/tokens/verify', 401, { success: false });
  await createAccount(makeEnv(), db, { label: 'Broken', provider: 'cloudflare', rawToken: 'rejected-cf-token' });
  route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'active' } });
  assert.equal(db.writes.accounts[0].label, 'Broken', 'explicit label kept on failure');
  assert.equal(db.writes.accounts[0].account_ref, null, 'still no claimed identity');
  console.log('ok 14c failed cloudflare token keeps label');
}

// 12i. A verified token that cannot list accounts writes no row.
{
  const db = makeDb();
  route('/client/v4/accounts', 403, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
  let caught = null;
  try {
    await createAccount(makeEnv(), db, { provider: 'cloudflare', rawToken: 'one-token' });
  } catch (e) {
    caught = e;
  }
  route('/client/v4/accounts', 200, accountsRoute);
  assert.equal(caught.code, 'cloudflare_account_read_forbidden', 'permission code surfaced');
  assert.equal(db.writes.accounts.length, 0, 'no account row written');
  console.log('ok 12i createAccount reports missing account-read permission');
}


// 15. Vercel path has no discovery: a bounded explicit ref is stored as-is.
{
  const db = makeDb();
  route('/api.vercel.com/v2/user', 200, { user: { uid: 'u_1', email: 'a@b.c' } });
  const res = await createAccount(makeEnv(), db, {
    label: 'Vercel Team',
    provider: 'vercel',
    accountId: 'team_123',
    rawToken: 'vrc-valid',
  });
  assert.equal(res.status, 'verified', 'vercel verified');
  assert.equal(db.writes.accounts[0].account_ref, 'team_123', 'explicit vercel ref stored');
  assert.equal(db.writes.accounts[0].label, 'Vercel Team', 'vercel label stored');
  assert.equal(db.writes.accounts[0].token_last4, 'alid', 'vercel token_last4 derived');
  console.log('ok 15 createAccount vercel ref');
}

// ---- testAccount ----------------------------------------------------------
const accountRows = new Map();
const envWithRows = (key = ENC_KEY) => ({
  LB_ENCRYPTION_KEY: key,
  DB: { prepare: () => ({ bind: (id) => ({ first: async () => accountRows.get(id) ?? null }) }) },
});
const withClock = async (ms, fn) => {
  const realNow = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
};

// 16. Active token → persists verified + timestamp.
{
  const db = makeDb();
  accountRows.set('acc-1', {
    encrypted_token: asBuffer(await encryptToken(ENC_KEY, 'one-token')),
    provider: 'cloudflare',
  });
  const res = await withClock(1234, () => testAccount(envWithRows(), db, 'acc-1'));
  assert.equal(res.status, 'verified', 'verified status');
  assert.equal(res.ok, true, 'ok flag');
  assert.deepEqual(db.writes.status, [['verified', 1234, 'acc-1']], 'verified + timestamp persisted');
  console.log('ok 16 testAccount persists verified');
}

// 17. Inactive token → persists failed, no raw provider body.
{
  const db = makeDb();
  accountRows.set('acc-1', {
    encrypted_token: asBuffer(await encryptToken(ENC_KEY, 'one-token')),
    provider: 'cloudflare',
  });
  route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'expired' } });
  const res = await withClock(1234, () => testAccount(envWithRows(), db, 'acc-1'));
  route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'active' } });
  assert.equal(res.status, 'failed', 'failed status');
  assert.deepEqual(db.writes.status, [['failed', 1234, 'acc-1']], 'failed + timestamp persisted');
  assert.doesNotMatch(res.err ?? '', /expired|[{}]/, 'no raw provider body in result');
  console.log('ok 17 testAccount persists failed');
}

// 17b. Provider transport failure during a test → unavailable, never verified.
{
  const db = makeDb();
  accountRows.set('acc-1', {
    encrypted_token: asBuffer(await encryptToken(ENC_KEY, 'one-token')),
    provider: 'cloudflare',
  });
  routeThrows('/client/v4/user/tokens/verify', 'MARKER-TRANSPORT-LEAK');
  const res = await withClock(555, () => testAccount(envWithRows(), db, 'acc-1'));
  route('/client/v4/user/tokens/verify', 200, { success: true, result: { status: 'active' } });
  assert.equal(res.status, 'unavailable', 'transport failure is unavailable');
  assert.equal(res.ok, false, 'not ok');
  assert.deepEqual(db.writes.status, [['unverified', 555, 'acc-1']], 'unverified persisted with timestamp');
  assert.doesNotMatch(JSON.stringify(res), /MARKER-TRANSPORT-LEAK/, 'no transport detail leaked');
  console.log('ok 17b testAccount transport failure caught');
}

// 18. Placeholder seed row with an empty blob → unavailable, never falsely verified.
{
  const db = makeDb();
  accountRows.set('acc-1', { encrypted_token: new ArrayBuffer(0), provider: 'cloudflare' });
  const res = await withClock(777, () => testAccount(envWithRows(), db, 'acc-1'));
  assert.equal(res.status, 'unavailable', 'empty seed is unavailable');
  assert.equal(res.ok, false, 'not ok');
  assert.deepEqual(db.writes.status, [['unverified', 777, 'acc-1']], 'unverified + timestamp persisted');
  assert.doesNotMatch(res.err ?? '', /decrypt|atob|Error/i, 'no decrypt internals leaked');
  console.log('ok 18 testAccount empty seed unavailable');
}

// 18b. Null token column → same unavailable path.
{
  const db = makeDb();
  accountRows.set('acc-1', { encrypted_token: null, provider: 'cloudflare' });
  const res = await withClock(888, () => testAccount(envWithRows(), db, 'acc-1'));
  assert.equal(res.status, 'unavailable', 'null seed is unavailable');
  assert.deepEqual(db.writes.status, [['unverified', 888, 'acc-1']], 'unverified + timestamp persisted');
  console.log('ok 18b testAccount null seed unavailable');
}

// 19. Corrupt ciphertext → unavailable, decrypt exception never surfaced.
{
  const db = makeDb();
  accountRows.set('acc-1', { encrypted_token: new Uint8Array([1, 2, 3]).buffer, provider: 'cloudflare' });
  const res = await withClock(999, () => testAccount(envWithRows(), db, 'acc-1'));
  assert.equal(res.status, 'unavailable', 'corrupt seed is unavailable');
  assert.deepEqual(db.writes.status, [['unverified', 999, 'acc-1']], 'unverified + timestamp persisted');
  assert.doesNotMatch(res.err ?? '', /too short|lb\/crypto|Error/i, 'no decrypt internals leaked');
  console.log('ok 19 testAccount corrupt seed unavailable');
}

// 19b. Wrong encryption key → unavailable, no crypto detail.
{
  const db = makeDb();
  accountRows.set('acc-1', {
    encrypted_token: asBuffer(await encryptToken('a-completely-different-key-value', 'one-token')),
    provider: 'cloudflare',
  });
  const res = await withClock(1010, () => testAccount(envWithRows(), db, 'acc-1'));
  assert.equal(res.status, 'unavailable', 'undecryptable seed is unavailable');
  assert.deepEqual(db.writes.status, [['unverified', 1010, 'acc-1']], 'unverified + timestamp persisted');
  assert.doesNotMatch(res.err ?? '', /decrypt|operation|crypto/i, 'no crypto detail leaked');
  console.log('ok 19b testAccount wrong key unavailable');
}

// 20. Unknown account → unavailable, no status write.
{
  const db = makeDb();
  const res = await testAccount(envWithRows(), db, 'missing-id');
  assert.equal(res.status, 'unavailable', 'unknown account unavailable');
  assert.equal(res.ok, false, 'not ok');
  assert.equal(db.writes.status.length, 0, 'no status write for unknown account');
  console.log('ok 20 testAccount unknown account');
}

globalThis.fetch = origFetch;
console.log('ALL PASS');
