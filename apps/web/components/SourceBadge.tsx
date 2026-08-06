const SOURCE_LABELS: Record<string, string> = {
  komiku: 'Komiku',
  mangadex: 'MangaDex',
};

const SOURCE_COLORS: Record<string, string> = {
  komiku: 'bg-blue-900 text-blue-200 border-blue-700',
  mangadex: 'bg-orange-900 text-orange-200 border-orange-700',
};

export function SourceBadge({ sources }: { sources: string[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap">
      {sources.map((s) => (
        <span
          key={s}
          className={`text-[10px] px-1.5 py-0.5 rounded border ${SOURCE_COLORS[s] ?? 'bg-gray-800 text-gray-300 border-gray-600'}`}
        >
          {SOURCE_LABELS[s] ?? s}
        </span>
      ))}
    </div>
  );
}
