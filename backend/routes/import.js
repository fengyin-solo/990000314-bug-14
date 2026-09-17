const express = require('express');
const multer = require('multer');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');
const { parseBookmarks } = require('../utils/bookmark-parser');
const { normalizeUrl } = require('../utils/url');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.html?$/i.test(file.originalname) || /text\/html/i.test(file.mimetype);
    cb(ok ? null : new Error('仅支持 .html / .htm 书签文件'), ok);
  },
});

// All routes require authentication
router.use(authMiddleware);

const CATEGORY_COLORS = ['#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399', '#9B59B6', '#1ABC9C', '#E74C3C'];

// POST /api/import/bookmarks - Import Chrome / Edge / Firefox bookmarks
router.post('/bookmarks', (req, res) => {
  upload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) {
      const reason = /file too large/i.test(uploadErr.message)
        ? '文件超过 10MB 限制，请拆分后再导入'
        : uploadErr.message || '文件上传失败';
      return res.status(400).json({ error: reason });
    }

    if (!req.file) {
      return res.status(400).json({ error: '未收到上传文件，请重新选择书签 HTML 文件' });
    }

    let html;
    try {
      html = req.file.buffer.toString('utf-8');
    } catch {
      return res.status(400).json({ error: '文件无法按 UTF-8 文本读取，请确认是浏览器导出的 HTML 书签' });
    }

    const { bookmarks, invalid } = parseBookmarks(html);

    if (bookmarks.length === 0 && invalid.length === 0) {
      return res.status(400).json({ error: '文件中没有解析出任何书签，请确认是浏览器导出的 HTML 书签' });
    }

    // One ordered list so "第几条" matches document order.
    const entries = [
      ...bookmarks.map((bm) => ({ kind: 'bookmark', ...bm })),
      ...invalid.map((it) => ({ kind: 'invalid', ...it })),
    ].sort((a, b) => a.line - b.line);

    const db = getDb();
    const userId = req.userId;

    const findCategory = db.prepare(
      'SELECT id FROM categories WHERE user_id = ? AND name = ? AND COALESCE(parent_id, 0) = ?'
    );
    const insertCategory = db.prepare(
      'INSERT INTO categories (user_id, name, color, parent_id) VALUES (?, ?, ?, ?)'
    );
    const findLinkByNorm = db.prepare(
      'SELECT id FROM links WHERE user_id = ? AND normalized_url = ?'
    );
    const insertLink = db.prepare(
      'INSERT INTO links (user_id, url, normalized_url, title, description, category_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertTag = db.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag) VALUES (?, ?)');

    const seenInFile = new Set();

    // One bookmark, one savepoint. A single bad row rolls itself back instead
    // of aborting (or worse, silently dropping) the rest of the file.
    const importOne = db.transaction((entry) => {
      const norm = normalizeUrl(entry.url);
      if (!norm.ok) return { status: 'failed', reason: norm.reason };
      const normalized = norm.normalized;

      if (seenInFile.has(normalized)) {
        return { status: 'skipped', reason: '与本次文件中前面的书签地址重复' };
      }
      seenInFile.add(normalized);

      const existing = findLinkByNorm.get(userId, normalized);
      if (existing) {
        return { status: 'skipped', reason: '规范化后的地址已存在于链接库' };
      }

      let categoryId = null;
      if (entry.folders.length > 0) {
        let parentId = null;
        for (const folder of entry.folders) {
          const category =
            findCategory.get(userId, folder, parentId ?? 0) ||
            {
              id: insertCategory.run(
                userId,
                folder,
                CATEGORY_COLORS[Math.floor(Math.random() * CATEGORY_COLORS.length)],
                parentId
              ).lastInsertRowid,
            };
          parentId = category.id;
        }
        categoryId = parentId;
      }

      const linkId = insertLink.run(
        userId, entry.url, normalized, entry.title, '', categoryId, 'unchecked'
      ).lastInsertRowid;

      for (const tag of entry.tags) {
        insertTag.run(linkId, tag);
      }

      return {
        status: 'imported',
        normalized_url: normalized,
        category_path: entry.folders.join(' / '),
        tags: entry.tags,
      };
    });

    const details = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;

    const runImport = db.transaction(() => {
      entries.forEach((entry, i) => {
        const index = i + 1;
        const base = {
          index,
          line: entry.line,
          title: entry.title || '(无标题)',
          url: entry.url || '',
        };

        if (entry.kind === 'invalid') {
          details.push({ ...base, status: 'failed', reason: entry.reason });
          failed++;
          return;
        }

        try {
          const outcome = importOne(entry);
          details.push({ ...base, ...outcome });
          if (outcome.status === 'imported') imported++;
          else if (outcome.status === 'skipped') skipped++;
          else failed++;
        } catch (err) {
          details.push({ ...base, status: 'failed', reason: `写入数据库失败: ${err.message}` });
          failed++;
        }
      });
    });

    try {
      runImport();
    } catch (err) {
      console.error('Import transaction failed:', err);
      return res.status(500).json({ error: `导入过程中断: ${err.message}` });
    }

    const total = imported + skipped + failed;
    res.json({
      message: `导入完成：新增 ${imported} 条，跳过 ${skipped} 条，失败 ${failed} 条`,
      imported,
      skipped,
      failed,
      total,
      parsed: bookmarks.length,
      rejected: invalid.length,
      details,
    });
  });
});

module.exports = router;
