// apps/api-cf/test/enrich-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBudget } from '../src/routes/reader.ts';

test('withBudget returns fallback on timeout', async () => {
  const slow = new Promise((r) => setTimeout(() => r('slow'), 5000));
  const out = await withBudget(slow, 50, 'fallback');
  assert.equal(out, 'fallback');
});

test('withBudget returns value when fast', async () => {
  const out = await withBudget(Promise.resolve('fast'), 1000, 'fallback');
  assert.equal(out, 'fast');
});
