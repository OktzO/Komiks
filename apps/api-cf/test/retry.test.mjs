import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable } from '../src/lib/retry.ts';

test('429 is retryable', () => {
  assert.ok(isRetryable('komiku getSeriesDetail 429'));
});

test('502 is retryable (DDoS-guard)', () => {
  assert.ok(isRetryable('komiku getSeriesDetail 502'));
});

test('503 is retryable', () => {
  assert.ok(isRetryable('komiku getSeriesDetail 503'));
});

test('520/521/522 (CF origin errors) are retryable', () => {
  assert.ok(isRetryable('upstream 520'));
  assert.ok(isRetryable('upstream 521'));
  assert.ok(isRetryable('upstream 522'));
  assert.ok(isRetryable('upstream 524'));
});

test('AbortError / timeout is retryable', () => {
  assert.ok(isRetryable('AbortError: timeout'));
  assert.ok(isRetryable('request aborted'));
});

test('network errors are retryable', () => {
  assert.ok(isRetryable('TypeError: fetch failed'));
  assert.ok(isRetryable('connection reset'));
});

test('non-retryable status codes (404, 410) are NOT retried', () => {
  assert.equal(isRetryable('komiku 404'), false);
  assert.equal(isRetryable('komiku 410'), false);
});

test('empty / unrelated errors are NOT retried', () => {
  assert.equal(isRetryable(''), false);
  assert.equal(isRetryable('SyntaxError: bad regex'), false);
});
