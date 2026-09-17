const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { collectSubtree } = require('../utils/category-tree');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/categories - Get user's categories with link counts and hierarchy
router.get('/', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const categories = db.prepare(`
    SELECT c.*, COUNT(l.id) as link_count
    FROM categories c
    LEFT JOIN links l ON c.id = l.category_id
    WHERE c.user_id = ?
    GROUP BY c.id
    ORDER BY c.parent_id, c.name
  `).all(userId);

  res.json(categories);
});

// POST /api/categories - Create a new category
router.post('/', (req, res) => {
  const { name, color, parent_id } = req.body;
  const userId = req.userId;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required' });
  }

  const db = getDb();

  if (parent_id) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(parent_id, userId);
    if (!parent) {
      return res.status(400).json({ error: '父分类不存在' });
    }
  }

  const result = db
    .prepare('INSERT INTO categories (user_id, name, color, parent_id) VALUES (?, ?, ?, ?)')
    .run(userId, name.trim(), color || '#409EFF', parent_id || null);

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ...category, link_count: 0 });
});

// PUT /api/categories/:id - Update a category
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, color, parent_id } = req.body;
  const userId = req.userId;

  const db = getDb();

  const category = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, userId);
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  let nextParentId = category.parent_id;
  if (parent_id !== undefined) {
    nextParentId = parent_id || null;
    if (nextParentId) {
      if (Number(nextParentId) === Number(id)) {
        return res.status(400).json({ error: '不能将分类的父分类设为自己' });
      }
      const parent = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(nextParentId, userId);
      if (!parent) {
        return res.status(400).json({ error: '父分类不存在' });
      }
      // Prevent cycles: new parent must not be a descendant of this node.
      const subtree = collectSubtree(db, userId, id);
      if (subtree.includes(Number(nextParentId))) {
        return res.status(400).json({ error: '不能将分类移动到它自己的子分类下' });
      }
    }
  }

  db.prepare('UPDATE categories SET name = ?, color = ?, parent_id = ? WHERE id = ?').run(
    name ? name.trim() : category.name,
    color || category.color,
    nextParentId,
    id
  );

  const updated = db.prepare(`
    SELECT c.*, COUNT(l.id) as link_count
    FROM categories c
    LEFT JOIN links l ON c.id = l.category_id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(id);

  res.json(updated);
});

// DELETE /api/categories/:id - Delete a category (and its subcategories)
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const db = getDb();

  const category = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, userId);
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  const idsToDelete = collectSubtree(db, userId, id);
  const placeholders = idsToDelete.map(() => '?').join(',');

  db.transaction(() => {
    // Links keep ON DELETE SET NULL semantics even for nested categories.
    db.prepare(`UPDATE links SET category_id = NULL WHERE category_id IN (${placeholders})`).run(...idsToDelete);
    db.prepare(`DELETE FROM categories WHERE id IN (${placeholders})`).run(...idsToDelete);
  })();

  res.json({ message: 'Category deleted successfully' });
});

// GET /api/tags - Get all unique tags for user with counts
router.get('/tags', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const tags = db.prepare(`
    SELECT lt.tag, COUNT(*) as count
    FROM link_tags lt
    INNER JOIN links l ON lt.link_id = l.id
    WHERE l.user_id = ?
    GROUP BY lt.tag
    ORDER BY count DESC
  `).all(userId);

  res.json(tags);
});

module.exports = router;
