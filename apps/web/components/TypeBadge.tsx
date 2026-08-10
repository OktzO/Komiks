// Compact type badge for manga/manhwa/manhua — inline pill with distinct accent.
const TYPE_META: Record<string, { label: string; cls: string }> = {
  manga: { label: 'Manga', cls: 'text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary/60 text-secondary' },
  manhwa: { label: 'Manhwa', cls: 'text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success' },
  manhua: { label: 'Manhua', cls: 'text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent' },
};

export function TypeBadge({ type }: { type?: string | null }) {
  if (!type) return null;
  const meta = TYPE_META[type.toLowerCase()] ?? TYPE_META.manga;
  return <span className={meta.cls}>{meta.label}</span>;
}
