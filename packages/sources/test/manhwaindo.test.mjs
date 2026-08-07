// ManhwaIndo adapter self-check against fixture HTML. No network.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manhwaindoAdapter } from '../manhwaindo/index.ts';

const detailFixture = readFileSync(new URL('../manhwaindo/fixtures/detail.html', import.meta.url), 'utf8');
const chapterFixture = readFileSync(new URL('../manhwaindo/fixtures/chapter.html', import.meta.url), 'utf8');
const searchFixture = readFileSync(new URL('../manhwaindo/fixtures/search.html', import.meta.url), 'utf8');

test('search parses .bsx cards with slug/title/type', () => {
  const adapter = manhwaindoAdapter();
  const items = adapter.searchFromFixtureForTest(searchFixture);
  assert.ok(items.length >= 3, `expected 3+ cards, got ${items.length}`);
  assert.ok(items.some((s) => s.title === 'Lookism'));
  for (const it of items) {
    assert.ok(it.slug);
    assert.equal(it.source, 'manhwaindo');
    assert.equal(it.type, 'manhwa');
  }
  assert.match(items[0].cover_image ?? '', /kacu\.gmbr\.pro/);
});

test('getSeries maps detail page to normalized Series', () => {
  const adapter = manhwaindoAdapter();
  const s = adapter.getSeriesFromFixtureForTest(detailFixture, 'insector');
  assert.equal(s.title, 'Insector');
  assert.equal(s.source, 'manhwaindo');
  assert.equal(s.status, 'ongoing');
  assert.equal(s.type, 'manhwa');
  assert.ok(Array.isArray(s.genres) && s.genres.includes('Action'));
  assert.ok(s.cover_image && s.cover_image.startsWith('http'));
  assert.ok(s.synopsis && s.synopsis.length > 50, 'synopsis present');
});

test('listChapters parses chapter list with numbers + dates', () => {
  const adapter = manhwaindoAdapter();
  const chapters = adapter.listChaptersFromFixtureForTest(detailFixture, 'insector');
  assert.ok(chapters.length >= 95, `expected 95+ chapters, got ${chapters.length}`);
  const first = chapters[0];
  assert.equal(first.chapter_number, 95);
  assert.equal(first.language, 'id');
  assert.ok(first.published_at && first.published_at > 0, 'date parsed');
});

test('fetchPageUrls extracts chapter images', () => {
  const adapter = manhwaindoAdapter();
  const urls = adapter.fetchPageUrlsFromFixtureForTest(chapterFixture);
  assert.ok(urls.length >= 10, `expected 10+ page images, got ${urls.length}`);
  for (const u of urls) {
    assert.match(u.url, /\.(webp|jpe?g|png)/);
    assert.equal(u.proxyHeaders?.Referer, 'https://www.manhwaindo.my/');
  }
});