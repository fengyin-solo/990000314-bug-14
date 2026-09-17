/**
 * Category hierarchy helpers.
 */

// Collect the category id subtree rooted at `rootId` (includes rootId).
function collectSubtree(db, userId, rootId) {
  const ids = [Number(rootId)];
  let frontier = [Number(rootId)];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(',');
    const children = db
      .prepare(`SELECT id FROM categories WHERE user_id = ? AND parent_id IN (${placeholders})`)
      .all(userId, ...frontier);
    const next = children.map((c) => c.id);
    ids.push(...next);
    frontier = next;
  }
  return ids;
}

module.exports = { collectSubtree };
