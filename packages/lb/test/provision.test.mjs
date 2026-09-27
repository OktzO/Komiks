// Self-check: provisionAccount flow. Every provider call is stubbed — no network.
// Run: npx tsx --test packages/lb/test/provision.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { provisionAccount, checkProvisionStatus } = await import('../provision.ts');

const CF_API = 'https://api.cloudflare.com/client/v4';
const ENC_KEY = 'test-key-32-bytes-long-aaaaaaaaa';
const CF_A = 'a'.repeat(32);
const CF_B = 'b'.repeat(32);
const D1_UUID = 'd1-uuid-0001';
const KV_ID = 'kv-uuid-0001';
const SUBDOMAIN = 'oktz';

// ---- provider stub: exact "METHOD /path" table, rejects anything unknown ---
const state = {
  accounts: {
    'one-token': [{ id: CF_A, name: 'Oktz', type: 'standard' }],
    'multi-token': [
      { id: CF_A, name: 'Oktz', type: 'standard' },
      { id: CF_B, name: 'Account Two', type: null },
    ],
  },
  tokenStatus: 'active',
  fail: {},
  calls: [],
  kvMissing: false,
};

const authOf = (init) =>
  String(init?.headers?.Authorization ?? init?.headers?.authorization ?? '').replace(/^Bearer\s+/, '');

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith(CF_API)) throw new Error(`unexpected remote call: ${u}`);
  const method = String(init?.method ?? 'GET').toUpperCase();
  const [path] = u.slice(CF_API.length).split('?');
  const key = `${method} ${path}`;
  const token = authOf(init);

  let metadata = null;
  if (typeof init?.body === 'string') {
    try { metadata = JSON.parse(init.body); } catch { metadata = null; }
  } else if (init?.body && typeof init.body.get === 'function') {
    const part = init.body.get('metadata');
    if (part) metadata = JSON.parse(await part.text());
  }
  state.calls.push({ key, token, metadata });

  if (key === 'GET /user/tokens/verify') {
    if (state.fail.verify) return jsonRes(403, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
    return jsonRes(200, { success: true, result: { status: state.tokenStatus } });
  }
  if (key === 'GET /accounts') return jsonRes(200, { success: true, result: state.accounts[token] ?? [] });
  if (key === `POST /accounts/${CF_A}/d1/database` || key === `POST /accounts/${CF_B}/d1/database`) {
    if (state.fail.d1Shape) return jsonRes(200, { success: true, result: { uuid: '' } });
    if (state.fail.d1) return jsonRes(state.fail.d1.status, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
    return jsonRes(200, { success: true, result: { uuid: D1_UUID } });
  }
  if (/\/d1\/database\/.+\/query$/.test(path)) {
    if (state.fail.query) return jsonRes(500, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
    return jsonRes(200, { success: true, result: [] });
  }
  if (key === `POST /accounts/${CF_A}/storage/kv/namespaces` || key === `POST /accounts/${CF_B}/storage/kv/namespaces`) {
    if (state.fail.kvShape) return jsonRes(200, { success: true, result: { id: '' } });
    if (state.fail.kv) return jsonRes(500, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
    return jsonRes(200, { success: true, result: { id: KV_ID } });
  }
  if (/workers\/scripts\/.+\/secrets$/.test(path)) {
    if (state.fail.secrets) return jsonRes(500, { success: false, errors: [{ message: 'MARKER-PROVIDER-LEAK' }] });
    return jsonRes(200, { success: true });
  }
  if (/workers\/scripts\/.+$/.test(path) && method === 'PUT' && metadata) return jsonRes(200, { success: true });
  if (/workers\/scripts\/.+\/subdomain$/.test(path)) return jsonRes(200, { success: true, result: {} });
  if (key === `GET /accounts/${CF_A}/workers/subdomain` || key === `GET /accounts/${CF_B}/workers/subdomain`) {
    return jsonRes(200, { success: true, result: { subdomain: SUBDOMAIN } });
  }
  throw new Error(`unstubbed provider call: ${key}`);
};

// ---- env stub -------------------------------------------------------------
const makeEnv = (over = {}) => {
  const kv = new Map([
    ['provision:schema:latest', 'CREATE TABLE t(x);'],
    ['provision:migration:latest', 'INSERT INTO t VALUES (1);'],
  ]);
  if (!state.kvMissing) {
    kv.set('worker-bundle:latest', Buffer.from('export default { fetch() {} };').toString('base64'));
  }
  return {
    LB_ENCRYPTION_KEY: ENC_KEY,
    CACHE_KV: {
      put: async (k, v) => { kv.set(k, v); },
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
    },
    DB: makeD1Stub(),
    peerUrl: 'https://w0.example,https://w1.example',
    ...over,
  };
};

// D1 stub shaped for the real `db()` seam in packages/db.
const makeD1Stub = () => {
  const ops = [];
  const counters = {};
  const nextId = (t) => `${t}-id-${(counters[t] = (counters[t] ?? 0) + 1)}`;
  return {
    ops,
    prepare: (sql) => ({
      bind: (...args) => ({
        run: async () => { ops.push({ op: 'run', sql, args }); return { success: true }; },
        first: async () => {
          ops.push({ op: 'first', sql, args });
          if (sql.includes('lb_origins') && state.fail.originThrow) throw new Error('MARKER-DB-LEAK');
          if (sql.includes('lb_origins') && state.fail.origin) return null;
          return { id: nextId(sql.includes('lb_origins') ? 'origin' : 'account') };
        },
        all: async () => ({ results: [] }),
      }),
    }),
  };
};

const rows = (env, table) => env.DB.ops.filter((o) => o.sql.includes(table));
const lastWrite = (env, table) => rows(env, table).at(-1);
const callsFor = (re) => state.calls.filter((c) => re.test(c.key));
const reset = () => {
  state.calls.length = 0;
  state.fail = {};
  state.tokenStatus = 'active';
  state.kvMissing = false;
};

const runFailed = async (env, jobId, input) => {
  await provisionAccount(env, input);
  const job = await checkProvisionStatus(env, jobId);
  assert.equal(job.status, 'failed', `${jobId} failed`);
  assert.equal(job.error, 'provision_failed', `${jobId} sanitized error`);
  return job;
};

// 1. Explicit accountId → pending-topology registration through the db() seam.
{
  reset();
  const env = makeEnv();
  env.CF_INVENTORY_TOKEN = 'inventory-token-supplied-by-operator';
  const res = await provisionAccount(env, {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-oktz',
    jobId: 'job-explicit',
    accountId: CF_A,
    createdBy: 7,
  });
  assert.equal(res.jobId, 'job-explicit', 'jobId echoed');
  const job = await checkProvisionStatus(env, 'job-explicit');
  assert.equal(job.status, 'completed', 'job completed');
  assert.match(job.workerUrl, /^https:\/\/manga-api-oktz\.[a-z0-9-]+\.workers\.dev$/, 'worker url recorded');

  const account = lastWrite(env, 'lb_accounts');
  assert.match(account.sql, /INSERT INTO lb_accounts/, 'account inserted via seam');
  assert.equal(typeof account.args[0], 'string', 'seam generates the account row id');
  assert.equal(account.args[1], 'cloudflare', 'provider cloudflare');
  assert.equal(account.args[2], 'Oktz', 'label stored');
  assert.equal(account.args[3], CF_A, 'real account_ref stored');
  assert.ok(account.args[4] instanceof ArrayBuffer, 'token stored encrypted');
  assert.equal(account.args[5], 'oken', 'token_last4 derived from the token');
  assert.equal(account.args[6], 'verified', 'status verified');
  assert.equal(account.args[7], 7, 'created_by from admin session');

  const origin = lastWrite(env, 'lb_origins');
  assert.match(origin.sql, /INSERT INTO lb_origins/, 'origin inserted via seam');
  assert.equal(origin.args[1], 'account-id-1', 'origin linked to the new account row');
  assert.equal(origin.args[2], job.workerUrl, 'origin url is the worker url');
  assert.equal(origin.args[3], 0, 'priority 0');
  assert.equal(origin.args[4], 1, 'weight 1');
  assert.equal(origin.args[5], 0, 'origin starts disabled');

  const audit = rows(env, 'lb_audit_log');
  assert.equal(audit.length, 1, 'exactly one audit row');
  assert.equal(audit[0].args[0], 'account-id-1', 'audit account id');
  assert.equal(audit[0].args[1], 'origin-id-1', 'audit origin id');
  assert.equal(audit[0].args[2], 'account.create.verified', 'audit action');
  assert.equal(audit[0].args[3], 7, 'audit user id');

  const deploy = callsFor(new RegExp(`^PUT .*workers/scripts/manga-api-oktz$`));
  assert.equal(deploy.length, 1, 'worker deployed once');
  const plain = Object.fromEntries(
    deploy[0].metadata.bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text])
  );
  assert.deepEqual(plain, {
    CF_ACCOUNT_ID: CF_A,
    CF_WORKER_NAME: 'manga-api-oktz',
    CF_D1_ID: D1_UUID,
    CF_KV_ID: KV_ID,
  }, 'non-secret topology bindings deployed');
  assert.equal(
    deploy[0].metadata.bindings.some((b) => b.name === 'CF_INVENTORY_TOKEN'),
    false,
    'inventory token is never a deploy binding'
  );

  const secretCalls = callsFor(/secrets$/);
  const inventorySecret = secretCalls.filter((c) => c.metadata?.name === 'CF_INVENTORY_TOKEN');
  assert.equal(inventorySecret.length, 1, 'inventory token secret set once');
  assert.equal(inventorySecret[0].metadata.text, 'inventory-token-supplied-by-operator', 'operator secret used');
  for (const call of secretCalls) {
    assert.doesNotMatch(JSON.stringify(call.metadata), /"one-token"/, 'DB token never re-sent as a secret');
  }

  assert.doesNotMatch(JSON.stringify(state.calls), /PEER_URLS|peerUrl/, 'no PEER_URLS read or written');
  assert.equal(env.peerUrl, 'https://w0.example,https://w1.example', 'PEER_URLS untouched');
  console.log('ok 1 provision explicit account pending topology');
}

// 2. No accountId, single accessible account → auto-select.
{
  reset();
  const env = makeEnv();
  const res = await provisionAccount(env, {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-auto',
    jobId: 'job-auto',
  });
  assert.equal(res.jobId, 'job-auto', 'jobId echoed');
  const job = await checkProvisionStatus(env, 'job-auto');
  assert.equal(job.status, 'completed', 'single account auto-selected');
  assert.equal(lastWrite(env, 'lb_accounts').args[3], CF_A, 'account_ref persisted');
  assert.equal(
    callsFor(/secrets$/).some((c) => c.metadata?.name === 'CF_INVENTORY_TOKEN'),
    false,
    'no inventory token secret without explicit env value'
  );
  console.log('ok 2 provision auto-select single account');
}

// 3. No accountId, multiple accounts → nothing is created.
{
  reset();
  const env = makeEnv();
  const res = await provisionAccount(env, {
    label: 'Oktz',
    cfApiToken: 'multi-token',
    workerName: 'manga-api-ambiguous',
    jobId: 'job-ambiguous',
  });
  const job = await runFailed(env, 'job-ambiguous', {
    label: 'Oktz',
    cfApiToken: 'multi-token',
    workerName: 'manga-api-ambiguous',
    jobId: 'job-ambiguous',
  });
  assert.equal(job.step, 'resolve account', 'fails while resolving the account');
  assert.equal(env.DB.ops.length, 0, 'no local rows written');
  assert.equal(callsFor(/d1\/database$/).length, 0, 'no D1 created');
  assert.equal(callsFor(/kv\/namespaces$/).length, 0, 'no KV created');
  assert.equal(res.jobId, 'job-ambiguous', 'jobId still returned');
  console.log('ok 3 provision ambiguous account refused');
}

// 4. Requested account outside the token → job fails before any resource.
{
  reset();
  const env = makeEnv();
  const job = await runFailed(env, 'job-wrong-account', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-wrong-account',
    jobId: 'job-wrong-account',
    accountId: CF_B,
  });
  assert.equal(job.step, 'resolve account', 'fails while resolving the account');
  assert.equal(job.accountId, undefined, 'no account handle claimed');
  assert.equal(env.DB.ops.length, 0, 'no local rows written');
  console.log('ok 4 provision unknown account refused');
}

// 5. D1 creation failure keeps the handles known so far.
{
  reset();
  const env = makeEnv();
  state.fail.d1 = { status: 500 };
  const job = await runFailed(env, 'job-fail-d1', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-fail',
    jobId: 'job-fail-d1',
    accountId: CF_A,
  });
  assert.equal(job.step, 'create D1', 'failing step retained');
  assert.equal(job.accountId, CF_A, 'account handle retained');
  assert.equal(job.databaseId, undefined, 'no database handle claimed');
  assert.equal(job.workerUrl, undefined, 'no worker url claimed');
  assert.doesNotMatch(JSON.stringify(job), /MARKER-PROVIDER-LEAK|one-token/, 'no provider body or token in job');
  assert.equal(rows(env, 'lb_accounts').length, 0, 'no account row on failure');
  assert.equal(rows(env, 'lb_origins').length, 0, 'no origin row on failure');
  console.log('ok 5 provision D1 failure keeps handles');
}

// 5b. Migration failure keeps the created database handle.
{
  reset();
  const env = makeEnv();
  state.fail.query = true;
  const job = await runFailed(env, 'job-fail-query', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-fail-query',
    jobId: 'job-fail-query',
    accountId: CF_A,
  });
  assert.equal(job.step, 'schema.sql', 'failing step retained');
  assert.equal(job.accountId, CF_A, 'account handle retained');
  assert.equal(job.databaseId, D1_UUID, 'database handle retained');
  assert.equal(job.kvId, undefined, 'no kv handle claimed');
  assert.equal(job.workerUrl, undefined, 'no worker url claimed');
  assert.equal(rows(env, 'lb_accounts').length, 0, 'no account row on failure');
  console.log('ok 5b provision migration failure keeps database handle');
}

// 5b-2. Only schema.sql is applied. packages/db/schema.sql is already the
// complete current baseline (it carries lb_accounts.last_tested_at and the
// _migrations ledger table), so replaying 0001_manga_data.sql on a database
// that was just created from it would fail on "duplicate column alt_titles"
// and on "table image_hashes already exists".
{
  reset();
  const env = makeEnv();
  await provisionAccount(env, {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-schema-only',
    jobId: 'job-schema-only',
    accountId: CF_A,
  });
  const queries = callsFor(/\/d1\/database\/.+\/query$/);
  assert.equal(queries.length, 1, 'exactly one D1 query: the schema');
  assert.equal(queries[0].metadata.sql, 'CREATE TABLE t(x);', 'that query is schema.sql');
  assert.equal(
    queries.some((call) => call.metadata.sql === 'INSERT INTO t VALUES (1);'),
    false,
    'the 0001 migration is never applied to a fresh database',
  );
  assert.equal(
    (await checkProvisionStatus(env, 'job-schema-only')).status,
    'completed',
    'provision still completes',
  );

  // The runtime dependency is gone, not just the apply: an env with no
  // provision:migration:latest key at all must still provision cleanly.
  reset();
  const bareEnv = makeEnv();
  const bareGet = bareEnv.CACHE_KV.get;
  bareEnv.CACHE_KV.get = async (k) =>
    (k === 'provision:migration:latest' ? null : bareGet(k));
  await provisionAccount(bareEnv, {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-no-migration-key',
    jobId: 'job-no-migration-key',
    accountId: CF_A,
  });
  assert.equal(
    (await checkProvisionStatus(bareEnv, 'job-no-migration-key')).status,
    'completed',
    'provision does not need the migration key in KV',
  );
  assert.equal(
    callsFor(/\/d1\/database\/.+\/query$/).length,
    1,
    'still a single schema query without the migration key',
  );
  console.log('ok 5b-2 provision applies schema.sql only');
}

// 5c. KV failure keeps the database handle and claims no KV.
{
  reset();
  const env = makeEnv();
  state.fail.kv = true;
  const job = await runFailed(env, 'job-fail-kv', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-fail-kv',
    jobId: 'job-fail-kv',
    accountId: CF_A,
  });
  assert.equal(job.step, 'create KV', 'failing step retained');
  assert.equal(job.databaseId, D1_UUID, 'database handle retained');
  assert.equal(job.kvId, undefined, 'no kv handle claimed');
  console.log('ok 5c provision KV failure keeps database handle');
}

// 5d. Secret failure keeps every handle including the worker URL.
{
  reset();
  const env = makeEnv();
  state.fail.secrets = true;
  const job = await runFailed(env, 'job-fail-secrets', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-fail-secrets',
    jobId: 'job-fail-secrets',
    accountId: CF_A,
  });
  assert.equal(job.step, 'set secrets', 'failing step retained');
  assert.equal(job.accountId, CF_A, 'account handle retained');
  assert.equal(job.databaseId, D1_UUID, 'database handle retained');
  assert.equal(job.kvId, KV_ID, 'kv handle retained');
  assert.match(job.workerUrl, /manga-api-fail-secrets\..*workers\.dev$/, 'worker url retained');
  assert.equal(rows(env, 'lb_accounts').length, 0, 'no account row on failure');
  console.log('ok 5d provision secret failure keeps all handles');
}

// 5e. Missing worker bundle in KV fails before any provider resource.
{
  reset();
  state.kvMissing = true;
  const env = makeEnv();
  const job = await runFailed(env, 'job-no-bundle', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-no-bundle',
    jobId: 'job-no-bundle',
    accountId: CF_A,
  });
  assert.equal(job.step, 'upload worker', 'failing step retained');
  assert.equal(job.accountId, CF_A, 'account handle retained');
  assert.equal(job.databaseId, D1_UUID, 'database handle retained');
  state.kvMissing = false;
  console.log('ok 5e provision missing bundle fails at deploy step');
}

// 6. Provider failure body never reaches the job state.
{
  reset();
  const env = makeEnv();
  state.fail.verify = true;
  const job = await runFailed(env, 'job-fail-verify', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-fail-verify',
    jobId: 'job-fail-verify',
    accountId: CF_A,
  });
  assert.equal(job.step, 'verify token', 'failing step retained');
  assert.doesNotMatch(JSON.stringify(job), /MARKER-PROVIDER-LEAK|one-token/, 'no provider body or token in job');
  assert.equal(env.DB.ops.length, 0, 'no local rows written');
  console.log('ok 6 provision verify failure sanitized');
}

// 7. A route-resolved account is reused instead of a second discovery call.
{
  reset();
  const env = makeEnv();
  const res = await provisionAccount(env, {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-resolved',
    jobId: 'job-resolved',
    accountId: CF_A,
    resolvedAccount: { id: CF_A, name: 'Oktz', type: 'standard' },
  });
  assert.equal(res.jobId, 'job-resolved', 'jobId echoed');
  const job = await checkProvisionStatus(env, 'job-resolved');
  assert.equal(job.status, 'completed', 'job completed');
  assert.equal(callsFor(/^GET \/accounts$/).length, 0, 'no duplicate discovery call');
  console.log('ok 7 provision reuses the resolved account');
}

// 7b. A resolved account that contradicts the requested id is refused.
{
  reset();
  const env = makeEnv();
  const job = await runFailed(env, 'job-mismatch', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-mismatch',
    jobId: 'job-mismatch',
    accountId: CF_B,
    resolvedAccount: { id: CF_A, name: 'Oktz', type: 'standard' },
  });
  assert.equal(job.step, 'resolve account', 'refused at account resolution');
  assert.equal(env.DB.ops.length, 0, 'no local rows written');
  assert.equal(callsFor(/d1\/database$/).length, 0, 'no D1 created');
  console.log('ok 7b provision rejects a contradictory resolved account');
}

// 8. Origin failure rolls the new account row back.
{
  reset();
  const env = makeEnv();
  state.fail.origin = true;
  const job = await runFailed(env, 'job-origin-fail', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-origin-fail',
    jobId: 'job-origin-fail',
    accountId: CF_A,
  });
  assert.equal(job.step, 'register account', 'fails at local registration');
  const deleted = rows(env, 'DELETE FROM lb_accounts');
  assert.equal(deleted.length, 1, 'new account row rolled back');
  assert.equal(deleted[0].args[0], 'account-id-1', 'rollback targets the new account');
  assert.equal(rows(env, 'lb_audit_log').length, 0, 'no audit for a rolled back registration');
  console.log('ok 8 provision rolls back on origin failure');
}

// 8b. A throwing createOrigin still rolls the new account row back.
{
  reset();
  const env = makeEnv();
  state.fail.originThrow = true;
  const job = await runFailed(env, 'job-origin-throw', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-origin-throw',
    jobId: 'job-origin-throw',
    accountId: CF_A,
  });
  assert.equal(job.step, 'register account', 'fails at local registration');
  assert.equal(job.error, 'provision_failed', 'sanitized job error');
  assert.equal(job.accountId, CF_A, 'account handle retained');
  assert.equal(job.databaseId, D1_UUID, 'database handle retained');
  assert.equal(job.kvId, KV_ID, 'kv handle retained');
  assert.match(job.workerUrl, /manga-api-origin-throw/, 'worker url retained');
  assert.doesNotMatch(JSON.stringify(job), /MARKER-DB-LEAK|one-token/, 'no db or token detail in job');
  const deleted = rows(env, 'DELETE FROM lb_accounts');
  assert.equal(deleted.length, 1, 'new account row rolled back on a thrown insert');
  assert.equal(deleted[0].args[0], 'account-id-1', 'rollback targets the new account');
  assert.equal(rows(env, 'lb_audit_log').length, 0, 'no audit for a rolled back registration');
  console.log('ok 8b provision rolls back when createOrigin throws');
}

// 8c. A missing KV id is refused before it reaches a binding.
{
  reset();
  const env = makeEnv();
  state.fail.kvShape = true;
  const job = await runFailed(env, 'job-kv-shape', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-kv-shape',
    jobId: 'job-kv-shape',
    accountId: CF_A,
  });
  assert.equal(job.step, 'create KV', 'fails at the KV step');
  assert.equal(job.kvId, undefined, 'no kv handle from an unusable payload');
  assert.equal(job.databaseId, D1_UUID, 'database handle retained');
  assert.equal(job.workerUrl, undefined, 'no worker url claimed');
  assert.equal(callsFor(new RegExp('workers/scripts/manga-api-kv-shape')).length, 0, 'nothing deployed');
  assert.equal(rows(env, 'lb_accounts').length, 0, 'no account row on failure');
  console.log('ok 8c provision refuses a missing KV id');
}

// 9. Missing provider ids are refused before they reach a binding.
{
  reset();
  const env = makeEnv();
  state.fail.d1Shape = true;
  const job = await runFailed(env, 'job-d1-shape', {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-d1-shape',
    jobId: 'job-d1-shape',
    accountId: CF_A,
  });
  assert.equal(job.step, 'create D1', 'fails at the D1 step');
  assert.equal(job.databaseId, undefined, 'no database handle from an unusable payload');
  assert.equal(callsFor(new RegExp(`workers/scripts/manga-api-d1-shape$`)).length, 0, 'nothing deployed');
  console.log('ok 9 provision refuses a missing D1 id');
}

// 10. No R2 creation step exists anywhere in the job lifecycle.
{
  reset();
  const env = makeEnv();
  const seen = [];
  const realPut = env.CACHE_KV.put;
  env.CACHE_KV.put = async (k, v) => { seen.push(JSON.parse(v)); return realPut(k, v); };
  await provisionAccount(env, {
    label: 'Oktz',
    cfApiToken: 'one-token',
    workerName: 'manga-api-steps',
    jobId: 'job-steps',
    accountId: CF_A,
  });
  const statuses = seen.map((j) => j.status);
  assert.equal(statuses.includes('creating_r2'), false, 'no dead creating_r2 state');
  assert.deepEqual(statuses, [
    'pending', 'verifying', 'verifying', 'verifying', 'creating_d1', 'migrating',
    'creating_kv', 'deploying', 'setting_secrets', 'registering', 'completed',
  ], 'observed job lifecycle — one migrating step, because schema.sql is the whole baseline');
  const final = seen.at(-1);
  assert.equal(final.status, 'completed', 'final job completed');
  assert.equal(final.accountId, CF_A, 'final job carries the account handle');
  assert.equal(final.workerUrl !== undefined, true, 'final job carries the worker url');
  assert.equal(callsFor(/r2|bucket/i).length, 0, 'no R2 provider call');
  console.log('ok 10 provision lifecycle without R2');
}

globalThis.fetch = origFetch;
console.log('ALL PASS');
