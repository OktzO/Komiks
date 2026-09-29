// The admin rate limiter's mount path, which is easy to get wrong and silent
// when wrong: `app.use('/api/admin', mw)` in Hono matches ONLY that exact path.
// `/api/admin/overview` is a different path and runs no middleware mounted at
// `/api/admin`. The global limiter does not save it — rateLimit() explicitly
// returns next() for anything under /api/admin — so 16 of the 18 admin routes
// were reachable with no limit at all. The comment in index.ts claimed the
// limiter applied to "all /api/admin/*", which was the belief the bug lived on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

const INDEX = new URL('../src/index.ts', import.meta.url);
const source = readFileSync(fileURLToPath(INDEX), 'utf8');

test('index.ts mounts the admin limiter with a wildcard', () => {
  // Assert the literal, because a substring search for 'rateLimitAdmin' finds
  // the identifier wherever it is used and cannot tell the two forms apart.
  const mounts = [...source.matchAll(/app\.use\('(\/api\/admin[^']*)',\s*rateLimitAdmin\)/g)]
    .map((m) => m[1]);
  assert.equal(mounts.length, 1, `expected exactly one admin limiter mount, found ${JSON.stringify(mounts)}`);
  assert.equal(mounts[0], '/api/admin/*', 'the exact-path form matches no sub-path');
});

test('scrape limiter also covers its sub-path', () => {
  // GET /api/scrape/:job_id is a real route. Under '/api/scrape' it got the
  // global 60/min instead of the intended admin budget.
  const mounts = [...source.matchAll(/app\.use\('(\/api\/scrape[^']*)',\s*rateLimitAdmin\)/g)]
    .map((m) => m[1]);
  assert.deepEqual(mounts, ['/api/scrape/*']);
});

// Prove the claim against the real Hono, so the assertion above is about a
// behaviour that is still true rather than about a string in a comment.
test('an exact-path use() really does skip sub-paths', async () => {
  const probe = async (path) => {
    const hits = [];
    const app = new Hono();
    app.use(path, async (_c, next) => { hits.push('limiter'); await next(); });
    app.get('/api/admin/overview', (c) => c.json({ ok: true }));
    await app.request('http://x/api/admin/overview');
    return hits;
  };
  assert.deepEqual(await probe('/api/admin'), [], 'the bug: exact path, no sub-path match');
  assert.deepEqual(await probe('/api/admin/*'), ['limiter'], 'wildcard covers the sub-path');
});
