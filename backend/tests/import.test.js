/**
 * Integration tests for the import endpoint against an in-memory-ish
 * temporary SQLite database. Boots the real express app on an ephemeral
 * port and issues real HTTP requests.
 *
 * Run: node tests/import.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the database before the app modules load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const http = require('http');
const bcrypt = require('bcryptjs');

const { initDatabase, getDb } = require('../db/init');
const { migrateDatabase } = require('../db/migrate');

initDatabase();
migrateDatabase();

// Seed one user directly.
const db = getDb();
db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(
  'u',
  'u@example.com',
  bcrypt.hashSync('pw', 4)
);

const app = require('express')();
app.use('/api/import', require('../routes/import'));
app.use('/api/categories', require('../routes/categories'));
app.use('/api/links', require('../routes/links'));
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const token = jwt.sign({ userId: 1 }, JWT_SECRET);

const server = app.listen(0);
const port = server.address().port;

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { Authorization: `Bearer ${token}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode, json: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function multipart(fileContent, filename = 'bookmarks.html') {
  const boundary = '----testboundary123';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/html\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const payload = Buffer.concat([Buffer.from(head), Buffer.from(fileContent), Buffer.from(tail)]);
  return { body: payload, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length } };
}

const FILE_A = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>父 文件夹</H3>
  <DL><p>
    <DT><A HREF="https://example.com/">Example</A>
    <DT><H3>子 文件夹</H3>
    <DL><p><DT><A HREF="HTTPS://EXAMPLE.COM/a?b=2&a=1#x">A 页面</A></DL><p>
  </DL><p>
  <DT><A HREF="https://other.example.com/">Other</A>
</DL><p>`;

const FILE_B = `<DL><p>
  <DT><A HREF="https://example.com">Example dup variant</A>
  <DT><A HREF="ftp://nope/">bad protocol</A>
  <DT><A HREF="https://brand-new.example.com/">Brand New</A>
</DL><p>`;

(async () => {
  let passed = 0;
  const ok = (cond, label) => {
    assert.ok(cond, label);
    passed++;
  };

  // First import.
  const r1 = await request('POST', '/api/import/bookmarks', multipart(FILE_A, '我的 书签.html'));
  assert.strictEqual(r1.status, 200, `first import status ${r1.status}: ${JSON.stringify(r1.json)}`);
  ok(r1.json.imported_count === 3, 'first import: 3 imported');
  ok(r1.json.failed_count === 0, 'first import: 0 failed');
  ok(r1.json.total === 3, 'first import: total 3');

  // Counts/detail invariant.
  const d = r1.json.details;
  ok(
    d.imported.length + d.skipped.length + d.failures.length === r1.json.total,
    'counts equal detail rows'
  );

  // Hierarchy created.
  const cats1 = (await request('GET', '/api/categories')).json;
  const byName = Object.fromEntries(cats1.map((c) => [c.name + ':' + (c.parent_id ?? 0), c]));
  const parent = byName['父 文件夹:0'];
  const child = byName['子 文件夹:' + parent.id];
  ok(parent && child, 'parent and child categories exist');
  ok(child.parent_id === parent.id, 'child parent_id points to parent');

  // Link is inside the child folder.
  const links1 = (await request('GET', '/api/links?limit=100')).json;
  const pageA = links1.links.find((l) => l.url.includes('/a'));
  ok(pageA && pageA.category_id === child.id, 'nested link attached to child category');

  // Filtering by parent includes subtree.
  const parentLinks = (await request('GET', `/api/links?category=${parent.id}&limit=100`)).json;
  ok(parentLinks.total === 2, 'parent category filter includes child folder links');

  // Re-import same file: everything skipped, nothing inserted.
  const r2 = await request('POST', '/api/import/bookmarks', multipart(FILE_A));
  ok(r2.json.imported_count === 0, 're-import: 0 imported');
  ok(r2.json.skipped_count === 3, 're-import: 3 skipped');
  const linksAfterRe = (await request('GET', '/api/links?limit=100')).json;
  ok(linksAfterRe.total === 3, 're-import: link count unchanged (no duplicate inserts)');

  // Second file: URL variant dedupes, invalid reported, new imported.
  const r3 = await request('POST', '/api/import/bookmarks', multipart(FILE_B));
  ok(r3.json.imported_count === 1, 'file B: 1 imported');
  ok(r3.json.skipped_count === 1, 'file B: 1 duplicate skipped');
  ok(r3.json.failed_count === 1, 'file B: 1 failure reported');
  ok(r3.json.details.failures[0].index != null, 'failure has entry index');
  ok(r3.json.details.failures[0].line === 3, 'failure has correct line number');
  const linksAfterB = (await request('GET', '/api/links?limit=100')).json;
  ok(linksAfterB.total === 4, 'file B: only missing link inserted');

  // Same-named child under a different parent stays distinct.
  const FILE_C = `<DL><p><DT><H3>另一个 父</H3><DL><p><DT><H3>子 文件夹</H3><DL><p><DT><A HREF="https://c.example.com/">C</A></DL><p></DL><p></DL><p>`;
  const r4 = await request('POST', '/api/import/bookmarks', multipart(FILE_C));
  ok(r4.json.imported_count === 1, 'file C: imported');
  const cats4 = (await request('GET', '/api/categories')).json;
  const sameNameChildren = cats4.filter((c) => c.name === '子 文件夹');
  ok(sameNameChildren.length === 2, 'same-named subfolders kept distinct under different parents');

  // Deleting parent cascades to child but keeps links.
  const del = await request('DELETE', `/api/categories/${parent.id}`);
  ok(del.status === 200, 'delete parent category ok');
  const catsAfter = (await request('GET', '/api/categories')).json;
  ok(!catsAfter.some((c) => c.id === child.id), 'child category cascade-deleted');
  const orphan = (await request('GET', '/api/links?limit=100')).json.links.find((l) => l.url.includes('/a'));
  ok(orphan && orphan.category_id === null, 'links survive parent delete with null category');

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`import: ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
