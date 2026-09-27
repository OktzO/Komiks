import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickB2Account, pickB2AccountIdx } from '../src/lib/b2Config.ts';

const accounts = [
  { name: 'kom', bucket: 'manga-images', keyId: 'AK1', appKey: 'SK1', region: 'us-east-005', host: 's3.us-east-005.backblazeb2.com' },
  { name: 'boltz', bucket: 'manga-images', keyId: 'AK2', appKey: 'SK2', region: 'eu-central-003', host: 's3.eu-central-003.backblazeb2.com' },
];

test('single account → index 0', () => {
  assert.equal(pickB2AccountIdx([accounts[0]], 'komiku/naruto/ch1/1'), 0);
});

test('empty accounts → null account', () => {
  assert.equal(pickB2Account([], 'x'), null);
});

test('deterministic across calls', () => {
  const key = 'komiku/naruto/chapter-1/5';
  assert.equal(pickB2AccountIdx(accounts, key), pickB2AccountIdx(accounts, key));
});

test('distribution roughly balanced across 2 accounts', () => {
  const keys = Array.from({ length: 2000 }, (_, i) => `komiku/manga-${i}/ch/1`);
  const counts = [0, 0];
  for (const k of keys) counts[pickB2AccountIdx(accounts, k)]++;
  for (const c of counts) {
    assert.ok(c > keys.length * 0.3, `count ${c} too low`);
    assert.ok(c < keys.length * 0.7, `count ${c} too high`);
  }
});

test('pickB2Account returns the picked account', () => {
  const idx = pickB2AccountIdx(accounts, 'komiku/a/ch/1');
  assert.equal(pickB2Account(accounts, 'komiku/a/ch/1')?.keyId, accounts[idx].keyId);
});

test('N=1 (single B2 account) → selalu index 0 (no-op sharding)', () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(pickB2AccountIdx([accounts[0]], `komiku/k-${i}/ch/1`), 0);
  }
});

test('N=5 → deterministik, semua bucket tercapai, balance sanity', () => {
  const five = Array.from({ length: 5 }, (_, i) => ({
    name: `b2-${i}`, bucket: 'manga-images', keyId: `AK${i}`, appKey: `SK${i}`,
    region: 'us-east-005', host: 's3.us-east-005.backblazeb2.com',
  }));
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < 1500; i++) {
    const k = `komiku/manga-${i}/ch/1`;
    const idx = pickB2AccountIdx(five, k);
    assert.ok(idx >= 0 && idx < 5, `idx out of range: ${idx}`);
    counts[idx]++;
    assert.equal(idx, pickB2AccountIdx(five, k), 'deterministic across calls');
  }
  assert.equal(counts.filter((c) => c > 0).length, 5, 'all 5 buckets reachable');
  for (const c of counts) {
    assert.ok(c > 1500 * 0.05, `bucket underfilled: ${c}`);
    assert.ok(c < 1500 * 0.4, `bucket overfilled: ${c}`);
  }
});
