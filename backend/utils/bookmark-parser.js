/**
 * Parse Chrome/Firefox/Netscape bookmark HTML file
 *
 * Robust against:
 * - Whitespace/case variations in tags (<dt><a href=...>, <DL><p>)
 * - Several elements sharing one line (e.g. </DL><p><DT><A ...>)
 * - Folders nested to any depth (hierarchy preserved via `folderPath`)
 * - Quoted/unquoted attribute values
 * - HTML entities in titles and folder names (&amp; &#39; etc.)
 *
 * Returns { items, failures } where:
 * - items: [{ url, rawUrl, title, folderPath: string[] }]
 * - failures: [{ line, title, rawUrl, reason }] (1-based line numbers)
 */

const MAX_DEPTH = 32;

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function decodeHtmlEntities(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(parseInt(code, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
    }[name]));
}

function decodeHref(value) {
  // HTML entities first (&amp; -> &), then percent-encoding.
  const htmlDecoded = decodeHtmlEntities(value);
  let decoded = htmlDecoded;
  try {
    decoded = decodeURIComponent(htmlDecoded);
  } catch {
    // Malformed percent encoding — keep the value instead of crashing.
    decoded = htmlDecoded;
  }
  // Strip control characters.
  return decoded.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/** Parse the attribute section of a tag, e.g. `HREF="x" ICON="y"`. */
function parseAttributes(attrText) {
  const attrs = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(attrText)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = value;
  }
  return attrs;
}

const TRACKING_PARAMS = new Set(['gclid', 'fbclid', 'spm', 'msclkid', 'yclid', 'mc_cid', 'mc_eid', 'igshid']);
const isTracking = (key) =>
  TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_');

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Normalize a URL for duplicate detection.
 *
 * Deliberately conservative — anything ambiguous is preserved:
 * - lowercase scheme and host, strip default ports (80/443) and userinfo
 * - drop the fragment
 * - drop tracking params (utm_*, gclid, fbclid, spm, ...) and sort the rest
 * - resolve "."/".." path segments and unify percent-encoding
 * - empty path becomes "/", so "https://host" == "https://host/"
 * Returns null when the value is not an http(s) URL.
 */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.protocol = url.protocol.toLowerCase();
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  url.hash = '';

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isTracking(key))
    // Parameter names are treated case-insensitively; values are kept as-is
    // (they may be case-sensitive tokens).
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([aK, aV], [bK, bV]) => (aK === bK ? aV.localeCompare(bV) : aK.localeCompare(bK)));
  url.search = params.length
    ? '?' + params.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&')
    : '';

  // Resolve "."/".." on the raw encoded segments so an encoded slash
  // (%2F) inside a segment is never mistaken for a path boundary.
  const rawSegments = url.pathname.split('/');
  const resolved = [];
  for (const segment of rawSegments) {
    if (segment === '..') {
      resolved.pop();
    } else if (segment !== '.') {
      resolved.push(segment);
    }
  }
  let normalizedPath;
  try {
    normalizedPath = resolved
      .map((segment) => {
        // Decode only to re-encode: unifies %7E/~ style variants while
        // keeping encoded slashes (%2F) encoded.
        const decoded = decodeURIComponent(segment);
        return encodeRfc3986(decoded);
      })
      .join('/');
    if (normalizedPath === '') normalizedPath = '/';
    if (url.pathname.endsWith('/') && !normalizedPath.endsWith('/')) normalizedPath += '/';
  } catch {
    normalizedPath = url.pathname || '/';
  }
  url.pathname = normalizedPath;

  return url.toString().replace(/\?$/, '');
}

// Matched in document order so nesting stays correct even when several
// tags share one line.
const TOKEN_PATTERN =
  /<H3\b[^>]*>([\s\S]*?)<\/H3\s*>|<DL\b[^>]*>|<\/DL\s*>|<A\b([^>]*?)(?:\/?)>([\s\S]*?)<\/A\s*>/gi;

function parseBookmarks(html) {
  const source = String(html ?? '');
  const items = [];
  const failures = [];
  // folderStack holds open folder names in document order; the root <DL>
  // (which has no H3) is never pushed.
  const folderStack = [];
  let pendingFolder = null;

  let match;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(source)) !== null) {
    const token = match[0];
    const line = source.slice(0, match.index).split('\n').length;

    if (/^<H3\b/i.test(token)) {
      pendingFolder = decodeHtmlEntities(match[1]).trim() || '未命名文件夹';
    } else if (/^<DL\b/i.test(token)) {
      if (pendingFolder) {
        if (folderStack.length >= MAX_DEPTH) {
          failures.push({
            line,
            title: pendingFolder,
            rawUrl: '',
            reason: `文件夹层级超过 ${MAX_DEPTH} 层，更深层的内容按上级目录处理`,
          });
          // Keep pendingFolder null so children attach to the parent folder.
        } else {
          folderStack.push(pendingFolder);
        }
        pendingFolder = null;
      }
    } else if (/^<\/DL/i.test(token)) {
      folderStack.pop();
      pendingFolder = null;
    } else if (/^<A\b/i.test(token)) {
      const attrs = parseAttributes(match[2] ?? '');
      const rawUrl = decodeHref(attrs.href ?? '');
      const title = decodeHtmlEntities(match[3] ?? '').trim();

      if (!rawUrl) {
        failures.push({ line, title, rawUrl, reason: '缺少 HREF 属性' });
        continue;
      }
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) {
        failures.push({ line, title, rawUrl, reason: '不是有效的 http/https 网址' });
        continue;
      }

      items.push({
        url: normalized,
        rawUrl,
        title: title || normalized,
        folderPath: folderStack.slice(),
        line,
      });
    }
  }

  return { items, failures };
}

module.exports = { parseBookmarks, normalizeUrl, decodeHtmlEntities };
