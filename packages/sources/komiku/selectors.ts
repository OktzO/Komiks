// Per-page CSS selectors for Komiku (WordPress-based manga site).
// Centralized so adding a new source = new selectors file.
export const KOMIKU_SELECTORS = {
  search: {
    container: '.listupd .bs',
    link: 'a',
    title: '.tt',
    cover: 'img',
  },
  detail: {
    title: 'h1.entry-title',
    synopsis: '.entry-content[itemprop="description"], .sinopsis p',
    cover: '.thumb img, .series-thumb img',
    author: '.fmed li:contains("Author") b, .mcs a:first',
    status: '.imptdt:contains("Status") i',
    type: '.imptdt:contains("Type") i',
    genreList: '.mgen a',
    chapterList: '#chapter_list li, .lch a',
    chapterLink: 'a',
    chapterTitle: 'a',
  },
} as const;
