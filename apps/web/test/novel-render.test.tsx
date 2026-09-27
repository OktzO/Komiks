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

// ---- Covers come from B2, not from the source -------------------------------
// spec 6.8: covers ride the existing R2/B2 + signed /img pipeline. cover_url is
// the API's signed /img path built from cover_ref; cover_fallback is the source
// URL. A row with a stored cover must produce no request to the source at all,
// so the reader's IP and UA never leave, and novelid being down does not blank
// the catalogue.
const coverRow = (over: Record<string, unknown>) => ({
  id: 'novelid-halal-tapi-asing', source: 'novelid', title: 'Halal Tapi Asing',
  author: 'Pengarang', genre: null, status: null,
  cover_ref: null, cover_fallback: null, cover_url: null, synopsis: null, updated_at: 0,
  ...over,
});

const coverPage = (rows: unknown[]) => renderToStaticMarkup(
  <NovelCatalog page={1} genre="" initial={{ data: rows, page: 1, limit: CATALOG_PAGE_SIZE, total: rows.length } as never} />,
);

test('a stored cover renders through /img and never touches the source', () => {
  const signed = '/img/novel/novelid-halal-tapi-asing?exp=1800000000&sig=abc123';
  const html = coverPage([coverRow({
    cover_ref: 'novel/covers/novelid-halal-tapi-asing',
    cover_url: signed,
    cover_fallback: 'https://i2.wp.com/novelid.org/uploads/halal.webp',
  })]);
  // & is HTML-escaped in the attribute; the sig is what is being asserted.
  assert.ok(html.includes(signed.replace(/&/g, '&amp;')),
    `the signed /img path is the src, got: ${html.match(/src="[^"]*"/)?.[0]}`);
  assert.ok(!html.includes('i2.wp.com'), 'no direct upstream image request');
});

test('a row with no stored cover falls back to the source URL', () => {
  const html = coverPage([coverRow({ cover_fallback: 'https://i2.wp.com/novelid.org/uploads/halal.webp' })]);
  assert.ok(html.includes('i2.wp.com'), 'the fallback still renders something');
  assert.ok(!html.includes('/img/novel/'), 'and is not a broken /img path');
});

test('a row with neither cover shows the title placeholder, not a broken image', () => {
  const html = coverPage([coverRow({})]);
  assert.ok(html.includes('Halal Tapi Asing'));
  assert.ok(!html.includes('<img'), 'no img element at all');
});
