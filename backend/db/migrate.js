const Database = require('better-sqlite3');
const path = require('path');
const { normalizeUrl } = require('../utils/bookmark-parser');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'links.db');

function hasColumn(db, table, column) {
  return db.pragma(`table_info(${table})`).some((col) => col.name === column);
}

function indexExists(db, indexName) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(indexName);
}

function migrateDatabase() {
  const db = new Database(DB_PATH);

  try {
    // --- links table ---
    if (!hasColumn(db, 'links', 'is_read_later')) {
      db.exec('ALTER TABLE links ADD COLUMN is_read_later INTEGER DEFAULT 0');
      console.log('Added column: links.is_read_later');
    }

    if (!hasColumn(db, 'links', 'review_date')) {
      db.exec('ALTER TABLE links ADD COLUMN review_date DATETIME');
      console.log('Added column: links.review_date');
    }

    if (!hasColumn(db, 'links', 'review_status')) {
      db.exec("ALTER TABLE links ADD COLUMN review_status TEXT DEFAULT 'pending' CHECK(review_status IN ('pending', 'completed', 'skipped'))");
      console.log('Added column: links.review_status');
    }

    if (!hasColumn(db, 'links', 'normalized_url')) {
      db.exec('ALTER TABLE links ADD COLUMN normalized_url TEXT');
      console.log('Added column: links.normalized_url');
    }

    // Backfill normalized urls for existing rows.
    const unfilled = db.prepare("SELECT id, url FROM links WHERE normalized_url IS NULL OR normalized_url = ''").all();
    const updateNormalized = db.prepare('UPDATE links SET normalized_url = ? WHERE id = ?');
    for (const row of unfilled) {
      const normalized = normalizeUrl(row.url);
      updateNormalized.run(normalized || row.url, row.id);
    }
    if (unfilled.length > 0) {
      console.log(`Backfilled normalized_url for ${unfilled.length} links`);
    }

    // Remove historical duplicates created by the old raw-URL matching,
    // keeping the oldest link of each (user, normalized_url) group so the
    // unique index can be created.
    const dupGroups = db
      .prepare(
        `SELECT user_id, normalized_url, COUNT(*) AS cnt, MIN(id) AS keep_id
         FROM links
         WHERE normalized_url IS NOT NULL
         GROUP BY user_id, normalized_url
         HAVING cnt > 1`
      )
      .all();
    let removed = 0;
    const deleteLink = db.prepare('DELETE FROM links WHERE id = ?');
    const deleteTagsForLink = db.prepare('DELETE FROM link_tags WHERE link_id = ?');
    for (const group of dupGroups) {
      const victims = db
        .prepare('SELECT id FROM links WHERE user_id = ? AND normalized_url = ? AND id != ? ORDER BY id')
        .all(group.user_id, group.normalized_url, group.keep_id);
      const tx = db.transaction((rows) =>
        rows.forEach((r) => {
          deleteTagsForLink.run(r.id);
          deleteLink.run(r.id);
        })
      );
      tx(victims);
      removed += victims.length;
    }
    if (removed > 0) {
      console.log(`Removed ${removed} duplicate links (oldest kept)`);
    }

    if (!indexExists(db, 'idx_links_user_normalized_url')) {
      db.exec('CREATE UNIQUE INDEX idx_links_user_normalized_url ON links(user_id, normalized_url)');
      console.log('Created unique index: idx_links_user_normalized_url');
    }

    // --- categories table ---
    if (!hasColumn(db, 'categories', 'parent_id')) {
      db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE');
      console.log('Added column: categories.parent_id');
    }
    if (!indexExists(db, 'idx_categories_parent_id')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id)');
    }

    console.log('Database migration completed successfully');
  } catch (error) {
    console.error('Migration error:', error);
    throw error;
  } finally {
    db.close();
  }
}

module.exports = { migrateDatabase };
