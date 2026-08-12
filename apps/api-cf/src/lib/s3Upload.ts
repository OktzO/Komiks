// S3-compatible upload minimal ke R2 (AWS SigV4) — tanpa @aws-sdk (bundle
// Worker 3MB gzip limit, dan bundle ini di-deploy ke banyak akun via
// auto-provision). Cukup untuk PUT object; fitur S3 lain (multipart, dll)
// ditambah belakangan kalau dibutuhkan.
// ponytail: ganti @aws-sdk/client-s3 kalau butuh multipart/list/delete massal.

import type { R2Account } from './r2Accounts.ts';
import { DEFAULT_BUCKET } from './r2Accounts.ts';

const R2_REGION = 'auto';
const SERVICE = 's3';

const hmac = (key: string | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> => {
  const cryptoObj = globalThis.crypto as Crypto;
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return cryptoObj.subtle
    .importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then((k) => cryptoObj.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
};

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

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

export const s3SignedHeaders = async (opts: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  contentType: string;
  dateISO?: string;
  region?: string;
  payloadHash?: string;
}): Promise<Record<string, string>> => {
  const dateISO = opts.dateISO ?? new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = opts.region ?? R2_REGION;
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const path = `/${opts.bucket}/${encodePath(opts.key)}`;
  const payloadHash = opts.payloadHash ?? 'UNSIGNED-PAYLOAD';

  const canonicalHeaders =
    `content-type:${opts.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const key = await signingKey(opts.secretAccessKey, dateStamp, region);
  const signature = hex(await hmac(key, stringToSign));

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'content-type': opts.contentType,
    Host: host,
  };
};

// Upload stream/bytes ke R2 bucket milik akun lain. Pakai UNSIGNED-PAYLOAD
// supaya body bisa di-stream tanpa buffer penuh di memori (128MB limit).
export const s3PutObject = async (
  account: R2Account,
  key: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string
): Promise<Response> => {
  const bucket = account.bucket ?? DEFAULT_BUCKET;
  const headers = await s3SignedHeaders({
    accountId: account.account_id,
    accessKeyId: account.access_key_id,
    secretAccessKey: account.secret_access_key,
    bucket,
    key,
    contentType,
  });
  return fetch(`https://${headers.Host}/${bucket}/${encodePath(key)}`, {
    method: 'PUT',
    headers,
    body,
  });
};

// ── Backblaze B2 (S3-compatible) ────────────────────────────────────────────
export interface B2Account {
  bucket: string;
  keyId: string;
  appKey: string;
  region: string; // contoh: us-east-005
  host: string;   // s3.<region>.backblazeb2.com
}

const b2Hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

// PUT ke B2 dengan real payload hash (B2 terima UNSIGNED-PAYLOAD juga, tapi
// hash nyata paling kompatibel). Body selalu ArrayBuffer di cache-aside
// (gambar chapter kecil, buffer aman di limit 128MB).
export const b2PutObject = async (
  b2: B2Account,
  key: string,
  body: ArrayBuffer,
  contentType: string
): Promise<Response> => {
  const dateISO = new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = b2Hex(await crypto.subtle.digest('SHA-256', body));
  const path = `/${b2.bucket}/${encodePath(key)}`;

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${b2.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${b2.region}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${b2Hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const keyBuf = await signingKey(b2.appKey, dateStamp, b2.region);
  const signature = b2Hex(await hmac(keyBuf, stringToSign));

  const headers: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${b2.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'content-type': contentType,
  };
  return fetch(`https://${b2.host}${path}`, { method: 'PUT', headers, body });
};

// Presigned GET (query auth) — privat bucket tetap bisa diserve langsung ke
// browser tanpa worker di request berikutnya. URL valid 7 hari (cache KV
// chapter 300s ≪ TTL, aman).
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
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${b2Hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const keyBuf = await signingKey(b2.appKey, dateStamp, b2.region);
  const signature = b2Hex(await hmac(keyBuf, stringToSign));
  return `https://${b2.host}${path}?${query}&X-Amz-Signature=${signature}`;
};
