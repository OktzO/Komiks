-- Seed data for local dev / smoke tests
INSERT OR IGNORE INTO series (slug, external_id, source, title, synopsis, type, status, author, artist, cover_image, genres, tags)
VALUES
  ('one-piece', 'one-piece', 'komiku',
   'One Piece',
   'Monkey D. Luffy sets sail to find the ultimate treasure, the One Piece.',
   'manga', 'ongoing', 'Eiichiro Oda', 'Eiichiro Oda',
   'https://img.komiku.org/pictures/one-piece.jpg',
   '["action","adventure","fantasy"]', '["shonen"]'),
  ('solo-leveling', 'solo-leveling', 'komiku',
   'Solo Leveling',
   'The world''s weakest hunter becomes the strongest in a dungeon-cleared future.',
   'manhwa', 'completed', 'Chugong', 'Dubu (Redice Studio)',
   'https://img.komiku.org/pictures/solo-leveling.jpg',
   '["action","fantasy"]', '["reincarnation"]');

INSERT OR IGNORE INTO chapters (id, series_slug, chapter_number, volume, title, language, pages_count, published_at)
VALUES
  ('one-piece-chapter-01', 'one-piece', 1, '1', 'Romance Dawn', 'id', 2, 946684800),
  ('one-piece-chapter-1090', 'one-piece', 1090, NULL, 'The Final Chapter?', 'id', 2, 1700000000);

INSERT OR IGNORE INTO chapter_pages (chapter_id, page_number, image_url)
VALUES
  ('one-piece-chapter-01', 1, 'https://img.komiku.org/pictures/one-piece-1.jpg'),
  ('one-piece-chapter-01', 2, 'https://img.komiku.org/pictures/one-piece-2.jpg'),
  ('one-piece-chapter-1090', 1, 'https://img.komiku.org/pictures/1090-1.jpg'),
  ('one-piece-chapter-1090', 2, 'https://img.komiku.org/pictures/1090-2.jpg');

INSERT OR IGNORE INTO lb_settings (id, mode, implementation, steering_policy, health_check_interval_sec, health_check_timeout_ms, failure_threshold)
VALUES (1, 'off', 'custom', 'failover', 30, 3000, 2);
