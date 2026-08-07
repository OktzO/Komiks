import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlugFromChapterId } from '../src/lib/komikuSlug.ts';

test('parses standard komiku chapter id', () => {
  assert.equal(parseSlugFromChapterId('naruto-chapter-123'), 'naruto');
});
test('parses slug with dashes', () => {
  assert.equal(parseSlugFromChapterId('one-piece-chapter-1089'), 'one-piece');
});
test('returns null on malformed', () => {
  assert.equal(parseSlugFromChapterId('not-a-chapter'), null);
});
test('returns null on empty slug', () => {
  assert.equal(parseSlugFromChapterId('-chapter-1'), null);
});