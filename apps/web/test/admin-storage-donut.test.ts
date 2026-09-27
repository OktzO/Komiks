import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStorageSegments, storageArcs, storageSummary, type StorageAccount } from '../src/components/admin/charts';

const GB = 1024 * 1024 * 1024;
const QUOTA = 10 * GB;

const account = (name: string, bytes: number | null, bucket = `bucket-${name}`): StorageAccount => ({
  name,
  bucket,
  bytes,
  quota: QUOTA,
});

test('buildStorageSegments keeps every account in input order with a stable index', () => {
  const segments = buildStorageSegments([account('satu', 1), account('dua', null), account('tiga', 3)]);
  assert.equal(segments.length, 3, 'null-byte accounts stay in the legend');
  assert.deepEqual(segments.map((s) => s.idx), [0, 1, 2]);
  assert.deepEqual(segments.map((s) => s.value), [1, null, 3]);
  assert.deepEqual(segments.map((s) => s.label), ['satu', 'dua', 'tiga']);
});

test('buildStorageSegments derives its index from array position, not from caller data', () => {
  const segments = buildStorageSegments([
    { name: 'a', bucket: 'ba', bytes: 1, quota: QUOTA, idx: 99 } as never,
    { name: 'b', bucket: 'bb', bytes: 2, quota: QUOTA, idx: 0 } as never,
  ]);
  assert.deepEqual(segments.map((s) => s.idx), [0, 1], 'a caller idx cannot reorder or relabel the arcs');
  assert.deepEqual(segments.map((s) => s.label), ['a', 'b']);
});

test('buildStorageSegments colour is keyed on the stable index, not list position', () => {
  const segments = buildStorageSegments([account('a', 1), account('b', 2), account('c', 3), account('d', 4), account('e', 5)]);
  const colors = segments.map((s) => s.color);
  assert.equal(new Set(colors).size <= 4, true, 'palette cycles');
  assert.equal(segments[0]?.color, segments[4]?.color, 'index 0 and 4 share a palette slot');
  assert.notEqual(segments[1]?.color, segments[2]?.color);
});

test('buildStorageSegments falls back through name, bucket, then a generated label', () => {
  const segments = buildStorageSegments([
    account('', null, 'named-bucket'),
    account('', null, ''),
    account('   ', null, 'bucket-only'),
  ]);
  assert.equal(segments[0]?.label, 'named-bucket');
  assert.equal(segments[1]?.label, 'akun 2', 'a generated label uses the one-based array position');
  assert.equal(segments[2]?.label, 'bucket-only');
});

test('buildStorageSegments normalises negative, fractional and non-numeric bytes to null', () => {
  const segments = buildStorageSegments([
    account('neg', -1),
    account('frac', 1.5),
    account('str', 'lots' as never),
    account('nan', Number.NaN),
    account('zero', 0),
  ]);
  assert.deepEqual(segments.map((s) => s.value), [null, null, null, null, 0]);
});

test('zero-byte accounts are listed but never drawn as an arc', () => {
  const segments = buildStorageSegments([account('a', 10), account('zero', 0), account('null', null)]);
  assert.deepEqual(storageArcs(segments).map((s) => s.idx), [0]);
  assert.equal(segments.length, 3, 'every account stays in the legend');
});

test('storageArcs returns the same segment objects the legend renders', () => {
  const segments = buildStorageSegments([
    account('a', null),
    account('b', 5),
    account('c', 0),
    account('d', 7),
    account('e', null),
  ]);
  const arcs = storageArcs(segments);
  for (const arc of arcs) {
    const legendRow = segments.find((s) => s.idx === arc.idx);
    assert.equal(legendRow, arc, 'an arc is the very object its legend row renders, so the shared idx cannot drift');
  }
  assert.deepEqual(arcs.map((s) => s.idx), [1, 3]);
  assert.equal(segments.length, 5);
});

test('legend colour and arc colour agree because both key on the same stable index', () => {
  const segments = buildStorageSegments([
    account('a', null),
    account('b', 5),
    account('c', null),
    account('d', 7),
  ]);
  const arcs = storageArcs(segments);
  for (const arc of arcs) {
    const legendRow = segments.find((s) => s.idx === arc.idx);
    assert.equal(arc.color, legendRow?.color, `idx ${arc.idx} must share one colour`);
  }
  assert.notEqual(arcs[0]?.color, arcs[1]?.color, 'a skipped row does not make two arcs share a palette slot');
});

test('a legend row and its arc share the same stable index when null and zero rows intervene', () => {
  const segments = buildStorageSegments([
    account('nolang', null),
    account('nolang-2', null),
    account('ada', 100),
    account('nolang-3', null),
    account('juga-ada', 300),
  ]);
  assert.deepEqual(storageArcs(segments).map((s) => s.idx), [2, 4], 'arc index is the original account index');
  assert.deepEqual(segments.map((s) => s.idx), [0, 1, 2, 3, 4]);
  const byIdx = (idx: number) => segments.find((s) => s.idx === idx);
  assert.equal(byIdx(2)?.value, 100, 'legend row 2 and arc row 2 are the same account');
  assert.equal(byIdx(4)?.value, 300);
  assert.equal(byIdx(0)?.value, null);
});

test('a fully measured set reports the exact share of quota', () => {
  const segments = buildStorageSegments([account('a', 2 * GB), account('b', 3 * GB)]);
  const summary = storageSummary(segments, null, QUOTA);
  assert.deepEqual(summary, { measuredBytes: 5 * GB, aggregateBytes: 5 * GB, known: 2, total: 2, share: 50, state: 'measured' });
});

test('a partially measured set reports the measured share and flags the gap', () => {
  const segments = buildStorageSegments([account('a', 2 * GB), account('b', null), account('c', 3 * GB)]);
  const summary = storageSummary(segments, null, QUOTA);
  assert.deepEqual(summary, { measuredBytes: 5 * GB, aggregateBytes: 5 * GB, known: 2, total: 3, share: 50, state: 'partial' });
});

test('a zero-byte account is known, not unknown', () => {
  const summary = storageSummary(buildStorageSegments([account('a', 0)]), null, QUOTA);
  assert.deepEqual(summary, { measuredBytes: 0, aggregateBytes: 0, known: 1, total: 1, share: 0, state: 'measured' });
});

test('an all-null per-account set with a usable total reports aggregate-only, never a percentage', () => {
  const segments = buildStorageSegments([account('a', null), account('b', null)]);
  const summary = storageSummary(segments, 4 * GB, QUOTA);
  assert.deepEqual(summary, {
    measuredBytes: 0,
    aggregateBytes: 4 * GB,
    known: 0,
    total: 2,
    share: null,
    state: 'aggregate-only',
  });
});

test('aggregate-only draws no arc, so the ring cannot imply a breakdown', () => {
  const segments = buildStorageSegments([account('a', null), account('b', null)]);
  assert.deepEqual(storageArcs(segments), []);
  assert.equal(storageSummary(segments, 4 * GB, QUOTA).share, null);
});

test('zero accounts with a reported total is aggregate-only, never measured', () => {
  const summary = storageSummary([], 2 * GB, QUOTA);
  assert.deepEqual(summary, {
    measuredBytes: 0,
    aggregateBytes: 2 * GB,
    known: 0,
    total: 0,
    share: null,
    state: 'aggregate-only',
  });
});

test('a reported total is ignored once any account measures its own bytes', () => {
  const summary = storageSummary(buildStorageSegments([account('a', 1 * GB), account('b', null)]), 9 * GB, QUOTA);
  assert.deepEqual(summary, { measuredBytes: 1 * GB, aggregateBytes: 1 * GB, known: 1, total: 2, share: 10, state: 'partial' });
});

test('an unusable reported total does not become a zero-byte measurement', () => {
  for (const bad of [-1, Number.NaN, 'lots', null, undefined, 1.5]) {
    const segments = buildStorageSegments([account('a', null)]);
    const summary = storageSummary(segments, bad as never, QUOTA);
    assert.deepEqual(summary, {
      measuredBytes: 0,
      aggregateBytes: null,
      known: 0,
      total: 1,
      share: null,
      state: 'unknown',
    }, `total ${String(bad)} must not be used`);
  }
});

test('an unusable quota reports no-quota instead of an unmeasured share', () => {
  for (const bad of [0, -1, Number.NaN]) {
    const summary = storageSummary(buildStorageSegments([account('a', 5 * GB)]), null, bad);
    assert.deepEqual(summary, {
      measuredBytes: 5 * GB,
      aggregateBytes: 5 * GB,
      known: 1,
      total: 1,
      share: null,
      state: 'no-quota',
    }, `quota ${String(bad)} must be no-quota`);
  }
});

test('a missing measurement outranks a missing quota', () => {
  const summary = storageSummary(buildStorageSegments([account('a', null)]), null, 0);
  assert.equal(summary.state, 'unknown', 'nothing to divide is the primary unknown');
  assert.equal(summary.share, null);
});

test('aggregate-only still outranks a missing quota, because a total does exist', () => {
  const summary = storageSummary(buildStorageSegments([account('a', null)]), 3 * GB, 0);
  assert.equal(summary.state, 'no-quota');
  assert.equal(summary.aggregateBytes, 3 * GB);
});

test('an empty account list without a total reports unknown', () => {
  assert.deepEqual(storageSummary([], null, QUOTA), {
    measuredBytes: 0,
    aggregateBytes: null,
    known: 0,
    total: 0,
    share: null,
    state: 'unknown',
  });
});

test('a share above the quota is capped at 100', () => {
  const summary = storageSummary(buildStorageSegments([account('a', 20 * GB)]), null, QUOTA);
  assert.equal(summary.measuredBytes, 20 * GB);
  assert.equal(summary.share, 100);
});

test('the ring share and the displayed bytes always describe the same quantity', () => {
  const cases: Array<[Array<number | null>, number | null]> = [
    [[2 * GB, 3 * GB], null],
    [[2 * GB, null, 3 * GB], null],
    [[null, null], 4 * GB],
    [[0], null],
    [[], 2 * GB],
  ];
  for (const [bytes, total] of cases) {
    const segments = buildStorageSegments(bytes.map((b, i) => account(`a${i}`, b)));
    const summary = storageSummary(segments, total, QUOTA);
    const label = `bytes ${JSON.stringify(bytes)} total ${String(total)}`;
    if (summary.known > 0) {
      assert.equal(summary.share, Math.min(100, (summary.measuredBytes / QUOTA) * 100), label);
      assert.equal(summary.aggregateBytes, summary.measuredBytes, label);
    } else if (summary.state === 'aggregate-only') {
      assert.equal(summary.share, null, `${label} must not show a percentage`);
      assert.equal(summary.aggregateBytes, total, label);
    } else {
      assert.equal(summary.aggregateBytes, null, label);
      assert.equal(summary.share, null, label);
    }
  }
});

test('share is non-null only when a per-account measurement exists', () => {
  const matrix: Array<[Array<number | null>, number | null, boolean]> = [
    [[1], null, true],
    [[1, null], null, true],
    [[null], 1, false],
    [[null, null], 1, false],
    [[], 1, false],
    [[], null, false],
  ];
  for (const [bytes, total, expectShare] of matrix) {
    const segments = buildStorageSegments(bytes.map((b, i) => account(`a${i}`, b)));
    const summary = storageSummary(segments, total, QUOTA);
    assert.equal(summary.share !== null, expectShare, `bytes ${JSON.stringify(bytes)} total ${String(total)}`);
  }
});
