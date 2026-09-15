// Status parsing terpusat utk semua source adapter.
// Aturan: jangan pernah default-kan 'ongoing' — asal label bikin komik tamat/
// tanpa-info terbaca salah. Nilai tak dikenal / kosong → 'unknown' → UI render '-'.
// DB CHECK series.status tidak menerima 'unknown' (upsertSeries men-sanitize).
export type MappedStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

const COMPLETED_RE = /(^|\W)(end|tamat|selesai|completed|complete|finished|tamat)(\W|$)/;
const HIATUS_RE = /(^|\W)(hiatus|on-hold|on hold|paused|drop|discarded)(\W|$)/;
const ONGOING_RE = /(ongoing|berjalan|active|still publishing|belum tamat)/;

export const mapStatusText = (raw: string | null | undefined): MappedStatus => {
  const s = (raw ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (/belum\s*(tamat|selesai)/.test(s)) return 'ongoing';
  if (COMPLETED_RE.test(s)) return 'completed';
  if (HIATUS_RE.test(s)) return 'hiatus';
  if (/(^|\W)cancel(l)?ed?(\W|$)/.test(s)) return 'cancelled';
  if (ONGOING_RE.test(s)) return 'ongoing';
  return 'unknown';
};
