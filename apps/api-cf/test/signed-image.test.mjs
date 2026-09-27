import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signImgPath, verifyImgSig } from '../src/lib/signedImage.ts';
import { constantTimeEqualStr } from '../src/lib/auth.ts';

// ── HMAC short-lived signed image URLs (anti-scraping /img) ───────────────
// signImgPath/verifyImgSig murni + deterministik; pakai WebCrypto (node:crypto
// webcrypto) + constantTimeEqualStr dari lib/auth. TTL produksi = 1500s (25
// menit), grace verify = 60s — dipakai sama di bawah.

const SECRET = 'test-signed-img-secret';
const NOW = 1_700_000_000;
const TTL = 1500;
const GRACE = 60;
const PATH = '/img/komiku/1234/1';

test('sign → verify lolos dengan secret/path/exp sama (dalam grace)', async () => {
  const { exp, sig } = await signImgPath(SECRET, PATH, TTL, NOW);
  assert.equal(exp, NOW + TTL);
  assert.match(sig, /^[0-9a-f]{64}$/); // hex HMAC-SHA256 (32 byte)
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, NOW, GRACE), true);
  // masih dalam window grace menjelang kedaluwarsa
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, exp + GRACE - 1, GRACE), true);
});

test('sig dimanipulasi / secret salah / exp diganti / path beda → gagal', async () => {
  const { exp, sig } = await signImgPath(SECRET, PATH, TTL, NOW);
  const tamperedSig = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  assert.equal(await verifyImgSig(SECRET, PATH, exp, tamperedSig, NOW, GRACE), false);
  assert.equal(await verifyImgSig('wrong-secret', PATH, exp, sig, NOW, GRACE), false);
  assert.equal(await verifyImgSig(SECRET, PATH, exp + 1, sig, NOW, GRACE), false); // exp beda → HMAC beda
  assert.equal(await verifyImgSig(SECRET, `${PATH}x`, exp, sig, NOW, GRACE), false); // path beda
});

test('lewat grace → gagal; tepat di batas → lolos; jauh kedaluwarsa → gagal', async () => {
  const { exp, sig } = await signImgPath(SECRET, PATH, TTL, NOW);
  // batas bawah: exp >= now - grace → lolos di boundary (exp + GRACE)
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, exp + GRACE, GRACE), true);
  // lewat 1 detik dari boundary → gagal
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, exp + GRACE + 1, GRACE), false);
  // sudah lama kedaluwarsa
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, exp + 3600, GRACE), false);
  // signature lama yang di-replay bertahun-tahun kemudian
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, exp + 999999999, GRACE), false);
});

test('secret kosong → verify selalu false (tak ada yang bisa lolos)', async () => {
  const { exp, sig } = await signImgPath(SECRET, PATH, TTL, NOW);
  assert.equal(await verifyImgSig('', PATH, exp, sig, NOW, GRACE), false);
  assert.equal(await verifyImgSig('', PATH, exp, '', NOW, GRACE), false);
});

test('exp invalid (non-integer / negatif / string sampah) → gagal', async () => {
  const { exp, sig } = await signImgPath(SECRET, PATH, TTL, NOW);
  assert.equal(sig.length, 64);
  for (const badExp of [NaN, 1.5, 0, -1, 'abc', '']) {
    assert.equal(await verifyImgSig(SECRET, PATH, badExp, sig, NOW, GRACE), false, `exp=${String(badExp)}`);
  }
});

test('round-trip encoded chapterId + ?retry=2 — pathname yang di-sign = yang dikirim browser', async () => {
  // chapterId ber-spasi → encodeURIComponent saat mint (reader.ts reader detail)
  const chapterId = 'chapter id';
  const encoded = encodeURIComponent(chapterId); // 'chapter%20id'
  assert.equal(encoded, 'chapter%20id');
  const mintPath = `/img/komiku/${encoded}/5`;
  const { exp, sig } = await signImgPath(SECRET, mintPath, TTL, NOW);

  // Browser mengirim URL signed + `?retry=2` (query kedua setelah ? pertama).
  const browserUrl = new URL(`http://localhost${mintPath}?exp=${exp}&sig=${sig}&retry=2`);
  // c.req.path (Hono) = RAW pathname encoded, tanpa query — persis yang di-sign.
  const rawPath = browserUrl.pathname;
  assert.equal(rawPath, mintPath);
  assert.equal(await verifyImgSig(SECRET, rawPath, exp, sig, NOW, GRACE), true);

  // Ganti retry (worker failover: ?retry=3) → pathname tetap sama → sig tetap valid.
  browserUrl.searchParams.set('retry', '3');
  assert.equal(
    await verifyImgSig(
      SECRET,
      browserUrl.pathname,
      Number(browserUrl.searchParams.get('exp')),
      browserUrl.searchParams.get('sig') ?? '',
      NOW,
      GRACE
    ),
    true
  );

  // Pathname dengan encoding literal/spasi ('chapter id' bukan '%20') → sig tidak cocok.
  assert.equal(await verifyImgSig(SECRET, `/img/komiku/${chapterId}/5`, exp, sig, NOW, GRACE), false);
});

test('implementasi memakai constantTimeEqualStr dari lib/auth (bukan === biasa)', async () => {
  // Helper yang sama dipakai signedImage.verifyImgSig; panjang beda → false tanpa throw.
  assert.equal(constantTimeEqualStr('aabb', 'aabb'), true);
  assert.equal(constantTimeEqualStr('aabb', 'aabbcc'), false);
  const { exp, sig } = await signImgPath(SECRET, PATH, TTL, NOW);
  assert.equal(await verifyImgSig(SECRET, PATH, exp, sig, NOW, GRACE), constantTimeEqualStr(sig, sig));
});