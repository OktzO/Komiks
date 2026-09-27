// Pins the reader's neighbour derivation where the regression happened: the
// round-1 helpers were correct, but nothing stopped NovelReader from going back
// to page arithmetic on the chapter number. These fail if it does — the
// behavioural ones on the walk, the last on the reader actually using it.
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

/** The links the reader renders, given a walk that the reader would accept. */
const linksFor = async (all: Row[], chapterId: string, number: number, maxPages = 5) => {
  const walk = await chapterPageWalk(pager(all).fetchPage, chapterId, { limit: LIMIT, maxPages });
  if (walk.reason !== 'end') return { reason: walk.reason, prev: null, next: null };
  return { reason: walk.reason, ...neighbourChapters(walk.rows, number) };
};

test('the walk locates a chapter that page arithmetic misplaces, and stops there', async () => {
  // Ingest dropped 11-100: 110 stored rows, so page 3 holds only 151-200.
  const all = rows([...Array.from({ length: 10 }, (_, i) => i + 1), ...Array.from({ length: 100 }, (_, i) => i + 101)]);
  const p = pager(all);

  const walk = await chapterPageWalk(p.fetchPage, 'novelid-x/150', { limit: LIMIT, maxPages: 5 });

  assert.deepEqual(p.asked, [1, 2], 'it must read the page the chapter is really on, not ceil(150/50) = 3');
  assert.equal(walk.reason, 'end', 'the list ran out, so the rows are the whole list');
  assert.equal(walk.rows.length, 100, 'page 1 (50) + page 2 (50), and no page 3');
  assert.ok(walk.rows.some((c) => c.source_chapter_id === 'novelid-x/150'), 'the chapter itself is in hand');

  const { prev, next } = neighbourChapters(walk.rows, 150);
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
  const walk = await chapterPageWalk(p.fetchPage, 'novelid-x/50', { limit: LIMIT, maxPages: 5 });

  assert.deepEqual(p.asked, [1, 2], 'exactly one extra page, for the successor');
  assert.equal(walk.reason, 'end');
  const { prev, next } = neighbourChapters(walk.rows, 50);
  assert.equal(prev?.source_chapter_id, 'novelid-x/49');
  assert.equal(next?.source_chapter_id, 'novelid-x/51', 'without the extra page there is no next link');
});

test('the walk stops at the end of the list instead of paging into nothing', async () => {
  const p = pager(rows([1, 2, 3]));
  const walk = await chapterPageWalk(p.fetchPage, 'novelid-x/3', { limit: LIMIT, maxPages: 5 });
  assert.deepEqual(p.asked, [1], 'a short page is the end');
  assert.equal(walk.reason, 'end');
  assert.equal(walk.rows.length, 3);

  // A chapter that is not stored at all: with the whole list in hand, absence
  // is meaningful, so there is no neighbour to point at.
  assert.deepEqual(neighbourChapters(walk.rows, 900), { prev: null, next: null });
});

// The residual from round 2. The walk is bounded at maxPages, and a walk that
// stops on that bound holds a PREFIX, not the list. Deriving neighbours from a
// prefix produced chapter 249/250 links for chapter 4000 — plausible, wrong,
// and the same failure class as the round-1 arithmetic bug. A wrong link is
// worse than no link, so a budget stop renders neither.
test('a series longer than the row budget yields no links, not wrong ones', async () => {
  const all = rows(Array.from({ length: 4000 }, (_, i) => i + 1));

  // Current chapter near the end of what the walk can read.
  const nearEnd = await linksFor(all, 'novelid-x/240', 240, 5);
  assert.equal(nearEnd.reason, 'end', 'page 5 holds it, and page 5 is short, so the list did end');
  assert.equal(nearEnd.prev?.number, 239);
  assert.equal(nearEnd.next?.number, 241);

  // Same list, chapter past the budget: the walk stops having read enough.
  const beyond = await linksFor(all, 'novelid-x/4000', 4000, 5);
  assert.equal(beyond.reason, 'budget', 'every page it read was full, so it never saw the end');
  assert.equal(beyond.prev, null, 'no link, rather than the last row it happened to read');
  assert.equal(beyond.next, null);

  // The prefix alone would have said prev = chapter 50, the last row read.
  // neighbourChapters must refuse: absence from a prefix is not evidence.
  const p = pager(all);
  const prefix = await chapterPageWalk(p.fetchPage, 'novelid-x/4000', { limit: LIMIT, maxPages: 1 });
  assert.equal(prefix.reason, 'budget');
  assert.equal(prefix.rows.length, 50, 'a full page, so the walk never saw the end');
  assert.deepEqual(neighbourChapters(prefix.rows, 4000), { prev: null, next: null });
  // …while the same helper still answers normally for a chapter it does hold.
  assert.equal(neighbourChapters(prefix.rows, 20).prev?.number, 19);
});

test('a walk that read the whole list is trusted only for chapters in it', async () => {
  const all = rows([10, 20, 30]);
  const walk = await chapterPageWalk(pager(all).fetchPage, 'novelid-x/20', { limit: LIMIT, maxPages: 5 });
  assert.equal(walk.reason, 'end');
  assert.equal(neighbourChapters(walk.rows, 20).prev?.number, 10);
  assert.equal(neighbourChapters(walk.rows, 20).next?.number, 30);
  // Present in the URL but not stored: no guess.
  assert.deepEqual(neighbourChapters(walk.rows, 25), { prev: null, next: null });
});

// The behavioural tests above prove the walk is right. This proves the reader
// calls it — the round-1 failure was a correct helper behind an unused import.
const READER_SRC = readFileSync(fileURLToPath(new URL('../src/components/NovelReader.tsx', import.meta.url)), 'utf8');

test('NovelReader walks the chapter list instead of computing a page', () => {
  assert.match(READER_SRC, /chapterPageWalk\(/, 'the reader must walk pages by the rows returned');
  assert.match(READER_SRC, /neighbourChapters\(/, 'the reader must take prev/next from the actual list');
  assert.match(READER_SRC, /walk\?\.reason === 'end'/, 'the reader must gate its links on the walk stopping at the end of the list');
  assert.doesNotMatch(
    READER_SRC,
    /Math\.ceil\([^)]*(?:number|chapter|Num|num)/,
    'page arithmetic on the chapter number is the bug this replaced — it must not come back',
  );
});
