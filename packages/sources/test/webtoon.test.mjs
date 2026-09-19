// Webtoon adapter self-check against fixture HTML/JSON.
// No network — pure parser unit tests.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webtoonAdapter } from '../webtoon/index.ts';

const mobileSeriesDetailFixture = {
  id: 95,
  title: "Tower of God",
  author: "SIU",
  summary: "A boy climbs the Tower...",
  thumbnail: "https://webtoon-phinf.pstatic.net/20250204_46/17386458444547o1b2_JPEG/95.jpg?type=q90",
  genre: "Fantasy, Action",
  link: "https://www.webtoons.com/id/fantasy/tower-of-god/list?title_no=95",
  status: "ongoing",
  completed: false,
  updateDay: "MONDAY"
};

const episodeListFixture = {
  episodes: [
    {
      episodeNo: 1,
      episodeTitle: "Prologue",
      thumbnail: "https://webtoon-phinf.pstatic.net/ep1.jpg",
      viewerLink: "/en/fantasy/tower-of-god/season-1-ep-0/viewer?title_no=95&episode_no=1",
      exposureDateMillis: 1577836800000,
      displayUp: false,
      hasBgm: false,
      genre: "Fantasy",
      author: "SIU",
      status: "ongoing"
    },
    {
      episodeNo: 2,
      episodeTitle: "Chapter 2",
      thumbnail: "https://webtoon-phinf.pstatic.net/ep2.jpg",
      viewerLink: "/en/fantasy/tower-of-god/season-1-ep-1/viewer?title_no=95&episode_no=2",
      exposureDateMillis: 1578528000000,
      displayUp: false,
      hasBgm: false,
      genre: "Fantasy",
      author: "SIU",
      status: "ongoing"
    }
  ]
};

const episodeViewerFixture = {
  id: 1,
  title: "Prologue",
  images: [
    "https://webtoon-phinf.pstatic.net/img1.jpg",
    "https://webtoon-phinf.pstatic.net/img2.jpg",
    "https://webtoon-phinf.pstatic.net/img3.jpg"
  ],
  genre: "Fantasy",
  slug: "tower-of-god",
  epSlug: "prologue"
};

test('getSeries maps detail JSON to normalized Series', () => {
  const adapter = webtoonAdapter();
  const s = adapter.getSeriesFromFixtureForTest(mobileSeriesDetailFixture);
  assert.equal(s.title, 'Tower of God');
  assert.equal(s.source, 'webtoon');
  assert.equal(s.slug, '95');
  assert.equal(s.external_id, '95');
  assert.ok(s.synopsis && s.synopsis.includes('A boy climbs'));
  assert.ok(s.cover_image && s.cover_image.startsWith('https://'));
  assert.ok(Array.isArray(s.genres) && s.genres.includes('Fantasy'));
  assert.equal(s.type, 'manga'); // genre "Fantasy, Action" maps to manga
  assert.equal(s.status, 'ongoing');
  assert.equal(s.author, 'SIU');
});

test('listChapters maps episode list to normalized Chapters', () => {
  const adapter = webtoonAdapter();
  const chapters = adapter.listChaptersFromFixtureForTest(episodeListFixture.episodes, '95');
  assert.equal(chapters.length, 2);
  const first = chapters[0];
  assert.equal(first.id, '95:1');
  assert.equal(first.chapter_number, 1);
  assert.equal(first.series_slug, '95');
  assert.ok(first.title && first.title.includes('Prologue'));
  assert.equal(first.language, 'id');
  assert.ok(first.published_at && first.published_at > 0);
});

test('fetchPageUrls extracts panel image URLs', () => {
  const adapter = webtoonAdapter();
  const urls = adapter.fetchPageUrlsFromFixtureForTest(episodeViewerFixture);
  assert.equal(urls.length, 3);
  for (const u of urls) {
    assert.ok(u.url.startsWith('https://webtoon-phinf.pstatic.net/'));
    assert.equal(u.proxyHeaders?.Referer, 'https://www.webtoons.com/');
  }
});

test('search function exists', () => {
  const adapter = webtoonAdapter();
  assert.ok(typeof adapter.search === 'function');
});