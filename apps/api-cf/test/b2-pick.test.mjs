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
