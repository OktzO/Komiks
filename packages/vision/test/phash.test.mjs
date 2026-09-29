// Self-check: Hamming distance — the comparison the identify route gates on.
// Run: packages/db/node_modules/.bin/tsx --test packages/vision/test/phash.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hammingDistance } from '../hamming.ts';

// identify.ts accepts a match at distance <= 8, so these are the values that
// decide one. A distance that cannot be computed has to fail the comparison, not
// pass it: returning 0 for a malformed pair would identify every upload as the
// same cover.
test('identical hashes are distance 0', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
});

test('a single flipped bit is distance 1', () => {
  assert.equal(hammingDistance('0000000000000000', '8000000000000000'), 1);
});

test('every bit flipped is distance 64', () => {
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
});

test('differing lengths are 64 — the widest distance, so never a match', () => {
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffffffff'), 64);
});

test('case does not matter, since hashes arrive from KV and D1 both', () => {
  assert.equal(hammingDistance('AABBCCDD00112233', 'aabbccdd00112233'), 0);
  // 3^2 = 1, so this is a genuine one-bit difference — 3^4 is three bits, which
  // is the kind of thing a test written by eye gets wrong and the fix for is to
  // assert the real value rather than the intended one.
  assert.equal(hammingDistance('AABBCCDD00112233', 'aabbccdd00112232'), 1);
});

// ponytail: phash and ahash themselves need OffscreenCanvas, which exists only
// in the Worker runtime — no test runner here can reach them, so nothing below
// this line is covered. `hashImage` silently falls back to ahash whenever the
// pHash path throws, which means a regression in DCT would not be visible. The
// fix is a fixture-driven test in the Worker runtime; add it when the identify
// route is next touched.
