import { test } from 'node:test';
import assert from 'node:assert/strict';
import { murmur3_32, buildRing, accountFor, generateRemapReport } from '../src/r2-routing.ts';

test('murmur3_32 known vector (seed 0)', () => {
  assert.equal(murmur3_32('hello'), 613153351);
});

test('murmur3_32 deterministic', () => {
  assert.equal(murmur3_32('naruto-chapter-1'), murmur3_32('naruto-chapter-1'));
});

test('buildRing throws on empty accounts', () => {
  assert.throws(() => buildRing([]), /no accounts/);
});

test('buildRing throws on empty ring', () => {
  assert.throws(() => accountFor('x', []), /empty ring/);
});

test('single account routes everything to index 0', () => {
  const ring = buildRing(['cdn1.example.com'], 32);
  for (const k of ['naruto', 'one-piece', 'boruto']) {
    assert.equal(accountFor(k, ring), 0);
  }
});

test('accountFor deterministic across repeated calls', () => {
  const ring = buildRing(['cdn1.example.com', 'cdn2.example.com'], 32);
  const keys = Array.from({ length: 2000 }, (_, i) => `slug-${i}`);
  for (const k of keys) {
    assert.equal(accountFor(k, ring), accountFor(k, ring));
  }
});

test('distribution roughly balanced across 2 accounts', () => {
  const ring = buildRing(['cdn1.example.com', 'cdn2.example.com'], 32);
  const keys = Array.from({ length: 2000 }, (_, i) => `manga-${i}`);
  const counts = [0, 0];
  for (const k of keys) counts[accountFor(k, ring)]++;
  for (const c of counts) {
    assert.ok(c > keys.length * 0.2, `count ${c} too low`);
    assert.ok(c < keys.length * 0.8, `count ${c} too high`);
  }
});

test('remap 2→3 accounts moves a minority of keys', () => {
  const oldA = ['cdn1.example.com', 'cdn2.example.com'];
  const newA = ['cdn1.example.com', 'cdn2.example.com', 'cdn3.example.com'];
  const keys = Array.from({ length: 2000 }, (_, i) => `manga-${i}`);
  const report = generateRemapReport(keys, oldA, newA, 32);
  assert.ok(report.length > keys.length * 0.1, `moved ${report.length}`);
  assert.ok(report.length < keys.length * 0.75, `moved ${report.length}`);
  for (const r of report) {
    assert.notEqual(r.from, r.to);
    assert.ok(r.to >= 0 && r.to < newA.length);
  }
});