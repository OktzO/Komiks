// gooddreamer + noveltoon metadata adapters. No live network: `fetch` is stubbed
// and the noveltoon assertions run against inline markup from the live page.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNovelAdapter, NOVEL_SOURCES } from '../novel.ts';
import { gooddreamerAdapter } from '../gooddreamer/index.ts';
import { noveltoonAdapter } from '../noveltoon/index.ts';
import { NOVELTOON_PATTERNS, parseNoveltoonListHtml, parseNoveltoonSeriesHtml } from '../noveltoon/rules.ts';

const NOVEL_PAYLOAD = {
  data: [
    {
      id: 14,
      novel_uri: 'bukan-salah-ibu-mengandung-pmh',
      novel_title: 'Bukan Salah Ibu Mengandung',
      novel_sinopsis: 'Cerita ini terinspirasi dari kisah nyata.',
      // Upstream ships a doubled slash on this host.
      novel_cover: 'https://api.gooddreamer.id//storage/novels/x.jpg',
      novel_rating: 5,
      chapters_count: 147,
      readers_count: 615,
      author: {
        id: 104,
        fullname: 'Meiry Priani Dwianingrum',
        // Must never reach the domain object.
        email: 'meirypriani19@gmail.com',
        phone: '0812',
      },
      main_category: { id: 18, category_name: 'Drama' },
      categories: [{ id: 18, category_name: 'Drama' }],
      tags: [{ id: 41, name: 'Cinta Beda Agama' }],
    },
  ],
};

const withStubbedFetch = async (payload, fn) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
};

test('gooddreamer search maps the verified payload onto NovelSeries', async () => {
  const { result, calls } = await withStubbedFetch(NOVEL_PAYLOAD, () =>
    gooddreamerAdapter().search({ q: 'ibuk', limit: 5 })
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.gooddreamer\.id\/api\/web\/novels\?/);
  assert.match(calls[0], /q=ibuk/);

  assert.equal(result.length, 1);
  const series = result[0];
  assert.equal(series.sourceSeriesId, '14');
  assert.equal(series.source, 'gooddreamer');
  assert.equal(series.title, 'Bukan Salah Ibu Mengandung');
  assert.equal(series.slug, 'bukan-salah-ibu-mengandung-pmh');
  assert.ok(series.genres.includes('Drama'), `genres=${JSON.stringify(series.genres)}`);
  assert.equal(series.chapterCount, 147);
  assert.equal(series.author, 'Meiry Priani Dwianingrum');
  // Doubled slash from upstream collapsed to a single one.
  assert.equal(series.coverUrl, 'https://api.gooddreamer.id/storage/novels/x.jpg');
  assert.ok(!JSON.stringify(series).includes('@gmail.com'), 'author email must not leak');
});

test('gooddreamer getSeries accepts either the numeric id or the uri', async () => {
  const { result, calls } = await withStubbedFetch({ data: NOVEL_PAYLOAD.data[0] }, () =>
    gooddreamerAdapter().getSeries('14')
  );
  assert.match(calls[0], /\/api\/web\/novels\/14$/);
  assert.equal(result.title, 'Bukan Salah Ibu Mengandung');
  assert.equal(result.sourceSeriesId, '14');
});

test('gooddreamer listChapters is empty — chapter bodies are coin-gated', async () => {
  const { calls } = await withStubbedFetch(NOVEL_PAYLOAD, () => gooddreamerAdapter().listChapters('14'));
  assert.deepEqual(calls, [], 'a metadata source must not hit an endpoint for chapters');
});

test('both fallback adapters are metadata-only', () => {
  for (const adapter of [gooddreamerAdapter(), noveltoonAdapter()]) {
    assert.equal(adapter.capability, 'metadata', `${adapter.sourceKey} capability`);
    assert.equal(adapter.getChapterContent, undefined, `${adapter.sourceKey} must not expose chapters`);
  }
});

test('registry exposes all three novel sources', () => {
  assert.deepEqual(NOVEL_SOURCES, ['novelid', 'gooddreamer', 'noveltoon']);
  for (const key of NOVEL_SOURCES) {
    const adapter = getNovelAdapter(key);
    assert.ok(adapter, `${key} resolves`);
    assert.equal(adapter.sourceKey, key);
  }
  assert.equal(getNovelAdapter('nope'), null);
});

// Mirrors the live /id/{slug}?content_id={id} template (same mangatoon family as
// novelid, but the title is an <h1> and there is no genre-tag block).
const NOVELTOON_DETAIL = `<div class="detail-top" style="background-image: url(https://cn-e-pic-aliyun.mangatoon.mobi/fictions-posters/2206e1a6.webp);">
  <div class="detail-top-left select-text">
    <p class="detail-author web-author">Nama Author: Ai Lina Herlina</p>
    <div class="detail-top-title"><h1 class="detail-title">Judulnya Cinta Sejati</h1></div>
    <p class="detail-author app-author select-text">Nama Author: Ai Lina Herlina</p>
    <div class="detail-desc detail-desc-hide select-text">
      <p class="detail-desc-info"> Menceritakan seorang gadis yang sangat cantik dan kaya raya.
      Karya ini diterbitkan atas izin NovelToon</p>
    </div>
  </div>
  <div class="detail-top-right">
    <img src="https://cn-e-pic-aliyun.mangatoon.mobi/fictions-posters/2206e1a6.webp" alt="Judulnya Cinta Sejati"/>
  </div>
</div>`;

test('noveltoon series parse maps title, author, synopsis and cover', () => {
  const parsed = parseNoveltoonSeriesHtml(NOVELTOON_DETAIL);
  assert.equal(parsed.title, 'Judulnya Cinta Sejati');
  assert.equal(parsed.author, 'Ai Lina Herlina');
  assert.equal(parsed.coverUrl, 'https://cn-e-pic-aliyun.mangatoon.mobi/fictions-posters/2206e1a6.webp');
  assert.equal(parsed.synopsis, 'Menceritakan seorang gadis yang sangat cantik dan kaya raya.');
});

test('noveltoon listing cards map contentId, slug, tags and cover', () => {
  const cards = parseNoveltoonListHtml(NOVELTOON_LISTING);
  assert.ok(cards.length >= 3, `expected 3+ cards, got ${cards.length}`);
  assert.equal(cards[0].contentId, '6067943');
  assert.equal(cards[0].slug, 'langit-tak-selamanya-mendung-seraphina');
  assert.equal(cards[0].title, 'Langit Tak Selamanya Mendung, Seraphina');
  // The label cell is one pipe-separated string.
  assert.ok(cards[0].genres.includes('Tamat'), JSON.stringify(cards[0].genres));
  assert.ok(cards.every((c) => c.coverUrl && !c.coverUrl.includes('?')));
  assert.ok(NOVELTOON_PATTERNS.contentId.test('?content_id=6067943'));
});

test('noveltoon getSeries logs the four-key record when a page has no title', async () => {
  const adapter = noveltoonAdapter();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logs = [];
  console.error = (line) => logs.push(line);
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /api\n', { status: 200 });
    return new Response('<html><body>redesign</body></html>', {
      status: 200,
      // fetchHtmlWithUrl reads res.url for the canonical slug.
      ...{},
    });
  };
  try {
    await assert.rejects(() => adapter.getSeries('2206'), /no title/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  const record = logs.map((l) => JSON.parse(l)).find((r) => r.stage === 'getSeries');
  assert.ok(record, `expected a log record, got ${JSON.stringify(logs)}`);
  assert.deepEqual(Object.keys(record).sort(), ['entityId', 'error', 'source', 'stage']);
  assert.equal(record.source, 'noveltoon');
  assert.equal(record.entityId, '2206');
});

test('noveltoon never requests a robots-disallowed /api path', async () => {
  const adapter = noveltoonAdapter();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const href = String(url);
    if (href.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /api\n', { status: 200 });
    return new Response(NOVELTOON_LISTING, { status: 200 });
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await adapter.search({ q: 'Langit', limit: 5 });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.ok(requested.length > 0, 'listing was fetched');
  for (const url of requested) {
    assert.ok(!new URL(url).pathname.startsWith('/api'), `disallowed path requested: ${url}`);
  }
});

// Live /id/genre/2/0/{page} card markup, trimmed to three cards.
const NOVELTOON_LISTING = `<div class="genre-content">
  <a href="https://noveltoon.mobi/id/langit-tak-selamanya-mendung-seraphina?content_id=6067943" class="genre-item-box">
    <div class="genre-content-item"><div class="genre-item-image">
      <img src="https://cn-e-pic-aliyun.mangatoon.mobi/cartoon-posters/6067943acbd.webp-posterend6" alt="Langit Tak Selamanya Mendung, Seraphina"/>
    </div><div class="genre-item-info"><p class="genre-item-title">Langit Tak Selamanya Mendung, Seraphina</p>
      <div class="genre-label"><span class="genre-item-label">
        Balas Dendam | Cinta Seiring Waktu | Penyesalan Suami | Tamat</span></div>
    </div></div></a>
  <a href="https://noveltoon.mobi/id/kau-rebut-tunanganku-ku-rayu-gebetanmu?content_id=6265685" class="genre-item-box">
    <div class="genre-content-item"><div class="genre-item-image">
      <img src="https://cn-e-pic-aliyun.mangatoon.mobi/cartoon-posters/6265685d096.webp-posterend6" alt="Kau Rebut Tunanganku, Ku Rayu Gebetanmu"/>
    </div><div class="genre-item-info"><p class="genre-item-title">Kau Rebut Tunanganku, Ku Rayu Gebetanmu</p>
      <div class="genre-label"><span class="genre-item-label">Crazy Rich/Konglomerat | Identitas Tersembunyi | Tamat</span></div>
    </div></div></a>
  <a href="https://noveltoon.mobi/id/cintaku-pahlawanku?content_id=2257" class="genre-item-box">
    <div class="genre-content-item"><div class="genre-item-image">
      <img src="https://cn-e-pic-aliyun.mangatoon.mobi/cartoon-posters/2257aa11bc.webp-posterend6" alt="Cintaku Pahlawanku"/>
    </div><div class="genre-item-info"><p class="genre-item-title">Cintaku Pahlawanku</p>
      <div class="genre-label"><span class="genre-item-label">Roman | Tamat</span></div>
    </div></div></a>
</div>`;

test('gooddreamer search applies the offset remainder within a page', async () => {
  // `page` alone only lands on the right record at exact multiples of `limit`.
  const rows = [1, 2, 3, 4].map((id) => ({
    ...NOVEL_PAYLOAD.data[0],
    id,
    novel_title: `Novel ${id}`,
  }));
  const { result, calls } = await withStubbedFetch({ data: rows }, () =>
    gooddreamerAdapter().search({ q: 'ibuk', limit: 4, offset: 2 })
  );
  assert.match(calls[0], /page=1/);
  assert.deepEqual(result.map((s) => s.title), ['Novel 3', 'Novel 4']);
});

test('the novel module is importable by specifier', async () => {
  // A missing "./novel" export in package.json is a TS2307 for every Wave 2
  // consumer, so resolve it the way they would.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./novel'], './novel.ts');
  const specifier = '@manga-platform/sources/novel';
  const resolved = import.meta.resolve(specifier);
  assert.match(resolved, /packages\/sources\/novel\.ts$/, `resolved to ${resolved}`);
  const mod = await import(specifier);
  assert.deepEqual(Object.keys(mod).sort(), ['NOVEL_SOURCES', 'getNovelAdapter', 'novelFailure', 'withNovelRetry']);
});
