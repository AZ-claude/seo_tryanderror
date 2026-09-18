/** NFKC, lowercase, whitespace-stripped. Shared normalization for GSC queries and cluster scope keys. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** Normalizes a site-relative path: ensures a leading slash, strips a trailing slash (except root). */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
    return withLeadingSlash.slice(0, -1);
  }
  return withLeadingSlash;
}

/** Rough word count for CJK+space-delimited text: counts whitespace-separated tokens plus CJK characters. */
export function countWords(text: string): number {
  const withoutCjk = text.replace(/[　-ヿ㐀-鿿豈-﫿]/gu, ' ');
  const latinTokens = withoutCjk.split(/\s+/).filter((t) => t.length > 0).length;
  const cjkChars = (text.match(/[　-ヿ㐀-鿿豈-﫿]/gu) ?? []).length;
  return latinTokens + cjkChars;
}
