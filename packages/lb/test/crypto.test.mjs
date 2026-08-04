// Self-check: AES-GCM roundtrip + tamper rejection via Web Crypto.
// Run: node packages/lb/test/crypto.test.mjs
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// @cloudflare/workers-types expects globalThis.crypto; Node 20+ already exposes it.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { deriveKey, encryptToken, decryptToken } = await import('../crypto.ts');

const ENC = 'test-encryption-key-very-secret';

// 1. roundtrip: encrypt then decrypt returns original plaintext.
{
  const pt = 'super-secret-cf-token-XYZ';
  const ct = await encryptToken(ENC, pt);
  assert.ok(ct instanceof Uint8Array, 'encrypt returns Uint8Array');
  assert.ok(ct.byteLength >= 12 + pt.length, 'ct includes iv + ciphertext+tag');
  const back = await decryptToken(ENC, ct);
  assert.equal(back, pt, 'roundtrip restores plaintext');
  console.log('ok 1 roundtrip');
}

// 2. distinct iv per call (randomness).
{
  const a = await encryptToken(ENC, 'x');
  const b = await encryptToken(ENC, 'x');
  assert.notDeepEqual([...a.slice(0, 12)], [...b.slice(0, 12)], 'iv is random');
  console.log('ok 2 iv randomness');
}

// 3. tamper rejection: flipping a ciphertext byte must fail decrypt.
{
  const pt = 'tamper-me';
  const ct = await encryptToken(ENC, pt);
  ct[12] ^= 0x01; // flip first ciphertext byte
  await assert.rejects(() => decryptToken(ENC, ct), /OperationError|Cipher|decrypt/i, 'tamper throws');
  console.log('ok 3 tamper reject');
}

// 4. wrong key rejection: decrypt with different key must fail.
{
  const pt = 'wrong-key-case';
  const ct = await encryptToken(ENC, pt);
  await assert.rejects(() => decryptToken('other-key', ct), /OperationError|Cipher|decrypt/i, 'wrong key throws');
  console.log('ok 4 wrong-key reject');
}

// 5. Uint8Array input accepted alongside string.
{
  const bytes = new TextEncoder().encode('bytes-input');
  const ct = await encryptToken(ENC, bytes);
  const back = await decryptToken(ENC, ct);
  assert.equal(back, 'bytes-input', 'Uint8Array input roundtrips');
  console.log('ok 5 Uint8Array input');
}

console.log('ALL PASS');
