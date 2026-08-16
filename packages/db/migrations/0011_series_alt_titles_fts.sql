-- Alt-titles search support (data-quality rework):
-- 1. Rebuild series_search FTS5 with an alt_titles column so search hits
--    both canonical and alternative titles.
-- 2. Backfill any series rows missing (entity-decode happens app-side).
-- Triggers are recreated to keep alt_titles synced.

-- Triggers must be dropped before the virtual table (SQLite keeps triggers
-- referencing a dropped table, and subsequent series INSERT would fail).
DROP TRIGGER IF EXISTS series_search_ai;
DROP TRIGGER IF EXISTS series_search_ad;
DROP TRIGGER IF EXISTS series_search_au;
DROP TABLE IF EXISTS series_search;

CREATE VIRTUAL TABLE series_search USING fts5 (
  title,
  description,
  alt_titles,
  tokenize = trigram
);

CREATE TRIGGER series_search_ai AFTER INSERT ON series BEGIN
  INSERT INTO series_search(rowid, title, description, alt_titles)
  VALUES (new.id, new.title, new.synopsis, new.alt_titles);
END;

CREATE TRIGGER series_search_ad AFTER DELETE ON series BEGIN
  DELETE FROM series_search WHERE rowid = old.id;
END;

CREATE TRIGGER series_search_au AFTER UPDATE ON series BEGIN
  DELETE FROM series_search WHERE rowid = new.id;
  INSERT INTO series_search(rowid, title, description, alt_titles)
  VALUES (new.id, new.title, new.synopsis, new.alt_titles);
END;

INSERT INTO series_search(rowid, title, description, alt_titles)
SELECT id, title, synopsis, alt_titles FROM series;