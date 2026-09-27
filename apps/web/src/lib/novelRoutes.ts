// Pure helpers for the /novel module — no Astro/React imports, so the rules
// that shape the pages stay assertable from `bun test` and reusable from client
// islands.
export const NOVEL_SEGMENT = 'novel';

// The catalogue merges 4 shard windows of MERGE_WINDOW(100) rows, so a page
// beyond offset+limit > 400 answers [] even when `total` claims more. Page
// links stop at the ceiling instead of rendering a blank page.
const CATALOG_MERGE_CEILING = 400;

const segments = (pathname: string): string[] => pathname.split('/').filter((s) => s.length > 0);

// decodeURIComponent throws on a malformed escape; a bad param must 404 through
// the normal path, not blow up the page render.
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export type NovelRoute =
  | { kind: 'not-novel' }
  | { kind: 'catalog' }
  | { kind: 'series'; slug: string }
  | { kind: 'chapter'; slug: string; chapterId: string };

export const resolveNovelRoute = (pathname: string): NovelRoute => {
  const seg = segments(pathname);
  if (seg[0] !== NOVEL_SEGMENT) return { kind: 'not-novel' };
  if (seg.length === 1) return { kind: 'catalog' };
  if (seg.length === 2) return { kind: 'series', slug: safeDecode(seg[1]) };
  if (seg.length === 3) {
    return { kind: 'chapter', slug: safeDecode(seg[1]), chapterId: safeDecode(seg[2]) };
  }
  return { kind: 'not-novel' };
};

export const isNovelPath = (pathname: string): boolean => segments(pathname)[0] === NOVEL_SEGMENT;

export const novelSeriesUrl = (slug: string): string =>
  `/${NOVEL_SEGMENT}/${encodeURIComponent(slug)}`;

// The composite chapter id carries a '/', so the whole thing is one encoded
// segment — never a second path segment.
export const novelChapterUrl = (slug: string, chapterId: string): string =>
  `${novelSeriesUrl(slug)}/${encodeURIComponent(chapterId)}`;

export const novelCatalogUrl = (opts: { page?: number; genre?: string | null } = {}): string => {
  const q = new URLSearchParams();
  if (opts.page && opts.page > 1) q.set('page', String(opts.page));
  if (opts.genre) q.set('genre', opts.genre);
  const qs = q.toString();
  return `/${NOVEL_SEGMENT}${qs ? `?${qs}` : ''}`;
};

export const catalogLastPage = (total: number, limit: number): number => {
  const l = Math.max(1, Math.floor(limit) || 1);
  const merge = Math.max(1, Math.floor(CATALOG_MERGE_CEILING / l));
  return Math.max(1, Math.min(Math.ceil(Math.max(0, total) / l), merge));
};

export const chapterNumberOf = (chapterId: string): number | null => {
  const n = Number(chapterId.slice(chapterId.lastIndexOf('/') + 1));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Row windows are ordered by `number`, so the neighbours are simply the rows either side. */
export const neighbourChapters = <T extends { number: number }>(
  chapters: T[],
  number: number | null,
): { prev: T | null; next: T | null } => {
  if (number === null || chapters.length === 0) return { prev: null, next: null };
  const ordered = [...chapters].sort((a, b) => a.number - b.number);
  return {
    prev: ordered.filter((c) => c.number < number).pop() ?? null,
    next: ordered.find((c) => c.number > number) ?? null,
  };
};

/**
 * Whether to keep walking chapter pages while hunting for `chapterId`.
 *
 * The answer is read off the rows that came back, never off the chapter number:
 * ingest drops every chapter whose body fetch failed or came back blank, so the
 * numbering has guaranteed gaps and a list page is a row-offset window rather
 * than a number range. `Math.ceil(number / limit)` therefore points at the
 * wrong window for exactly the novels long enough to page.
 */
export const shouldFetchNextChapterPage = (
  rows: { source_chapter_id: string }[],
  chapterId: string,
  limit: number,
): boolean => {
  const at = rows.findIndex((c) => c.source_chapter_id === chapterId);
  // Not in this window. A short page is the end of the list, so the chapter is
  // not stored; a full page means keep walking.
  if (at === -1) return rows.length >= limit;
  // Current chapter is the last row of this window: its successor is on the next.
  return at === rows.length - 1;
};

/** genre arrives as a JSON array string; anything else is not a tag list, so `[]`. */
export const parseNovelGenres = (genre: string | null | undefined): string[] => {
  if (!genre) return [];
  try {
    const parsed: unknown = JSON.parse(genre);
    if (Array.isArray(parsed)) return parsed.filter((g): g is string => typeof g === 'string' && g.length > 0);
  } catch {
    return genre.split(',').map((g) => g.trim()).filter(Boolean);
  }
  return [];
};

// ---- Chapter body sanitiser -------------------------------------------------
// Chapter HTML is scraped from a third party, so only prose-level tags survive:
// every attribute is dropped (no href/src/srcset, so no javascript: or data:
// URL context; no style/class; no on* handler) and every text run is escaped.
// Tags outside the allowlist are unwrapped — their text is kept as prose, which
// is what makes the output safe to hand to dangerouslySetInnerHTML.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'em', 'strong', 'i', 'b', 'u', 's', 'hr', 'blockquote',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'sup', 'sub', 'small', 'wbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

// Self-closing: the tag is dropped and scanning continues. These must not be
// treated as containers or an <img> would swallow the rest of the chapter.
const VOID_TAGS = new Set([
  'area', 'base', 'col', 'embed', 'frame', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track',
]);

// Container tags whose payload is executable, resource-loading or non-prose:
// dropped together with everything up to the matching close tag.
const DISCARD_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg',
  'math', 'canvas', 'audio', 'video', 'form', 'button', 'select', 'option',
  'textarea', 'label', 'fieldset', 'title', 'head', 'html', 'body', 'frameset',
  'applet', 'map', 'portal', 'marquee', 'dialog', 'slot',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

// Upstream entities are decoded once, then everything is escaped once. An
// unknown entity is left literal rather than guessed at.
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });

const escapeText = (s: string): string =>
  decodeEntities(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const TAG = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/;

export const sanitizeNovelHtml = (input: string | null | undefined): string => {
  if (!input) return '';
  // Comments first: `<!--` cannot open a tag, so the scanner would otherwise
  // surface the comment body as visible prose.
  const src = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const lower = src.toLowerCase();
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += escapeText(src.slice(i));
      break;
    }
    out += escapeText(src.slice(i, lt));
    const m = TAG.exec(src.slice(lt));
    if (!m) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    i = lt + m[0].length;
    if (ALLOWED_TAGS.has(tag)) {
      out += closing ? `</${tag}>` : `<${tag}>`;
    } else if (VOID_TAGS.has(tag)) {
      continue;
    } else if (DISCARD_TAGS.has(tag)) {
      if (closing) continue;
      // Unclosed → swallow the remainder. Failing closed is the safe direction.
      const end = lower.indexOf(`</${tag}`, i);
      i = end === -1 ? src.length : end;
    }
  }
  return out;
};
