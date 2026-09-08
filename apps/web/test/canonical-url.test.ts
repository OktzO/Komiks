import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typedUrl, typedChapterUrl, isValidType } from '../lib/api';

test('typedUrl builds /manhwa/slug', () => {
  assert.equal(typedUrl('manhwa', 'solo-leveling'), '/manhwa/solo-leveling');
});

test('typedChapterUrl appends chapter', () => {
  assert.equal(typedChapterUrl('manga', 'one-piece', 'one-piece-chapter-1'), '/manga/one-piece/one-piece-chapter-1');
});

test('isValidType rejects source names', () => {
  assert.equal(isValidType('komiku'), false);
  assert.equal(isValidType('manhua'), true);
});
