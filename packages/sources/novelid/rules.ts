// novelid.org parsing rules. Every pattern is anchored to a real tag or a URL
// path — never a bare class name, because the page ships a large inline
// `<style>` block that mentions the same class names before the markup does.
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { NOVELID_BASE } from './client.js';

export const NOVELID_PATHS = {
  series: (slug: string): string => `/novel/${slug}/`,
  chapter: (slug: string, n: number | string): string => `/novel/${slug}/bab/${n}/`,
  search: (q: string): string => `/?s=${encodeURIComponent(q)}`,
} as const;

export const NOVELID_PATTERNS = {
  babNumber: /\/bab\/(\d+)\/?/,
  detailTitle: /<(h1|div|p)\b[^>]*\bclass\s*=\s*["'][^"']*\bdetail-title\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i,
  detailAuthor: /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bweb-author\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  detailSynopsis: /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bdetail-desc-info\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  detailCover: /style\s*=\s*["'][^"']*background-image\s*:\s*url\(([^)"']+)["']?[^>]*>/i,
  coverImage: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i,
  episodeItemTitle: /episode-item-title[^>]*>\s*([^<]*)</i,
  genreTitle: /genre-item-title[^>]*>\s*([^<]*)</i,
  genreLabel: /genre-item-label[^>]*>\s*([^<]*)</i,
  // novelid tags the series as finished with a `Tamat` (complete) pseudo-genre.
  finishedMarker: /^tamat$/i,
} as const;

const CHAPTER_CONTAINER = 'watch-chapter-detail';

// Whole-card matches, not string splits on the class name: attribute order
// varies between the search and detail templates (`href` before `class` on
// search cards), so a split would drop the href.
const cardFor = (className: string, tag: string): RegExp =>
  new RegExp(
    `<${tag}\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'gi'
  );

const NOVELID_CARDS = {
  search: cardFor('genre-item-box', 'a'),
  episode: cardFor('episodes-info-a-item', 'a'),
  tag: cardFor('detail-tag-item', 'div'),
} as const;

const attrHref = (tag: string): string => /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';

/** Strip inline `<script>`/`<style>`/comment blocks. */
const stripNoise = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

/**
 * Content of the container div. The open tag is matched in full (class name
 * inside a real `<div …>`), never by bare class name — the page ships a
 * `.watch-chapter-detail{…}` stylesheet rule that an indexOf would hit first.
 * The body is found by balanced-tag scan rather than a non-greedy `</div>` so a
 * future wrapper div inside the prose cannot truncate the chapter.
 */
export const extractContainer = (html: string, className: string): string | null => {
  const open = new RegExp(
    `<div\\b[^>]*\\bclass\\s*=\\s*(?:"[^"]*\\b${className}\\b[^"]*"|'[^']*\\b${className}\\b[^']*')[^>]*>`,
    'i'
  );
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let pos = start;
  while (depth > 0) {
    const next = /<\/?div\b[^>]*>/gi;
    next.lastIndex = pos;
    const tag = next.exec(html);
    if (!tag) return null;
    depth += tag[0][1] === '/' ? -1 : 1;
    pos = tag.index + tag[0].length;
  }
  return html.slice(start, pos - 6);
};

export const parseChapterHtml = (html: string): string | null => {
  const inner = extractContainer(html, CHAPTER_CONTAINER);
  if (inner === null) return null;
  const prose = stripNoise(inner).trim();
  return prose.length > 0 ? prose : null;
};

export const buildSeriesUrl = (slug: string): string => NOVELID_BASE + NOVELID_PATHS.series(slug);

export const buildChapterUrl = (slug: string, n: number | string): string =>
  NOVELID_BASE + NOVELID_PATHS.chapter(slug, n);

/** Bab number out of a chapter URL — the upstream chapter key. */
export const buildChapterSourceId = (url: string): string | null => NOVELID_PATTERNS.babNumber.exec(url)?.[1] ?? null;

/** `?resize=139,184` thumbnails collapse portrait art; the bare path serves full art. */
export const stripCoverQuery = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.split('?')[0] || null;
};

const text = (raw: string | undefined): string =>
  (decodeHtmlEntities(raw?.replace(/<[^>]+>/g, '') ?? '') ?? '').trim();

// Card templates ship commented-out alternative markup (`<p class='genre-item-label'>
// Fantasy</p>`) that would otherwise win the first-match race.
const cardText = (pattern: RegExp, card: string): string => text(pattern.exec(stripNoise(card))?.[1]);

const absolute = (href: string): string =>
  href.startsWith('http') ? href : NOVELID_BASE + href.replace(/^\/*/, '/').replace(/\/{2,}/g, '/');

export interface ParsedNovelidSearchItem {
  slug: string;
  title: string;
  coverUrl: string | null;
  genre: string | null;
}

export const parseSearchHtml = (html: string): ParsedNovelidSearchItem[] => {
  const items: ParsedNovelidSearchItem[] = [];
  for (const m of html.matchAll(NOVELID_CARDS.search)) {
    const href = attrHref(m[0]);
    const slug = href.match(/\/novel\/([^/?#]+)/)?.[1] ?? '';
    const title = cardText(NOVELID_PATTERNS.genreTitle, m[1]);
    if (!slug || !title) continue;
    items.push({
      slug,
      title,
      coverUrl: stripCoverQuery(NOVELID_PATTERNS.coverImage.exec(m[1])?.[1]),
      genre: cardText(NOVELID_PATTERNS.genreLabel, m[1]) || null,
    });
  }
  return items;
};

export interface ParsedNovelidSeries {
  slug: string;
  title: string;
  author: string | null;
  synopsis: string | null;
  coverUrl: string | null;
  genres: string[];
  status: string | null;
  chapterCount: number | null;
}

export const parseSeriesHtml = (html: string, slug: string): ParsedNovelidSeries => {
  const tags: string[] = [];
  for (const m of html.matchAll(NOVELID_CARDS.tag)) {
    const tag = cardText(/<span[^>]*>\s*([^<]*)<\/span>/i, m[1]);
    if (tag) tags.push(tag);
  }
  const authorRaw = text(NOVELID_PATTERNS.detailAuthor.exec(html)?.[1]);
  const synopsisRaw = text(NOVELID_PATTERNS.detailSynopsis.exec(html)?.[1]);
  const coverRaw = NOVELID_PATTERNS.detailCover.exec(html)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  return {
    slug,
    title: text(NOVELID_PATTERNS.detailTitle.exec(html)?.[2]),
    author: authorRaw ? authorRaw.replace(/^Nama\s+Author\s*[:：]?\s*/i, '') || null : null,
    // The disclaimer paragraph shares the container; everything from it on is
    // site boilerplate, not plot.
    synopsis: synopsisRaw ? synopsisRaw.split(/Karya ini diterbitkan atas izin/i)[0].trim() || null : null,
    coverUrl: coverRaw ? stripCoverQuery(absolute(coverRaw)) : null,
    genres: tags,
    status: tags.some((t) => NOVELID_PATTERNS.finishedMarker.test(t)) ? 'completed' : 'ongoing',
    chapterCount: null,
  };
};

export interface ParsedNovelidEpisode {
  number: number;
  title: string | null;
  href: string;
}

export const parseChapterListHtml = (html: string): ParsedNovelidEpisode[] => {
  const episodes: ParsedNovelidEpisode[] = [];
  for (const m of html.matchAll(NOVELID_CARDS.episode)) {
    const href = attrHref(m[0]);
    const number = Number(buildChapterSourceId(href));
    if (!href || !Number.isFinite(number)) continue;
    episodes.push({
      number,
      title: cardText(NOVELID_PATTERNS.episodeItemTitle, m[1]) || null,
      href: absolute(href),
    });
  }
  return episodes;
};
