// gooddreamer + noveltoon metadata adapters. No live network: `fetch` is stubbed
// and the noveltoon assertions run against inline markup from the live page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getNovelAdapter, NOVEL_SOURCES } from '../novel.ts';
import { gooddreamerAdapter } from '../gooddreamer/index.ts';
import { noveltoonAdapter, parseNoveltoonSeriesHtml } from '../noveltoon/index.ts';

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
  const parsed = parseNoveltoonSeriesHtml(NOVELTOON_DETAIL, 'judulnya-cinta-sejati');
  assert.equal(parsed.title, 'Judulnya Cinta Sejati');
  assert.equal(parsed.author, 'Ai Lina Herlina');
  assert.equal(parsed.coverUrl, 'https://cn-e-pic-aliyun.mangatoon.mobi/fictions-posters/2206e1a6.webp');
  assert.equal(parsed.synopsis, 'Menceritakan seorang gadis yang sangat cantik dan kaya raya.');
});
