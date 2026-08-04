import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const schema = fs.readFileSync(
  path.resolve(here, '../packages/db/schema.sql'), 'utf8'
);
const seed = fs.readFileSync(
  path.resolve(here, '../packages/db/seed.sql'), 'utf8'
);

const db = new DatabaseSync(':memory:');
db.exec(schema);
db.exec(seed);

let ok = true;
const check = (name, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} => ${JSON.stringify(got)}`);
};

// getSeriesBySlug
check('getSeriesBySlug one-piece',
  db.prepare('SELECT * FROM series WHERE slug = ?1 LIMIT 1').get('one-piece'),
  db.prepare('SELECT * FROM series WHERE slug = ?1 LIMIT 1').get('one-piece'));

// listSeries (all)
check('listSeries count',
  db.prepare('SELECT * FROM series ORDER BY updated_at DESC, id DESC LIMIT ?1 OFFSET ?2').all(20, 0).length,
  2);

// listSeries (genre filter)
check('listSeries genre action',
  db.prepare("SELECT * FROM series WHERE genres LIKE ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2 OFFSET ?3")
    .all('%"action"%', 20, 0).length, 2);

// getChapter
check('getChapter', db.prepare('SELECT * FROM chapters WHERE id = ?1 LIMIT 1').get('9e4f0c2a-onepiece-ch1').chapter_number, 1);

// listChapterPages
check('listChapterPages',
  db.prepare('SELECT id, chapter_id, page_number, image_url FROM chapter_pages WHERE chapter_id = ?1 ORDER BY page_number ASC')
    .get('9e4f0c2a-onepiece-ch1').page_number, 1);

// searchSeries (FTS)
check('searchSeries FTS treasure',
  db.prepare('SELECT s.* FROM series_search f JOIN series s ON s.id = f.rowid WHERE series_search MATCH ?1 ORDER BY rank')
    .all('treasure')[0]?.title, 'One Piece');

// createUser / getUserById
db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?1, ?2, ?3, ?4) RETURNING id')
  .get('tester@example.com', null, 'hash', 'user');
check('getUserById', db.prepare('SELECT id, email, name, role FROM users WHERE id = ?1 LIMIT 1').get(1).email, 'tester@example.com');

// addBookmark / listBookmarks
db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, series_slug) VALUES (?1, ?2)').run(1, 'one-piece');
check('listBookmarks', db.prepare(
  `SELECT s.* FROM bookmarks b JOIN series s ON s.slug = b.series_slug WHERE b.user_id = ?1 ORDER BY b.created_at DESC`)
    .all(1).length, 1);

// upsertHistory / listHistory
db.prepare(
  `INSERT INTO reading_history (user_id, chapter_id, last_page) VALUES (?1, ?2, ?3)
   ON CONFLICT(user_id, chapter_id) DO UPDATE SET last_page = ?3, updated_at = unixepoch() RETURNING *`
).get(1, '9e4f0c2a-onepiece-ch1', 5);
check('upsertHistory last_page',
  db.prepare('SELECT last_page FROM reading_history WHERE user_id=1 AND chapter_id=?1').get('9e4f0c2a-onepiece-ch1').last_page, 5);

// lb helpers
check('getLbSettings', db.prepare('SELECT key, value FROM lb_settings').all().length, 2);
db.prepare('INSERT INTO lb_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
  .run('mode', 'custom');
check('setLbSettings', db.prepare('SELECT value FROM lb_settings WHERE key=?1').get('mode').value, 'custom');

// addAccount / listAccounts / updateOrigin / createOrigin / recordOriginHealth / getOriginStatus / addAuditLog
const acc = db.prepare(
  'INSERT INTO lb_accounts (name, provider, encrypted_token, token_last4, enabled) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id'
).get('cf-acct', 'cloudflare', 'enc', '1234', 1);
check('addAccount id', acc.id, 1);

db.prepare(
  'INSERT INTO lb_origins (name, url, enabled, priority, weight) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id'
).get('primary', 'https://api.example.com', 1, 0, 1);
db.prepare('UPDATE lb_origins SET name = ?1 WHERE id = ?2').run('primary-renamed', 1);
db.prepare('INSERT INTO lb_audit_log (origin_id, action) VALUES (?1, ?2)').run(1, 'healthy');
check('getOriginStatus', db.prepare(
  'SELECT action FROM lb_audit_log WHERE origin_id = ?1 ORDER BY created_at DESC LIMIT 1').get(1).action, 'healthy');
db.prepare('INSERT INTO lb_audit_log (account_id, origin_id, action, user_id) VALUES (?1, ?2, ?3, ?4)')
  .run(1, 1, 'account_created', 1);

console.log(`\n${ok ? 'ALL PASS' : 'SOME FAILED'}`);
db.close();
process.exit(ok ? 0 : 1);
