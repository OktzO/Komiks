// Shinigami adapter self-check against fixture JSON (no network).
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shinigamiAdapter } from '../shinigami/index.ts';

const listFixture = JSON.parse(readFileSync(new URL('../shinigami/fixtures/list.json', import.meta.url), 'utf8'));
const searchFixture = JSON.parse(readFileSync(new URL('../shinigami/fixtures/search.json', import.meta.url), 'utf8'));
const detailFixture = JSON.parse(readFileSync(new URL('../shinigami/fixtures/detail.json', import.meta.url), 'utf8'));
const chaptersFixture = JSON.parse(readFileSync(new URL('../shinigami/fixtures/chapters.json', import.meta.url), 'utf8'));
const chapterFixture = JSON.parse(readFileSync(new URL('../shinigami/fixtures/chapter.json', import.meta.url), 'utf8'));

test('list data maps to Series', async () => {
  const adapter = shinigamiAdapter();
  const series = adapter.getSeriesFromFixtureForTest(listFixture.data[0]);
  assert.equal(series.source, 'shinigami');
  assert.ok(series.slug, 'has manga_id slug');
  assert.ok(series.title);
  assert.equal(series.status, 'ongoing');
  assert.ok(series.cover_image?.startsWith('https://assets.shngm.id/'));
  assert.ok(Array.isArray(series.genres) && series.genres.length > 0);
});

test('search fixture maps title + type', async () => {
  const adapter = shinigamiAdapter();
  const series = adapter.getSeriesFromFixtureForTest(searchFixture.data[0]);
  assert.equal(series.title, 'One Piece');
});

test('detail data maps full Series', async () => {
  const adapter = shinigamiAdapter();
  const series = adapter.getSeriesFromFixtureForTest(detailFixture.data);
  assert.ok(series.synopsis);
  assert.ok(series.genres && series.genres.length > 0);
});

test('chapter list maps to Chapter[]', async () => {
  const adapter = shinigamiAdapter();
  const chapters = adapter.listChaptersFromFixtureForTest(chaptersFixture.data, detailFixture.data.manga_id);
  assert.ok(chapters.length >= 3);
  const first = chapters[0];
  assert.ok(first.id);
  assert.ok(first.chapter_number > 0);
  assert.equal(first.series_slug, detailFixture.data.manga_id);
  assert.ok(first.published_at);
});

test('chapter detail maps to page URLs', async () => {
  const adapter = shinigamiAdapter();
  const pages = adapter.fetchPageUrlsFromFixtureForTest(chapterFixture.data);
  assert.ok(pages.length >= 2);
  assert.match(pages[0].url, /^https:\/\/assets\.shngm\.id\/chapter\/.*\.jpg$/);
  assert.equal(pages[0].proxyHeaders?.Referer, 'https://11.shinigami.asia/');
});
