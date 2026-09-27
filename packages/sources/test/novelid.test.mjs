// novelid.org chapter parser self-check. No network — pure parser unit tests.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChapterSourceId,
  buildChapterUrl,
  buildSeriesUrl,
  parseChapterHtml,
  parseChapterListHtml,
  parseSearchHtml,
  parseSeriesHtml,
  stripCoverQuery,
} from '../novelid/rules.ts';

const fixture = readFileSync(new URL('./fixtures/novelid-chapter.html', import.meta.url), 'utf8');

test('fixture retains the inline CSS preamble that shadows the container name', () => {
  // `.watch-chapter-detail{...}` appears in CSS before the real <div>. A parser
  // that just indexOf's the class name lands on the stylesheet, so the fixture
  // has to keep that trap or the test proves nothing.
  const cssRule = fixture.indexOf('.watch-chapter-detail{');
  const realDiv = fixture.indexOf('<div class="watch-chapter-detail">');
  assert.ok(cssRule !== -1, 'CSS rule present in fixture');
  assert.ok(realDiv > cssRule, 'real div comes after the CSS rule');
});

test('parseChapterHtml returns prose from the detail div, not the CSS preamble', () => {
  const html = parseChapterHtml(fixture);
  assert.ok(html, 'prose extracted');
  assert.ok(html.length > 500, `expected >500 chars of prose, got ${html.length}`);
  assert.ok(
    html.includes('Jam dinding di ruang makan sudah lewat pukul sebelas malam.'),
    'known opening sentence present'
  );
  assert.ok(!/<style/i.test(html), 'no <style>');
  assert.ok(!/<script/i.test(html), 'no <script>');
  assert.ok(!/css/i.test(html), 'no css token');
});

test('parseChapterHtml returns null when the detail div is absent', () => {
  const noContainer = '<html><body><div class="other">bukan bab novel</div></body></html>';
  assert.equal(parseChapterHtml(noContainer), null);
  assert.equal(parseChapterHtml(''), null);
  // Stylesheet-only page: class name present in CSS but no <div>. Must be null,
  // not the CSS text.
  const cssOnly = '<style>.watch-chapter-detail{margin-bottom:30px;}</style>';
  assert.equal(parseChapterHtml(cssOnly), null);
});

test('URL builders', () => {
  assert.equal(buildSeriesUrl('halal-tapi-asing'), 'https://novelid.org/novel/halal-tapi-asing/');
  assert.equal(buildChapterUrl('halal-tapi-asing', 1), 'https://novelid.org/novel/halal-tapi-asing/bab/1/');
});

test('buildChapterSourceId reads the bab number out of a chapter URL', () => {
  assert.equal(buildChapterSourceId('https://novelid.org/novel/x/bab/12/'), '12');
  assert.equal(buildChapterSourceId('https://novelid.org/novel/x/bab/12'), '12');
  assert.equal(buildChapterSourceId('https://novelid.org/novel/x/'), null);
});

test('stripCoverQuery drops the resize thumbnail params', () => {
  assert.equal(
    stripCoverQuery('https://novelid.org/uploads/a.jpg?resize=139,184'),
    'https://novelid.org/uploads/a.jpg'
  );
  assert.equal(stripCoverQuery('https://novelid.org/uploads/a.jpg'), 'https://novelid.org/uploads/a.jpg');
  assert.equal(stripCoverQuery(null), null);
});

// Attribute order and commented-out alternates are the two shapes that broke
// the first draft of the card parsers; both come from the live templates.
const SEARCH_CARD = `<style>.genre-item-box{color:#333}</style>
  <a href='/novel/halal-tapi-asing' class='genre-item-box'>
   <div class='genre-content-item'><div class='genre-item-image'>
   <img src='https://novelid.org/uploads/a.jpg?resize=120,160'></div>
   <div class='genre-item-info'><p class='genre-item-title'>Halal tapi Asing</p>
   <!--          <p class='genre-item-label'>Fantasy</p>-->
   <div class='genre-label'> <span class='genre-item-label'> Religi </span> </div></div></div></a>`;

test('parseSearchHtml reads href-before-class cards and skips commented markup', () => {
  const items = parseSearchHtml(SEARCH_CARD);
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, 'halal-tapi-asing');
  assert.equal(items[0].title, 'Halal tapi Asing');
  assert.equal(items[0].coverUrl, 'https://novelid.org/uploads/a.jpg');
  assert.equal(items[0].genre, 'Religi');
});

const SERIES_PAGE = `<div class="detail-top" style="background-image: url(/uploads/author/cov.webp);">
   <p class="detail-author web-author">Nama Author ：Qiev</p>
   <div class="detail-title">Halal tapi Asing</div>
   <p class="detail-desc-info"> &ldquo;Kenapa masih bertahan?&rdquo; CeritaAboutNothing<br/><br/>
   Karya ini diterbitkan atas izin NovelID </p>
   <div class="detail-tag-content"><div class="detail-tag-item"><span>Romantis</span></div>
   <div class="detail-tag-item"><span>Tamat</span></div></div></div>`;

test('parseSeriesHtml maps the detail page and trims the site disclaimer', () => {
  const parsed = parseSeriesHtml(SERIES_PAGE, 'halal-tapi-asing');
  assert.equal(parsed.title, 'Halal tapi Asing');
  assert.equal(parsed.author, 'Qiev');
  assert.deepEqual(parsed.genres, ['Romantis', 'Tamat']);
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.coverUrl, 'https://novelid.org/uploads/author/cov.webp');
  assert.equal(parsed.synopsis, '\u201cKenapa masih bertahan?\u201d CeritaAboutNothing');
});

test('parseChapterListHtml reads number + title and ignores the "Mulai lihat" CTA', () => {
  const html = `<div class="detail-top-btn-box"><a href="/novel/x//bab/1/"> Mulai lihat EP.1 </a></div>
   <div class="episodes-info clear">
   <a class="episodes-info-a-item" href="/novel/x//bab/1/"> <div class="episodes-item">
   <span class="episode-item-num">1</span><span class="episode-item-title">Terasa Asing</span></div></a>
   <a class="episodes-info-a-item" href="/novel/x//bab/2/"> <div class="episodes-item">
   <span class="episode-item-num">2</span><span class="episode-item-title">OVT</span></div></a></div>`;
  const episodes = parseChapterListHtml(html);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].number, 1);
  assert.equal(episodes[0].title, 'Terasa Asing');
  // Upstream emits a doubled slash; the stored href must be usable as-is.
  assert.equal(episodes[0].href, 'https://novelid.org/novel/x/bab/1/');
});
