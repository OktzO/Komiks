// Feedback-loop test for the Response-body leak.
//
// Symptom (user): "request worker leaks on Cloudflare" — random 502/timeout
// under concurrent load, elevated Worker CPU-billing.
//
// Mechanism (confirmed via official CF docs):
//   "A fetch is only considered complete once the response body is fully
//    consumed. If a Worker fails to read response bodies while waiting for
//    more than six concurrent requests, the runtime will cancel the
//    least-recently-used request (deadlock avoidance)."
//   Hard limit = 6 concurrent outgoing fetches per incoming request.
//
// This stubs global `fetch` to return a Response whose body.cancel() is
// spied, then drives call sites that previously discarded the body on an
// error/early-return path.
//
//   RED  : body.cancel() never called  -> leak reproduced
//   GREEN: body.cancel() called once   -> leak fixed
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { komikuAdapter } from '../../../packages/sources/komiku/index.ts';
import { thriveAdapter } from '../../../packages/sources/thrive/index.ts';
import { bacakomikAdapter } from '../../../packages/sources/bacakomik/index.ts';
import { manhwaindoAdapter } from '../../../packages/sources/manhwaindo/index.ts';

const makeTrackedResponse = (status) => {
  const res = new Response('error body', { status });
  let drained = false;
  const origCancel = res.body?.cancel?.bind(res.body);
  if (res.body) {
    res.body.cancel = () => { drained = true; return origCancel ? origCancel() : Promise.resolve(); };
  }
  const origText = res.text.bind(res);
  res.text = () => { drained = true; return origText(); };
  return { res, drained: () => drained };
};

const stubFetch = (res) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => res;
  return () => { globalThis.fetch = original; };
};

describe('response body is drained on error/early-return paths (no CF subrequest leak)', () => {
  test('komiku search on 500 drains the body', async () => {
    const { res, drained } = makeTrackedResponse(500);
    const restore = stubFetch(res);
    try {
      const out = await komikuAdapter().search({ q: 'x' });
      assert.deepEqual(out, []);
      assert.ok(drained(), 'komiku search did not drain non-200 body');
    } finally { restore(); }
  });

  test('komiku healthCheck drains the body', async () => {
    const { res, drained } = makeTrackedResponse(200);
    const restore = stubFetch(res);
    try {
      const h = await komikuAdapter().healthCheck();
      assert.equal(h.healthy, true);
      assert.ok(drained(), 'komiku healthCheck did not drain body');
    } finally { restore(); }
  });

  test('thrive fetchHtml error drains the body', async () => {
    const { res, drained } = makeTrackedResponse(500);
    const restore = stubFetch(res);
    try {
      await assert.rejects(() => thriveAdapter().getSeries('nope'), /thrive fetch/);
      assert.ok(drained(), 'thrive fetchHtml did not drain non-200 body');
    } finally { restore(); }
  });

  test('thrive healthCheck drains the body', async () => {
    const { res, drained } = makeTrackedResponse(200);
    const restore = stubFetch(res);
    try {
      const h = await thriveAdapter().healthCheck();
      assert.equal(h.healthy, true);
      assert.ok(drained(), 'thrive healthCheck did not drain body');
    } finally { restore(); }
  });

  test('bacakomik healthCheck drains the body', async () => {
    const { res, drained } = makeTrackedResponse(200);
    const restore = stubFetch(res);
    try {
      const h = await bacakomikAdapter().healthCheck();
      assert.equal(h.healthy, true);
      assert.ok(drained(), 'bacakomik healthCheck did not drain body');
    } finally { restore(); }
  });

  test('manhwaindo healthCheck drains the body', async () => {
    const { res, drained } = makeTrackedResponse(200);
    const restore = stubFetch(res);
    try {
      const h = await manhwaindoAdapter().healthCheck();
      assert.equal(h.healthy, true);
      assert.ok(drained(), 'manhwaindo healthCheck did not drain body');
    } finally { restore(); }
  });
});
