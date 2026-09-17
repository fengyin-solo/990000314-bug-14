const express = require('express');
const multer = require('multer');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { parseBookmarks } = require('../utils/bookmark-parser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All routes require authentication
router.use(authMiddleware);

const FALLBACK_COLORS = ['#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399', '#9B59B6', '#1ABC9C', '#E74C3C'];

// POST /api/import/bookmarks - Import Chrome/Firefox bookmark HTML
router.post('/bookmarks', (req, res) => {
  upload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) {
      // multer errors (file too large, wrong field, ...) must surface with
      // an actionable message instead of a generic 500.
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '文件超过 10MB 大小限制，请拆分后再导入' });
      }
      return res.status(400).json({ error: `文件上传失败：${uploadErr.message}` });
    }

    if (!req.file) {
      return res.status(400).json({ error: '未收到上传文件，请先选择书签 HTML 文件' });
    }

    const html = req.file.buffer.toString('utf-8');
    const { items: bookmarks, failures: parseFailures } = parseBookmarks(html);

    if (bookmarks.length === 0 && parseFailures.length === 0) {
      return res.status(400).json({ error: '文件中没有找到任何书签，请确认导出的是 Chrome/Firefox 书签 HTML 文件' });
    }

    // Assign a single 1-based position across every bookmark entry found
    // in the file, ordered by document position — entries that failed to
    // parse still get a position so the report can say "第 N 条".
    const positioned = [
      ...bookmarks.map((b) => ({ kind: 'bookmark', line: b.line, data: b })),
      ...parseFailures.map((f) => ({ kind: 'failure', line: f.line, data: f })),
    ].sort((a, b) => a.line - b.line);
    positioned.forEach((entry, i) => {
      entry.index = i + 1;
    });

    const db = getDb();
    const userId = req.userId;

    const findCategory = db.prepare(
      'SELECT id FROM categories WHERE user_id = ? AND parent_id IS ? AND name = ?'
    );
    const insertCategory = db.prepare(
      'INSERT INTO categories (user_id, name, color, parent_id) VALUES (?, ?, ?, ?)'
    );
    const findLinkByNormalized = db.prepare(
      'SELECT id FROM links WHERE user_id = ? AND normalized_url = ?'
    );
    const insertLink = db.prepare(
      'INSERT INTO links (user_id, url, normalized_url, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    // Ensure a folder chain exists; categories are unique per
    // (user, parent folder, name) so same-named subfolders under different
    // parents stay distinct and the hierarchy is preserved.
    const categoryCache = new Map(); // "parentId::name" -> id
    function resolveCategory(folderPath) {
      let parentId = null;
      folderPath.forEach((name) => {
        const key = `${parentId}::${name}`;
        let id = categoryCache.get(key);
        if (id === undefined) {
          const existing = findCategory.get(userId, parentId, name);
          if (existing) {
            id = existing.id;
          } else {
            const color = FALLBACK_COLORS[Math.floor(Math.random() * FALLBACK_COLORS.length)];
            id = Number(insertCategory.run(userId, name, color, parentId).lastInsertRowid);
          }
          categoryCache.set(key, id);
        }
        parentId = id;
      });
      return parentId;
    }

    // Normalized URLs already handled during this very request (file may
    // contain the same link twice).
    const seenInRequest = new Set();

    // Create every folder chain up front in one transaction. This keeps
    // the category cache stable while link inserts run in their own
    // independent transactions below.
    const ensureCategories = db.transaction(() => {
      for (const bookmark of bookmarks) {
        if (bookmark.folderPath && bookmark.folderPath.length > 0) {
          resolveCategory(bookmark.folderPath);
        }
      }
    });
    ensureCategories();

    const imported = [];
    const skipped = [];
    const failures = positioned
      .filter((e) => e.kind === 'failure')
      .map((e) => ({
        index: e.index,
        line: e.data.line,
        title: e.data.title || '',
        url: e.data.rawUrl || '',
        reason: e.data.reason,
        stage: 'parse',
      }));

    // One savepoint per bookmark so a failing row never rolls back rows
    // that already succeeded.
    const processOne = db.transaction((entry) => {
      const bookmark = entry.data;
      const result = { index: entry.index, title: bookmark.title, url: bookmark.rawUrl };

      if (seenInRequest.has(bookmark.url)) {
        skipped.push({ ...result, reason: '与本文件前面的书签重复' });
        return;
      }
      seenInRequest.add(bookmark.url);

      const existing = findLinkByNormalized.get(userId, bookmark.url);
      if (existing) {
        skipped.push({ ...result, reason: '规范化后的网址已存在，跳过重复项' });
        return;
      }

      let categoryId = null;
      if (bookmark.folderPath && bookmark.folderPath.length > 0) {
        categoryId = resolveCategory(bookmark.folderPath);
      }

      try {
        const info = insertLink.run(
          userId,
          bookmark.rawUrl,
          bookmark.url,
          bookmark.title,
          '',
          categoryId,
          'unchecked'
        );
        imported.push({ ...result, id: Number(info.lastInsertRowid), categoryPath: bookmark.folderPath });
      } catch (err) {
        seenInRequest.delete(bookmark.url);
        // UNIQUE constraint races / any other DB error: report, don't abort.
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          skipped.push({ ...result, reason: '规范化后的网址已存在，跳过重复项' });
        } else {
          failures.push({ index: entry.index, line: bookmark.line, title: bookmark.title, url: bookmark.rawUrl, reason: `写入数据库失败：${err.message}`, stage: 'insert' });
        }
      }
    });

    positioned
      .filter((e) => e.kind === 'bookmark')
      .forEach((entry) => {
        try {
          processOne(entry);
        } catch (err) {
          // Unexpected failure outside the per-row try/catch.
          failures.push({
            index: entry.index,
            line: entry.data.line,
            title: entry.data.title,
            url: entry.data.rawUrl,
            reason: `处理失败：${err.message}`,
            stage: 'insert',
          });
        }
      });

    // Counts are derived from the detail lists so the summary and the
    // returned rows can never disagree.
    const total = bookmarks.length + parseFailures.length;
    res.json({
      message: `解析 ${total} 条，导入 ${imported.length} 条，跳过 ${skipped.length} 条，失败 ${failures.length} 条`,
      total,
      imported_count: imported.length,
      skipped_count: skipped.length,
      failed_count: failures.length,
      // Keep legacy field names for older clients.
      imported: imported.length,
      skipped: skipped.length,
      failed: failures.length,
      details: {
        imported,
        skipped,
        failures,
      },
    });
  });
});

module.exports = router;
