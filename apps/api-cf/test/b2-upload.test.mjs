import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseB2Accounts,
  resolveB2Accounts,
  b2AccountForIdx,
} from '../src/lib/b2Config.ts';

const validArray = JSON.stringify([
  { name: 'kom', bucket: 'manga-images', keyId: 'AK1', appKey: 'SK1', region: 'us-east-005' },
  { name: 'boltz', bucket: 'manga-images', keyId: 'AK2', appKey: 'SK2' }, // default region
]);

test('parseB2Accounts valid array', () => {
  const accs = parseB2Accounts(validArray);
  assert.equal(accs.length, 2);
  assert.equal(accs[0].name, 'kom');
  assert.equal(accs[0].host, 's3.us-east-005.backblazeb2.com');
  assert.equal(accs[1].region, 'us-east-005', 'missing region → default');
  assert.equal(accs[1].host, 's3.us-east-005.backblazeb2.com');
});

test('parseB2Accounts single-object backward-compat → 1-item array', () => {
  const single = JSON.stringify({ bucket: 'b1', keyId: 'k1', appKey: 'a1' });
  const accs = parseB2Accounts(single);
  assert.equal(accs.length, 1);
  assert.equal(accs[0].bucket, 'b1');
});

test('parseB2Accounts undefined → []', () => {
  assert.deepEqual(parseB2Accounts(undefined), []);
});

test('parseB2Accounts empty string → []', () => {
  assert.deepEqual(parseB2Accounts(''), []);
});

test('parseB2Accounts missing field throws', () => {
  assert.throws(() => parseB2Accounts('[{"bucket":"b"}]'), /missing field/);
});

test('b2AccountForIdx: idx<0 → B2 account', () => {
  const accs = parseB2Accounts(validArray);
  assert.equal(b2AccountForIdx(accs, -1)?.keyId, 'AK1');
  assert.equal(b2AccountForIdx(accs, -2)?.keyId, 'AK2');
});

test('b2AccountForIdx: idx>=0 (R2 legacy) → null', () => {
  const accs = parseB2Accounts(validArray);
  assert.equal(b2AccountForIdx(accs, 0), null);
  assert.equal(b2AccountForIdx(accs, 1), null);
});

test('b2AccountForIdx out of range → null', () => {
  const accs = parseB2Accounts(validArray);
  assert.equal(b2AccountForIdx(accs, -3), null);
});

test('resolveB2Accounts merges B2_CONFIG + B2_ACCOUNTS', () => {
  const config = JSON.stringify({ bucket: 'b1', keyId: 'AK1', appKey: 'SK1', region: 'us-east-005', name: 'kom' });
  const accounts = JSON.stringify([{ bucket: 'b2', keyId: 'AK2', appKey: 'SK2', region: 'eu-central-003', name: 'boltz' }]);
  const merged = resolveB2Accounts(config, accounts);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].keyId, 'AK1');
  assert.equal(merged[1].keyId, 'AK2');
});

test('resolveB2Accounts dedups by keyId', () => {
  const accts = JSON.stringify([
    { bucket: 'b1', keyId: 'AK1', appKey: 'SK1' },
    { bucket: 'b2', keyId: 'AK1', appKey: 'SK1' }, // dup
  ]);
  assert.equal(resolveB2Accounts(undefined, accts).length, 1);
});
