// BacaKomik adapter self-check against fixture HTML.
// No network — pure parser unit tests.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bacakomikAdapter } from '../bacakomik/index.ts';

const detailFixture = readFileSync(new URL('../bacakomik/fixtures/detail.html', import.meta.url), 'utf8');
const chapterFixture = readFileSync(new URL('../bacakomik/fixtures/chapter.html', import.meta.url), 'utf8');
const searchFixture = readFileSync(new URL('../bacakomik/fixtures/search.html', import.meta.url), 'utf8');

test('search parses animepost cards with slug/title/type', () => {
  const adapter = bacakomikAdapter();
  const items = adapter.searchFromFixtureForTest(searchFixture);
  assert.ok(items.length >= 5, `expected 5+ cards, got ${items.length}`);
  assert.ok(items.some((s) => s.title.toLowerCase().includes('nano machine')));
  for (const it of items) {
    assert.ok(it.slug, 'slug present');
    assert.ok(it.source === 'bacakomik');
    assert.ok(['manga', 'manhwa', 'manhua'].includes(it.type));
  }
});

test('getSeries maps detail page to normalized Series', () => {
  const adapter = bacakomikAdapter();
  const s = adapter.getSeriesFromFixtureForTest(detailFixture, 'nano-machine');
  assert.equal(s.title, 'Nano Machine');
  assert.equal(s.source, 'bacakomik');
  assert.equal(s.status, 'ongoing');
  assert.equal(s.type, 'manhwa');
  assert.ok(Array.isArray(s.genres) && (s.genres.length > 0 && s.genres.includes('Action')), 'genres parsed');
  assert.ok(s.cover_image, 'cover present');
  assert.ok(s.synopsis && s.synopsis.length > 10, 'synopsis present');
});

test('listChapters parses chapter list with numbers', () => {
  const adapter = bacakomikAdapter();
  const chapters = adapter.listChaptersFromFixtureForTest(detailFixture, 'nano-machine');
  assert.ok(chapters.length >= 10, `expected many chapters, got ${chapters.length}`);
  const first = chapters[0];
  assert.ok(first.id.endsWith('-chapter-324') || first.chapter_number === 324, 'newest chapter is 324');
  assert.equal(first.language, 'id');
});

test('fetchPageUrls extracts chapter images', () => {
  const adapter = bacakomikAdapter();
  const urls = adapter.fetchPageUrlsFromFixtureForTest(chapterFixture);
  assert.ok(urls.length > 0, 'at least one page image');
  for (const u of urls) {
    assert.ok(u.url.startsWith('http'));
    assert.equal(u.proxyHeaders?.Referer, 'https://bacakomik.my/');
  }
});