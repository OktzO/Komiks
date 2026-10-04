// Setelah gate token-only, tidak boleh ada helper client yang menembak worker
// API secara langsung — semuanya harus same-origin lewat proxy BFF. Token tidak
// pernah sampai ke browser, jadi satu-satunya jalur yang tersisa adalah oktzz.xyz
// sendiri.
//
// Test ini menyimulasikan lingkungan browser (window + sessionStorage ada) dan
// memeriksa dua hal: base URL browser memang kosong, dan tidak ada komponen
// yang masih merakit URL lintas-origin sendiri.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync as readDirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fake browser environment SEBELUM modul diimpor.
const store = new Map<string, string>();
(globalThis as any).window = globalThis;
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const api = await import('../src/lib/api');

test('BROWSER_API_BASE kosong — semua fetch client jadi relative', () => {
  assert.equal(api.BROWSER_API_BASE, '');
});

test('API_URL di browser bernilai kosong, bukan URL worker', () => {
  // Kalau ini bocor ke worker API, setiap fetch client dapat 403 karena tidak
  // membawa token. Ini yang membuat task ini exist.
  assert.equal(api.API_URL, '', 'API_URL di browser masih URL worker');
});

test('sticky-origin auth sudah dihapus — tidak ada lagi yang perlu dispersal', () => {
  // getAuthApiUrl ada hanya karena cookie hidup di domain worker. Sekarang
  // cookie di oktzz.xyz, jadi tidak ada satu pun alasan untuk menyimpan origin
  // auth di sessionStorage.
  assert.equal((api as any).getAuthApiUrl, undefined, 'getAuthApiUrl masih ada');
  assert.equal((api as any).setAuthOrigin, undefined, 'setAuthOrigin masih ada');
});

test('link OAuth Google tidak boleh di-prefetch', () => {
  // Turnstile token single-use: siteverify menolak token yang sudah dipakai
  // dengan 'timeout-or-duplicate'. Astro memakai prefetchAll + strategy hover,
  // jadi hover membakar satu GET /api/auth/google yang memakai token itu, lalu
  // klik aslinya mengirim token yang sama dan login selalu gagal.
  const text = readFileSync(
    fileURLToPath(new URL('../src/components/AuthForm.tsx', import.meta.url)), 'utf8');
  const at = text.indexOf('<a\n            href={googleUrl}');
  assert.ok(at > -1, 'link Google tidak ditemukan');
  const tag = text.slice(at, at + 900);
  assert.ok(
    /data-astro-prefetch="false"/.test(tag),
    'link OAuth tidak punya data-astro-prefetch="false" — hover akan membakar Turnstile token'
  );
});

test('link OAuth Google harus opt-out dari ClientRouter', () => {
  // /api/auth/google membalas 302 ke accounts.google.com. ClientRouter
  // mengintercept klik same-origin sebagai fetch(); begitu responsnya redirect
  // lintas origin, router jatuh ke full-page navigation dan link yang sama
  // dikirim dua kali. Token single-use => request kedua dapat
  // 'timeout-or-duplicate', jadi user melihat JSON error padahal OAuth-nya
  // sudah berjalan. data-astro-reload membuat router mengabaikan link ini.
  const text = readFileSync(
    fileURLToPath(new URL('../src/components/AuthForm.tsx', import.meta.url)), 'utf8');
  const at = text.indexOf('<a\n            href={googleUrl}');
  assert.ok(at > -1, 'link Google tidak ditemukan');
  const tag = text.slice(at, at + 900);
  assert.ok(
    /data-astro-reload/.test(tag),
    'link OAuth tidak punya data-astro-reload — router bisa mengirim request kedua dan menghabiskan token'
  );
});

test('tidak ada komponen client yang memanggil getAuthApiUrl/setAuthOrigin', () => {
  const offenders: string[] = [];
  for (const file of listFiles(new URL('../src/components/', import.meta.url))) {
    if (!file.pathname.endsWith('.tsx')) continue;
    if (/getAuthApiUrl|setAuthOrigin/.test(readFileSync(file, 'utf8'))) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, [], `masih pakai getAuthApiUrl: ${offenders.join(', ')}`);
});

test('AuthForm merakit URL OAuth relatif, bukan dari apiUrl', () => {
  const text = readFileSync(
    fileURLToPath(new URL('../src/components/AuthForm.tsx', import.meta.url)), 'utf8');
  assert.ok(
    !/\$\{apiUrl\}\/api\/auth\/google/.test(text),
    'AuthForm masih merakit URL OAuth dari apiUrl'
  );
  assert.ok(
    /`\/api\/auth\/google\?origin=/.test(text),
    'AuthForm tidak memakai path relative'
  );
});

test('halaman .astro meneruskan apiUrl kosong ke island', () => {
  // ReaderShell/SourceSwitcher membangun URL dari prop apiUrl. Kalau prop-nya
  // masih API_URL (URL worker), fetch client menembak worker secara langsung.
  const offenders: string[] = [];
  for (const file of listFiles(new URL('../src/pages/', import.meta.url))) {
    if (!file.pathname.endsWith('.astro')) continue;
    const text = readFileSync(file, 'utf8');
    if (/apiUrl=\{API_URL\}/.test(text)) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, [], `masih meneruskan apiUrl={API_URL}: ${offenders.join(', ')}`);
});

test('lib/api.ts tidak pernah membangun URL worker di jalur browser', () => {
  const text = readFileSync(
    fileURLToPath(new URL('../src/lib/api.ts', import.meta.url)), 'utf8');
  // Fetch helper client tidak boleh lagi memakai API_URL secara langsung.
  assert.ok(
    !/export const fetchMe[\s\S]*?fetch\(`\$\{API_URL\}/.test(text),
    'fetchMe masih menembak API_URL langsung'
  );
});

function* listFiles(dir: URL): Generator<URL> {
  for (const entry of readDirSync(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) yield* listFiles(url);
    else yield url;
  }
}
