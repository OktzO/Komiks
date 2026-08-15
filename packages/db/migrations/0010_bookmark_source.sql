-- Add source attribution to bookmarks so a bookmark can reference the
-- specific source (komiku|bacakomik|thrive|manhwaindo) the user bookmarked.
-- Backward compatible: existing rows get NULL; convention resolves to 'komiku'.
ALTER TABLE bookmarks ADD COLUMN source TEXT;
ALTER TABLE bookmarks ADD COLUMN source_url TEXT;
CREATE INDEX idx_bookmarks_source ON bookmarks (source, created_at DESC);
