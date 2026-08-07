// Smoke test D1 r2 storage: schema + migration 0002 di :memory: (node:sqlite).
// Jalankan: node scripts/smoke-r2-db.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const schema = fs.readFileSync(path.resolve(here, '../packages/db/schema.sql'), 'utf8');
const migration1 = fs.readFileSync(path.resolve(here, '../packages/db/migrations/0001_manga_data.sql'), 'utf8');
const migration = fs.readFileSync(path.resolve(here, '../packages/db/migrations/0002_r2_storage.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
db.exec(schema);
db.exec(migration1);
db.exec(migration);

let ok = true;
const check = (name, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} => ${JSON.stringify(got)}`);
};

// Seed minimal: series + chapter (FK chapter_pages → chapters → series)
db.prepare(`INSERT INTO series (slug, title, type, status, language) VALUES ('smoke-r2', 'Smoke', 'manga', 'ongoing', 'id')`).run();
db.prepare(`INSERT INTO chapters (id, series_slug, chapter_number, language) VALUES ('smoke-r2-chapter-1', 'smoke-r2', 1, 'id')`).run();

// markPageR2Uploaded: insert + upsert ulang (idempoten)
db.prepare(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
  VALUES ('smoke-r2-chapter-1', 1, 'https://img.komiku.org/x.jpg', 'komiku/smoke-r2/smoke-r2-chapter-1/1', 0)
  ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`).run();
db.prepare(`INSERT INTO chapter_pages (chapter_id, page_number, image_url, r2_key, r2_account_idx)
  VALUES ('smoke-r2-chapter-1', 1, 'https://img.komiku.org/x.jpg', 'komiku/smoke-r2/smoke-r2-chapter-1/1', 1)
  ON CONFLICT(chapter_id, page_number) DO UPDATE SET r2_key = excluded.r2_key, r2_account_idx = excluded.r2_account_idx`).run();
check('markPageR2Uploaded upsert idempoten (1 row)',
  db.prepare('SELECT COUNT(*) c FROM chapter_pages WHERE chapter_id = ?').get('smoke-r2-chapter-1').c, 1);
check('r2_account_idx ter-update ke 1',
  db.prepare('SELECT r2_account_idx FROM chapter_pages WHERE chapter_id = ? AND page_number = 1').get('smoke-r2-chapter-1').r2_account_idx, 1);

// touchLastAccess: insert lalu update
db.prepare(`INSERT INTO r2_last_access (r2_key, account_idx, last_viewed, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(r2_key) DO UPDATE SET last_viewed = excluded.last_viewed, account_idx = excluded.account_idx`)
  .run('komiku/smoke-r2/smoke-r2-chapter-1/1', 1, 1000, 1000);
db.prepare(`INSERT INTO r2_last_access (r2_key, account_idx, last_viewed, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(r2_key) DO UPDATE SET last_viewed = excluded.last_viewed, account_idx = excluded.account_idx`)
  .run('komiku/smoke-r2/smoke-r2-chapter-1/1', 1, 2000, 1000);
check('touchLastAccess update last_viewed',
  db.prepare('SELECT last_viewed FROM r2_last_access WHERE r2_key = ?').get('komiku/smoke-r2/smoke-r2-chapter-1/1').last_viewed, 2000);

// incrementLbUsage: insert + increment
db.prepare(`INSERT INTO lb_usage (origin_url, date_key, req_count, updated_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(origin_url, date_key) DO UPDATE SET req_count = req_count + 1, updated_at = excluded.updated_at`)
  .run('https://api1.example.com', '2026-08-07', 1234);
db.prepare(`INSERT INTO lb_usage (origin_url, date_key, req_count, updated_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(origin_url, date_key) DO UPDATE SET req_count = req_count + 1, updated_at = excluded.updated_at`)
  .run('https://api1.example.com', '2026-08-07', 1234);
check('incrementLbUsage bertambah',
  db.prepare('SELECT req_count FROM lb_usage WHERE origin_url = ? AND date_key = ?').get('https://api1.example.com', '2026-08-07').req_count, 2);

const usageRow = db.prepare('SELECT origin_url, req_count FROM lb_usage WHERE date_key = ?').all('2026-08-07');
check('listLbUsage shape', usageRow, [{ origin_url: 'https://api1.example.com', req_count: 2 }]);

if (ok) {
  console.log('smoke-r2-db: ALL PASS');
  process.exit(0);
} else {
  console.error('smoke-r2-db: FAILED');
  process.exit(1);
}