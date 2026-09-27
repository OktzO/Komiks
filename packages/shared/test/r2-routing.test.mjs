import { test } from 'node:test';
import assert from 'node:assert/strict';
import { murmur3_32, b2KeyFor, buildRing, ringPick } from '../src/r2-routing.ts';

test('murmur3_32 known vector (seed 0)', () => {
  assert.equal(murmur3_32('hello'), 613153351);
});

test('murmur3_32 deterministic', () => {
  assert.equal(murmur3_32('naruto-chapter-1'), murmur3_32('naruto-chapter-1'));
});

test('b2KeyFor deterministic format {source}/{slug}/{chapterId}/{pageNo}', () => {
  assert.equal(b2KeyFor('komiku', 'naruto', 'naruto-chapter-1', 3), 'komiku/naruto/naruto-chapter-1/3');
});

test('buildRing N=0 → empty ring, ringPick = -1', () => {
  const ring = buildRing([]);
  assert.equal(ring.nodes.length, 0);
  assert.equal(ringPick(ring, 'anything'), -1);
});

test('buildRing N=1 → single node, every key → index 0 (approaches "always single account")', () => {
  const ring = buildRing(['a']);
  assert.ok(ring.nodes.length >= 1);
  for (let i = 0; i < 50; i++) {
    assert.equal(ringPick(ring, `key-${i}`), 0);
  }
  assert.equal(ringPick(ring, 'komiku/naruto/naruto-chapter-1/1'), 0);
});

test('buildRing N=2 → both buckets used, deterministic', () => {
  const ring = buildRing(['a', 'b']);
  const seen = new Set();
  const memo = new Map();
  for (let i = 0; i < 200; i++) {
    const key = `komiku/sl-${i}/ch-${i}/1`;
    const pick = ringPick(ring, key);
    assert.ok(pick === 0 || pick === 1, `pick out of range: ${pick}`);
    seen.add(pick);
    assert.equal(memo.has(key) ? memo.get(key) : memo.set(key, pick).get(key), pick);
  }
  assert.equal(seen.size, 2);
});

test('buildRing N=5 → all 5 nodes reachable, deterministic, balanced', () => {
  const ring = buildRing(['a', 'b', 'c', 'd', 'e']);
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < 1000; i++) {
    const pick = ringPick(ring, `komiku/slug-${i}/ch-1/1`);
    assert.ok(pick >= 0 && pick < 5, `pick out of range: ${pick}`);
    counts[pick]++;
  }
  // determinism
  for (let i = 0; i < 100; i++) {
    assert.equal(ringPick(ring, `komiku/slug-${i}/ch-1/1`), ringPick(ring, `komiku/slug-${i}/ch-1/1`));
  }
  // balance: semua bucket terisi dengan reasonable fraction
  for (const c of counts) {
    assert.ok(c > 50, `bucket underfilled: ${c}`);
    assert.ok(c < 400, `bucket overfilled: ${c}`);
  }
});

test('buildRing independent counts per resource type (N_ring_A=2, N_ring_B=4 in one test)', () => {
  // Ring per resource-type punya jumlah account independen; kedua ring hidup
  // dalam satu sistem (coordinated deploy) tanpa saling memengaruhi.
  const ringA = buildRing(['b2-a', 'b2-b']); // 2 account (mis. B2 storage piksel rendah)
  const ringB = buildRing(['c1', 'c2', 'c3', 'c4']); // 4 account (mis. chapter shard)
  assert.equal(ringA.nodes.length > 0, true);
  assert.equal(ringB.nodes.length > 0, true);
  const seenA = new Set();
  const seenB = new Set();
  const key = 'komiku/naruto-1/ch-1/p-1';
  for (let i = 0; i < 200; i++) {
    const k = `${key}:${i}`;
    const a = ringPick(ringA, k);
    const b = ringPick(ringB, k);
    assert.ok(a >= 0 && a < 2);
    assert.ok(b >= 0 && b < 4);
    seenA.add(a);
    seenB.add(b);
  }
  assert.ok(seenA.size >= 2, 'ring A (2 accounts) should use both buckets');
  assert.ok(seenB.size >= 3, 'ring B (4 accounts) should use most buckets');
});
