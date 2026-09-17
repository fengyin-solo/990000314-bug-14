/**
 * URL normalization used for duplicate detection.
 *
 * Two bookmarks that only differ by a trailing slash, host casing, a default
 * port, a #fragment, tracking parameters or query-string order must be
 * considered the same entry.
 */

// Query parameters that never identify a resource and only add noise.
const STRIP_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'gclid',
  'fbclid',
  'msclkid',
  'ref',
  'ref_src',
  'spm',
]);

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * Normalize a URL string.
 *
 * @param {string} rawUrl
 * @returns {{ ok: true, normalized: string } | { ok: false, reason: string }}
 */
function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return { ok: false, reason: 'URL 不是文本' };
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: `URL 无法解析: ${truncate(rawUrl)}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `不支持的协议 ${url.protocol}（仅支持 http/https）` };
  }

  // Host is case-insensitive; remove dot suffix and default port.
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }

  const port =
    url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';

  // Path: collapse repeated slashes, percent-unescode safe characters, drop the
  // trailing slash (root path stays '/').
  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  pathname = decodeSafePath(pathname);
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Query: drop tracking params and sort the rest so order does not matter.
  const params = [];
  for (const [key, value] of url.searchParams) {
    if (STRIP_QUERY_PARAMS.has(key.toLowerCase())) continue;
    params.push([key, value]);
  }
  params.sort(([ka, va], [kb, vb]) =>
    ka === kb ? va.localeCompare(vb) : ka.localeCompare(kb)
  );
  const search = params.length
    ? '?' + params.map(([k, v]) => `${encodeQueryPart(k)}=${encodeQueryPart(v)}`).join('&')
    : '';

  // Fragments identify a page position, not a different resource.
  const normalized = `${url.protocol}//${host}${port}${pathname}${search}`;
  return { ok: true, normalized };
}

function truncate(s, n = 80) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// new URL keeps percent-encoded bytes as-is; un-encode the ones that are
// equivalent to their plain form so %7Eexample and ~example match.
const UNESCAPED_SAFE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@"
);

function decodeSafePath(pathname) {
  return pathname.replace(/%[0-9A-Fa-f]{2}/g, (seq) => {
    const ch = String.fromCharCode(parseInt(seq.slice(1), 16));
    return UNESCAPED_SAFE.has(ch) ? ch : seq.toUpperCase();
  });
}

function encodeQueryPart(part) {
  return part.replace(/[^0-9A-Za-z'!()*+._~-]/g, (ch) =>
    encodeURIComponent(ch)
  );
}

module.exports = { normalizeUrl };
