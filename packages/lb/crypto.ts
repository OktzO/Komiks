// AES-GCM token encryption via Web Crypto (crypto.subtle).
// No deps. Token plaintext never persisted; only iv+ciphertext+tag BLOB stored.
//
// Layout of the returned Uint8Array: [ 12-byte iv | ciphertext+tag ].
// The GCM tag is appended to the ciphertext by subtle.encrypt by default.

const IV_LEN = 12;

export const deriveKey = async (encKey: string): Promise<CryptoKey> => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encKey));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
};

const asBytes = (input: string | Uint8Array): Uint8Array =>
  typeof input === 'string' ? new TextEncoder().encode(input) : input;

export const encryptToken = async (
  encKey: string,
  plaintext: string | Uint8Array
): Promise<Uint8Array> => {
  const key = await deriveKey(encKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, asBytes(plaintext) as unknown as BufferSource);
  const out = new Uint8Array(IV_LEN + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_LEN);
  return out;
};

export const decryptToken = async (
  encKey: string,
  data: Uint8Array
): Promise<string> => {
  if (data.byteLength < IV_LEN + 1) throw new Error('lb/crypto: ciphertext too short');
  const key = await deriveKey(encKey);
  const iv = data.slice(0, IV_LEN);
  const ct = data.slice(IV_LEN);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
};
