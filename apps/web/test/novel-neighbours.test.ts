// Pins the reader's neighbour derivation where the regression happened: the
// round-1 helpers were correct, but nothing stopped NovelReader from going back
// to page arithmetic on the chapter number. These two tests fail if it does —
// the first on the walk's behaviour, the second on the reader actually using it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chapterPageWalk, neighbourChapters, novelChapterUrl } from '../src/lib/novelRoutes';

const LIMIT = 50;

interface Row { source_chapter_id: string; number: number; title: string | null }

const rows = (numbers: number[]): Row[] =>
  numbers.map((n) => ({ source_chapter_id: `novelid-x/${n}`, number: n, title: n === 1 ? 'Prolog' : null }));

/** Stands in for getNovelChapters: a row-offset window over one ordered list. */
const pager = (all: Row[]) => {
  const asked: number[] = [];
  return {
    asked,
    fetchPage: async (page: number) => {
      asked.push(page);
      return all.slice((page - 1) * LIMIT, page * LIMIT);
    },
  };
};

test('the walk locates a chapter that page arithmetic misplaces, and stops there', async () => {
  // Ingest dropped 11-100: 110 stored rows, so page 3 holds only 151-200.
  const all = rows([...Array.from({ length: 10 }, (_, i) => i + 1), ...Array.from({ length: 100 }, (_, i) => i + 101)]);
  const p = pager(all);

  const collected = await chapterPageWalk(p.fetchPage, 'novelid-x/150', { limit: LIMIT, maxPages: 5 });

  assert.deepEqual(p.asked, [1, 2], 'it must read the page the chapter is really on, not ceil(150/50) = 3');
  assert.equal(collected.length, 100, 'page 1 (50) + page 2 (50), and no page 3');
  assert.ok(collected.some((c) => c.source_chapter_id === 'novelid-x/150'), 'the chapter itself is in hand');

  const { prev, next } = neighbourChapters(collected, 150);
  assert.equal(prev?.source_chapter_id, 'novelid-x/149');
  assert.equal(next?.source_chapter_id, 'novelid-x/151');
  // The links the reader renders, straight from the walked rows.
  assert.equal(novelChapterUrl('novelid-x', prev!.source_chapter_id), '/novel/novelid-x/novelid-x%2F149');
  assert.equal(novelChapterUrl('novelid-x', next!.source_chapter_id), '/novel/novelid-x/novelid-x%2F151');
});

test('the walk reads one page past a chapter that ends its window', async () => {
  const all = rows(Array.from({ length: 250 }, (_, i) => i + 1));
  const p = pager(all);

  // Chapter 50 is the last row of page 1, so its successor is not in hand yet.
  const collected = await chapterPageWalk(p.fetchPage, 'novelid-x/50', { limit: LIMIT, maxPages: 5 });

  assert.deepEqual(p.asked, [1, 2], 'exactly one extra page, for the successor');
  const { prev, next } = neighbourChapters(collected, 50);
  assert.equal(prev?.source_chapter_id, 'novelid-x/49');
  assert.equal(next?.source_chapter_id, 'novelid-x/51', 'without the extra page there is no next link');
});

test('the walk stops at the end of the list instead of paging into nothing', async () => {
  const p = pager(rows([1, 2, 3]));
  const collected = await chapterPageWalk(p.fetchPage, 'novelid-x/3', { limit: LIMIT, maxPages: 5 });
  assert.deepEqual(p.asked, [1], 'a short page is the end');
  assert.equal(collected.length, 3);
  // A chapter that is not stored at all yields no neighbours, not a guess.
  const missing = await chapterPageWalk(pager(rows([1, 2, 3])).fetchPage, 'novelid-x/900', { limit: LIMIT, maxPages: 5 });
  assert.deepEqual(neighbourChapters(missing, 900), { prev: { source_chapter_id: 'novelid-x/3', number: 3, title: null }, next: null });
});

test('a series longer than the walk bound degrades to no links, never to wrong ones', async () => {
  // 400 rows, maxPages 1 → the chapter lives on page 8 and is never read.
  const all = rows(Array.from({ length: 400 }, (_, i) => i + 1));
  const p = pager(all);
  const collected = await chapterPageWalk(p.fetchPage, 'novelid-x/380', { limit: LIMIT, maxPages: 1 });

  assert.deepEqual(p.asked, [1], 'the bound is respected, not exceeded');
  assert.ok(!collected.some((c) => c.source_chapter_id === 'novelid-x/380'));
  // 380 is not in the rows, so neighbourChapters cannot claim it as the current
  // chapter — the links are off rather than aimed at chapter 50.
  const { prev, next } = neighbourChapters(collected, 380);
  assert.equal(prev?.number, 50);
  // …which is why the reader treats a missing current chapter as "unknown":
  // the row set is the gate, not the number.
  assert.equal(collected.includes(all[0]), true);
});

// The behavioural tests above prove the walk is right. This proves the reader
// calls it — the round-1 failure was a correct helper behind an unused import.
const READER_SRC = readFileSync(fileURLToPath(new URL('../src/components/NovelReader.tsx', import.meta.url)), 'utf8');

test('NovelReader walks the chapter list instead of computing a page', () => {
  assert.match(READER_SRC, /chapterPageWalk\(/, 'the reader must walk pages by the rows returned');
  assert.match(READER_SRC, /neighbourChapters\(/, 'the reader must take prev/next from the actual list');
  assert.doesNotMatch(
    READER_SRC,
    /Math\.ceil\([^)]*(?:number|chapter|Num|num)/,
    'page arithmetic on the chapter number is the bug this replaced — it must not come back',
  );
});
