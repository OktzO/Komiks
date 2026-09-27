import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { VALID_TYPES, isValidType, safeType } from '../src/lib/api';

const GUARD = 'if (!isValidType(type!)) notFound = true;';
const PAGES = [
  '../src/pages/[type]/[slug]/index.astro',
  '../src/pages/[type]/[slug]/[chapterId].astro',
];

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('VALID_TYPES stays manga-only (novel has its own module)', () => {
  assert.deepEqual([...VALID_TYPES], ['manga', 'manhwa', 'manhua']);
  assert.equal(isValidType('novel'), false);
});

test('unknown type is rejected, not coerced to manga', () => {
  assert.equal(isValidType('bogus'), false);
  assert.equal(isValidType('Novel'), false);
  assert.equal(isValidType('novel-2'), false);
});

test('safeType would coerce the same inputs — guard is what rejects them', () => {
  assert.equal(safeType('bogus'), 'manga');
  assert.equal(isValidType(safeType('bogus')), true);
});

for (const page of PAGES) {
  test(`${page}: type guard runs before the wrong-type redirect`, () => {
    const src = read(page);
    const guard = src.indexOf(GUARD);
    const redirect = src.indexOf('Astro.redirect');
    assert.notEqual(guard, -1, 'guard missing');
    assert.notEqual(redirect, -1, 'redirect block missing');
    assert.ok(guard < redirect, 'guard must precede the redirect block');

    const line = src.slice(src.lastIndexOf('\n', guard) + 1, src.indexOf('\n', guard));
    assert.match(src.slice(src.indexOf('\n', guard) + 1, redirect), /if \(!notFound &&/, 'redirect must be gated on !notFound');
    assert.equal(line.trim(), GUARD);
  });

  test(`${page}: 404 path preserved (status + NotFoundPage)`, () => {
    const src = read(page);
    assert.match(src, /if \(notFound\) Astro\.response\.status = 404;/);
    assert.match(src, /NotFoundPage client:load \/>/);
  });
}
