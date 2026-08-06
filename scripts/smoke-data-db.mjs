// Self-check: data-api migration tables + helpers against in-memory sqlite.
// Run: node scripts/smoke-data-db.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const schema = fs.readFileSync(path.resolve(here, '../packages/db/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.resolve(here, '../packages/db/migrations/0001_manga_data.sql'), 'utf8');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = OFF');
db.exec(schema);
db.exec(migration);

let ok = true;
const check = (name, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} => ${JSON.stringify(got)}`);
};

// series has new columns
const cols = db.prepare("PRAGMA table_info(series)").all().map(c => c.name);
check('series has alt_titles', cols.includes('alt_titles'), true);
check('series has source_url', cols.includes('source_url'), true);
check('series has cover_r2_key', cols.includes('cover_r2_key'), true);
check('series has language', cols.includes('language'), true);

// image_hashes table
check('image_hashes insert', db.prepare('INSERT INTO image_hashes (series_slug, hash, r2_key, image_type) VALUES (?1, ?2, ?3, ?4)').run('test-slug', 'abcdef0123456789', 'covers/test.jpg', 'cover').changes > 0, true);
check('image_hashes query', db.prepare('SELECT series_slug FROM image_hashes WHERE hash LIKE ?1').all('abc%')[0].series_slug, 'test-slug');

// scrape_jobs table
check('scrape_jobs insert', db.prepare('INSERT INTO scrape_jobs (id, source, status) VALUES (?1, ?2, ?3)').run('job-1', 'komiku', 'pending').changes > 0, true);
db.prepare('UPDATE scrape_jobs SET status = ?1, completed_at = ?2 WHERE id = ?3').run('completed', 1700000000, 'job-1');
check('scrape_jobs update', db.prepare('SELECT status FROM scrape_jobs WHERE id = ?1').get('job-1').status, 'completed');

// source_health table
db.prepare('INSERT INTO source_health (source, healthy, latency_ms) VALUES (?1, ?2, ?3)').run('komiku', 1, 234);
check('source_health latest', db.prepare('SELECT source, healthy FROM source_health WHERE source = ?1 ORDER BY checked_at DESC LIMIT 1').get('komiku').healthy, 1);

// upsertSeries (ON CONFLICT)
db.prepare("INSERT INTO series (slug, title, type, status, source) VALUES (?1, ?2, ?3, ?4, ?5)").run('upsert-test', 'Test Title', 'manga', 'ongoing', 'komiku');
db.prepare("INSERT INTO series (slug, title, type, status, source) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, updated_at=unixepoch()").run('upsert-test', 'Updated Title', 'manga', 'ongoing', 'komiku');
check('upsertSeries updates title', db.prepare('SELECT title FROM series WHERE slug = ?1').get('upsert-test').title, 'Updated Title');

console.log(`\n${ok ? 'ALL PASS' : 'SOME FAILED'}`);
db.close();
process.exit(ok ? 0 : 1);
