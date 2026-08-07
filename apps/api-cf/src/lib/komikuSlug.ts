// Resolve slug manga dari chapter id Komiku. Format: '<slug>-chapter-<num>'.
export const parseSlugFromChapterId = (chapterId: string): string | null => {
  const m = chapterId.split('-chapter-');
  if (m.length < 2) return null;
  const slug = m[0];
  return slug.length > 0 ? slug : null;
};