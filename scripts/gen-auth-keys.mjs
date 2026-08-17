// Generate per-worker ECDSA P-256 auth keys (Opsi 3: asymmetric session signing).
// Usage: node scripts/gen-auth-keys.mjs
// Output:
//   - <repo>/apps/api-cf/.auth-keys.json (private — gitignored via *.json? no: see .gitignore)
//   - prints AUTH_PUBLIC_KEYS ([vars] value for all wrangler tomls)
import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const crypto = webcrypto;
const workers = ['manga-api', 'manga-api-2', 'manga-api-3', 'manga-api-4'];

const out = { generated_at: new Date().toISOString(), workers: {} };
const pub = [];

for (const name of workers) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const kid = name;
  out.workers[name] = { kid, key: priv };
  pub.push({ kid, key: pubJwk });
  console.error(`[gen] ${name}: kid=${kid}`);
}

// Private signing keys — local only. File is gitignored (.auth-keys.json).
writeFileSync('apps/api-cf/.auth-keys.json', JSON.stringify(out, null, 2));
// Public keys — safe to commit; goes into [vars] AUTH_PUBLIC_KEYS on all tomls.
console.log(JSON.stringify(pub));
