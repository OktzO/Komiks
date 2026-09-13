import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typedUrl, typedChapterUrl, isValidType, safeType } from '../src/lib/api';

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

test('safeType passes valid types through', () => {
  assert.equal(safeType('manga'), 'manga');
  assert.equal(safeType('manhwa'), 'manhwa');
  assert.equal(safeType('manhua'), 'manhua');
});

test('safeType falls back to manga on undefined/null/empty', () => {
  assert.equal(safeType(undefined), 'manga');
  assert.equal(safeType(null), 'manga');
  assert.equal(safeType(''), 'manga');
});

test('safeType falls back to manga on non-type strings (source names)', () => {
  assert.equal(safeType('komiku'), 'manga');
  assert.equal(safeType('bacakomik'), 'manga');
  assert.equal(safeType('ongoing'), 'manga');
});
