// Thrive adapter self-check against fixture __NEXT_DATA__ JSON.
// No network — pure parser unit tests.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNextData } from '../thrive/client.ts';
import { thriveAdapter } from '../thrive/index.ts';

const detailFixture = JSON.parse(readFileSync(new URL('../thrive/fixtures/detail.json', import.meta.url), 'utf8'));
const chapterFixture = JSON.parse(readFileSync(new URL('../thrive/fixtures/chapter.json', import.meta.url), 'utf8'));
const homepageFixture = readFileSync(new URL('../thrive/fixtures/homepage.html', import.meta.url), 'utf8');

test('parseNextData extracts pageProps from __NEXT_DATA__ HTML', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(detailFixture)}</script></body></html>`;
  const data = parseNextData(html);
  assert.ok(data, 'pageProps parsed');
  assert.equal(data.id, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
  assert.equal(data.title, 'One Piece');
});

test('getSeries maps pageProps to normalized Series', async () => {
  const adapter = thriveAdapter();
  // Stub fetchHtml via monkeypatch? fixture-driven: call parser path directly.
  const detail = parseNextData(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(detailFixture)}</script>`);
  const series = await adapter.getSeriesFromFixtureForTest(detail);
  assert.equal(series.slug, 'a1c7c817-4e59-43b7-9365-09675a149a6f');
  assert.equal(series.source, 'thrive');
  assert.equal(series.status, 'ongoing');
  assert.ok(series.title, 'One Piece');
  assert.ok(series.synopsis.includes('Raja Bajak Laut'));
  assert.ok(Array.isArray(series.genres) && series.genres.length > 0);
  assert.match(series.cover_image ?? '', /^https:\/\/uploads\.mangadex\.org\//);
});

test('chapterlist maps to Chapter[]', async () => {
  const adapter = thriveAdapter();
  const chapters = adapter.listChaptersFromFixtureForTest(detailFixture.props.pageProps);
  assert.ok(chapters.length >= 2);
  const first = chapters[0];
  assert.equal(first.id, '0a6decca-5396-4f3e-84b6-03d2df7054eb');
  assert.equal(first.chapter_number, 1103);
  assert.equal(first.title, 'Maafkan Aku, Ayah');
  assert.ok(first.published_at && first.published_at > 0);
});

test('fetchPageUrls builds cdn.thrive.moe URLs from prefix + images', () => {
  const adapter = thriveAdapter();
  const urls = adapter.fetchPageUrlsFromFixtureForTest(chapterFixture.props.pageProps);
  assert.equal(urls.length, 3);
  assert.match(urls[0].url, /^https:\/\/cdn\.thrive\.moe\/data\/a929ae013b24248e6f7e8262cb3bb1a2\/1-c53d0339/);
  assert.equal(urls[0].proxyHeaders?.Referer, 'https://thrive.moe/');
});

test('homepage listing parses carousel cards with covers', () => {
  const adapter = thriveAdapter();
  const items = adapter.searchHomepageFromFixtureForTest(homepageFixture);
  assert.ok(items.length >= 20, `expected 20+ cards, got ${items.length}`);
  assert.ok(items.some((s) => s.slug === 'ba8730b3-cef9-4d99-97bb-bcfeeca6a61e'));
  const withCover = items.filter((s) => s.cover_image);
  assert.ok(withCover.length > 0, 'covers resolved');
  assert.match(withCover[0].cover_image, /cdn\.thrive\.moe\/covers/);
});