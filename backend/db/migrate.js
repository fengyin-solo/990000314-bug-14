const Database = require('better-sqlite3');
const path = require('path');
const { normalizeUrl } = require('../utils/url');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'links.db');

function migrateDatabase() {
  const db = new Database(DB_PATH);

  try {
    const linkColumns = db.pragma('table_info(links)').map((col) => col.name);
    const categoryColumns = db.pragma('table_info(categories)').map((col) => col.name);

    if (!categoryColumns.includes('parent_id')) {
      db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE');
      console.log('Added column: categories.parent_id');
    }

    if (!linkColumns.includes('normalized_url')) {
      db.exec('ALTER TABLE links ADD COLUMN normalized_url TEXT');
      console.log('Added column: links.normalized_url');
      backfillNormalizedUrls(db);
    }

    dedupeLinks(db);
    dedupeCategories(db);

    // Safe to enforce uniqueness only after existing duplicates are resolved.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_links_user_normalized_url
        ON links(user_id, normalized_url);
      CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
    `);

    console.log('Database migration completed successfully');
  } catch (error) {
    console.error('Migration error:', error);
  } finally {
    db.close();
  }
}

function backfillNormalizedUrls(db) {
  const rows = db.prepare('SELECT id, url FROM links').all();
  const update = db.prepare('UPDATE links SET normalized_url = ? WHERE id = ?');
  const fill = db.transaction((links) => {
    for (const row of links) {
      const result = normalizeUrl(row.url);
      update.run(result.ok ? result.normalized : null, row.id);
    }
  });
  fill(rows);
  console.log(`Backfilled normalized_url for ${rows.length} links`);
}

// One link per (user, normalized URL). Keep the oldest row, merge tags and the
// read-later flag from the duplicates, then drop the duplicates.
function dedupeLinks(db) {
  const groups = db.prepare(`
    SELECT user_id, normalized_url, COUNT(*) AS count
    FROM links
    WHERE normalized_url IS NOT NULL
    GROUP BY user_id, normalized_url
    HAVING count > 1
  `).all();

  if (groups.length === 0) return;

  const selectDupes = db.prepare(`
    SELECT * FROM links WHERE user_id = ? AND normalized_url = ? ORDER BY id
  `);
  const selectTags = db.prepare('SELECT tag FROM link_tags WHERE link_id = ?');
  const insertTag = db.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag) VALUES (?, ?)');
  const mergeFlags = db.prepare(`
    UPDATE links SET is_read_later = MAX(is_read_later, ?) WHERE id = ?
  `);
  const deleteTags = db.prepare('DELETE FROM link_tags WHERE link_id = ?');
  const deleteLink = db.prepare('DELETE FROM links WHERE id = ?');

  const cleanup = db.transaction(() => {
    for (const group of groups) {
      const dupes = selectDupes.all(group.user_id, group.normalized_url);
      const [keep, ...rest] = dupes;
      for (const dup of rest) {
        for (const { tag } of selectTags.all(dup.id)) {
          insertTag.run(keep.id, tag);
        }
        mergeFlags.run(dup.is_read_later, keep.id);
        deleteTags.run(dup.id);
        deleteLink.run(dup.id);
      }
    }
  });
  cleanup();
  console.log(`Resolved ${groups.length} groups of duplicate links`);
}

// Collapse same-name categories sharing the same parent. Legacy categories all
// sit at parent_id NULL, so this only merges categories created by the old
// flat-name import when they were ever duplicated.
function dedupeCategories(db) {
  const groups = db.prepare(`
    SELECT user_id, COALESCE(parent_id, 0) AS parent_key, name, COUNT(*) AS count
    FROM categories
    GROUP BY user_id, parent_key, name
    HAVING count > 1
  `).all();

  if (groups.length === 0) return;

  const cleanup = db.transaction(() => {
    for (const g of groups) {
      const rows = db.prepare(
        'SELECT id FROM categories WHERE user_id = ? AND name = ? AND COALESCE(parent_id, 0) = ? ORDER BY id'
      ).all(g.user_id, g.name, g.parent_key);
      const [keep, ...rest] = rows;
      for (const dup of rest) {
        db.prepare('UPDATE links SET category_id = ? WHERE category_id = ?').run(keep.id, dup.id);
        db.prepare('DELETE FROM categories WHERE id = ?').run(dup.id);
      }
    }
  });
  cleanup();
  console.log(`Merged ${groups.length} groups of duplicate categories`);
}

module.exports = { migrateDatabase };
