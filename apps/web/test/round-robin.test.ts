// Round-robin SSR fix test - verifies apiWithFailover distribution:
//  T1 server: ~uniform spread across origins (no 100%-to-one-origin skew)
//  T1b gate: /api/novel/ is allowlisted, a private path is not
//  T2 client: sessionStorage cursor rotation unchanged (no regression)
//  T3 server: circuit-open origin is skipped BEFORE random selection
//  T4 server: all origins open -> falls back to main API, no hard error
// RUN: bun apps/web/test/round-robin.test.ts   |   N-agnostik: satukan TEST_ORIGINS=N (N≥3).
// N<3 tidak bermakna utk round-robin/failover (T3 butuh ORIGINS[2], T2 butuh ≥2) → skip bersih.
import assert from 'node:assert/strict';

delete (globalThis as any).sessionStorage; // server-like env initially
delete (globalThis as any).window;

const N_ORIGINS = Number(process.env.TEST_ORIGINS ?? 4);
if (N_ORIGINS < 3) {
  console.log(`skip: round-robin test butuh N≥3 origin (TEST_ORIGINS=${N_ORIGINS})`);
  process.exit(0);
}
const ORIGINS = Array.from({ length: N_ORIGINS }, (_, i) => `https://w${i}.test`);
const hits: Record<string, number> = {};
let mainHits = 0;
// How the main API (the not-in-ORIGINS host) answers. T1b and T4 need it healthy;
// T7 drives it to prove the 404-vs-outage boundary.
let mainBehaviour: 'ok' | number | 'throw' = 'ok';
const injectedFails: Record<string, number> = {}; // origin -> remaining 500s to inject

(globalThis as any).fetch = async (input: any) => {
  const url = String(input);
  if (url.endsWith('/api/origins')) {
    return new Response(JSON.stringify({ data: ORIGINS.map((url) => ({ url })) }));
  }
  const origin = ORIGINS.find((o) => url.startsWith(o));
  if (!origin) {
    // main API fallback (separate host, always healthy)
    mainHits++;
    if (mainBehaviour === 'throw') throw new TypeError('fetch failed');
    if (typeof mainBehaviour === 'number') return new Response('err', { status: mainBehaviour });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
  }
  hits[origin] = (hits[origin] ?? 0) + 1;
  if ((injectedFails[origin] ?? 0) > 0) {
    injectedFails[origin]--;
    return new Response('err', { status: 500 });
  }
  return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
};

process.env.PUBLIC_API_URL = 'https://main-api.test'; // NOT in ORIGINS

const { apiWithFailover } = await import('../src/lib/api');
const PATH = '/api/reader/komiku/series/x/detail';

const report = (label: string, counts: Record<string, number>) => {
  const vals = Object.values(counts);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const total = vals.reduce((a, b) => a + b, 0);
  console.log(
    `${label}: total=${total} min=${min} max=${max} skew=${((max - min) / (max || 1) * 100).toFixed(1)}%` +
      ` | ${ORIGINS.map((o) => `${o.replace('https://', '')}:${counts[o] ?? 0}`).join(' ')}`
  );
  return { min, max };
};

// T1: server distribution, all healthy
for (let i = 0; i < 200; i++) await apiWithFailover(PATH);
const t1 = report('T1 server all-healthy (200 req)', hits);
assert.ok(t1.min > 0, 'T1 FAIL: some origin got zero requests');
assert.ok(t1.max / t1.min < 2.5, `T1 FAIL: skew too high (max/min=${t1.max}/${t1.min})`);
console.log('T1 PASS - server requests spread across all origins\n');

// T1b: the ORIGIN_PATH_ALLOWLIST gate. A novel path must be admitted to
// round-robin, and a private path must not be. A typo on the single
// '/api/novel/' line would otherwise pin every novel fetch to the main API and
// no other test would fail — that is exactly the regression this pins.
const NOVEL_PATH = '/api/novel/catalog?page=1&limit=24';
const PRIVATE_PATH = '/api/source-status';
const beforeOrigins = { ...hits };
const beforeMain = mainHits;
for (let i = 0; i < 60; i++) await apiWithFailover(NOVEL_PATH);
const novelSpread = ORIGINS.map((o) => (hits[o] ?? 0) - (beforeOrigins[o] ?? 0));
for (const [i, n] of novelSpread.entries()) {
  assert.ok(n > 0, `T1b FAIL: ${NOVEL_PATH} never reached origin ${ORIGINS[i]} — is '/api/novel/' still allowlisted?`);
}
const midMain = mainHits - beforeMain;
const originsAfterNovel = { ...hits };
const beforePrivate = mainHits;
for (let i = 0; i < 60; i++) await apiWithFailover(PRIVATE_PATH);
for (const o of ORIGINS) {
  assert.equal(hits[o], originsAfterNovel[o], `T1b FAIL: ${PRIVATE_PATH} leaked to ${o} — it must stay on the main API`);
}
assert.equal(mainHits - beforePrivate, 60, 'T1b FAIL: a non-allowlisted path must not fan out');
console.log(
  `T1b PASS - allowlist gate: novel spread=${novelSpread.join('/')}, main-hits-during-novel=${midMain}, ` +
  `private path fanned out to 0 origins\n`,
);

// T2: client cursor regression - sessionStorage rotation unchanged
const storage = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v); },
  removeItem: (k: string) => { storage.delete(k); },
};
const seq: string[] = [];
const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (input: any) => {
  const url = String(input);
  const origin = ORIGINS.find((o) => url.startsWith(o));
  if (origin) seq.push(origin);
  return realFetch(input);
};
const clientHits: Record<string, number> = {};
for (let i = 0; i < 12; i++) {
  await apiWithFailover(PATH);
  clientHits[seq[seq.length - 1]] = (clientHits[seq[seq.length - 1]] ?? 0) + 1;
}
// N-agnostik: 12 request rotasi merata → setiap origin ke-cover, selisih
// hit antar-origin ≤ 1 (round-robin murni). Untuk N besar (≥12) tetap valid:
// counts ∈ {floor(12/N), ceil(12/N)}.
for (const o of ORIGINS) {
  assert.ok((clientHits[o] ?? 0) > 0, `T2 FAIL: origin ${o} tidak tersentuh (clientHits=${JSON.stringify(clientHits)})`);
}
const cVals = Object.values(clientHits);
assert.ok(Math.max(...cVals) - Math.min(...cVals) <= 1, `T2 FAIL: spread >1: ${JSON.stringify(clientHits)}`);
assert.ok(seq[0] === ORIGINS[1 % N_ORIGINS], `T2 FAIL: cursor should start at index 1 (prev=null -> 1), got ${seq[0]}`);
for (let i = 0; i < seq.length - 1; i++) {
  assert.ok(seq[i] !== seq[i + 1], 'T2 FAIL: consecutive requests hit the same origin');
}
console.log(`T2 PASS - client cursor rotation: ${seq.slice(0, 8).map((o) => o.replace('https://', '')).join(' ')} ...\n`);

// back to server env
delete (globalThis as any).sessionStorage;

// T3: circuit breaker - open origin skipped before random selection
const W2 = ORIGINS[2];
const w2Baseline = hits[W2] ?? 0;
injectedFails[W2] = 2;
let guard = 0;
while ((hits[W2] ?? 0) < w2Baseline + 1 && guard++ < 500) await apiWithFailover(PATH); // 1st failure
assert.ok((hits[W2] ?? 0) === w2Baseline + 1, 'T3 FAIL: first 500 not delivered');
console.log('T3: first 500 delivered, waiting out 5s soft-open window...');
await new Promise((r) => setTimeout(r, 5200)); // soft-open (5s) expires -> 2nd failure trips 60s open
guard = 0;
while ((hits[W2] ?? 0) < w2Baseline + 2 && guard++ < 500) await apiWithFailover(PATH);
const tripped = hits[W2] ?? 0;
assert.ok(tripped === w2Baseline + 2, `T3 FAIL: breaker not tripped (${W2} got ${tripped - w2Baseline} new hits, expected 2)`);
console.log(`T3 trip: ${W2} +${tripped - w2Baseline} hits, breaker open (60s)`);
for (let i = 0; i < 200; i++) await apiWithFailover(PATH);
assert.ok((hits[W2] ?? 0) === tripped, `T3 FAIL: circuit-open origin still receives requests (total ${hits[W2]})`);
const t3others = ORIGINS.filter((o) => o !== W2).reduce((a, o) => a + (hits[o] ?? 0), 0);
assert.ok(t3others > 0, 'T3 FAIL: no other origin served requests');
console.log('T3 PASS - circuit-open origin skipped, load spread to healthy\n');

// T4: all origins open -> main API fallback, no hard error
const warned: string[] = [];
const origWarn = console.warn;
console.warn = (...args: any[]) => { warned.push(String(args[0])); };
for (const o of ORIGINS) injectedFails[o] = 100;
for (let i = 0; i < 50; i++) {
  const res = await apiWithFailover(PATH);
  assert.ok(res && (res as any).data, 'T4 FAIL: fallback response missing data');
}
console.warn = origWarn;
assert.ok(warned.some((w) => w.includes('all origins circuit-open')), 'T4 FAIL: fallback warning not logged');
console.log('T4 PASS - all-open fallback to main API, warning logged, no hard error');

// T5: image origin picker (imgOriginFor) — hash-stable per path, distribusi
// merata, retry geser worker (failover), eksklusi origin utama (akun-1).
const { imgOriginFor } = await import('../src/lib/api');
const MAIN = 'https://main-api.test'; // = PUBLIC_API_URL (akun-1) — harus dieksklusi
const pool = [...ORIGINS, MAIN].map((url) => ({ url }));
(globalThis as any).sessionStorage = {
  getItem: (k: string) => (k === 'origins' ? JSON.stringify(pool) : null),
  setItem: () => {},
  removeItem: () => {},
};
const seen: Record<string, number> = {};
for (let i = 0; i < 600; i++) {
  const origin = imgOriginFor(`/img/komiku/ch-${i}/1`);
  assert.ok(origin !== MAIN, 'T5 FAIL: main API origin (akun-1) must be excluded');
  seen[origin] = (seen[origin] ?? 0) + 1;
}
assert.ok(
  Object.keys(seen).length === N_ORIGINS,
  `T5 FAIL: expected ${N_ORIGINS} non-main origins, got ${Object.keys(seen).length}`
);
const vals = Object.values(seen);
assert.ok(Math.min(...vals) / Math.max(...vals) > 0.3, 'T5 FAIL: distribution skew too high');
assert.equal(imgOriginFor('/img/komiku/ch-1/1'), imgOriginFor('/img/komiku/ch-1/1'), 'T5 FAIL: same path must map to same origin');
assert.notEqual(imgOriginFor('/img/komiku/ch-1/1', 1), imgOriginFor('/img/komiku/ch-1/1', 0), 'T5 FAIL: retry should shift to another origin');
console.log(`T5 PASS - imgOriginFor: ${N_ORIGINS} origins (main excluded), dist=${JSON.stringify(seen)}, retry shifts\n`);

// T6: the 404-vs-outage boundary. isNotFound() is only as good as the boundary
// that feeds it, and nothing pinned that boundary: reverting api() to a bare
// Error left every other test green while turning an upstream outage into a
// server-side 404 on the novel pages. T4 left every origin circuit-open, so
// these requests fall straight through to the main API — which is exactly the
// api() boundary under test.
const { ApiError, isNotFound } = await import('../src/lib/api');
const NOVEL_CHAPTER_PATH = '/api/novel/series/novelid-x/chapter/novelid-x%2F1';
const probe = async (behaviour: 'ok' | number | 'throw') => {
  mainBehaviour = behaviour;
  try {
    await apiWithFailover(NOVEL_CHAPTER_PATH);
    return { threw: false as const };
  } catch (e) {
    return { threw: true as const, e };
  }
};
// 1. A 404 answer must arrive as ApiError(404), so the page can 404 on it.
const miss = await probe(404);
assert.ok(miss.threw, 'T6 FAIL: a 404 must reject, not resolve with an empty chapter');
assert.ok(miss.e instanceof ApiError, `T6 FAIL: 404 must throw ApiError, got ${miss.e?.constructor?.name}`);
assert.equal((miss.e as { status?: number }).status, 404, 'T6 FAIL: the status must survive to the caller');
assert.equal(isNotFound(miss.e), true, 'T6 FAIL: isNotFound must accept a real 404');

// 2. An outage must NOT look like a 404, or every novel page 404s during one.
const boom = await probe(500);
assert.ok(boom.threw, 'T6 FAIL: a 500 must reject');
assert.ok(boom.e instanceof ApiError);
assert.equal(isNotFound(boom.e), false, 'T6 FAIL: a 500 must not read as a not-found');

const throttled = await probe(429);
assert.equal(isNotFound(throttled.e), false, 'T6 FAIL: a 429 must not read as a not-found');

// 3. A transport failure is not an ApiError at all, and must not 404 either.
const dead = await probe('throw');
assert.ok(dead.threw, 'T6 FAIL: a network failure must reject');
assert.equal(dead.e instanceof ApiError, false, 'T6 FAIL: a network failure is not an ApiError');
assert.equal(isNotFound(dead.e), false, 'T6 FAIL: a network failure must not read as a not-found');

// 4. And the happy path still resolves, or the probe proves nothing.
const ok = await probe('ok');
assert.equal(ok.threw, false, 'T6 FAIL: a healthy novel chapter must resolve');
mainBehaviour = 'ok';
console.log('T6 PASS - 404 → ApiError(404) → isNotFound; 500/429/network → not-found=false\n');

console.log('\nALL TESTS PASSED');
