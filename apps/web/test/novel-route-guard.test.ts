// The novel module ships its own static routes under /novel, so the manga
// catch-all ([type]/[slug]) never sees them. These assertions pin the boundary
// that keeps it that way: the novel helper claims /novel only, and the manga
// VALID_TYPES guard still rejects everything it does not know.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, VALID_TYPES, isNotFound, isValidType, safeType } from '../src/lib/api';
import {
  NOVEL_SEGMENT,
  catalogLastPage,
  chapterNumberOf,
  isNovelPath,
  neighbourChapters,
  novelCatalogUrl,
  novelChapterUrl,
  novelSeriesUrl,
  parseNovelGenres,
  resolveNovelRoute,
  sanitizeNovelHtml,
} from '../src/lib/novelRoutes';

test('resolveNovelRoute maps the three novel routes', () => {
  assert.deepEqual(resolveNovelRoute('/novel'), { kind: 'catalog' });
  assert.deepEqual(resolveNovelRoute('/novel/'), { kind: 'catalog' });
  assert.deepEqual(resolveNovelRoute('/novel/abc'), { kind: 'series', slug: 'abc' });
  assert.deepEqual(resolveNovelRoute('/novel/abc/tekaburu%2F1'), {
    kind: 'chapter',
    slug: 'abc',
    chapterId: 'tekaburu/1',
  });
});

test('resolveNovelRoute declines anything outside /novel', () => {
  for (const p of ['/', '/manga/abc', '/manga/abc/chapter-1', '/novels/abc', '/bookmark']) {
    assert.equal(resolveNovelRoute(p).kind, 'not-novel', p);
  }
});

// The chapter page resolves its two segments through this helper and then hands
// the id to getNovelChapter, which encodes it into the API path. An id still
// encoded at that point becomes "tekaburu%252F1" and 404s every chapter, so the
// decoded id is the contract the reader depends on.
test('a chapter id from the resolver survives the API path encoding', () => {
  const route = resolveNovelRoute('/novel/abc/tekaburu%2F1');
  assert.equal(route.kind, 'chapter');
  const id = route.kind === 'chapter' ? route.chapterId : '';
  assert.equal(
    `/api/novel/series/${encodeURIComponent('abc')}/chapter/${encodeURIComponent(id)}`,
    '/api/novel/series/abc/chapter/tekaburu%2F1',
    'the API sees one level of encoding, the composite id whole',
  );
});

test('isNovelPath separates the novel module from the manga shell', () => {
  assert.equal(isNovelPath('/novel/abc'), true);
  assert.equal(isNovelPath('/novel'), true);
  assert.equal(isNovelPath('/manga/abc'), false);
  assert.equal(isNovelPath('/manga/abc/tekaburu%2F1'), false);
});

test('the manga type guard is untouched by the novel module', () => {
  assert.deepEqual([...VALID_TYPES], ['manga', 'manhwa', 'manhua']);
  assert.equal(isValidType(NOVEL_SEGMENT), false);
  assert.equal(isValidType('bogus'), false);
  // safeType would coerce both to 'manga'; the guard is what rejects them.
  assert.equal(isValidType(safeType(NOVEL_SEGMENT)), true);
  // resolveNovelRoute must never hand a manga type back to the manga shell.
  assert.equal('type' in resolveNovelRoute('/novel/abc'), false);
});

test('a malformed percent-escape does not throw while resolving', () => {
  assert.deepEqual(resolveNovelRoute('/novel/%zz'), { kind: 'series', slug: '%zz' });
});

test('chapterNumberOf reads the bab number off a composite id', () => {
  assert.equal(chapterNumberOf('novelid-halal-tapi-asing/12'), 12);
  assert.equal(chapterNumberOf('tekaburu/1.5'), 1.5);
  assert.equal(chapterNumberOf('no-slash'), null);
});

// Finding 1. novelIngest drops every chapter whose body fetch failed or came back
// blank, so numbering has guaranteed gaps and a list page is a row-offset window
// — never a number range. The walk that must cope with this, and the neighbours
// it feeds, are covered behaviourally in novel-neighbours.test.ts.
const gapped = (numbers: number[]) =>
  numbers.map((n) => ({ number: n, source_chapter_id: `s/${n}` }));

test('prev/next come from the stored rows, gaps and all', () => {
  // Ingest dropped 41-60; the neighbours of 61 are 40 and 62, not 60.
  const rows = gapped([...Array.from({ length: 40 }, (_, i) => i + 1), ...Array.from({ length: 40 }, (_, i) => i + 61)]);
  assert.deepEqual(neighbourChapters(rows, 61), { prev: { number: 40, source_chapter_id: 's/40' }, next: { number: 62, source_chapter_id: 's/62' } });
  // Ends of a gapped list have one neighbour, not a phantom ±1.
  assert.deepEqual(neighbourChapters(rows, 1), { prev: null, next: { number: 2, source_chapter_id: 's/2' } });
  assert.deepEqual(neighbourChapters(rows, 100), { prev: { number: 99, source_chapter_id: 's/99' }, next: null });
  // A chapter that is not among the rows: both links off. This assertion used
  // to expect 40/61 here, which is the round-2 residual — absence from the rows
  // in hand is not evidence about the list, so a "neighbour" is a guess.
  assert.deepEqual(neighbourChapters(rows, 55), { prev: null, next: null });
  assert.deepEqual(neighbourChapters(rows, null), { prev: null, next: null });
  assert.deepEqual(neighbourChapters([], 5), { prev: null, next: null });
});

// Finding 3. Only an upstream that answered 404 may become a 404. A Worker
// outage (5xx, all origins circuit-open, DNS failure) renders the shell and
// retries, exactly like the manga reader documents at
// [type]/[slug]/[chapterId].astro:59-60 — telling a crawler "not found" during
// an outage is worse than a slow page.
test('only an upstream 404 counts as not-found', () => {
  assert.equal(isNotFound(new ApiError('API /x → 404 {"error":"Chapter not found"}', 404)), true);
  assert.equal(isNotFound(new ApiError('API /x → 500 boom', 500)), false);
  assert.equal(isNotFound(new ApiError('API /x → 429', 429)), false);
  assert.equal(isNotFound(new ApiError('API /x → 503', 503)), false);
  assert.equal(isNotFound(new TypeError('fetch failed')), false, 'network failure is an outage, not a miss');
  assert.equal(isNotFound(new Error('API /x → 404 {}')), false, 'a bare Error is never trusted as a 404');
  assert.equal(isNotFound(undefined), false);
});

test('chapter urls encode the composite id whole', () => {
  assert.equal(novelSeriesUrl('novelid-halal-tapi-asing'), '/novel/novelid-halal-tapi-asing');
  assert.equal(
    novelChapterUrl('novelid-halal-tapi-asing', 'novelid-halal-tapi-asing/12'),
    '/novel/novelid-halal-tapi-asing/novelid-halal-tapi-asing%2F12',
  );
});

test('chapterNumberOf reads the bab number off a composite id', () => {
  assert.equal(chapterNumberOf('novelid-halal-tapi-asing/12'), 12);
  assert.equal(chapterNumberOf('tekaburu/1.5'), 1.5);
  assert.equal(chapterNumberOf('no-slash'), null);
});

test('catalog pagination stops at the shard merge ceiling', () => {
  // 4 shards x MERGE_WINDOW(100) = 400 rows are addressable; a higher page
  // returns [] even when total says otherwise.
  assert.equal(catalogLastPage(400, 50), 8);
  assert.equal(catalogLastPage(10_000, 50), 8);
  assert.equal(catalogLastPage(10_000, 100), 4);
  assert.equal(catalogLastPage(120, 50), 3);
  assert.equal(catalogLastPage(0, 50), 1);
});

test('catalog url keeps page and genre together', () => {
  assert.equal(novelCatalogUrl({ page: 1 }), '/novel');
  assert.equal(novelCatalogUrl({ page: 3 }), '/novel?page=3');
  assert.equal(novelCatalogUrl({ page: 2, genre: 'Fantasy' }), '/novel?page=2&genre=Fantasy');
});

test('genre arrives as a JSON array string and degrades safely', () => {
  assert.deepEqual(parseNovelGenres('["Fantasy","Isekai"]'), ['Fantasy', 'Isekai']);
  assert.deepEqual(parseNovelGenres('[]'), []);
  assert.deepEqual(parseNovelGenres(null), []);
  assert.deepEqual(parseNovelGenres('Fantasy, Isekai'), ['Fantasy', 'Isekai']);
  assert.deepEqual(parseNovelGenres('"Fantasy"'), []);
});

test('sanitiser keeps prose and drops everything executable', () => {
  const out = sanitizeNovelHtml(
    '<p onclick="steal()">Satu <em>dua</em><br>tiga</p><script>alert(1)</script><iframe src="//evil"></iframe>',
  );
  assert.equal(out, '<p>Satu <em>dua</em><br>tiga</p>');
  assert.ok(!out.includes('onclick'));
  assert.ok(!out.includes('script'));
  assert.ok(!out.includes('iframe'));
});

test('sanitiser never lets an attribute or a url scheme through', () => {
  for (const html of [
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">klik</a>',
    '<div style="background:url(javascript:alert(1))">teks</div>',
    '<svg/onload=alert(1)>',
    '<math><mtext></mtext></math>',
    '<form action="//evil"><input name="a"></form>',
    '<base href="//evil">',
  ]) {
    const out = sanitizeNovelHtml(html);
    assert.ok(!/on[a-z]+=/i.test(out), html);
    assert.ok(!/javascript:/i.test(out), html);
    assert.ok(!/\s(href|src|style|action)\s*=/i.test(out), html);
  }
});

test('sanitiser strips comments and unclosed script bodies', () => {
  assert.equal(sanitizeNovelHtml('<!-- <script>x</script> --><p>ok</p>'), '<p>ok</p>');
  // Unclosed <script> eats the rest rather than leaking it as prose.
  assert.equal(sanitizeNovelHtml('<p>a</p><script>alert(1)'), '<p>a</p>');
  // A void <img> must not swallow the document that follows it.
  assert.equal(sanitizeNovelHtml('<p>a</p><img src=x><p>b</p>'), '<p>a</p><p>b</p>');
});

// The discard boundary is indexed in `src.toLowerCase()` coordinates while the
// walk advances through `src`, and toLowerCase is not length-preserving. That
// makes the boundary inexact on a page containing a character like İ, so this
// pins the direction the inexactness is allowed to err in: over-swallow, never
// under-swallow. If someone "fixes" the coordinate mismatch, this must still
// hold — an escaped </script> surviving as live markup is the failure it exists
// to prevent.
test('a case-folding character near a discard tag still swallows, never leaks', () => {
  for (const html of [
    '<p>a</p><script>x</script>İ<p>b</p>',
    'İ<script>x</script><p>b</p>',
    '<p>İİİ</p><script>x</script>İ<p>b</p>',
    '<style>.x{}</style>İİ<p>b</p>',
  ]) {
    const out = sanitizeNovelHtml(html);
    assert.ok(!/<script|<style/i.test(out), `leaked a discarded tag: ${html}`);
    assert.ok(!/x</.test(out), `leaked the discarded body: ${html}`);
  }
});

test('sanitiser decodes entities once and re-escapes exactly once', () => {
  assert.equal(sanitizeNovelHtml('<p>a &amp; b &nbsp;c &mdash; d</p>'), '<p>a &amp; b  c — d</p>');
  // Pre-encoded markup stays literal text, it is never re-interpreted.
  assert.equal(sanitizeNovelHtml('&lt;script&gt;alert(1)&lt;/script&gt;'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('sanitiser unwraps unknown tags but keeps their text', () => {
  assert.equal(sanitizeNovelHtml('<div class="x"><font size="3">teks</font></div>'), '<div>teks</div>');
  assert.equal(sanitizeNovelHtml(''), '');
  assert.equal(sanitizeNovelHtml(null), '');
});
