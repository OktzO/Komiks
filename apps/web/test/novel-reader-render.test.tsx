// Renders the reader island to static markup: the chapter body arrives as
// third-party HTML, so the assertion that matters is what reaches the DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
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
