const state = { status: 'ok', source: 'local', observedAt: 1000, errorCode: null };

export const peerInventoryFixture = (over = {}) => ({
  topologyHash: 'abc',
  self: false,
  account: { id: 'acct-1', name: 'Oktz', type: 'standard', state },
  worker: { name: 'manga-api', createdAt: null, modifiedAt: null, state },
  d1: {
    id: 'd1-1', name: 'manga-db', fileBytes: null, jurisdiction: null, region: null,
    counts: { series: 1, chapters: 2, chapterPages: 3, users: 4, bookmarks: 5 }, state,
  },
  kv: {
    id: 'kv-1', title: 'CACHE_KV', jurisdiction: null,
    keyCount: null, byteCount: null, operationalD1Bytes: null, state,
  },
  lb: { account: null, origins: [] },
  ...over,
});
