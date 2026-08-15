// Regression test: getSeriesDetail must fetch the detail page ONCE (not twice).
// Root cause of intermittent 502: detail endpoint called getSeries + listChapters
// in Promise.all, each fetching the same komiku.org/manga/<slug>/ URL. Komiku's
// DDoS-guard edge stalls on parallel requests → intermittent 502.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { komikuAdapter } from '../komiku/index.ts';
import { bacakomikAdapter } from '../bacakomik/index.ts';
import { thriveAdapter } from '../thrive/index.ts';
import { manhwaindoAdapter } from '../manhwaindo/index.ts';

const DETAIL_HTML = `
<html>
<head>
  <meta property="og:image" content="https://thumbnail.komiku.to/new/img/images/2026/08/15/20260815161516_00162abb359b401b_8f9d608a.jpg" />
  <span itemprop="name">I Became the Villainess\u2019s Favorite</span>
  <div itemprop="description">A synopsis here.</div>
</head>
<body>
  <td>Author:</td><td>Some Author</td>
  <td>Status:</td><td>Ongoing</td>
  <td>Tipe:</td><td>Manga</td>
  <div class="mgen"><a href="/genre/fantasy">Fantasy</a></div>
  <a href="/i-became-the-villainesss-favorite-chapter-1/">
    <img src="https://img.komiku.org/foo/1.webp" />
  </a>
  <a href="/i-became-the-villainesss-favorite-chapter-1/" title="Baca I Became the Villainess\u2019s Favorite Chapter 1 Bahasa Indonesia">Ch 1</a>
  <a href="/i-became-the-villainesss-favorite-chapter-2/" title="Baca I Became the Villainess\u2019s Favorite Chapter 2 Bahasa Indonesia">Ch 2</a>
</body>
</html>
`;

test('all adapters expose getSeriesDetail', () => {
  const adapters = [
    ['komiku', komikuAdapter()],
    ['bacakomik', bacakomikAdapter()],
    ['thrive', thriveAdapter()],
    ['manhwaindo', manhwaindoAdapter()],
  ];
  for (const [name, adapter] of adapters) {
    assert.equal(typeof adapter.getSeriesDetail, 'function', `${name} missing getSeriesDetail`);
  }
});

test('komiku getSeriesDetail fetches detail page exactly once', async () => {
  let detailCalls = 0;
  const origFetch = global.fetch;
  global.fetch = function (input, _init) {
    const url = String(input);
    if (url.includes('/manga/i-became-the-villainesss-favorite/')) {
      detailCalls++;
      return new Response(DETAIL_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    // Any search/cover-fallback fetch should NOT happen when cover is already in og:image.
    return new Response('', { status: 404 });
  };
  try {
    const adapter = komikuAdapter();
    const result = await adapter.getSeriesDetail('i-became-the-villainesss-favorite');
    assert.ok(result.series, 'series returned');
    assert.ok(result.chapters, 'chapters returned');
    assert.ok(result.chapters.length >= 2, `expected 2+ chapters, got ${result.chapters.length}`);
    assert.equal(detailCalls, 1, `expected 1 detail-page fetch, got ${detailCalls}`);
  } finally {
    global.fetch = origFetch;
  }
});
