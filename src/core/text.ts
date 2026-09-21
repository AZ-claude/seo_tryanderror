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

/**
 * Path-only comparison key for a page reference that may be either a bare
 * site-relative path (Action.targetPaths convention) or a full URL
 * (MeasurementPlan.targetPages convention, matching GSC's page field) — the
 * page-conflict guard needs to recognize both spellings of the same page.
 */
export function toComparablePath(value: string): string {
  try {
    return normalizePath(new URL(value).pathname);
  } catch {
    return normalizePath(value);
  }
}

/** Rough word count for CJK+space-delimited text: counts whitespace-separated tokens plus CJK characters. */
export function countWords(text: string): number {
  const withoutCjk = text.replace(/[　-ヿ㐀-鿿豈-﫿]/gu, ' ');
  const latinTokens = withoutCjk.split(/\s+/).filter((t) => t.length > 0).length;
  const cjkChars = (text.match(/[　-ヿ㐀-鿿豈-﫿]/gu) ?? []).length;
  return latinTokens + cjkChars;
}
