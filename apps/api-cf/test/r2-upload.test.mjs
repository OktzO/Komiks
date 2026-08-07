import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseR2Accounts } from '../src/lib/r2Accounts.ts';
import { s3SignedHeaders } from '../src/lib/s3Upload.ts';

const validJson = JSON.stringify([
  { account_id: 'acc1', access_key_id: 'AK1', secret_access_key: 'SK1', public_domain: 'cdn1.example.com' },
  { account_id: 'acc2', access_key_id: 'AK2', secret_access_key: 'SK2', public_domain: 'cdn2.example.com', bucket: 'custom-bucket' },
]);

test('parseR2Accounts valid', () => {
  const accs = parseR2Accounts(validJson);
  assert.equal(accs.length, 2);
  assert.equal(accs[0].public_domain, 'cdn1.example.com');
  assert.equal(accs[1].bucket, 'custom-bucket');
  assert.equal(accs[0].bucket, 'manga-images');
});

test('parseR2Accounts undefined → []', () => {
  assert.deepEqual(parseR2Accounts(undefined), []);
});

test('parseR2Accounts empty string → []', () => {
  assert.deepEqual(parseR2Accounts(''), []);
});

test('parseR2Accounts invalid JSON throws', () => {
  assert.throws(() => parseR2Accounts('not-json'), /invalid R2_ACCOUNTS/);
});

test('parseR2Accounts missing field throws', () => {
  assert.throws(() => parseR2Accounts('[{"account_id":"a"}]'), /missing field/);
});

test('s3SignedHeaders deterministic + structure', async () => {
  const opts = {
    accountId: 'acc1', accessKeyId: 'AK1', secretAccessKey: 'SK1',
    bucket: 'manga-images', key: 'komiku/naruto/naruto-chapter-1/1', contentType: 'image/jpeg',
  };
  const h1 = await s3SignedHeaders(opts);
  const h2 = await s3SignedHeaders(opts);
  assert.deepEqual(h1, h2, 'same inputs → same headers');
  assert.match(h1.Authorization, /^AWS4-HMAC-SHA256 Credential=AK1\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(h1['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.ok(h1['x-amz-date'], 'has x-amz-date');
  assert.ok(h1.Host.startsWith('acc1.r2.cloudflarestorage.com'), `host ${h1.Host}`);
  assert.match(h1.Authorization, /Signature=[0-9a-f]{64}$/, 'signature 64 hex');
});

test('s3SignedHeaders fixed date iso format', async () => {
  const h = await s3SignedHeaders({
    accountId: 'acc1', accessKeyId: 'AK1', secretAccessKey: 'SK1',
    bucket: 'b', key: 'k/1', contentType: 'image/png',
    dateISO: '2026-08-07T10:00:00.000Z',
  });
  assert.equal(h['x-amz-date'], '20260807T100000Z');
  assert.match(h.Authorization, /Credential=AK1\/20260807\/auto\/s3\/aws4_request/);
});