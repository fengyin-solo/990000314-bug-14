/* End-to-end regression for bookmark import. Run with the test DB server up. */
const assert = require('assert');
const http = require('http');

const BASE = { hostname: 'localhost', port: 3004 };

function request(method, path, { token, body, formFile } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers['Content-Type'] = 'application/json';
      payload = Buffer.from(JSON.stringify(body));
    }
    if (formFile) {
      const boundary = '----regboundary';
      const head = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`),
        Buffer.from(formFile.filename, 'utf8'),
        Buffer.from(`"\r\nContent-Type: text/html\r\n\r\n`),
      ]);
      payload = Buffer.concat([head, formFile.content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    }
    headers['Content-Length'] = payload ? payload.length : 0;
    const req = http.request({ ...BASE, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const FILE_A = Buffer.from(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<DL><p>
<DT><H3>收藏夹 根</H3>
<DL><p>
  <DT><H3>技术</H3>
  <DL><p>
    <DT><H3>前端 框架</H3>
    <DL><p>
      <DT><A HREF="https://Vuejs.org/guide/introduction.html#start">Vue 指南 &amp; 教程</A>
      <DT><A HREF="https://cn.vitejs.dev/guide/?utm_source=mail">Vite 指南</A>
    </DL><p>
  </DL><p>
  <DT><H3>前端 框架</H3>
  <DL><p>
    <DT><A HREF="https://react.dev/learn">React 学习</A>
  </DL><p>
  <DT><A HREF="https://nodejs.org/en/docs">Node 文档</A>
</DL><p>
<DT><A HREF="https://example.com/">裸链 书签</A>
<DT><A HREF="ftp://files.example.com/a.zip">FTP 服务器</A>
</DL><p>`, 'utf8');

const FILE_B = Buffer.from(`<DL><p>
<DT><H3>收藏夹 根</H3><DL><p>
<DT><A HREF="https://vuejs.org/guide/introduction.html/">Vue again trailing slash</A>
<DT><A HREF="https://news.ycombinator.com/">Hacker News 新的</A>
</DL><p></DL><p>`, 'utf8');

(async () => {
  const username = 'reg_' + Date.now();
  await request('POST', '/api/auth/register', { body: { username, email: `${username}@x.com`, password: 'pass1234' } });
  const login = await request('POST', '/api/auth/login', { body: { username, password: 'pass1234' } });
  const token = login.json.token;

  // --- import #1 ---
  const r1 = await request('POST', '/api/import/bookmarks', { token, formFile: { filename: '我的 书签.html', content: FILE_A } });
  assert.strictEqual(r1.status, 200, `import1 status ${r1.status}: ${r1.text}`);
  assert.strictEqual(r1.json.imported, 5, 'import1 imported');
  assert.strictEqual(r1.json.failed, 1, 'import1 failed (ftp)');
  assert.strictEqual(r1.json.total, r1.json.imported + r1.json.skipped + r1.json.failed, 'counts add up');
  const ftp = r1.json.details.find((d) => d.status === 'failed');
  assert.ok(/ftp/i.test(ftp.reason) && ftp.index >= 1 && ftp.line >= 1, 'failure row has index/line/reason');

  // hierarchy preserved: two distinct "前端 框架" categories
  const tree = (await request('GET', '/api/categories/tree', { token })).json;
  const root = tree.find((n) => n.name === '收藏夹 根');
  assert.ok(root, 'top folder created');
  const tech = root.children.find((n) => n.name === '技术');
  assert.ok(tech, 'nested 技术 folder created');
  const nestedFrontend = tech.children.find((n) => n.name === '前端 框架');
  assert.ok(nestedFrontend, '技术/前端 框架 exists');
  const siblingFrontend = root.children.find((n) => n.name === '前端 框架');
  assert.ok(siblingFrontend, '收藏夹 根/前端 框架 exists as a SEPARATE node');
  assert.notStrictEqual(nestedFrontend.id, siblingFrontend.id, 'same-name subfolders do not collapse');

  // tags/entities decoded check via links list
  const links1 = (await request('GET', '/api/links?limit=50', { token })).json;
  assert.strictEqual(links1.total, 5, 'list total equals imported count');
  const vue = links1.links.find((l) => l.url.startsWith('https://Vuejs.org'));
  assert.ok(vue, 'original-case url preserved');
  assert.ok(vue.title.includes('&'), 'HTML entity decoded: ' + vue.title);
  assert.ok(!vue.title.includes('&amp;'), 'no raw entity left');

  // --- import #2: normalized dup (fragment+case+trailing slash) + 1 new ---
  const r2 = await request('POST', '/api/import/bookmarks', { token, formFile: { filename: 'b.html', content: FILE_B } });
  assert.strictEqual(r2.status, 200, `import2 status ${r2.status}: ${r2.text}`);
  assert.strictEqual(r2.json.imported, 1, 'import2 only inserts missing');
  assert.strictEqual(r2.json.skipped, 1, 'import2 normalized dup skipped');
  assert.strictEqual(r2.json.total, 2, 'server total reflects this file details only');
  const skipRow = r2.json.details.find((d) => d.status === 'skipped');
  assert.ok(skipRow.reason && skipRow.index === 1, 'skip row explains why and where');

  // --- server count must equal page rows, no double insert ---
  const links2 = (await request('GET', '/api/links?limit=50', { token })).json;
  assert.strictEqual(links2.total, 6, 'one new link after re-import, not re-inserted');
  assert.strictEqual(links2.links.length, 6, 'page rows match server total');

  // --- manual POST normalized duplicate rejected ---
  const dup = await request('POST', '/api/links', { token, body: { url: 'https://VUEJS.ORG/guide/introduction.html?utm_source=x', title: 'dup manual' } });
  assert.strictEqual(dup.status, 409, 'manual normalized duplicate rejected');

  // --- non-html upload rejected with clear message ---
  const bad = await request('POST', '/api/import/bookmarks', {
    token,
    formFile: { filename: 'not.txt', content: Buffer.from('hello') },
  });
  assert.strictEqual(bad.status, 400, 'non-html rejected');
  assert.ok(bad.json.error && bad.json.error.length > 0, 'error message present');

  console.log('✅ ALL E2E ASSERTIONS PASSED');
  console.log('   import#1:', r1.json.message);
  console.log('   import#2:', r2.json.message);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
