// Type shim untuk `import { webcrypto } from 'node:crypto'`.
// @types/node tidak di-load (tsconfig pakai `types: ["@cloudflare/workers-types"]`),
// sehingga module `node:crypto` tidak punya deklarasi — padahal runtime menyediakan
// `webcrypto` (WebCrypto) baik di Workers (nodejs_compat) maupun Node >= 19.
// Memetakan ke global `Crypto` (workers-types) yang API-nya identik (crypto.subtle).
declare module 'node:crypto' {
  export const webcrypto: Crypto;
}