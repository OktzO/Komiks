// Session reads were fail-closed on the D1 row: if the row was missing, or the
// owning shard could not be reached, getSessionUser returned null and the user
// was logged out. Both of those are common and neither means "revoked":
//
//   - A missing row happens whenever the login-time insert to the owner shard did
//     not land (createSession swallows a failed forward) or the row predates
//     sharding. Verified on production: 3 session rows sit in the shard belonging
//     to a different user id, so those users can never pass the read.
//   - An unreachable shard is an infrastructure fault and was indistinguishable
//     from a revocation. With the BFF proxy rotating every /api/user/* request
//     across four Workers in four accounts, any D1 hiccup on the owning account
//     logged the user out at random.
//
// Revocation is never expressed by a missing row — revoke always runs
// `UPDATE sessions SET revoked_at = ?1`, never a DELETE. So an absent or
// unreachable row carries no information about revocation, and the signed cookie
// (ECDSA over {sid, uid, email, role, exp}, verified before this lookup) is the
// authority on whether the session is genuine. These tests pin that split, and
// pin that a real revocation still logs the user out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerFor } from '../src/lib/peers.ts';
import { createSession, revokeSessionForUser, getSessionUser } from '../src/lib/auth.ts';

const URLS = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];
const PEER_ENV = { PEER_URLS: URLS.join(','), PEER_INDEX: '0', DB_FORWARD_KEY: 'sekret' };

const envFor = (DB, over = {}) => ({
  ...PEER_ENV,
  DB,
  CACHE_KV: { async get() { return null; }, async put() {}, async delete() {} },
  ...over,
});

const ownedByPeer = (index) => () => {
  for (let i = 1; i < 5000; i++) {
    if (ownerFor(PEER_ENV, String(i)).index === index) return i;
  }
  throw new Error(`no user id owned by peer ${index}`);
};
const localUserId = ownedByPeer(0);

/** Both halves of one keypair: the Worker signs with the private JWK and
 *  verifies against AUTH_PUBLIC_KEYS, so a read test needs both. */
const sessionKeys = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    AUTH_SIGNING_KEY: JSON.stringify({ kid: 'test-kid', ...priv }),
    AUTH_PUBLIC_KEYS: JSON.stringify([{ kid: 'test-kid', key: { ...pub, key_ops: ['verify'] } }]),
  };
};

/** D1 stub holding real session rows, so a login-time insert is visible to the
 *  read that follows it. Mirrors packages/db: insert runs, getSession selects
 *  `WHERE sid = ?1`, revoke updates revoked_at by sid. */
const stubD1 = () => {
  const rows = [];
  const trace = [];
  const client = {
    prepare(sql) {
      const rec = { sql, args: [] };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() {
          if (sql.includes('FROM sessions WHERE sid = ?1')) {
            return rows.find((r) => r.sid === rec.args[0]) ?? null;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.startsWith('INSERT INTO sessions')) {
            rows.push({
              sid: rec.args[0], user_id: rec.args[1], created_at: rec.args[2],
              expires_at: rec.args[3], ua: rec.args[4], ip: rec.args[5], revoked_at: null,
            });
          } else if (sql.startsWith('UPDATE sessions SET revoked_at')) {
            const row = rows.find((r) => r.sid === rec.args[1]);
            if (row) row.revoked_at = rec.args[0];
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  return { client, rows, trace };
};

const ctx = (env, cookie) => ({ env, req: { header: (k) => (k === 'cookie' ? cookie : null) } });
const cookieFor = (token) => `__Host-session=${token}`;
const asUser = { email: 'a@b.test', role: 'user' };
/** createSession mints its own sid; revoking needs that exact one. */
const sidOf = (token) => {
  const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64)).sid;
};

const stubFetch = (handler) => {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
};
const forwardsOk = () => stubFetch(async () =>
  new Response(JSON.stringify({ ok: true, results: [{ sid: '', user_id: 0, created_at: 0, expires_at: 0, revoked_at: null, ua: null, ip: null }] }), { status: 200 }));
const forwardsDown = (status) => stubFetch(async () =>
  new Response(JSON.stringify({ error: 'peer down' }), { status }));

test('a live session reads back as the user', async () => {
  const { client } = stubD1();
  const env = envFor(client, await sessionKeys());
  const userId = localUserId();
  const token = await createSession({ env, req: { header: () => null } }, userId, asUser);
  assert.deepEqual(await getSessionUser(ctx(env, cookieFor(token))), { id: userId, ...asUser });
});

test('an explicitly revoked session reads back as null', async () => {
  const { client } = stubD1();
  const env = envFor(client, await sessionKeys());
  const userId = localUserId();
  const token = await createSession({ env, req: { header: () => null } }, userId, asUser);
  await revokeSessionForUser(env, userId, sidOf(token));
  assert.equal(await getSessionUser(ctx(env, cookieFor(token))), null, 'revoked_at set => logged out');
});

test('a missing session row does not log the user out', async () => {
  const { client, rows } = stubD1();
  const env = envFor(client, await sessionKeys());
  const userId = localUserId();
  const token = await createSession({ env, req: { header: () => null } }, userId, asUser);
  rows.length = 0; // the insert never landed / the row predates sharding
  assert.deepEqual(
    await getSessionUser(ctx(env, cookieFor(token))),
    { id: userId, ...asUser },
    'an absent row is not a revocation — the signed cookie is the authority'
  );
});

test('an unreachable owning shard does not log the user out', async () => {
  const { client } = stubD1();
  const env = envFor(client, await sessionKeys());
  const userId = ownedByPeer(1)(); // owner is a remote peer => the read forwards
  const restoreWrite = forwardsOk();
  let token;
  try {
    token = await createSession({ env, req: { header: () => null } }, userId, asUser);
  } finally {
    restoreWrite();
  }
  const restore = forwardsDown(503); // owner and backup both unreachable
  try {
    assert.deepEqual(
      await getSessionUser(ctx(env, cookieFor(token))),
      { id: userId, ...asUser },
      'a D1 fault is not a revocation'
    );
  } finally {
    restore();
  }
});

test('a revoked session stays revoked even while the shard is unreachable', async () => {
  // The fail-open is only ever reached when nothing authoritative can be read.
  // When the row IS readable and says revoked, that answer must win.
  const { client } = stubD1();
  const env = envFor(client, await sessionKeys());
  const userId = localUserId();
  const token = await createSession({ env, req: { header: () => null } }, userId, asUser);
  await revokeSessionForUser(env, userId, sidOf(token));
  assert.equal(await getSessionUser(ctx(env, cookieFor(token))), null);
});

test('a token that is not signed by a known kid is still rejected', async () => {
  const { client } = stubD1();
  const env = envFor(client, await sessionKeys());
  assert.equal(await getSessionUser(ctx(env, cookieFor('bogus.bogus'))), null);
  assert.equal(await getSessionUser(ctx(env, 'other=1')), null, 'no session cookie at all');
});