import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCoverUrl } from '../src/http.ts';

test('http:// cover di-upgrade ke https:// (mixed content diblokir browser)', () => {
  assert.equal(
    sanitizeCoverUrl('http://kacu.gmbr.pro/uploads/manga-images/s/x/thumbnail.webp'),
    'https://kacu.gmbr.pro/uploads/manga-images/s/x/thumbnail.webp',
  );
});

test('querystring dibuang agar dapat art potret asli', () => {
  assert.equal(
    sanitizeCoverUrl('https://thumbnail.komiku.org/a/b.jpg?resize=450,235&#038;quality=60'),
    'https://thumbnail.komiku.org/a/b.jpg',
  );
  assert.equal(
    sanitizeCoverUrl('https://i2.wp.com/cover.jpg?resize=450,235&quality=60'),
    'https://i2.wp.com/cover.jpg',
  );
  assert.equal(sanitizeCoverUrl('https://cdn.thrive.moe/covers/x.jpg?w=450'), 'https://cdn.thrive.moe/covers/x.jpg');
});

test('URL bersih tidak berubah (idempoten)', () => {
  const clean = 'https://bacakomik.my/wp-content/uploads/2023/10/Komik-321.webp';
  assert.equal(sanitizeCoverUrl(clean), clean);
  assert.equal(sanitizeCoverUrl(sanitizeCoverUrl(clean)), clean);
});

test('fragment dipertahankan', () => {
  assert.equal(sanitizeCoverUrl('http://a.b/c.jpg#frag'), 'https://a.b/c.jpg#frag');
});

test('whitespace dipangkas', () => {
  assert.equal(sanitizeCoverUrl('  https://a.b/c.jpg  '), 'https://a.b/c.jpg');
});

test('input kosong → null', () => {
  assert.equal(sanitizeCoverUrl(null), null);
  assert.equal(sanitizeCoverUrl(undefined), null);
  assert.equal(sanitizeCoverUrl(''), null);
});
