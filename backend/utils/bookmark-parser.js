/**
 * Parse Netscape-style bookmark HTML files (Chrome / Edge / Firefox exports).
 *
 * The previous implementation walked the file line by line and guessed folder
 * boundaries from raw lines. That lost folder nesting (two different folders
 * named the same collapsed into one category), broke whenever a line did not
 * look exactly like a Chrome export and never decoded HTML entities.
 *
 * This version tokenizes the document by tag, keeps an explicit folder stack
 * keyed by <DL> nesting depth, decodes entity-encoded names and also reads the
 * TAGS attribute used by Firefox / Edge exports.
 */

// All structural tags; inner text is read explicitly for <H3>/<A>.
const TAG_RE = /<\/?(?:DL|DT|DD|H3|A)\b[^>]*>/gi;
const ATTR_RE = /([A-Z_:][-\w:]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s">]+)/gi;

/**
 * @param {string} html
 * @returns {{
 *   bookmarks: Array<{ url: string, title: string, tags: string[], folders: string[], line: number }>,
 *   invalid: Array<{ line: number, title: string, url: string, reason: string }>
 * }}
 */
function parseBookmarks(html) {
  const bookmarks = [];
  const invalid = [];

  if (typeof html !== 'string' || html.length === 0) {
    return { bookmarks, invalid };
  }

  // Names of the folder that owns each open <DL>; the document root is null.
  const dlOwners = [null];
  const folderStack = [];
  let lastHeader = null; // <H3> name waiting for its <DL> to open

  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(html)) !== null) {
    const raw = match[0];
    const tagName = /^<\/?([A-Z0-9]+)/i.exec(raw)[1].toUpperCase();
    const isClose = raw[1] === '/';
    const line = lineAt(html, match.index);

    if (tagName === 'DL') {
      if (isClose) {
        if (dlOwners.length > 1) {
          const owner = dlOwners.pop();
          if (owner !== null) folderStack.pop();
        }
      } else {
        // The list belongs to the immediately preceding <H3> header.
        dlOwners.push(lastHeader);
        if (lastHeader !== null) folderStack.push(lastHeader);
        lastHeader = null;
      }
      continue;
    }

    if (tagName === 'H3') {
      if (isClose) continue;
      const content = readInnerContent(html, TAG_RE.lastIndex, 'H3');
      const name = content.text.trim();
      TAG_RE.lastIndex = content.endIndex;
      lastHeader = name || null;
      continue;
    }

    if (tagName === 'A') {
      if (isClose) continue;
      const attrs = parseAttributes(raw);
      const content = readInnerContent(html, TAG_RE.lastIndex, 'A');
      const rawTitle = content.text.trim();
      TAG_RE.lastIndex = content.endIndex;

      if (!attrs.href) {
        invalid.push({ line, title: rawTitle, url: '', reason: '链接缺少 HREF 地址' });
        continue;
      }

      if (!/^https?:\/\//i.test(attrs.href)) {
        invalid.push({
          line,
          title: rawTitle,
          url: attrs.href,
          reason: `不支持的链接类型（仅支持 http/https）: ${attrs.href}`,
        });
        continue;
      }

      const title = rawTitle || hostFromUrl(attrs.href) || attrs.href;
      const tags = attrs.tags
        ? attrs.tags.split(/[,，;:]/).map((t) => t.trim()).filter(Boolean)
        : [];

      bookmarks.push({
        url: attrs.href,
        title,
        tags,
        folders: [...folderStack],
        line,
      });
      // A link can never open the pending folder's list, so any <H3> that was
      // not followed by its <DL> is an orphan header.
      lastHeader = null;
      continue;
    }
    // <DT>/<DD> carry no information we need; folder depth comes from <DL>.
  }

  return { bookmarks, invalid };
}

/**
 * Read text up to the closing tag of `name`. Browsers entity-encode folder
 * names and link titles, so decode them and strip any stray inner tags.
 * If the closing tag is missing (truncated / malformed files), fall back to
 * the next structural tag instead of swallowing the rest of the document.
 */
function readInnerContent(html, fromIndex, name) {
  const closeRe = new RegExp(`</${name}\\s*>`, 'i');
  const closeMatch = closeRe.exec(html.slice(fromIndex));
  let textEnd;
  let endIndex;

  if (closeMatch) {
    textEnd = fromIndex + closeMatch.index;
    endIndex = textEnd + closeMatch[0].length;
  } else {
    const nextStructural = /<\/?(?:DL|DT|DD|H3)\b/i.exec(html.slice(fromIndex));
    textEnd = nextStructural ? fromIndex + nextStructural.index : html.length;
    endIndex = textEnd;
  }

  return {
    text: decodeEntities(stripTags(html.slice(fromIndex, textEnd))),
    endIndex,
  };
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, '');
}

function parseAttributes(tagText) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tagText)) !== null) {
    const name = m[1].toLowerCase();
    const value = ((m[3] ?? m[4] ?? m[2]) ?? '').trim();
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function lineAt(html, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (html.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Decode the numeric/named entities browsers actually emit in bookmark files. */
function decodeEntities(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => {
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      return map[name.toLowerCase()];
    });
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

module.exports = { parseBookmarks, decodeEntities };
