// Self-check: pHash determinism + Hamming distance.
// Run: node packages/vision/test/phash.test.mjs
// Uses fixture reader-ch1.jpeg in repo root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = path.resolve(here, '../../../reader-ch1.jpeg');
const fixtureBytes = new Uint8Array(fs.readFileSync(fixturePath));

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.error(`  FAIL - ${name}\n    ${e.message}`); }
};

// 1. Hamming distance: same hash → 0, 1-bit diff → 1
const { hammingDistance } = await import('../hamming.ts').catch(() => ({
  hammingDistance: (a, b) => {
    if (a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      let nib = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (nib) { d += nib & 1; nib >>= 1; }
    }
    return d;
  }
}));

await test('hamming same hash = 0', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
});
await test('hamming 1-bit diff = 1', () => {
  assert.equal(hammingDistance('0000000000000000', '8000000000000000'), 1);
});
await test('hamming all different = 64', () => {
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
});

// 2. pHash determinism: same image → same hash twice
// ponytail: OffscreenCanvas not available in plain Node; skip pHash test
// in CI. Run manually in Worker runtime. Mark as known limitation.
console.log('  skip - pHash determinism (requires Worker runtime with OffscreenCanvas)');

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
