import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPeers, ownerFor, internalExec, internalQuery, peerKvGet } from '../src/lib/peers.ts';

const URLS = 'https://a.example.com,https://b.example.com,https://c.example.com';
const env = (over = {}) => ({ PEER_URLS: URLS, PEER_INDEX: '1', DB_FORWARD_KEY: 'sekret', ...over });

test('getPeers parses URLS + marks self via PEER_INDEX', () => {
  const peers = getPeers(env());
  assert.equal(peers.length, 3);
  assert.equal(peers[0].index, 0);
  assert.equal(peers[1].self, true);
  assert.equal(peers[0].self, false);
  assert.equal(peers[2].url, 'https://c.example.com');
});

test('ownerFor maps deterministically into [0, len)', () => {
  for (let i = 0; i < 50; i++) {
    const o = ownerFor(env(), `ch-${i}`);
    assert.ok(o.index >= 0 && o.index < 3);
    assert.equal(o.url, URLS.split(',')[o.index]);
  }
});

test('ownerFor is stable across calls', () => {
  assert.equal(ownerFor(env(), 'naruto-chapter-1').index, ownerFor(env(), 'naruto-chapter-1').index);
});

test('distribution roughly balanced', () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 900; i++) counts[ownerFor(env(), `manga-${i}`).index]++;
  for (const c of counts) {
    assert.ok(c > 200, `count ${c} too low`);
    assert.ok(c < 400, `count ${c} too high`);
  }
});

test('internalExec POSTs to /api/_internal/db/exec with forward key', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const ok = await internalExec(env(), 'https://b.example.com', {
    sql: 'INSERT INTO chapter_pages ...', params: [1], table: 'chapter_pages',
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://b.example.com/api/_internal/db/exec');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-db-forward-key'], 'sekret');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.table, 'chapter_pages');
  delete globalThis.fetch;
});

test('internalExec returns false without key or peer', async () => {
  assert.equal(await internalExec(env({ DB_FORWARD_KEY: undefined }), 'https://b.example.com', { sql: '', params: [], table: 'chapter_pages' }), false);
  assert.equal(await internalExec(env(), '', { sql: '', params: [], table: 'chapter_pages' }), false);
});

test('internalQuery returns rows on 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, results: [{ page_number: 1 }] }), { status: 200 });
  const rows = await internalQuery(env(), 'https://c.example.com', 'SELECT ...', [], 'chapter_pages');
  assert.deepEqual(rows, [{ page_number: 1 }]);
  delete globalThis.fetch;
});

test('internalQuery returns null on non-ok', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
  const rows = await internalQuery(env(), 'https://c.example.com', 'SELECT ...', [], 'chapter_pages');
  assert.equal(rows, null);
  delete globalThis.fetch;
});

test('peerKvGet returns first non-null value from peers', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ value: url.includes('a.example') ? { data: 42 } : null }), { status: 200 });
  };
  const v = await peerKvGet(env(), 'series:detail:komiku:naruto:id');
  assert.equal(v.data, 42);
  assert.ok(seen.some((u) => u.includes('kv/get')));
  delete globalThis.fetch;
});
