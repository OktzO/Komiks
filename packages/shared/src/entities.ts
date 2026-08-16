// HTML entity decoding for scraped text fields (titles, alt titles, synopses).
//
// The sources (WordPress blogs like komiku/bacakomik) ship HTML entities in
// their JSON/HTML — e.g. `&#038;` (&), `&#8217;` ('), `&amp;` (&), quotes.
// Web renderers decode them automatically, but our DB stores raw text; search
// index + normalizeTitle (matching) then operate on the raw form — producing
// "weird" titles and failed dedup. Decode at scrape time and backfill existing
// rows (see data-quality spec).

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#039': "'",
  '#39': "'",
  '#038': '&',
  '#038;': '&',
  nbsp: '\u00a0',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bull: '\u2022',
  middot: '\u00b7',
  trade: '\u2122',
  reg: '\u00ae',
  copy: '\u00a9',
  times: '\u00d7',
  deg: '\u00b0',
  eacute: '\u00e9',
  egrave: '\u00e8',
  aacute: '\u00e1',
  agrave: '\u00e0',
  iacute: '\u00ed',
  oacute: '\u00f3',
  uacute: '\u00fa',
  ntilde: '\u00f1',
  ccedil: '\u00e7',
};

/** Decode HTML entities (&amp; &#038; &#8217; …) in a string. Null-safe. */
export const decodeHtmlEntities = (value: string | null | undefined): string | null | undefined => {
  if (!value) return value;
  return value.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|[a-zA-Z]+);?/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const lower = entity.toLowerCase();
    if (NAMED[lower]) return NAMED[lower];
    return match;
  });
};