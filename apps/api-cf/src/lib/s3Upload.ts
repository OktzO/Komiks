// S3-compatible upload minimal ke R2 (AWS SigV4) — tanpa @aws-sdk (bundle
// Worker 3MB gzip limit, dan bundle ini di-deploy ke banyak akun via
// auto-provision). Cukup untuk PUT object; fitur S3 lain (multipart, dll)
// ditambah belakangan kalau dibutuhkan.
// ponytail: ganti @aws-sdk/client-s3 kalau butuh multipart/list/delete massal.

import type { R2Account } from './r2Accounts.ts';
import { DEFAULT_BUCKET } from './r2Accounts.ts';

const REGION = 'auto';
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
const signingKey = async (secret: string, dateStamp: string): Promise<Uint8Array> => {
  const kDate = await hmac(`AWS4${secret}`, dateStamp);
  const kRegion = await hmac(kDate, REGION);
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
}): Promise<Record<string, string>> => {
  const dateISO = opts.dateISO ?? new Date().toISOString();
  const amzDate = dateISO.replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const path = `/${opts.bucket}/${encodePath(opts.key)}`;
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalHeaders =
    `content-type:${opts.contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;content-type;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))}`;
  const key = await signingKey(opts.secretAccessKey, dateStamp);
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