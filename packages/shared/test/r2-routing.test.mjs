import { test } from 'node:test';
import assert from 'node:assert/strict';
import { murmur3_32, b2KeyFor } from '../src/r2-routing.ts';

test('murmur3_32 known vector (seed 0)', () => {
  assert.equal(murmur3_32('hello'), 613153351);
});

test('murmur3_32 deterministic', () => {
  assert.equal(murmur3_32('naruto-chapter-1'), murmur3_32('naruto-chapter-1'));
});

test('b2KeyFor deterministic format {source}/{slug}/{chapterId}/{pageNo}', () => {
  assert.equal(b2KeyFor('komiku', 'naruto', 'naruto-chapter-1', 3), 'komiku/naruto/naruto-chapter-1/3');
});

test('b2KeyFor rejects ring imports (buildRing removed)', async () => {
  const mod = await import('../src/r2-routing.ts');
  assert.equal(mod.buildRing, undefined);
  assert.equal(mod.accountFor, undefined);
  assert.equal(mod.generateRemapReport, undefined);
});
