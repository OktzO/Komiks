// Type badge with country flag: manga/manhwa/manhua.
// Border hitam, text putih bercahaya (glow), posisi kanan-bawah pojok cover.
export const TYPE_META: Record<string, { label: string; flag: string }> = {
  manga: { label: 'Manga', flag: '🇯🇵' },
  manhwa: { label: 'Manhwa', flag: '🇰🇷' },
  manhua: { label: 'Manhua', flag: '🇨🇳' },
};

export function TypeBadge({ type }: { type?: string | null }) {
  if (!type) return null;
  const meta = TYPE_META[type.toLowerCase()] ?? TYPE_META.manga;
  return (
    <span className="type-badge-glow inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded">
      <span aria-hidden="true">{meta.flag}</span>
      <span>{meta.label}</span>
    </span>
  );
}
