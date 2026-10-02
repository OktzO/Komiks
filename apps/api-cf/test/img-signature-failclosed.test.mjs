// /img setelah gate /api dikunci tidak lagi bisa jadi pintu belakang scraper.
// Sebelumnya SIGNED_IMG_SECRET unset → terima semua + warning (fail-open).
// Sekarang unset → 403.
//
// Dev lokal dilindungi oleh SIGNED_IMG_SECRET di .dev.vars, bukan oleh
// kelonggaran produksi — jadi test ini juga mengunci escape hatch itu, supaya
// fail-closed tidak mematikan semua gambar di mesin development.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signImgPath, verifyImgSig } from '../src/lib/signedImage.ts';

const READER = new URL('../src/routes/reader.ts', import.meta.url);
const readerSource = readFileSync(fileURLToPath(READER), 'utf8');

const NOW = 1_700_000_000;
const SECRET = 'a'.repeat(64);

// signature yang benar-benar valid, untuk membuktikan penolakan bukan karena sig
// salah melainkan karena secret tidak ada.
const { exp, sig } = await signImgPath(SECRET, '/img/komiku/x/1', 1500, NOW);

test('source: hasValidImgSignature tidak punya cabang fail-open', () => {
  const start = readerSource.indexOf('const hasValidImgSignature');
  assert.ok(start > -1, 'hasValidImgSignature tidak ditemukan');
  const end = readerSource.indexOf('\n};', start);
  const fn = readerSource.slice(start, end);
  assert.ok(
    !/if\s*\(\s*!secret\s*\)[\s\S]*return true/.test(fn),
    'masih ada fail-open: secret kosong → return true'
  );
  // Secret kosong harus menolak, bukan menerima.
  assert.ok(
    /if\s*\(\s*!secret\s*\)\s*return false/.test(fn),
    'secret kosong tidak langsung return false'
  );
});

test('source: warning "belum di-set" untuk /img sudah dihapus', () => {
  assert.ok(!/warnedSignedImgUnset/.test(readerSource), 'warnedSignedImgUnset masih ada');
});

test('verifyImgSig menolak apa pun saat secret kosong — signature valid sekalipun', async () => {
  // Inilah yang membuat fail-closed di hasValidImgSignature cukup sederhana:
  // secret kosong = tidak ada yang bisa diverifikasi.
  assert.equal(await verifyImgSig('', '/img/komiku/x/1', exp, sig, NOW, 60), false);
  assert.equal(await verifyImgSig('', '/img/komiku/x/1', NaN, '', NOW, 60), false);
  assert.equal(await verifyImgSig('', '/img/komiku/x/1', NOW + 600, 'deadbeef', NOW, 60), false);
});

test('verifyImgSig tetap benar saat secret ada', async () => {
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/1', exp, sig, NOW, 60), true);
  // Signature tidak bisa dipakai ulang untuk path lain.
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/2', exp, sig, NOW, 60), false);
  // Expired di luar grace → tolak.
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/1', exp, sig, exp + 61, 60), false);
  // Masih dalam grace → terima (clock skew antar worker).
  assert.equal(await verifyImgSig(SECRET, '/img/komiku/x/1', exp, sig, exp + 30, 60), true);
});

test('.dev.vars punya escape hatch supaya dev lokal tidak kehilangan semua gambar', () => {
  const devVars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  assert.ok(/^SERVICE_TOKEN=.+/m.test(devVars), '.dev.vars tidak punya SERVICE_TOKEN terisi');
  assert.ok(
    /^SIGNED_IMG_SECRET=.+/m.test(devVars),
    '.dev.vars tidak punya SIGNED_IMG_SECRET terisi — /img akan 403 semua di dev'
  );
});

test('.dev.vars.example mendokumentasikan kedua secret itu', () => {
  const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
  assert.ok(/^SERVICE_TOKEN=/m.test(example), '.dev.vars.example tidak menyebut SERVICE_TOKEN');
  assert.ok(
    /^SIGNED_IMG_SECRET=/m.test(example),
    '.dev.vars.example tidak menyebut SIGNED_IMG_SECRET'
  );
});
