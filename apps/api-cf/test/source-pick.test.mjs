import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRecommendedSource, SOURCE_WEIGHT } from '../src/routes/reader.ts';

const L = (overrides = {}) => ({
  source: 'komiku',
  hasChapterList: true,
  chapterCount: 0,
  lastScrapedAt: null,
  ...overrides,
});

test('picks source with most chapters', () => {
  const links = [
    L({ source: 'komiku', chapterCount: 100 }),
    L({ source: 'bacakomik', chapterCount: 200, hasChapterList: true }),
    L({ source: 'thrive', chapterCount: 150, hasChapterList: true }),
  ];
  assert.equal(pickRecommendedSource(links), 'bacakomik');
});

test('tie-break by most recent last_scraped_at', () => {
  const links = [
    L({ source: 'komiku', chapterCount: 100, lastScrapedAt: 1000 }),
    L({ source: 'thrive', chapterCount: 100, lastScrapedAt: 5000 }),
  ];
  assert.equal(pickRecommendedSource(links), 'thrive');
});

test('excludes sources without chapter list', () => {
  const links = [
    L({ source: 'komiku', hasChapterList: false, chapterCount: 999 }),
    L({ source: 'bacakomik', hasChapterList: true, chapterCount: 10 }),
  ];
  assert.equal(pickRecommendedSource(links), 'bacakomik');
});

test('all-zero counts → static priority fallback', () => {
  const links = [
    L({ source: 'thrive', chapterCount: 0 }),
    L({ source: 'bacakomik', chapterCount: 0 }),
    L({ source: 'komiku', chapterCount: 0 }),
  ];
  assert.equal(pickRecommendedSource(links), 'komiku');
});

test('mixed data → real counts beat zero-count sources', () => {
  const links = [
    L({ source: 'komiku', chapterCount: 0 }),
    L({ source: 'manhwaindo', chapterCount: 300 }),
  ];
  assert.equal(pickRecommendedSource(links), 'manhwaindo');
});

test('null when no eligible source', () => {
  assert.equal(pickRecommendedSource([]), null);
  assert.equal(pickRecommendedSource([L({ hasChapterList: false })]), null);
});

test('SOURCE_WEIGHT order matches expected priority', () => {
  assert.ok(SOURCE_WEIGHT.komiku > SOURCE_WEIGHT.bacakomik);
  assert.ok(SOURCE_WEIGHT.bacakomik > SOURCE_WEIGHT.thrive);
  assert.ok(SOURCE_WEIGHT.thrive > SOURCE_WEIGHT.shinigami);
  assert.ok(SOURCE_WEIGHT.shinigami > SOURCE_WEIGHT.manhwaindo);
});
