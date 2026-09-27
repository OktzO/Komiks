// SSR output of the novel islands. Two things are asserted here: what the
// chapter body puts into the DOM (it arrives as third-party HTML), and what the
// catalog does with a page number that is outside the merge ceiling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NovelCatalog, CATALOG_PAGE_SIZE } from '../src/components/NovelCatalog';
import { NovelReader } from '../src/components/NovelReader';

const HOSTILE = '<p onclick="x()">Satu <b>kasar</b> <a href="javascript:alert(1)">jahat</a></p>'
  + '<img src=x onerror=alert(1)><script>alert(2)</script><iframe src="//evil"></iframe>'
  + '<p>Penutup &#8212; &amp; selesai.</p>';

const render = (content: string) => renderToStaticMarkup(
  <NovelReader
    slug="novelid-halal-tapi-asing"
    chapterId="novelid-halal-tapi-asing/3"
    chapterNumber={3}
    chapterTitle="Bab Tiga"
    seriesTitle="Halal Tapi Asing"
    initial={{ number: 3, title: 'Bab Tiga', content }}
  />,
);

test('the chapter body is rendered without any executable markup', () => {
  const html = render(HOSTILE);
  for (const bad of ['onclick', 'onerror', '<script', '<iframe', 'javascript:', '<img']) {
    assert.ok(!html.includes(bad), `leaked ${bad}`);
  }
  // <a> is not in the allowlist, so it is unwrapped and only its text survives.
  assert.match(html, /<p>Satu <b>kasar<\/b> jahat<\/p>/);
  assert.match(html, /Penutup — &amp; selesai\./);
});

test('the reader chrome links the encoded composite chapter ids', () => {
  // No siblings yet, so the neighbours are disabled; the way back is not.
  const html = render('<p>isi</p>');
  assert.match(html, /href="\/novel\/novelid-halal-tapi-asing"/);
  assert.match(html, /Bab 3: Bab Tiga/);
});

test('a chapter with no body renders the skeleton, not an empty page', () => {
  const html = renderToStaticMarkup(
    <NovelReader
      slug="s"
      chapterId="s/1"
      chapterNumber={1}
      chapterTitle={null}
      seriesTitle="S"
      initial={null}
    />,
  );
  assert.match(html, /aria-busy="true"/);
  assert.ok(!html.includes('dangerouslySetInnerHTML'));
});

// ---- Catalog: a page outside the merge ceiling -------------------------------
// Re-reviewer round 2: `{ data: [], total: 300, page: 99 }` rendered the empty
// state beside a "Halaman 13 / 13" counter — a false claim of emptiness next to
// a valid-looking pager. The payload in hand belongs to no real page, so it must
// not be rendered at all until the clamped page arrives.
const catalog = (page: number, data: unknown[], total: number) =>
  renderToStaticMarkup(
    <NovelCatalog
      page={page}
      genre=""
      initial={{ data, page, limit: CATALOG_PAGE_SIZE, total } as never}
    />,
  );

test('a page beyond the last one never claims the catalog is empty', () => {
  const html = catalog(99, [], 300);
  assert.ok(!html.includes('Belum ada novel'), 'a page outside the range must not show the empty state');
  assert.ok(!html.includes('Halaman 99'), 'and must not claim to be page 99');
  assert.ok(html.includes('aria-busy="true"'), 'it shows the skeleton while the clamped page loads');
  // No "Hal. n / m" at all, so there is no counter to contradict the skeleton.
  assert.ok(!/Halaman \d+ \/ \d+/.test(html), 'no pager until the clamped page is in hand');
});

test('the empty state is reserved for a page genuinely inside the range', () => {
  // total 0 → one page, no series. That is a real empty catalog.
  assert.ok(catalog(1, [], 0).includes('Belum ada novel'));
  // A genre with no matches, on page 1 of a populated catalog.
  assert.ok(catalog(1, [], 300).includes('Belum ada novel'));
});

test('an in-range page renders its rows and a real pager', () => {
  const rows = Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => ({
    id: `novelid-titel-${i}`, source: 'novelid', title: `Titel ${i}`,
    author: null, genre: null, status: null,
    cover_ref: null, cover_fallback: null, synopsis: null, updated_at: 0,
  }));
  const html = catalog(2, rows, 300);
  assert.ok(html.includes('Titel 0'), 'the grid renders the payload it was given');
  assert.ok(html.includes('Halaman 2 / 13'), '300 rows at 24 per page is 13 pages');
  assert.ok(html.includes('href="/novel"'), 'page 1 is the canonical /novel, not /novel?page=1');
  assert.ok(html.includes('href="/novel?page=3"'), 'next page is a link');
  assert.ok(!html.includes('Belum ada novel'));
});
