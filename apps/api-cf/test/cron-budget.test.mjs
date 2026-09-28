// The cron runs five steps inside one Workers invocation, and the plan allows 50
// subrequests for all of them — not 50 each. Budgeting the novel work against
// the plan's cap left the outbox (6) plus the chapter refresh (44) exactly on
// 50, so the eviction sweep and the homepage feed scheduled after them had no
// headroom at all. "Too many subrequests" is not catchable: the runtime drops
// the invocation, so those steps never ran. The crash moved, it did not go away.
//
// These are the numbers the plan is trusted to keep true as steps are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRON_STEP_BUDGETS,
  CRON_STEPS_TOTAL,
  CRON_SUBREQUEST_CAP,
  CRON_SUBREQUEST_HEADROOM,
} from '../src/lib/cronBudget.ts';
import { OUTBOX_FLUSH_BUDGET } from '../src/lib/dbWrite.ts';
import {
  CATALOG_SUBREQUEST_BUDGET,
  REFRESH_SUBREQUEST_BUDGET,
  REFRESH_VISIT_COST,
  refreshVisitsFor,
  refreshWindowFor,
} from '../src/lib/novelIngest.ts';

const srcDir = new URL('../src', import.meta.url).pathname;
const readSrc = (p) => readFileSync(join(srcDir, p), 'utf8');

test('every step of the invocation has an allowance, and they fit under the cap', () => {
  assert.equal(CRON_SUBREQUEST_CAP, 50, 'the Workers free-plan cap the defaults are sized for');
  assert.ok(
    CRON_STEPS_TOTAL + CRON_SUBREQUEST_HEADROOM <= CRON_SUBREQUEST_CAP,
    `the steps allow ${CRON_STEPS_TOTAL} and the reserve is ${CRON_SUBREQUEST_HEADROOM},`
    + ` which is ${CRON_STEPS_TOTAL + CRON_SUBREQUEST_HEADROOM} of ${CRON_SUBREQUEST_CAP}`,
  );
  // Sized against what each step actually spends, not left at a round number:
  // the eviction sweep's own snapshot counts eleven tables, so a plan that
  // reserved nothing for it would hand the overspend straight to the runtime.
  assert.ok(CRON_STEP_BUDGETS.eviction >= 6, 'the usage snapshot alone counts eleven tables');
  assert.ok(CRON_STEP_BUDGETS.homepage >= 8, 'five scrapes, two KV writes and the peer push');
  for (const [step, allowance] of Object.entries(CRON_STEP_BUDGETS)) {
    assert.ok(Number.isInteger(allowance) && allowance > 0, `${step} has no allowance`);
  }
});

test('a step added later has to declare a share, and the sum still has to hold', () => {
  // The list is closed on purpose: a step that wants a share has to be added to
  // it, and the assertion above is what makes that addition visible in review.
  assert.deepEqual(
    Object.keys(CRON_STEP_BUDGETS).sort(),
    ['catalog', 'eviction', 'homepage', 'outbox', 'refresh'],
  );
});

test('the novel steps read the plan instead of declaring their own number', () => {
  assert.equal(OUTBOX_FLUSH_BUDGET, CRON_STEP_BUDGETS.outbox);
  assert.equal(REFRESH_SUBREQUEST_BUDGET, CRON_STEP_BUDGETS.refresh);
  assert.equal(CATALOG_SUBREQUEST_BUDGET, CRON_STEP_BUDGETS.catalog);
  assert.ok(
    CATALOG_SUBREQUEST_BUDGET < REFRESH_SUBREQUEST_BUDGET,
    'the crawl and the refresh run in the same invocation, so they cannot both claim the refresh share',
  );
  // A constant that survives in the file alongside the import is how the two
  // drift apart again — the number the cron actually spends stops being the
  // number the plan was checked against.
  const declared = [
    ['lib/dbWrite.ts', 'OUTBOX_FLUSH_BUDGET', 'outbox'],
    ['lib/novelIngest.ts', 'REFRESH_SUBREQUEST_BUDGET', 'refresh'],
  ];
  for (const [file, name, key] of declared) {
    const decl = readSrc(file).match(new RegExp(`${name} = ([^;]+);`));
    assert.ok(decl, `${name} is not declared`);
    assert.equal(decl[1].trim(), `CRON_STEP_BUDGETS.${key}`, `${name} is ${decl[1]}`);
  }
});

test('one chapter refresh visit fits its share, however many the share buys', () => {
  const share = CRON_STEP_BUDGETS.refresh;
  const window = refreshWindowFor({});
  assert.equal(window, share - REFRESH_VISIT_COST, 'the window is what the share buys, not a constant');
  const visits = refreshVisitsFor({});
  assert.ok(visits * (REFRESH_VISIT_COST + window) <= share, `${visits} visits at a window of ${window} over ${share}`);
  assert.ok(visits >= 1, 'and a series must still advance, so it is never zero');
  // The window shrank with the share: the series is no longer crawled in one
  // tick, so a novel's remaining chapters are carried by the cursor over
  // several hours. Resumable, not dropped.
  assert.equal(window, 10, 'a slice of a 44-chapter window, since the share is 16');
  assert.ok(
    CRON_STEP_BUDGETS.refresh < 44,
    'the refresh may not claim what the whole invocation was allowed',
  );
});

test('the catalogue walk cannot spend the share it was not given', () => {
  // syncCatalog defaulted to the refresh budget, so the crawler and the refresh
  // each drew the same number from the same invocation.
  const src = readSrc('lib/novelIngest.ts');
  const line = src.split('\n').find((l) => l.includes('const budget = Math.max(1, opts.budget'));
  assert.ok(line, 'the walk reads a budget');
  assert.match(line, /CATALOG_SUBREQUEST_BUDGET/, 'and that budget is the catalogue share, not the refresh one');
  assert.ok(!/NOVEL_REFRESH_BUDGET/.test(line), 'NOVEL_REFRESH_BUDGET configures the refresh, not the crawl');
});
