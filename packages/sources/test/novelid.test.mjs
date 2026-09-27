// novelid.org adapter self-check. No network — pure parser unit tests against
// the three real fixtures in ./fixtures plus a few adversarial snippets.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBabNumber,
  buildChapterSourceId,
  buildChapterUrl,
  buildSeriesUrl,
  extractContainer,
  parseChapterHtml,
  parseChapterListHtml,
  parseSearchHtml,
  parseSeriesHtml,
  stripCoverQuery,
} from '../novelid/rules.ts';
import { novelidAdapter } from '../novelid/index.ts';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = read('novelid-chapter.html');
const seriesFixture = read('novelid-series.html');
const searchFixture = read('novelid-search.html');

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

test('extractContainer measures the closing tag, not a hardcoded 6 chars', () => {
  // `</div >` is legal HTML. A slice(start, pos - 6) leaves a literal `<`.
  for (const closer of ['</div>', '</div >', '</div\n>']) {
    const html = `<div class="watch-chapter-detail"><p>isi bab</p>${closer}<div>sesudah</div>`;
    const inner = extractContainer(html, 'watch-chapter-detail');
    assert.equal(inner, '<p>isi bab</p>', `closer=${JSON.stringify(closer)}`);
  }
});

test('extractContainer handles a nested div instead of truncating at the first close', () => {
  const html = '<div class="watch-chapter-detail"><div class="ad"><p>iklan</p></div><p>prose</p></div>';
  assert.equal(extractContainer(html, 'watch-chapter-detail'), '<div class="ad"><p>iklan</p></div><p>prose</p>');
});

test('URL builders', () => {
  assert.equal(buildSeriesUrl('halal-tapi-asing'), 'https://novelid.org/novel/halal-tapi-asing/');
  assert.equal(buildChapterUrl('halal-tapi-asing', 1), 'https://novelid.org/novel/halal-tapi-asing/bab/1/');
});

test('buildChapterSourceId returns the id getChapterContent accepts', () => {
  // Must be `{slug}/{bab}`: `/novel/{slug}/bab/{n}/` has no slug-less form, so a
  // bare number is unusable as an id.
  assert.equal(buildChapterSourceId('https://novelid.org/novel/x/bab/12/'), 'x/12');
  assert.equal(buildChapterSourceId('https://novelid.org/novel/x/bab/12'), 'x/12');
  assert.equal(buildChapterSourceId('/novel/x//bab/7/'), 'x/7');
  assert.equal(buildChapterSourceId('https://novelid.org/novel/x/'), null);
  assert.equal(buildChapterSourceId('https://novelid.org/bab/12/'), null);
  // The raw upstream key stays available under its own name.
  assert.equal(buildBabNumber('https://novelid.org/novel/x/bab/12/'), '12');
  assert.equal(buildBabNumber('https://novelid.org/novel/x/'), null);
});

test('parseSeriesHtml against the real series page fixture', () => {
  const parsed = parseSeriesHtml(seriesFixture, 'halal-tapi-asing');
  assert.equal(parsed.slug, 'halal-tapi-asing');
  assert.equal(parsed.title, 'Halal tapi Asing');
  assert.equal(parsed.author, 'Qiev');
  assert.deepEqual(parsed.genres, ['Romantis', 'Tamat']);
  assert.equal(parsed.status, 'completed');
  assert.equal(
    parsed.coverUrl,
    'https://novelid.org/uploads/author/125/2026/05/69fde8cacc651_Halal tapi Asing cov.webp'
  );
  assert.ok(parsed.synopsis.startsWith('\u201cKenapa masih bertahan'), 'synopsis kept');
  assert.ok(!parsed.synopsis.includes('Karya ini diterbitkan'), 'site disclaimer trimmed');
  assert.equal(parsed.chapterCount, 30);
});

test('parseChapterListHtml against the real series page fixture', () => {
  const episodes = parseChapterListHtml(seriesFixture);
  assert.equal(episodes.length, 30);
  assert.deepEqual(episodes[0], {
    number: 1,
    title: 'Terasa Asing',
    href: 'https://novelid.org/novel/halal-tapi-asing/bab/1/',
  });
  assert.equal(episodes[29].number, 30);
  // Upstream emits a doubled slash; the stored href must be usable as-is.
  assert.equal(episodes[1].href, 'https://novelid.org/novel/halal-tapi-asing/bab/2/');
});

test('parseSearchHtml against the real search page fixture', () => {
  const items = parseSearchHtml(searchFixture);
  assert.equal(items.length, 18);
  assert.equal(items[0].slug, 'jejak-di-koridor-sekolah');
  assert.ok(items[0].title.length > 0);
  // Search cards carry `href` before `class`; a split on the class name drops it.
  assert.ok(items.every((i) => i.slug && i.title));
  assert.ok(items.every((i) => !i.coverUrl || !i.coverUrl.includes('?')), 'cover query stripped');
});

test('parseSearchHtml skips the commented-out label the live cards ship', () => {
  const html = `<a href='/novel/x' class='genre-item-box'><div class='genre-content-item'>
    <div class='genre-item-image'><img src='https://novelid.org/uploads/a.jpg?resize=120,160'></div>
    <div class='genre-item-info'><p class='genre-item-title'>Judul Asli</p>
    <!--          <p class='genre-item-label'>Fantasy</p>-->
    <div class='genre-label'> <span class='genre-item-label'> Religi </span> </div></div></div></a>`;
  const items = parseSearchHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Judul Asli');
  assert.equal(items[0].coverUrl, 'https://novelid.org/uploads/a.jpg');
  assert.equal(items[0].genre, 'Religi');
});

test('parseChapterListHtml rejects anchors that are not /bab/N', () => {
  // `Number(null)` is 0, so a missing bab number used to survive the guard and
  // emit a phantom chapter 0 indistinguishable from a real `/bab/0/`.
  const html = `<div class="episodes-info clear">
   <a class="episodes-info-a-item" href="/novel/x/2024/"> <div class="episodes-item">
   <span class="episode-item-num">?</span><span class="episode-item-title">Arsip</span></div></a>
   <a class="episodes-info-a-item" href="/novel/x//bab/0/"> <div class="episodes-item">
   <span class="episode-item-num">0</span><span class="episode-item-title">Nol</span></div></a>
   <a class="episodes-info-a-item" href="/novel/x//bab/3/"> <div class="episodes-item">
   <span class="episode-item-num">3</span><span class="episode-item-title">Tiga</span></div></a></div>`;
  const episodes = parseChapterListHtml(html);
  assert.deepEqual(episodes.map((e) => e.number), [3]);
});

test('status is null when the tag block is missing, not a fabricated ongoing', () => {
  const noTags = '<div class="detail-title">Judul</div>';
  const parsed = parseSeriesHtml(noTags, 'x');
  assert.equal(parsed.title, 'Judul');
  assert.deepEqual(parsed.genres, []);
  assert.equal(parsed.status, null, 'selector drift must not be stored as ongoing');
  assert.equal(parseSeriesHtml(SERIES_WITH_TAGS_OPEN, 'x').status, 'ongoing');
  assert.equal(parseSeriesHtml(SERIES_WITH_TAGS_TAMAT, 'x').status, 'completed');
});

const SERIES_WITH_TAGS_OPEN =
  '<div class="detail-tag-content"><div class="detail-tag-item"><span>Romantis</span></div></div>';
const SERIES_WITH_TAGS_TAMAT =
  '<div class="detail-tag-content"><div class="detail-tag-item"><span>Romantis</span></div>' +
  '<div class="detail-tag-item"><span>Tamat</span></div></div>';

test('listChapters → getChapterContent round-trips a real fixture chapter id', async () => {
  const adapter = novelidAdapter();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(url.includes('/bab/') ? fixture : seriesFixture, { status: 200 });
  };
  try {
    const chapters = await adapter.listChapters('halal-tapi-asing', { limit: 3 });
    assert.equal(chapters.length, 3);
    // Every emitted id must be accepted by getChapterContent — the two
    // exported surfaces have to agree.
    for (const chapter of chapters) {
      assert.equal(chapter.sourceChapterId.split('/').length, 2, 'id is `{slug}/{bab}`');
      assert.equal(chapter.sourceChapterId, `halal-tapi-asing/${chapter.number}`);
      const content = await adapter.getChapterContent(chapter.sourceChapterId);
      assert.ok(content.html.includes('Jam dinding di ruang makan'));
      assert.ok(requested.includes(chapter.sourceUrl), 'chapter URL was fetched');
    }
    assert.deepEqual(
      chapters.map((c) => c.sourceChapterId),
      ['halal-tapi-asing/1', 'halal-tapi-asing/2', 'halal-tapi-asing/3']
    );
    // Offset window is applied after parse, not before.
    const windowed = await adapter.listChapters('halal-tapi-asing', { limit: 2, offset: 1 });
    assert.deepEqual(windowed.map((c) => c.number), [2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getChapterContent logs the four-key record when a 200 carries no prose', async () => {
  const adapter = novelidAdapter();
  const originalFetch = globalThis.fetch;
  const logs = [];
  const originalError = console.error;
  console.error = (line) => logs.push(line);
  globalThis.fetch = async () => new Response('<html><body>login wall</body></html>', { status: 200 });
  try {
    await assert.rejects(() => adapter.getChapterContent('halal-tapi-asing/1'), /no prose/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  const record = logs.map((l) => JSON.parse(l)).find((r) => r.stage === 'getChapterContent');
  assert.ok(record, `expected a log record, got ${JSON.stringify(logs)}`);
  assert.deepEqual(Object.keys(record).sort(), ['entityId', 'error', 'source', 'stage']);
  assert.equal(record.source, 'novelid');
  assert.equal(record.entityId, 'halal-tapi-asing/1');
});

test('getChapterContent rejects a bare bab number with a usable message', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => novelidAdapter().getChapterContent('12'), /expected "\{slug\}\/\{bab\}"/);
  } finally {
    console.error = originalError;
  }
});

test('search honours offset via the upstream /page/N/ path', async () => {
  const adapter = novelidAdapter();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(searchFixture, { status: 200 });
  };
  // The robots gate fetches robots.txt before the page; only page URLs matter.
  const pages = () => requested.filter((u) => !u.endsWith('/robots.txt'));
  try {
    const first = await adapter.search({ q: 'a', limit: 3 });
    assert.equal(first.length, 3);
    assert.match(pages()[0], /novelid\.org\/\?s=a$/);
    // offset 2 within page 1 → in-page window, not a repeat of slice(0, limit).
    const five = await adapter.search({ q: 'a', limit: 5 });
    const windowed = await adapter.search({ q: 'a', limit: 3, offset: 2 });
    assert.deepEqual(
      windowed.map((s) => s.sourceSeriesId),
      five.slice(2, 5).map((s) => s.sourceSeriesId)
    );
    assert.notDeepEqual(windowed.map((s) => s.sourceSeriesId), first.map((s) => s.sourceSeriesId));
    // offset 20 crosses into page 2 (18 per page).
    await adapter.search({ q: 'a', limit: 3, offset: 20 });
    assert.match(pages().at(-1), /novelid\.org\/page\/2\/\?s=a$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stripCoverQuery drops the resize thumbnail params', () => {
  assert.equal(
    stripCoverQuery('https://novelid.org/uploads/a.jpg?resize=139,184'),
    'https://novelid.org/uploads/a.jpg'
  );
  assert.equal(stripCoverQuery('https://novelid.org/uploads/a.jpg'), 'https://novelid.org/uploads/a.jpg');
  assert.equal(stripCoverQuery(null), null);
});
