// Round-robin SSR fix test - verifies apiWithFailover distribution:
//  T1 server: ~uniform spread across origins (no 100%-to-one-origin skew)
//  T2 client: sessionStorage cursor rotation unchanged (no regression)
//  T3 server: circuit-open origin is skipped BEFORE random selection
//  T4 server: all origins open -> falls back to main API, no hard error
// Run: bun apps/web/test/round-robin.test.ts
import assert from 'node:assert/strict';

delete (globalThis as any).sessionStorage; // server-like env initially
delete (globalThis as any).window;

const ORIGINS = ['https://w0.test', 'https://w1.test', 'https://w2.test', 'https://w3.test'];
const hits: Record<string, number> = {};
const injectedFails: Record<string, number> = {}; // origin -> remaining 500s to inject

(globalThis as any).fetch = async (input: any) => {
  const url = String(input);
  if (url.endsWith('/api/origins')) {
    return new Response(JSON.stringify({ data: ORIGINS.map((url) => ({ url })) }));
  }
  const origin = ORIGINS.find((o) => url.startsWith(o));
  if (!origin) {
    // main API fallback (separate host, always healthy)
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
assert.deepEqual(clientHits, { 'https://w0.test': 3, 'https://w1.test': 3, 'https://w2.test': 3, 'https://w3.test': 3 });
assert.ok(seq[0] === ORIGINS[1], `T2 FAIL: cursor should start at index 1 (prev=null -> 1), got ${seq[0]}`);
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
assert.ok(Object.keys(seen).length === 4, `T5 FAIL: expected 4 non-main origins, got ${Object.keys(seen).length}`);
const vals = Object.values(seen);
assert.ok(Math.min(...vals) / Math.max(...vals) > 0.3, 'T5 FAIL: distribution skew too high');
assert.equal(imgOriginFor('/img/komiku/ch-1/1'), imgOriginFor('/img/komiku/ch-1/1'), 'T5 FAIL: same path must map to same origin');
assert.notEqual(imgOriginFor('/img/komiku/ch-1/1', 1), imgOriginFor('/img/komiku/ch-1/1', 0), 'T5 FAIL: retry should shift to another origin');
console.log(`T5 PASS - imgOriginFor: 4 origins (main excluded), dist=${JSON.stringify(seen)}, retry shifts\n`);
(globalThis as any).sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

console.log('\nALL TESTS PASSED');
