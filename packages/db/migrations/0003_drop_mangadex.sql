-- Hapus data sumber mangadex: series → chapters (CASCADE) → chapter_pages (CASCADE)
-- + bookmarks/reading_history (CASCADE via FK series_slug).
DELETE FROM series WHERE source = 'mangadex';

-- source_health: hapus baris histori mangadex (no FK, manual).
DELETE FROM source_health WHERE source = 'mangadex';