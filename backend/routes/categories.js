const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/categories - Get user's flat category list with direct link counts
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

// GET /api/categories/tree - Category tree; link_count aggregates descendants
router.get('/tree', (req, res) => {
  const userId = req.userId;
  const db = getDb();

  const rows = db.prepare(`
    WITH RECURSIVE cat_tree(id, parent_id, root_id) AS (
      SELECT id, parent_id, id FROM categories WHERE user_id = ?
      UNION ALL
      SELECT c.id, c.parent_id, t.root_id
      FROM categories c JOIN cat_tree t ON c.parent_id = t.id
      WHERE c.user_id = ?
    )
    SELECT c.id, c.name, c.color, c.parent_id, COUNT(l.id) AS link_count
    FROM categories c
    LEFT JOIN cat_tree t ON t.root_id = c.id
    LEFT JOIN links l ON l.category_id = t.id
    WHERE c.user_id = ?
    GROUP BY c.id
    ORDER BY c.id
  `).all(userId, userId, userId);

  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  function sortNodes(nodes) {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    nodes.forEach((n) => sortNodes(n.children));
    return nodes;
  }

  res.json(sortNodes(roots));
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
    const parent = db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(parent_id, userId);
    if (!parent) {
      return res.status(400).json({ error: 'Parent category not found' });
    }
  }

  const result = db.prepare(
    'INSERT INTO categories (user_id, name, color, parent_id) VALUES (?, ?, ?, ?)'
  ).run(userId, name.trim(), color || '#409EFF', parent_id || null);

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
    if (nextParentId === Number(id)) {
      return res.status(400).json({ error: '分类不能挂到自己下面' });
    }
    if (nextParentId) {
      const parent = db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(nextParentId, userId);
      if (!parent) {
        return res.status(400).json({ error: 'Parent category not found' });
      }
      // Reject cycles: the new parent must not be a descendant of this node.
      let cursor = parent;
      while (cursor) {
        if (cursor.id === Number(id)) {
          return res.status(400).json({ error: '不能把分类移动到它自己的子分类下' });
        }
        cursor = db.prepare('SELECT * FROM categories WHERE id = ?').get(cursor.parent_id);
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

// DELETE /api/categories/:id - Delete a category
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const userId = req.userId;

  const db = getDb();

  const category = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, userId);
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  const tx = db.transaction(() => {
    // Move children up one level instead of cascading the delete into them.
    db.prepare('UPDATE categories SET parent_id = ? WHERE parent_id = ?').run(category.parent_id, id);
    // Links keep existing but become uncategorized.
    db.prepare('UPDATE links SET category_id = NULL WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });
  tx();

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
