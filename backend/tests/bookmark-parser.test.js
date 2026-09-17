/**
 * Unit tests for the bookmark parser and URL normalizer.
 * Run: node tests/bookmark-parser.test.js
 */
const assert = require('assert');
const { parseBookmarks, normalizeUrl } = require('../utils/bookmark-parser');

let passed = 0;
function check(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label);
  passed++;
}

// --- normalizeUrl ---
check('no trailing slash', normalizeUrl('https://example.com'), 'https://example.com/');
check('trailing slash', normalizeUrl('https://example.com/'), 'https://example.com/');
check('uppercase scheme/host', normalizeUrl('HTTPS://EXAMPLE.COM'), 'https://example.com/');
check('fragment stripped', normalizeUrl('https://example.com/#frag'), 'https://example.com/');
check('default https port', normalizeUrl('https://example.com:443/a'), 'https://example.com/a');
check('default http port', normalizeUrl('http://example.com:80'), 'http://example.com/');
check('query sorted', normalizeUrl('https://example.com?b=2&a=1'), 'https://example.com/?a=1&b=2');
check('tracking params removed', normalizeUrl('https://example.com?utm_source=x&id=9'), 'https://example.com/?id=9');
check('dot segments resolved', normalizeUrl('https://example.com/a/../b/./c'), 'https://example.com/b/c');
check('encoded slash preserved', normalizeUrl('https://example.com/a%2fb'), 'https://example.com/a%2Fb');
check('tilde unescaped', normalizeUrl('https://example.com/%7Euser'), 'https://example.com/~user');
check('ftp rejected', normalizeUrl('ftp://example.com'), null);
check('garbage rejected', normalizeUrl('not a url'), null);
check('spaces rejected', normalizeUrl('http://a b.com'), null);
check('userinfo stripped', normalizeUrl('https://user:pwd@example.com/'), 'https://example.com/');

// Distinct URLs must NOT collapse:
check('different query sets kept', normalizeUrl('https://vuejs.org/') === normalizeUrl('https://vuejs.org/?a=1'), false);
check('different paths kept', normalizeUrl('https://x.com/a') === normalizeUrl('https://x.com/a/'), false);

// --- parser: hierarchy + robustness ---
const chromeHtml = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<DL><p>
    <DT><H3>书签栏</H3>
    <DL><p>
        <DT><A HREF="https://example.com/">Example</A>
        <DT><H3>开发 资料</H3>
        <DL><p>
            <DT><A HREF="https://developer.mozilla.org/zh-CN/" ICON="data:x">MDN &amp; Web Docs</A>
            <DT><H3>前端 框架</H3>
            <DL><p>
                <DT><A HREF="https://vuejs.org/?b=2&amp;a=1">Vue.js</A>
                <DT><A HREF="HTTPS://VueJS.org/?A=1&B=2#top">Vue dup</A>
            </DL><p>
        </DL><p>
    </DL><p>
</DL><p>`;

const { items, failures } = parseBookmarks(chromeHtml);
check('parsed item count', items.length, 4);
check('no parse failures', failures.length, 0);
check('top-level path', items[0].folderPath, ['书签栏']);
check('nested path depth 2', items[1].folderPath, ['书签栏', '开发 资料']);
check('nested path depth 3', items[2].folderPath, ['书签栏', '开发 资料', '前端 框架']);
check('html entity decoded in title', items[1].title, 'MDN & Web Docs');
check('html entity decoded in href', items[2].rawUrl, 'https://vuejs.org/?b=2&a=1');
check('query order + case normalized equal', items[3].url, items[2].url);
check('1-based lines present', items.every((i) => typeof i.line === 'number' && i.line > 0), true);

// Several elements sharing one line must not be dropped.
const compactHtml = '<DL><p><DT><H3>父 目录</H3><DL><p><DT><A HREF="https://react.dev/">React &amp; 文档</A></DL><p></DL><p>';
const compact = parseBookmarks(compactHtml);
check('compact line parsed count', compact.items.length, 1);
check('compact line nesting', compact.items[0].folderPath, ['父 目录']);
check('compact line title entity', compact.items[0].title, 'React & 文档');

// Invalid entries are reported with line and reason.
const invalidHtml = ['<DL><p>',
  '<DT><A HREF="ftp://x/a">f</A>',
  '<DT><A HREF="">empty</A>',
  '<DT><A HREF="https://ok.com/">ok</A>',
  '</DL><p>'].join('\n');
const invalid = parseBookmarks(invalidHtml);
check('invalid: one good item', invalid.items.length, 1);
check('invalid: two failures', invalid.failures.length, 2);
check('invalid: failure line 2', invalid.failures[0].line, 2);
check('invalid: reason text', invalid.failures[0].reason, '不是有效的 http/https 网址');
check('invalid: missing href line 3', invalid.failures[1].line, 3);

// Garbage file yields nothing and throws nothing.
check('garbage input', (() => {
  const r = parseBookmarks('totally not html');
  return r.items.length + r.failures.length;
})(), 0);

console.log(`bookmark-parser: ${passed} assertions passed`);
