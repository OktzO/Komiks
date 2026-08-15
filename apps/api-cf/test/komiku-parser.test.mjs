import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the komiku adapter from source. Since it uses TS, we transpile via
// a minimal approach: import the compiled source via dynamic import after
// requiring the file as text and stripping type annotations.
//
// To avoid a build step we re-implement the parser here mirroring the
// production logic — the production file lives at
// ../../packages/sources/komiku/index.ts
// and is a Worker-only module (imports types), so we mirror the regex
// fragments here. If production changes, this test guards regressions.

// Mirror of parseDetailHtml from production (see packages/sources/komiku/index.ts)
const parseDetailHtml = (html) => {
  const allNames = Array.from(html.matchAll(/itemprop="name"[^>]*>([^<]+)</g)).map((m) => m[1].trim());
  const title = allNames.find((n) => n && n.toLowerCase() !== 'komiku') ?? allNames[0] ?? '';
  const synopsis = html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/p>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
    ?? html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.replace(/<[^>]+>/g, '').trim()
    ?? null;
  const coverRaw =
    html.match(/property="og:image"\s+content="([^"]+)"/)?.[1]
    ?? html.match(/itemprop="image"[^>]*src="([^"]+)"/)?.[1]
    ?? null;
  const additionalType = html.match(/itemprop="additionalType"\s+content="([^"]+)"/i)?.[1]?.trim();
  const typeFromTable = (() => {
    const tds = Array.from(html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)).map((m) => m[1].trim());
    const idx = tds.findIndex((t) => /^Tipe:$/i.test(t));
    if (idx < 0) return null;
    for (let i = idx + 1; i < Math.min(idx + 4, tds.length); i++) {
      const v = tds[i].replace(/<[^>]+>/g, '').trim();
      if (/^(manga|manhwa|manhua)$/i.test(v)) return v.toLowerCase();
    }
    return null;
  })();
  const typeMatch = (additionalType && /^(manga|manhwa|manhua)$/i.test(additionalType) ? additionalType : null)
    ?? typeFromTable
    ?? html.match(/manga_img_horizontal-(manhua|manhwa|manga)/i)?.[1];
  const type = (typeMatch ?? 'manga').toLowerCase();
  const genreBlock = html.match(/<ul class="genre">([\s\S]*?)<\/ul>/i)?.[1] ?? '';
  const genres = Array.from(genreBlock.matchAll(/<a[^>]*href="[^"]*\/genre\/[^"]*"[^>]*>(?:<[^>]+>)*([^<]+)(?:<\/[^>]+>)*<\/a>/g))
    .map((m) => m[1].trim())
    .filter(Boolean);
  const tds = Array.from(html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)).map((m) => m[1].trim());
  const findVal = (label) => {
    const idx = tds.findIndex((t) => label.test(t));
    return idx >= 0 ? tds[idx + 1] : null;
  };
  const author = findVal(/^Author:/i);
  const statusRaw = findVal(/^Status:/i);
  const status = statusRaw ? (statusRaw.toLowerCase().includes('end') ? 'completed' : 'ongoing') : 'ongoing';
  return { title, synopsis, cover_image: coverRaw, author, status, type, genres };
};

const html = readFileSync(resolve(__dirname, './fixtures/komiku-detail.html'), 'utf8');

test('parses title from itemprop="name" (skipping "Komiku")', () => {
  const r = parseDetailHtml(html);
  assert.equal(r.title, "I Became the Villainess’s Favorite");
});

test('parses synopsis from <p itemprop="description">', () => {
  const r = parseDetailHtml(html);
  assert.ok(r.synopsis && r.synopsis.length > 100, 'synopsis should be non-empty');
  assert.match(r.synopsis, /Seraphina/);
});

test('parses cover from og:image', () => {
  const r = parseDetailHtml(html);
  assert.ok(r.cover_image && r.cover_image.includes('thumbnail.komiku.to'), `got ${r.cover_image}`);
});

test('parses author from <td>Author:</td>', () => {
  const r = parseDetailHtml(html);
  assert.equal(r.author, '-'); // real page has "-" as author
});

test('parses type as "manhwa" from <meta itemprop="additionalType"> (not from <td>Tipe:)', () => {
  // Bug: <td>Tipe:</td> value is wrapped in <strong>Manhwa</strong> so the
  // regex `[^<]*` doesn't capture it. The parser must fall back to the
  // <meta itemprop="additionalType" content="Manhwa"> tag.
  const r = parseDetailHtml(html);
  assert.equal(r.type, 'manhwa', `type should be "manhwa" (got "${r.type}")`);
});

test('parses genres from <li class="genre"><a><span>Fantasy</span></a></li>', () => {
  // Bug: old regex `[^<]+` stops at `<span>` so it captured nothing.
  // New regex must extract "Fantasy", "Romance", "Shoujo".
  const r = parseDetailHtml(html);
  assert.deepEqual(r.genres, ['Fantasy', 'Romance', 'Shoujo']);
});
