// Novel covers go through the existing R2/B2 + signed /img pipeline: the bytes
// live in B2, the credential stays server-side, and the reader's IP never
// reaches the source. Asserted here: the key contract, the host guard on a URL
// that came out of a scraped page, the upload itself, and the /img route that
// serves it under the same signature + referer guards as a chapter page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { novelCoverKey, uploadNovelCover } from '../src/lib/novelCover.ts';
import { imgRouter } from '../src/routes/reader.ts';
import { signImgPath } from '../src/lib/signedImage.ts';

const SECRET = 'test-signed-img-secret';

const ACCOUNTS = JSON.stringify([
  { name: 'b1', bucket: 'manga-images', keyId: 'k1', appKey: 'a1', region: 'us-east-005', host: 's3.us-east-005.backblazeb2.com' },
]);

const b2Env = (over = {}) => ({
  B2_CONFIG: undefined,
  B2_ACCOUNTS: ACCOUNTS,
  CACHE_KV: { async get() { return null; }, async put() {} },
  ...over,
});

// B2 and the source CDN are both reached over fetch, so the host is the seam.
// Anything that is neither is refused, which is what makes the host guard
// observable.
const captureFetch = () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    calls.push({ url, init });
    if (url.includes('backblazeb2.com')) {
      return Promise.resolve(new Response(init?.method === 'PUT' ? '' : 'IMAGEBYTES', {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      }));
    }
    if (url.includes('wp.com')) {
      return Promise.resolve(new Response('IMAGEBYTES', { status: 200, headers: { 'content-type': 'image/webp' } }));
    }
    return Promise.reject(new Error(`network disabled in tests: ${url}`));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
};

test('the cover key is defined once and names the series', () => {
  assert.equal(novelCoverKey('novelid-tekaburu'), 'novel/covers/novelid-tekaburu');
  // The key is a storage path, so a series id with a separator must not escape
  // into a different key space.
  assert.ok(!novelCoverKey('a/b').includes('..'));
});

test('a cover from a novelid CDN host is uploaded to B2 and returns its key', async () => {
  const { calls, restore } = captureFetch();
  try {
    const ref = await uploadNovelCover(
      b2Env(),
      'novelid-tekaburu',
      'https://i2.wp.com/novelid.org/uploads/a.webp?resize=139,184',
    );
    assert.equal(ref, novelCoverKey('novelid-tekaburu'));
    const put = calls.find((c) => c.init?.method === 'PUT');
    assert.ok(put, 'the object was PUT, not hotlinked');
    assert.match(put.url, /\/manga-images\/novel\/covers\/novelid-tekaburu$/);
    assert.equal(put.init.headers['content-type'], 'image/webp', 'the upstream type is preserved');
    assert.equal(put.init.headers['x-amz-content-sha256'].length, 64, 'the payload is really signed');
  } finally {
    restore();
  }
});

test('a cover host that is not a novelid CDN is never fetched', async () => {
  const { calls, restore } = captureFetch();
  try {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'https://evil.test/cover.jpg',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.equal(await uploadNovelCover(b2Env(), 's', url), null, `refused ${url}`);
    }
    assert.deepEqual(calls, [], 'no request left the Worker for any of them');
  } finally {
    restore();
  }
});

test('a non-image response is not stored as a cover', async () => {
  const { restore } = captureFetch();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve(new Response('<html>404</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    assert.equal(
      await uploadNovelCover(b2Env(), 'novelid-x', 'https://i2.wp.com/novelid.org/a.webp'),
      null,
      'an HTML body is not a cover',
    );
  } finally {
    globalThis.fetch = original;
    restore();
  }
});

test('no B2 account configured means no cover_ref, and the reader falls back', async () => {
  const { calls, restore } = captureFetch();
  try {
    const env = { ...b2Env(), B2_ACCOUNTS: undefined, B2_CONFIG: undefined };
    assert.equal(await uploadNovelCover(env, 'novelid-x', 'https://i2.wp.com/novelid.org/a.webp'), null);
    assert.deepEqual(calls, [], 'nothing is fetched when there is nowhere to put the bytes');
  } finally {
    restore();
  }
});

// ---- the /img route that serves it -----------------------------------------
// The existing chapter-page route is /img/:source/:chapterId/:pageNo and needs a
// chapter_pages row, so a cover cannot ride it. This is the same router, the
// same signature gate and the same server-side B2 read.
const imgApp = () => {
  const app = new Hono();
  app.route('/img', imgRouter);
  return app;
};

const imgEnv = (over = {}) => ({
  PEER_URLS: 'https://w0.test',
  PEER_INDEX: '0',
  DB_FORWARD_KEY: 'forward-secret',
  SIGNED_IMG_SECRET: SECRET,
  B2_ACCOUNTS: ACCOUNTS,
  CACHE_KV: { async get() { return null; }, async put() {} },
  ...over,
});

const get = async (path, env) => {
  const original = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = (input) => {
    fetches.push(String(input?.url ?? input));
    if (String(input?.url ?? input).includes('backblazeb2.com')) {
      return Promise.resolve(new Response('IMAGEBYTES', { status: 200, headers: { 'content-type': 'image/webp' } }));
    }
    return Promise.reject(new Error('network disabled in tests'));
  };
  try {
    const res = await imgApp().request(path, {}, env, { waitUntil: () => {}, passThroughOnException: () => {} });
    return { res, body: Buffer.from(await res.arrayBuffer()).toString(), fetches };
  } finally {
    globalThis.fetch = original;
  }
};

test('the cover route serves the B2 object, immutable, behind a valid signature', async () => {
  const env = imgEnv();
  const path = `/img/novel/${encodeURIComponent('novelid-tekaburu')}`;
  const { exp, sig } = await signImgPath(SECRET, path, 1500, Math.floor(Date.now() / 1000));
  const { res, body, fetches } = await get(`${path}?exp=${exp}&sig=${sig}`, env);
  assert.equal(res.status, 200);
  assert.equal(body, 'IMAGEBYTES');
  assert.equal(res.headers.get('content-type'), 'image/webp', 'the type stored at upload is what is served');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok(fetches.some((u) => u.includes('/manga-images/novel/covers/novelid-tekaburu')), 'read from B2');
  assert.ok(!fetches.some((u) => u.includes('backblazeb2.com') === false && u.includes('wp.com')), 'never from the source CDN');
});

test('the cover route enforces the same signature gate as a chapter page', async () => {
  const env = imgEnv();
  const path = `/img/novel/${encodeURIComponent('novelid-tekaburu')}`;
  const unsigned = await get(path, env);
  assert.equal(unsigned.res.status, 403, 'no signature, no bytes');

  const { exp, sig } = await signImgPath('a different secret', path, 1500, Math.floor(Date.now() / 1000));
  assert.equal((await get(`${path}?exp=${exp}&sig=${sig}`, env)).res.status, 403, 'a foreign secret does not pass');

  const expired = await signImgPath(SECRET, path, -3600, Math.floor(Date.now() / 1000));
  assert.equal((await get(`${path}?exp=${expired.exp}&sig=${expired.sig}`, env)).res.status, 403, 'an expired URL does not pass');

  const good = await signImgPath(SECRET, path, 1500, Math.floor(Date.now() / 1000));
  assert.equal((await get(`${path}?exp=${good.exp}&sig=${good.sig}`, env)).res.status, 200);
});

test('the cover route is 404 when the object is not in B2', async () => {
  const env = imgEnv();
  const path = '/img/novel/novelid-ghost';
  const { exp, sig } = await signImgPath(SECRET, path, 1500, Math.floor(Date.now() / 1000));
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('', { status: 404 }));
  try {
    const res = await imgApp().request(`${path}?exp=${exp}&sig=${sig}`, {}, env, { waitUntil: () => {} });
    assert.equal(res.status, 404, 'no upstream fallback: a cover is never hotlinked on a miss');
  } finally {
    globalThis.fetch = original;
  }
});
