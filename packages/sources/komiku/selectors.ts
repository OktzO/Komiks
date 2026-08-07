// Per-page CSS selectors for Komiku (komiku.org, redesigned).
// Centralized so adding a new source = new selectors file.
export const KOMIKU_SELECTORS = {
  search: {
    container: '.bge',
    link: '.bgei a',
    title: 'h3',
    cover: 'img',
  },
  detail: {
    title: 'h1',
    synopsis: '[itemprop="description"]',
    cover: 'img[itemprop="image"]',
    author: 'td',
    status: 'td',
    type: 'td',
    genreList: '.mgen a',
    chapterList: '#daftarChapter a.judulseries, #Daftar_Chapter a',
    chapterLink: 'a',
    chapterTitle: 'a',
  },
} as const;
