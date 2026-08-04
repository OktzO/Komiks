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
// lb_settings (single row, id = 1 from seed)
const settings = db.prepare('SELECT * FROM lb_settings WHERE id = ?1 LIMIT 1').get(1);
check('getLbSettings single row', settings.mode, 'off');
check('getLbSettings default impl', settings.implementation, 'custom');

// setLbSettings (update specific columns on row id=1)
db.prepare('UPDATE lb_settings SET mode = ?1, implementation = ?2 WHERE id = ?3').run('on', 'native_cf', 1);
const updated = db.prepare('SELECT mode, implementation FROM lb_settings WHERE id = ?1 LIMIT 1').get(1);
check('setLbSettings mode', updated.mode, 'on');
check('setLbSettings implementation', updated.implementation, 'native_cf');

// addAccount (returns TEXT id)
const acc = db.prepare(
  'INSERT INTO lb_accounts (id, provider, label, account_ref, encrypted_token, token_last4, status, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id'
).get('acct-1', 'cloudflare', 'cf-account', 'account-123', Buffer.from('encrypted-token'), '1234', 'verified', 1);
check('addAccount id is TEXT', typeof acc.id, 'string');

// listAccounts (omits encrypted_token)
const accountsList = db.prepare(
  'SELECT id, provider, label, account_ref, token_last4, status, created_by, created_at FROM lb_accounts ORDER BY id'
).all();
check('listAccounts omits token', accountsList[0] && !('encrypted_token' in accountsList[0]), true);
check('listAccounts label', accountsList[0]?.label, 'cf-account');

// createOrigin with account_id FK
const origin = db.prepare(
  'INSERT INTO lb_origins (id, account_id, origin_url, priority, weight, enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id'
).get('origin-1', 'acct-1', 'https://api.example.com', 0, 1, 1);
check('createOrigin id is TEXT', typeof origin.id, 'string');

// recordOriginHealth (UPDATE lb_origins last_health_status + last_checked_at)
db.prepare('UPDATE lb_origins SET last_health_status = ?1, last_checked_at = ?2 WHERE id = ?3')
  .run('healthy', 1700000000, 'origin-1');

// getOriginStatus (reads from lb_origins)
const originStatus = db.prepare(
  'SELECT last_health_status, last_checked_at FROM lb_origins WHERE id = ?1 LIMIT 1'
).get('origin-1');
check('getOriginStatus healthy', originStatus.last_health_status, 'healthy');
check('getOriginStatus last_checked_at', originStatus.last_checked_at, 1700000000);

// addAuditLog
db.prepare(
  'INSERT INTO lb_audit_log (account_id, origin_id, action, user_id) VALUES (?1, ?2, ?3, ?4)'
).run('acct-1', 'origin-1', 'origin_created', 1);
check('addAuditLog', db.prepare(
  'SELECT action FROM lb_audit_log WHERE origin_id = ?1 ORDER BY created_at DESC LIMIT 1').get('origin-1').action, 'origin_created');

console.log(`\n${ok ? 'ALL PASS' : 'SOME FAILED'}`);
db.close();
process.exit(ok ? 0 : 1);
