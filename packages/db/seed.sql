-- Seed data for local dev / smoke tests
INSERT OR IGNORE INTO series (slug, external_id, source, title, synopsis, type, status, author, artist, cover_image, genres, tags)
VALUES
  ('one-piece', '32d056d2-d96f-4cd2-b8e7-5c08b3a41b01', 'mangadex',
   'One Piece',
   'Monkey D. Luffy sets sail to find the ultimate treasure, the One Piece.',
   'manga', 'ongoing', 'Eiichiro Oda', 'Eiichiro Oda',
   'https://uploads.mangadex.org/covers/32d056d2-d96f-4cd2-b8e7-5c08b3a41b01/f1b0c5.jpg',
   '["action","adventure","fantasy"]', '["shonen"]'),
  ('solo-leveling', '223a0f10-58d4-42a4-b331-5f06a9c7c7f5', 'mangadex',
   'Solo Leveling',
   'The world''s weakest hunter becomes the strongest in a dungeon-cleared future.',
   'manhwa', 'completed', 'Chugong', 'Dubu (Redice Studio)',
   'https://uploads.mangadex.org/covers/223a0f10-58d4-42a4-b331-5f06a9c7c7f5/cover.jpg',
   '["action","fantasy"]', '["reincarnation"]');

INSERT OR IGNORE INTO chapters (id, series_slug, chapter_number, volume, title, language, pages_count, published_at)
VALUES
  ('9e4f0c2a-onepiece-ch1', 'one-piece', 1, '1', 'Romance Dawn', 'en', 2, 946684800),
  ('9e4f0c2a-onepiece-ch1090', 'one-piece', 1090, NULL, 'The Final Chapter?', 'en', 2, 1700000000);

INSERT OR IGNORE INTO chapter_pages (chapter_id, page_number, image_url)
VALUES
  ('9e4f0c2a-onepiece-ch1', 1, 'https://mangadex.org/image1/page1.jpg'),
  ('9e4f0c2a-onepiece-ch1', 2, 'https://mangadex.org/image1/page2.jpg'),
  ('9e4f0c2a-onepiece-ch1090', 1, 'https://mangadex.org/image1/1090-1.jpg'),
  ('9e4f0c2a-onepiece-ch1090', 2, 'https://mangadex.org/image1/1090-2.jpg');

INSERT OR IGNORE INTO lb_settings (key, value)
VALUES ('mode', 'native'), ('admin_password_hash', '0000');
