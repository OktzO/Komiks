// noveltoon.mobi parsing rules. Every pattern is anchored to a real tag or a URL
// path, never a bare class name — the pages ship inline `<style>` blocks that
// mention the same class names before the markup does.
import { decodeHtmlEntities } from '@manga-platform/shared/entities';
import { NOVELTOON_BASE } from './client.js';

export const NOVELTOON_PATTERNS = {
  detailTitle: /<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bdetail-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
  detailAuthor: /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bweb-author\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  detailSynopsis: /<p\b[^>]*\bclass\s*=\s*["'][^"']*\bdetail-desc-info\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  detailCover: /style\s*=\s*["'][^"']*background-image\s*:\s*url\(([^)"']+)["']?[^>]*>/i,
  card: /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bgenre-item-box\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  cardTitle: /genre-item-title[^>]*>\s*([^<]*)</i,
  cardLabel: /genre-item-label[^>]*>\s*([^<]*)</i,
  cardImage: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i,
  cardSpan: /<span[^>]*>\s*([^<]*)<\/span>/i,
  href: /href\s*=\s*["']([^"']+)["']/i,
  contentId: /content_id=(\d+)/i,
  slugInUrl: /\/id\/([^/?#]+)/,
} as const;

/** Strip inline `<script>`/`<style>`/comment blocks. */
export const stripNoise = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

export const text = (raw: string | undefined): string =>
  (decodeHtmlEntities(raw?.replace(/<[^>]+>/g, '') ?? '') ?? '').trim();

// Card templates ship commented-out alternative markup that would otherwise win
// the first-match race.
export const cardText = (pattern: RegExp, card: string): string => text(pattern.exec(stripNoise(card))?.[1]);

export const stripCoverQuery = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const trimmed = url.trim();
  return trimmed ? trimmed.split('?')[0] || null : null;
};

export const absolute = (href: string): string =>
  /^https?:\/\//i.test(href) ? href : NOVELTOON_BASE + href.replace(/^\/*/, '/').replace(/\/{2,}/g, '/');

export interface ParsedNoveltoonSeries {
  title: string;
  author: string | null;
  synopsis: string | null;
  coverUrl: string | null;
}

export const parseNoveltoonSeriesHtml = (html: string): ParsedNoveltoonSeries => {
  const authorRaw = text(NOVELTOON_PATTERNS.detailAuthor.exec(html)?.[1]);
  const synopsisRaw = text(NOVELTOON_PATTERNS.detailSynopsis.exec(html)?.[1]);
  const coverRaw = NOVELTOON_PATTERNS.detailCover.exec(html)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  return {
    title: text(NOVELTOON_PATTERNS.detailTitle.exec(html)?.[1]),
    author: authorRaw ? authorRaw.replace(/^Nama\s+Author\s*[:：]?\s*/i, '') || null : null,
    synopsis: synopsisRaw ? synopsisRaw.split(/Karya ini diterbitkan atas izin/i)[0].trim() || null : null,
    coverUrl: coverRaw ? stripCoverQuery(absolute(coverRaw)) : null,
  };
};

export interface ParsedNoveltoonCard {
  contentId: string;
  slug: string;
  title: string;
  genres: string[];
  coverUrl: string | null;
}

export const parseNoveltoonListHtml = (html: string): ParsedNoveltoonCard[] => {
  const cards: ParsedNoveltoonCard[] = [];
  for (const m of html.matchAll(NOVELTOON_PATTERNS.card)) {
    const href = NOVELTOON_PATTERNS.href.exec(m[0])?.[1] ?? '';
    const contentId = NOVELTOON_PATTERNS.contentId.exec(href)?.[1] ?? '';
    const slug = NOVELTOON_PATTERNS.slugInUrl.exec(href)?.[1] ?? '';
    const title = cardText(NOVELTOON_PATTERNS.cardTitle, m[1]);
    if (!contentId || !title) continue;
    cards.push({
      contentId,
      slug,
      title,
      // The label cell packs several tags into one pipe-separated string.
      genres: cardText(NOVELTOON_PATTERNS.cardLabel, m[1])
        .split('|')
        .map((g) => g.trim())
        .filter(Boolean),
      coverUrl: stripCoverQuery(NOVELTOON_PATTERNS.cardImage.exec(m[1])?.[1]),
    });
  }
  return cards;
};
