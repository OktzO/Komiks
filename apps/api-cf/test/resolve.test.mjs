// apps/api-cf/test/resolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolveResponse } from '../src/routes/resolve.ts';

test('resolves canonical type+source, recommended = most chapters', () => {
  const out = buildResolveResponse(
    { slug: 'solo-leveling', type: 'manhwa', source: 'komiku' },
    [
      { source: 'komiku', source_slug: 'solo-leveling', has_chapter_list: 1, chapter_count: 100, last_scraped_at: 1 },
      { source: 'bacakomik', source_slug: 'solo-leveling', has_chapter_list: 1, chapter_count: 179, last_scraped_at: 2 },
    ]
  );
  assert.equal(out.type, 'manhwa');
  assert.equal(out.source, 'komiku');
  assert.equal(out.recommendedSource, 'bacakomik');
});

test('unknown slug → null', () => {
  assert.equal(buildResolveResponse(null, []), null);
});

test('wrong-type caller detected via type field', () => {
  const out = buildResolveResponse(
    { slug: 'one-piece', type: 'manga', source: 'komiku' },
    [{ source: 'komiku', source_slug: 'one-piece', has_chapter_list: 1, chapter_count: 10, last_scraped_at: 1 }]
  );
  assert.equal(out.type, 'manga');
});
