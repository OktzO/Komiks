// Regression test for thrive `this._fetchDetail` binding loss.
//
// Symptom (live): /status/thrive uptime 85%, error string:
//   "TypeError: Cannot read properties of undefined (reading '_fetchDetail')"
//
// Root cause: reader.ts did `const detail = adapter.getSeriesDetail; detail(...)`
// which detaches the method from `adapter` → `this` is undefined at call time →
// thriveAdapter.getSeriesDetail calls `this._fetchDetail` → TypeError.
//
// bacakomik/manhwaindo inline their fetch, so they are immune. Only thrive
// uses a shared `this._fetchDetail` helper.
//
// RED  : detached invocation throws TypeError (reading '_fetchDetail')
// GREEN: detached invocation throws a network/HTTP error (meaning `this` bound)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { thriveAdapter } from '../../../packages/sources/thrive/index.ts';

describe('thrive adapter survives detached method invocation (this-binding)', () => {
  test('detached getSeriesDetail does not crash on missing `this`', async () => {
    const adapter = thriveAdapter();
    // Mirrors reader.ts:293 `const detail = adapter.getSeriesDetail; detail(...)`.
    const detached = adapter.getSeriesDetail;
    let err;
    try { await detached('00000000-0000-0000-0000-000000000000'); }
    catch (e) { err = e; }
    assert.ok(err, 'expected an error (network/404), not a silent success');
    const msg = String(err);
    // Must NOT be the this-binding TypeError.
    assert.ok(!msg.includes("reading '_fetchDetail'"),
      `regression: this-binding lost → ${msg}`);
    // Should be a real upstream-fetch error (404 / network / timeout).
    assert.match(msg, /thrive|fetch|network|404|timeout/i, `unexpected error: ${msg}`);
  });

  test('detached listChapters does not crash on missing `this`', async () => {
    const adapter = thriveAdapter();
    const detached = adapter.listChapters;
    let err;
    try { await detached('00000000-0000-0000-0000-000000000000'); }
    catch (e) { err = e; }
    assert.ok(err);
    const msg = String(err);
    assert.ok(!msg.includes("reading '_fetchDetail'"),
      `regression: this-binding lost → ${msg}`);
  });
});
