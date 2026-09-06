// Backblaze B2 (S3-compatible / AWS SigV4) upload utilities.
// Minimal: PUT object + presigned GET. Tanpa @aws-sdk agar bundle < 3MB.
// ponytail: tambahkan multipart/list/delete kalau butuh.

const SERVICE = 's3';

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

const hmac = (key: string | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> => {
  const cryptoObj = globalThis.crypto as Crypto;
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return cryptoObj.subtle
    .importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then((k) => cryptoObj.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
};

// derive signing key: HMAC chain (AWS SigV4)
const signingKey = async (secret: string, dateStamp: string, region: string): Promise<Uint8Array> => {
  const kDate = await hmac(`AWS4${secret}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, 'aws4_request');
  return new Uint8Array(kSigning);
};

const encodePath = (key: string): string =>
  key.split('/').map((seg) => encodeURIComponent(seg)).join('/');

// ── Backblaze B2 (S3-compatible) ────────────────────────────────────────────
export interface B2Account {
  name: string;
  bucket: string;
  keyId: string;
  appKey: string;
  region: string;
  host: string;
}

// PUT ke B2 dengan real payload hash.
export const b2PutObject = async (
  b2: B2Account,
  key: string,
  body: ArrayBuffer,
  contentType: string
): Promise<Response> => {
  const dateISO = new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hex(await crypto.subtle.digest('SHA-256', body));
  const path = `/${b2.bucket}/${encodePath(key)}`;

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${b2.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${b2.region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const keyBuf = await signingKey(b2.appKey, dateStamp, b2.region);
  const signature = hex(await hmac(keyBuf, stringToSign));

  const headers: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${b2.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'content-type': contentType,
  };
  return fetch(`https://${b2.host}${path}`, { method: 'PUT', headers, body });
};

// Presigned GET (query auth) — privat bucket tetap bisa diserve langsung ke
// browser. URL valid 7 hari (cache KV chapter 300s ≪ TTL, aman).
export const b2PresignedGet = async (
  b2: B2Account,
  key: string,
  expiresSec = 604800
): Promise<string> => {
  const dateISO = new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const path = `/${b2.bucket}/${encodePath(key)}`;
  const query = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    `X-Amz-Credential=${encodeURIComponent(`${b2.keyId}/${dateStamp}/${b2.region}/${SERVICE}/aws4_request`)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${expiresSec}`,
    'X-Amz-SignedHeaders=host',
  ].join('&');
  const canonicalRequest = `GET\n${path}\n${query}\nhost:${b2.host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const scope = `${dateStamp}/${b2.region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const keyBuf = await signingKey(b2.appKey, dateStamp, b2.region);
  const signature = hex(await hmac(keyBuf, stringToSign));
  return `https://${b2.host}${path}?${query}&X-Amz-Signature=${signature}`;
};

// GET object with header signing (server-side). Same SigV4 chain as the
// presigned path but the credential never leaves the Worker — the browser
// only ever sees the proxied response, never an X-Amz URL.
export const b2GetObject = async (b2: B2Account, key: string): Promise<Response> => {
  const dateISO = new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const path = `/${b2.bucket}/${encodePath(key)}`;
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256("")
  const canonicalHeaders = `host:${b2.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `GET\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${b2.region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const keyBuf = await signingKey(b2.appKey, dateStamp, b2.region);
  const signature = hex(await hmac(keyBuf, stringToSign));
  return fetch(`https://${b2.host}${path}`, {
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${b2.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  });
};

// DELETE object (AWS SigV4). Used by storage eviction.
export const b2DeleteObject = async (b2: B2Account, key: string): Promise<boolean> => {
  const dateISO = new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const path = `/${b2.bucket}/${encodePath(key)}`;
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256("")
  const canonicalHeaders = `host:${b2.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `DELETE\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${b2.region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const keyBuf = await signingKey(b2.appKey, dateStamp, b2.region);
  const signature = hex(await hmac(keyBuf, stringToSign));
  const res = await fetch(`https://${b2.host}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${b2.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  });
  return res.ok || res.status === 204;
};
