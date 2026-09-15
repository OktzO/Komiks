// Sistem status: sumber bilang tamat → 'completed' (UI "End"); sumber tidak
// punya info → 'unknown' (UI "-"). Jangan pernah default 'ongoing'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStatusText } from '@manga-platform/shared/status';
import { komikuAdapter } from '../komiku/index.ts';
import { bacakomikAdapter } from '../bacakomik/index.ts';

test('mapStatusText: known values', () => {
  assert.equal(mapStatusText('Ongoing'), 'ongoing');
  assert.equal(mapStatusText('End'), 'completed');
  assert.equal(mapStatusText('Completed'), 'completed');
  assert.equal(mapStatusText('Selesai'), 'completed');
  assert.equal(mapStatusText('Tamat'), 'completed');
  assert.equal(mapStatusText('Belum Tamat'), 'ongoing');
  assert.equal(mapStatusText('Hiatus'), 'hiatus');
  assert.equal(mapStatusText('On Hiatus'), 'hiatus');
  assert.equal(mapStatusText('Cancelled'), 'cancelled');
});

test('mapStatusText: missing/garbage → unknown (BUKAN ongoing)', () => {
  assert.equal(mapStatusText(null), 'unknown');
  assert.equal(mapStatusText(''), 'unknown');
  assert.equal(mapStatusText('   '), 'unknown');
  assert.equal(mapStatusText('?'), 'unknown');
  assert.equal(mapStatusText('N/A'), 'unknown');
});

const komikuDetail = (statusCell) => `
<html>
<head>
  <meta property="og:image" content="https://img.komiku.org/foo.jpg" />
  <span itemprop="name">Test Series</span>
  <div itemprop="description">Syn.</div>
</head>
<body>
  <td>Author:</td><td>X</td>
  ${statusCell}
  <td>Tipe:</td><td>Manga</td>
  <a href="/test-series-chapter-1/" title="Baca Test Series Chapter 1">Ch 1</a>
</body>
</html>
`;

const stubFetch = (html) => {
  const orig = global.fetch;
  global.fetch = () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  return () => { global.fetch = orig; };
};

test('komiku detail: Status End → completed', async () => {
  const restore = stubFetch(komikuDetail('<td>Status:</td><td>End</td>'));
  try {
    const { series } = await komikuAdapter().getSeriesDetail('test-series');
    assert.equal(series.status, 'completed');
  } finally { restore(); }
});

test('komiku detail: tanpa baris Status → unknown (bukan ongoing)', async () => {
  const restore = stubFetch(komikuDetail(''));
  try {
    const { series } = await komikuAdapter().getSeriesDetail('test-series');
    assert.equal(series.status, 'unknown');
  } finally { restore(); }
});

const bacaDetail = (statusValue) => `
<html>
<head><meta property="og:image" content="https://x/y.jpg" /></head>
<body>
  <h1 class="entry-title">Komik Test Serie</h1>
  <div class="entry-content">Syn.</div>
  <span><b>Status:</b> ${statusValue}</span>
  <span><b>Jenis Komik:</b> Manga</span>
  <div class="chapter-list"><ul>
    <li><a href="/komik/test-serie-chapter-1/" <span>Ch 1</span></a></li>
  </ul></div>
</body>
</html>
`;

test('bacakomik detail: Selesai → completed; kosong → unknown', async () => {
  let restore = stubFetch(bacaDetail('Selesai'));
  try {
    const { series } = await bacakomikAdapter().getSeriesDetail('test-serie');
    assert.equal(series.status, 'completed');
  } finally { restore(); }
  restore = stubFetch(bacaDetail(''));
  try {
    const { series } = await bacakomikAdapter().getSeriesDetail('test-serie');
    assert.equal(series.status, 'unknown');
  } finally { restore(); }
});
