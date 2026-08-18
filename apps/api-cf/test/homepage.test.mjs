import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePopularity, SOURCE_PRIORITY } from '../src/routes/homepage.ts';

const NOW = 1750000000000; // fixed epoch

test('source priority dominates: komiku > manhwaindo for equal data', () => {
  const base = { chapter_count: 10, updated_at: Math.floor(NOW / 1000) };
  const komiku = computePopularity({ ...base, source: 'komiku' }, NOW);
  const manhwa = computePopularity({ ...base, source: 'manhwaindo' }, NOW);
  assert.ok(komiku > manhwa, `komiku ${komiku} should beat manhwaindo ${manhwa}`);
});

test('recency: fresh update scores higher than 30-day-old', () => {
  const fresh = computePopularity({ source: 'komiku', chapter_count: 10, updated_at: Math.floor(NOW / 1000) }, NOW);
  const stale = computePopularity({ source: 'komiku', chapter_count: 10, updated_at: Math.floor(NOW / 1000) - 30 * 86400 }, NOW);
  assert.ok(fresh > stale, `fresh ${fresh} should beat stale ${stale}`);
});

test('chapter_count adds a small positive contribution', () => {
  const more = computePopularity({ source: 'komiku', chapter_count: 500, updated_at: Math.floor(NOW / 1000) }, NOW);
  const less = computePopularity({ source: 'komiku', chapter_count: 1, updated_at: Math.floor(NOW / 1000) }, NOW);
  assert.ok(more > less, `more ${more} should beat less ${less}`);
});

test('unknown source falls back to local priority', () => {
  const unknown = computePopularity({ source: 'weird', chapter_count: 0, updated_at: 0 }, NOW);
  assert.equal(unknown, SOURCE_PRIORITY.local * 2);
});