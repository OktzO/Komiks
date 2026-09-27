// The write-forward fallback, at every caller that has one.
//
// 6fe6f18 widened internalExec from Promise<boolean> to Promise<{ok, changes}> for
// the novel gap fill. Every other caller kept `const ok = await internalExec(...);
// if (!ok) { local write; enqueue outbox }` — and an object is always truthy, so
// the fallback became unreachable. A failed forward then reported success with no
// local write and no retry: session revoke silently did nothing, a user-scoped
// write was dropped, and the outbox never learned about it. `tsc` cannot catch
// `!someObject` and nothing here was covered, so it shipped.
//
// What is asserted below is always the same pair of facts: on a failed forward
// the local write actually runs, and on a successful forward it does not. The
// second half matters as much as the first — a fix that "always writes locally"
// would satisfy the fallback assertions alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ownerFor } from '../src/lib/peers.ts';
import { execOnUserOwner } from '../src/lib/userShard.ts';
import { createSession, revokeSessionForUser, revokeAllSessionsForUser } from '../src/lib/auth.ts';
import { flushOutbox } from '../src/lib/dbWrite.ts';

const srcFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
};

const URLS = ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'];

/** Four peers, this worker is peer 0, so most keys own a peer and take the
 *  forward path — which is the only path where a fallback can be wrong. */
const envFor = (DB, over = {}) => ({
  PEER_URLS: URLS.join(','),
  PEER_INDEX: '0',
  DB_FORWARD_KEY: 'sekret',
  DB,
  CACHE_KV: { async get() { return null; }, async put() {}, async delete() {} },
  ...over,
});

/** A key whose owner is a peer rather than this worker. */
const remoteKey = (prefix) => {
  for (let i = 0; i < 5000; i++) {
    const key = `${prefix}-${i}`;
    if (!ownerFor({ PEER_URLS: URLS.join(','), PEER_INDEX: '0' }, key).self) return key;
  }
  throw new Error('every key resolved to self');
};

/** A user id owned by peer 1 or 2, so the owner *and* its backup replica are both
 *  remote: owner 3 would take its backup from this worker, and the local write
 *  that replication legitimately makes is not the fallback under test. */
const remoteUserId = () => {
  for (let i = 1; i < 5000; i++) {
    const owner = ownerFor({ PEER_URLS: URLS.join(','), PEER_INDEX: '0' }, String(i));
    if (owner.index === 1 || owner.index === 2) return i;
  }
  throw new Error('no user id owned by a peer with a peer backup');
};

/** A D1 stub that records every statement, and keeps _outbox as real rows so a
 *  retry can be replayed by hand. `failLocal` makes every local write throw, which
 *  is how "nothing landed" is told apart from "the fallback ran". */
const stubD1 = ({ failLocal = false } = {}) => {
  const trace = [];
  let nextId = 1;
  const outbox = [];
  const record = (sql, rec) => {
    if (sql.startsWith('INSERT INTO _outbox')) {
      const [owner_url, table_name, sqlText, params] = rec.args;
      outbox.push({ id: nextId++, owner_url, table_name, sql: sqlText, params, attempts: 0 });
    } else if (sql.startsWith('DELETE FROM _outbox WHERE id')) {
      const at = outbox.findIndex((r) => r.id === rec.args[0]);
      if (at >= 0) outbox.splice(at, 1);
    } else if (sql.startsWith('UPDATE _outbox SET attempts')) {
      const row = outbox.find((r) => r.id === rec.args[0]);
      if (row) row.attempts += 1;
    }
  };
  const client = {
    prepare(sql) {
      const rec = { sql, args: [] };
      trace.push(rec);
      const stmt = {
        rec,
        bind(...args) { rec.args = args; return stmt; },
        async first() {
          if (sql.includes('FROM _outbox')) return { c: outbox.length };
          return null;
        },
        async all() {
          if (sql.includes('FROM _outbox')) return { results: outbox.slice(0, rec.args.at(-1)) };
          return { results: [] };
        },
        async run() {
          if (failLocal) throw new Error('local D1 unavailable');
          record(sql, rec);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(stmts) { return stmts.map(() => ({ success: true, meta: { changes: 1 } })); },
  };
  return { client, trace, outbox };
};

const ran = (trace, fragment) => trace.filter((r) => r.sql.includes(fragment));

/** Answer every forward with a status, so the fallback is the only path open. */
const forwarding = (status) => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    seen.push(String(input?.url ?? input));
    return new Response(JSON.stringify({ error: 'peer unavailable' }), { status });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
};

const acceptsForwards = () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    seen.push(String(input?.url ?? input));
    return new Response(JSON.stringify({ ok: true, target: 'local', changes: 1 }), { status: 200 });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
};

const sessionSigningKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return JSON.stringify({ kid: 'test-kid', ...jwk });
};

test('execOnUserOwner writes locally and queues the outbox when the forward fails', async () => {
  const userId = remoteUserId();
  const { client, trace, outbox } = stubD1();
  const fwd = forwarding(500);
  try {
    const ok = await execOnUserOwner(envFor(client), userId, 'UPDATE bookmarks SET page = ?1 WHERE user_id = ?2', [7, userId], 'bookmarks');
    assert.equal(ok, true, 'the local write landed, so the row is not lost');
    assert.equal(fwd.seen.length, 1, 'and the forward was actually attempted');
    assert.match(fwd.seen[0], /\/api\/_internal\/db\/exec$/);
    assert.equal(ran(trace, 'UPDATE bookmarks').length, 1, 'the local write is the fallback that never ran');
    assert.equal(outbox.length, 1, 'and the write is retried by the next flush');
    assert.equal(outbox[0].table_name, 'bookmarks');
    assert.ok(!outbox[0].sql.includes(String(userId)), 'the id is bound, not interpolated');
  } finally {
    fwd.restore();
  }
});

test('execOnUserOwner leaves the write to the owner when the forward succeeds', async () => {
  const userId = remoteUserId();
  const { client, trace, outbox } = stubD1();
  const fwd = acceptsForwards();
  try {
    assert.equal(await execOnUserOwner(envFor(client), userId, 'UPDATE bookmarks SET page = ?1 WHERE user_id = ?2', [7, userId], 'bookmarks'), true);
    assert.equal(fwd.seen.length, 1);
    assert.equal(ran(trace, 'UPDATE bookmarks').length, 0, 'the owner took the write; do not duplicate it here');
    assert.equal(outbox.length, 0, 'and nothing to retry');
  } finally {
    fwd.restore();
  }
});

test('execOnUserOwner reports failure when the forward fails and the local write fails too', async () => {
  const userId = remoteUserId();
  const { client } = stubD1({ failLocal: true });
  const fwd = forwarding(500);
  try {
    const ok = await execOnUserOwner(envFor(client), userId, 'UPDATE bookmarks SET page = ?1 WHERE user_id = ?2', [7, userId], 'bookmarks');
    assert.equal(ok, false, 'nothing landed, so the caller must not hear success');
  } finally {
    fwd.restore();
  }
});

test('a session revoke still revokes locally when the owner shard cannot be reached', async () => {
  const userId = remoteUserId();
  const { client, trace, outbox } = stubD1();
  const fwd = forwarding(500);
  try {
    const res = await revokeSessionForUser(envFor(client), userId, `${userId}:sid-1`);
    // The owner — the store that decides whether this session is live — never
    // confirmed the revoke, so the honest answer is failure even though the
    // local heal ran. Reporting success here is what left a revoked session valid.
    assert.deepEqual(res, { success: false });
    assert.equal(ran(trace, 'UPDATE sessions SET revoked_at').length, 1, 'the local revoke is the fallback that never ran');
    assert.ok(
      ran(trace, 'UPDATE sessions SET revoked_at').every((r) => r.sql.includes('WHERE sid = ?')),
      'and it targets the one session, not the user'
    );
    assert.equal(outbox.length, 0, 'sessions have no outbox row; the local write is the whole fallback');
  } finally {
    fwd.restore();
  }
});

test('a session revoke that the owner accepts touches nothing local', async () => {
  const userId = remoteUserId();
  const { client, trace } = stubD1();
  const fwd = acceptsForwards();
  try {
    assert.deepEqual(await revokeSessionForUser(envFor(client), userId, `${userId}:sid-1`), { success: true });
    assert.ok(fwd.seen.length >= 1, 'the owner was asked');
    assert.ok(fwd.seen.every((u) => u.endsWith('/api/_internal/db/exec')), 'and only by forwarding');
    assert.equal(ran(trace, 'UPDATE sessions').length, 0, 'the owner revoked it; a local copy is not a second authority');
  } finally {
    fwd.restore();
  }
});

test('revoke-all still revokes locally when the owner shard cannot be reached', async () => {
  const userId = remoteUserId();
  const { client, trace } = stubD1();
  const fwd = forwarding(500);
  try {
    const res = await revokeAllSessionsForUser(envFor(client), userId, undefined);
    assert.deepEqual(res, { revoked: 0 }, 'no session on the owner was confirmed revoked');
    assert.equal(ran(trace, 'UPDATE sessions SET revoked_at').length, 1, 'the local revoke-all is the fallback that never ran');
    assert.ok(ran(trace, 'UPDATE sessions SET revoked_at')[0].args.includes(userId), 'scoped to the user');
  } finally {
    fwd.restore();
  }
});

test('a session create still writes the row locally when the owner shard cannot be reached', async () => {
  const userId = remoteUserId();
  const { client, trace } = stubD1();
  const fwd = forwarding(500);
  const env = envFor(client, { AUTH_SIGNING_KEY: await sessionSigningKey() });
  try {
    const token = await createSession({ env, req: { header: () => null } }, userId, { email: 'a@b.test', role: 'user' });
    assert.ok(token.length > 0, 'the cookie is still issued — it is signed and exp-gated on its own');
    const inserts = ran(trace, 'INSERT INTO sessions');
    assert.equal(inserts.length, 1, 'the row write is the fallback that never ran');
    assert.ok(
      inserts[0].args.some((a) => typeof a === 'string' && a.startsWith(`${userId}:`)),
      'bound as a parameter'
    );
  } finally {
    fwd.restore();
  }
});

test('the outbox retries a write the owner would not accept, and stops retrying one it does', async () => {
  // The row's owner is a known peer, so flushOutbox attempts the forward instead
  // of dropping the row as unreachable.
  const { client, outbox } = stubD1();
  outbox.push({ id: 1, owner_url: URLS[1], table_name: 'chapter_pages', sql: 'UPDATE chapter_pages SET last_access = ?1', params: [1], attempts: 0 });
  const env = envFor(client);

  const failing = forwarding(500);
  try {
    assert.deepEqual(await flushOutbox(env), { flushed: 0, pending: 1 });
    assert.equal(outbox.length, 1, 'the row survives, or the write is lost for good');
    assert.equal(outbox[0].attempts, 1, 'and the attempt is counted');
  } finally {
    failing.restore();
  }

  const accepting = acceptsForwards();
  try {
    assert.deepEqual(await flushOutbox(env), { flushed: 1, pending: 0 });
    assert.equal(outbox.length, 0, 'accepted, so it is dequeued');
  } finally {
    accepting.restore();
  }
});

// The always-truthy shape has exactly one consumer, the novel gap fill, which
// reads .ok. Widening internalExec for a second caller is what broke the other
// seven, so a second consumer has to be a deliberate act with a test that says
// what it is doing — not something that happens by reaching for the object.
test('the counted forward has a single consumer, and it reads .ok', () => {
  const consumers = srcFiles(new URL('../src', import.meta.url).pathname)
    .filter((file) => readFileSync(file, 'utf8').includes('internalExecCounted('))
    .filter((file) => !file.endsWith('/lib/peers.ts'));
  assert.deepEqual(consumers.map((f) => f.slice(f.indexOf('/src/'))), ['/src/lib/novelIngest.ts']);
  const call = readFileSync(consumers[0], 'utf8');
  assert.ok(call.includes("if (forwarded?.ok) return forwarded;"), 'and it checks .ok rather than truthiness');
});
