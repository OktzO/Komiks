// Self-check: runtime input validation and sanitized error mapping for the admin
// LB credential/provision routes.
// Run: npx tsx --test apps/api-cf/test/admin-lb-validate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  validateAccountBody,
  validateProvisionBody,
  accountMutationErrorResponse,
  provisionRequestErrorResponse,
  accountTestResponse,
  accountTestErrorResponse,
  router as lbRouter,
} from '../src/routes/admin/lb.ts';
import {
  AccountSelectionRequiredError,
  AccountNotAccessibleError,
  NoCloudflareAccountsError,
  AccountDiscoveryError,
} from '@manga-platform/lb/accounts';

const TOKEN = 'sk-live-token-value-1234';

test('account body: rejects missing token and unknown provider', () => {
  assert.equal(validateAccountBody(null).ok, false, 'null body rejected');
  assert.equal(validateAccountBody('nope').ok, false, 'non-object body rejected');
  assert.equal(validateAccountBody({ provider: 'cloudflare' }).ok, false, 'token required');
  assert.equal(validateAccountBody({ provider: 'aws', rawToken: 't' }).ok, false, 'unknown provider rejected');
});

test('account body: caps token length', () => {
  assert.equal(validateAccountBody({ provider: 'cloudflare', rawToken: 'x'.repeat(513) }).ok, false, 'token too long');
  assert.equal(validateAccountBody({ provider: 'cloudflare', rawToken: 'x'.repeat(512) }).ok, true, 'token at cap');
});

test('account body: label is optional, trimmed, and capped at 100', () => {
  const blank = validateAccountBody({ provider: 'cloudflare', rawToken: 'tok' });
  assert.equal(blank.ok, true, 'blank label accepted');
  assert.equal(blank.value.label, '', 'absent label normalizes to empty for server fallback');
  const padded = validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', label: '  Oktz  ' });
  assert.equal(padded.value.label, 'Oktz', 'label trimmed');
  assert.equal(
    validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', label: 'x'.repeat(101) }).ok,
    false,
    'label too long'
  );
  assert.equal(
    validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', label: 'a'.repeat(100) }).ok,
    true,
    'label at cap'
  );
  assert.equal(validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', label: 7 }).ok, false, 'non-string label');
});

test('account body: cloudflare accountId must be 32 hex chars', () => {
  const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const good = validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', accountId: id });
  assert.equal(good.ok, true, '32-hex accepted');
  assert.equal(good.value.accountId, id, 'accountId passed through');
  for (const bad of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), '', 'acct-1', 'A'.repeat(31) + '!']) {
    assert.equal(
      validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', accountId: bad }).ok,
      false,
      `rejected accountId ${JSON.stringify(bad)}`
    );
  }
  assert.equal(validateAccountBody({ provider: 'cloudflare', rawToken: 'tok', accountId: 5 }).ok, false, 'non-string');
});

test('account body: vercel ref has its own cap, independent of the label cap', () => {
  const ref = validateAccountBody({ provider: 'vercel', rawToken: 'tok', accountId: 'team_123' });
  assert.equal(ref.ok, true, 'vercel ref accepted');
  assert.equal(ref.value.accountId, 'team_123', 'vercel ref passed through');
  assert.equal(
    validateAccountBody({ provider: 'vercel', rawToken: 'tok', accountId: 'x'.repeat(101) }).ok,
    false,
    'vercel ref over 100 rejected'
  );
  assert.equal(
    validateAccountBody({ provider: 'vercel', rawToken: 'tok', accountId: 'x'.repeat(100) }).ok,
    true,
    'vercel ref at 100 accepted'
  );
});

test('account body: rejected payloads never echo the token', () => {
  const res = validateAccountBody({ provider: 'cloudflare', rawToken: TOKEN, label: 'x'.repeat(101) });
  assert.equal(res.ok, false);
  assert.doesNotMatch(JSON.stringify(res), /sk-live-token/, 'no token in validation error');
});

test('provision body: requires token and worker name', () => {
  assert.equal(validateProvisionBody({ cfApiToken: 't' }).ok, false, 'worker name required');
  assert.equal(validateProvisionBody({ workerName: 'manga-api-oktz' }).ok, false, 'token required');
  const good = validateProvisionBody({ cfApiToken: 't', workerName: 'manga-api-oktz' });
  assert.equal(good.ok, true, 'minimal provision body accepted');
  assert.equal(good.value.label, '', 'label optional for discovered-name fallback');
});

test('provision body: caps token and worker name length', () => {
  assert.equal(
    validateProvisionBody({ cfApiToken: 'x'.repeat(513), workerName: 'manga-api-oktz' }).ok,
    false,
    'token too long'
  );
  assert.equal(
    validateProvisionBody({ cfApiToken: 't', workerName: 'm'.repeat(64) }).ok,
    false,
    'worker name over 63 chars'
  );
  assert.equal(
    validateProvisionBody({ cfApiToken: 't', workerName: `m${'a'.repeat(61)}z` }).ok,
    true,
    'worker name at 63 chars'
  );
});

test('provision body: worker name must be a valid Cloudflare script name', () => {
  for (const bad of ['Manga-Api', 'manga_api', '-manga', 'manga-', 'manga api', 'manga.api', '']) {
    assert.equal(
      validateProvisionBody({ cfApiToken: 't', workerName: bad }).ok,
      false,
      `rejected worker name ${JSON.stringify(bad)}`
    );
  }
});

test('provision body: cloudflare accountId must be 32 hex chars', () => {
  const base = { cfApiToken: 't', workerName: 'manga-api-oktz' };
  assert.equal(validateProvisionBody({ ...base, accountId: 'b'.repeat(32) }).ok, true, '32-hex accepted');
  assert.equal(validateProvisionBody({ ...base, accountId: 'acct-1' }).ok, false, 'short id rejected');
  assert.equal(validateProvisionBody({ ...base, accountId: 'b'.repeat(33) }).ok, false, 'long id rejected');
});

test('provision body: label capped at 100 and rejected payloads are token-free', () => {
  const long = validateProvisionBody({
    cfApiToken: TOKEN,
    workerName: 'manga-api-oktz',
    label: 'x'.repeat(101),
  });
  assert.equal(long.ok, false, 'label too long');
  assert.doesNotMatch(JSON.stringify(long), /sk-live-token/, 'no token in validation error');
});

test('account mutation mapping: ambiguity is 409 with safe choices', () => {
  const accounts = [
    { id: 'a'.repeat(32), name: 'Oktz', type: 'standard' },
    { id: 'b'.repeat(32), name: 'Two', type: null },
  ];
  const res = accountMutationErrorResponse(new AccountSelectionRequiredError(accounts));
  assert.equal(res.status, 409, 'ambiguity conflict');
  assert.deepEqual(res.body, { error: 'account selection required', accounts }, 'safe choices only');
  assert.doesNotMatch(JSON.stringify(res.body), /sk-live-token/, 'no token in body');
});

test('account mutation mapping: unreachable requested id is 409', () => {
  const res = accountMutationErrorResponse(new AccountNotAccessibleError('c'.repeat(32)));
  assert.equal(res.status, 409, 'unreachable id conflict');
  assert.deepEqual(res.body, { error: 'account not accessible' }, 'stable body');
});

test('account mutation mapping: no accessible account is 422', () => {
  const res = accountMutationErrorResponse(new NoCloudflareAccountsError());
  assert.equal(res.status, 422, 'unprocessable');
  assert.deepEqual(res.body, { error: 'no accessible cloudflare accounts' }, 'stable body');
});

test('account mutation mapping: rejected token is 422, outage is 502', () => {
  const rejected = accountMutationErrorResponse(new AccountDiscoveryError('cloudflare_token_rejected', 'x'));
  assert.equal(rejected.status, 422, 'token problem is the caller input');
  assert.deepEqual(rejected.body, { error: 'cloudflare_token_rejected' }, 'actionable code');
  const forbidden = accountMutationErrorResponse(new AccountDiscoveryError('cloudflare_account_read_forbidden', 'x'));
  assert.equal(forbidden.status, 422, 'missing account-read permission is the caller input');
  assert.deepEqual(forbidden.body, { error: 'cloudflare_account_read_forbidden' }, 'actionable code');
  assert.deepEqual(provisionRequestErrorResponse(new AccountDiscoveryError('cloudflare_account_read_forbidden', 'x')), {
    status: 422,
    body: { error: 'cloudflare_account_read_forbidden' },
  }, 'provision mirrors it');
  for (const code of ['cloudflare_unavailable', 'cloudflare_invalid_response']) {
    const outage = accountMutationErrorResponse(new AccountDiscoveryError(code, 'x'));
    assert.equal(outage.status, 502, `${code} is an upstream failure`);
    assert.deepEqual(outage.body, { error: code }, 'actionable code echoed');
  }
});

test('account mutation mapping: unknown failure is 500 and leaks nothing', () => {
  const res = accountMutationErrorResponse(new Error(`MARKER-LEAK ${TOKEN} MARKER-LEAK`));
  assert.equal(res.status, 500, 'server-side failure');
  assert.doesNotMatch(JSON.stringify(res.body), /MARKER-LEAK|sk-live-token/, 'nothing echoed');
});

test('provision mapping: mirrors the account mapping with its own generic body', () => {
  const accounts = [{ id: 'a'.repeat(32), name: 'Oktz', type: 'standard' }];
  assert.deepEqual(provisionRequestErrorResponse(new AccountSelectionRequiredError(accounts)), {
    status: 409,
    body: { error: 'account selection required', accounts },
  }, 'ambiguity');
  assert.deepEqual(provisionRequestErrorResponse(new AccountNotAccessibleError('a'.repeat(32))), {
    status: 409,
    body: { error: 'account not accessible' },
  }, 'unreachable id');
  assert.deepEqual(provisionRequestErrorResponse(new NoCloudflareAccountsError()), {
    status: 422,
    body: { error: 'no accessible cloudflare accounts' },
  }, 'no accounts');
  assert.deepEqual(provisionRequestErrorResponse(new AccountDiscoveryError('cloudflare_token_rejected', 'x')), {
    status: 422,
    body: { error: 'cloudflare_token_rejected' },
  }, 'rejected token');
  assert.deepEqual(provisionRequestErrorResponse(new AccountDiscoveryError('cloudflare_unavailable', 'x')), {
    status: 502,
    body: { error: 'cloudflare_unavailable' },
  }, 'outage');
  const unknown = provisionRequestErrorResponse(new Error(`MARKER-LEAK ${TOKEN}`));
  assert.equal(unknown.status, 500, 'server-side failure');
  assert.doesNotMatch(JSON.stringify(unknown.body), /MARKER-LEAK|sk-live-token/, 'nothing echoed');
});

test('account mutation mapping: keys off the error code, not class identity', () => {
  const plain = { code: 'account_selection_required', accounts: [{ id: 'a'.repeat(32), name: 'Oktz', type: 'standard' }] };
  assert.deepEqual(accountMutationErrorResponse(plain), {
    status: 409,
    body: { error: 'account selection required', accounts: [{ id: 'a'.repeat(32), name: 'Oktz', type: 'standard' }] },
  }, 'code-identical plain object maps the same way');
  assert.deepEqual(accountMutationErrorResponse({ code: 'account_not_accessible' }), {
    status: 409,
    body: { error: 'account not accessible' },
  }, 'unreachable id');
});

test('account mutation mapping: echoed account choices are re-allowlisted', () => {
  const res = accountMutationErrorResponse({
    code: 'account_selection_required',
    accounts: [
      { id: 'a'.repeat(32), name: 'Oktz', type: 'standard', settings: { x: 1 }, token: 'sk-leak' },
      { id: 7, name: 'bad' },
      null,
      'nope',
    ],
  });
  assert.deepEqual(res.body.accounts, [{ id: 'a'.repeat(32), name: 'Oktz', type: 'standard' }], 'extras dropped');
  assert.doesNotMatch(JSON.stringify(res.body), /sk-leak|settings/, 'no provider extras echoed');
});

test('credential test mapping: every status has a fixed sanitized body', () => {
  assert.deepEqual(accountTestResponse({ ok: true, status: 'verified' }), {
    status: 200,
    body: { ok: true, status: 'verified', err: null },
  }, 'verified');
  assert.deepEqual(accountTestResponse({ ok: false, status: 'failed', err: 'cloudflare verify HTTP 403' }), {
    status: 200,
    body: { ok: false, status: 'failed', err: 'cloudflare verify HTTP 403' },
  }, 'failed keeps the stable provider message');
  assert.deepEqual(accountTestResponse({ ok: false, status: 'unavailable', err: 'credential unavailable' }), {
    status: 200,
    body: { ok: false, status: 'unavailable', err: 'credential unavailable' },
  }, 'unavailable');
});

test('credential test mapping: a thrown failure is caught and sanitized', () => {
  const res = accountTestErrorResponse(new Error(`MARKER-LEAK ${TOKEN}`));
  assert.equal(res.status, 500, 'server-side failure');
  assert.deepEqual(res.body, { error: 'account test failed' }, 'fixed body');
  assert.doesNotMatch(JSON.stringify(res.body), /MARKER-LEAK|sk-live-token/, 'nothing echoed');
});

const mountApp = () => {
  const app = new Hono();
  app.route('/admin/lb', lbRouter);
  return app;
};

test('protected LB routes answer 403 with no-store when there is no admin session', async () => {
  for (const [method, path] of [
    ['GET', '/admin/lb/accounts'],
    ['POST', '/admin/lb/accounts'],
    ['POST', '/admin/lb/accounts/provision'],
    ['POST', '/admin/lb/accounts/acc-1/test'],
    ['PUT', '/admin/lb/settings'],
    ['GET', '/admin/lb/accounts/acc-1/provision-status'],
  ]) {
    const res = await mountApp().request(path, { method, headers: {} });
    assert.equal(res.status, 403, `${method} ${path} is admin only`);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', `${method} ${path} 403 is no-store`);
  }
});

test('the 403 body never leaks provider or session detail', async () => {
  const res = await mountApp().request('/admin/lb/accounts', { method: 'GET' });
  assert.deepEqual(await res.json(), { error: 'admin required' }, 'fixed body');
});
