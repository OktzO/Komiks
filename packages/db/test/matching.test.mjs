// Matching/dedup self-check — no DB, pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, levenshtein, jaroWinkler, matchCandidate, FUZZY_THRESHOLD } from '../src/matching.ts';

const cands = [
  { id: 1, title: 'One Piece', alt_titles: ['ワンピース'] },
  { id: 2, title: 'Solo Leveling', alt_titles: ['나 혼자만 레벨업'] },
  { id: 3, title: 'Nano Machine', alt_titles: ['나노 마신'] },
  { id: 4, title: 'Lookism', alt_titles: ['외모지상주의'] },
];

test('normalizeTitle strips noise + case', () => {
  assert.equal(normalizeTitle('One Piece Chapter 1100'), 'one piece');
  assert.equal(normalizeTitle('Nano Machine (Full Color)'), 'nano machine');
  assert.equal(normalizeTitle('SOLO LEVELING - Vol 2'), 'solo leveling');
});

test('levenshtein known distances', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('one piece', 'one piece'), 0);
});

test('jaroWinkler exact = 1, similar high, dissimilar low', () => {
  assert.equal(jaroWinkler('one piece', 'one piece'), 1);
  assert.ok(jaroWinkler('nano machine', 'nano machine') === 1);
  assert.ok(jaroWinkler('nano mashin', 'nano machine') >= 0.9);
  assert.ok(jaroWinkler('one piece', 'solo leveling') < 0.6);
});

test('matchCandidate exact by title', () => {
  const r = matchCandidate('One Piece', cands);
  assert.equal(r.type, 'exact');
  assert.equal(r.id, 1);
});

test('matchCandidate exact by alt_title', () => {
  const r = matchCandidate('나 혼자만 레벨업', cands);
  assert.equal(r.type, 'exact');
  assert.equal(r.id, 2);
});

test('matchCandidate fuzzy near-miss (typo)', () => {
  const r = matchCandidate('Nano Mashin', cands);
  assert.equal(r.type, 'fuzzy');
  assert.equal(r.id, 3);
  assert.ok(r.score >= FUZZY_THRESHOLD);
});

test('matchCandidate ambiguous → queue', () => {
  // Two candidates with near-identical titles → queue.
  const similar = [
    { id: 10, title: 'Solo Leveling' },
    { id: 11, title: 'Solo Leveling' },
  ];
  const r = matchCandidate('Solo Leveling', similar);
  assert.equal(r.type, 'queue');
  assert.ok(r.candidateIds.length === 2);
});

test('matchCandidate new when no match', () => {
  const r = matchCandidate('Berserk', cands);
  assert.equal(r.type, 'new');
});