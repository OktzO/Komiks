// The chapter page's own data path, driven end to end.
//
// Reverting 7e4bfb8 (decode the composite chapter id once, not twice) left this
// suite green. The guard that was supposed to catch it exercised
// `resolveNovelRoute` — correct in isolation, and never touched by the page,
// which read `Astro.params` directly. Astro hands `params` the *raw* path
// segment, so a chapter id still encoded at that point reaches `getNovelChapter`
// as "tekaburu%2F1" and is encoded a second time for the API path:
// "tekaburu%252F1", which 404s every chapter. Nothing above `resolveNovelRoute`
// could see that, because the page was the thing under test.
//
// So this runs the page's frontmatter — the real file, transpiled, with a stub
// `Astro` and a recording `fetch` — and asserts on the URL that leaves it. The
// assertions are about the id, not the markup: `getNovelChapter` is imported
// from the real `@/lib/api`, so the encoding the API sees is the encoding the
// production page produces.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getNovelChapter, getNovelSeries, isNotFound } from '../src/lib/api';
import { chapterNumberOf, resolveNovelRoute } from '../src/lib/novelRoutes';

const PAGE = '../src/pages/novel/[slug]/[chapter].astro';

const frontmatter = (): string => {
  const src = readFileSync(fileURLToPath(new URL(PAGE, import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('---') + 4, src.indexOf('\n---', 3));
  // The components and helpers arrive as parameters; `export const prerender`
  // is not a statement this harness can host.
  return body.replace(/^import .*$/gm, '').replace(/^export /gm, '');
};

const page = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `return (async () => {\n${frontmatter()}\n})()`,
) as unknown as (
  astro: unknown,
  getNovelChapter: unknown,
  getNovelSeries: unknown,
  isNotFound: unknown,
  chapterNumberOf: unknown,
  resolveNovelRoute: unknown,
) => Promise<unknown>;

/** Astro's stub, faithful on the one point that matters: `params` carries the
 *  raw segment while `url.pathname` carries the same string still encoded. A
 *  harness that pre-decoded `params` would pass a page reading `params`, which
 *  is why the URL is derived from the pathname rather than typed in twice. */
const astroFor = (pathname: string, params: Record<string, string>) => ({
  url: new URL(`https://oktzz.xyz${pathname}`),
  params,
  response: { status: 200 },
});

/** Runs the page and reports every URL it asked the API for. */
const runPage = async (pathname: string, params: Record<string, string>) => {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: unknown) => {
    const url = String((input as { url?: URL })?.url ?? input);
    asked.push(url);
    if (url.endsWith('/api/origins')) {
      return new Response(JSON.stringify({ data: [{ url: 'https://novel.test' }] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ data: { id: 'tekaburu/1', number: 1, title: 'Bab Satu', content: '<p>isi</p>' } }),
      { status: 200 },
    );
  };
  try {
    const page_ = new Function(
      'Astro', 'getNovelChapter', 'getNovelSeries', 'isNotFound', 'chapterNumberOf', 'resolveNovelRoute',
      page,
    );
    await page_(
      astroFor(pathname, params),
      getNovelChapter,
      getNovelSeries,
      isNotFound,
      chapterNumberOf,
      resolveNovelRoute,
    );
  } finally {
    globalThis.fetch = original;
  }
  return asked;
};

const chapterAsk = (asked: string[]): string | undefined =>
  asked.find((u) => u.includes('/chapter/'));

test('the page asks the API for the stored chapter id, unchanged', async () => {
  const asked = await runPage('/novel/abc/tekaburu%2F1', { slug: 'abc', chapter: 'tekaburu%2F1' });

  assert.equal(
    chapterAsk(asked),
    'https://novel.test/api/novel/series/abc/chapter/tekaburu%2F1',
    'the id is encoded exactly once for the API path, so the API receives "tekaburu/1"',
  );
  // The failure this pins is silent and total: a second level of encoding asks
  // for a chapter that does not exist, and every chapter 404s.
  assert.ok(
    !asked.some((u) => u.includes('%252F')),
    `no URL may be double-encoded — got ${JSON.stringify(asked)}`,
  );
});

test('the page passes the decoded slug through too', async () => {
  // A slug with an escape in it decodes once as well, and an over-encoded slug
  // reaches the series read rather than the chapter read.
  const asked = await runPage('/novel/halal%20tapi/tekaburu%2F1', { slug: 'halal%20tapi', chapter: 'tekaburu%2F1' });
  assert.equal(
    chapterAsk(asked),
    'https://novel.test/api/novel/series/halal%20tapi/chapter/tekaburu%2F1',
  );
  assert.ok(asked.some((u) => u.endsWith('/api/novel/series/halal%20tapi')), `and it read the series: ${JSON.stringify(asked)}`);
});

test('a page that read Astro.params would fail this, which is the point', async () => {
  // The stub's `params` are the raw segments. Anything the page derives from
  // them therefore re-encodes on the way into getNovelChapter, and the URL the
  // API sees comes out with %252F in it. Asserting that here means the harness
  // cannot quietly become a rubber stamp for the page: if a future Astro decoded
  // params before handing them over, this expectation is what says so.
  const asked = await runPage('/novel/abc/tekaburu%2F1', { slug: 'abc', chapter: 'tekaburu%2F1' });
  const fromParams = `/api/novel/series/abc/chapter/${encodeURIComponent('tekaburu%2F1')}`;
  assert.equal(
    asked.some((u) => u.includes(fromParams)),
    false,
    'the raw param must not be what the page sends',
  );
  assert.ok(chapterAsk(asked) !== undefined, 'and the page did make the read, so the line above is not vacuous');
});
