// Source badge: shows the source site logo image instead of plain text.
// Komiku = komiku.org favicon; bacakomik/thrive placeholder (Part 4 refines).
const SOURCE_LOGOS: Record<string, string> = {
  komiku: 'https://komiku.org/asset/img/ico.ico',
  bacakomik: '',
  thrive: '',
};

const SOURCE_LABELS: Record<string, string> = {
  komiku: 'Komiku',
  bacakomik: 'BacaKomik',
  thrive: 'Thrive',
};

const SOURCE_RING: Record<string, string> = {
  komiku: 'ring-blue-500/40',
  bacakomik: 'ring-green-500/40',
  thrive: 'ring-purple-500/40',
};

export function SourceBadge({ sources }: { sources: string[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex gap-1.5 flex-wrap items-center mt-1">
      {sources.map((s) => (
        <span key={s} className="inline-flex items-center gap-1 text-[10px] text-muted">
          {SOURCE_LOGOS[s] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={SOURCE_LOGOS[s]}
              alt={SOURCE_LABELS[s] ?? s}
              width={14}
              height={14}
              className={`h-3.5 w-3.5 rounded-sm ring-1 ${SOURCE_RING[s] ?? 'ring-white/10'} object-contain bg-white/5`}
            />
          ) : null}
          <span>{SOURCE_LABELS[s] ?? s}</span>
        </span>
      ))}
    </div>
  );
}
