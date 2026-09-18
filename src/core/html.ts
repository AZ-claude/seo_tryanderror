// Minimal, dependency-free HTML/XML parsing helpers. Good enough for
// extracting text/headings/links from real-world pages and fixture HTML in
// tests; not a full HTML parser (YAGNI: no external HTML lib per DESIGN.md).

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1] ?? '') || undefined : undefined;
}

export function extractHeadings(html: string): string[] {
  const headings: string[] = [];
  const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const text = stripTags(match[1] ?? '');
    if (text) headings.push(text);
  }
  return headings;
}

export function extractBodyText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return stripTags(withoutScripts);
}

export function parsePage(html: string): { title?: string; headings: string[]; text: string } {
  return {
    title: extractTitle(html),
    headings: extractHeadings(html),
    text: extractBodyText(html),
  };
}

/** Extracts <loc> URLs from a sitemap.xml (or sitemap index) document. */
export function extractSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const url = decodeEntities((match[1] ?? '').trim());
    if (url) locs.push(url);
  }
  return locs;
}

/** Extracts same-origin hrefs from an HTML page, for the shallow-crawl fallback. */
export function extractSameOriginLinks(html: string, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const links = new Set<string>();
  const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[1]!;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.origin === origin) {
        resolved.hash = '';
        links.add(resolved.toString());
      }
    } catch {
      // ignore malformed hrefs (mailto:, javascript:, etc.)
    }
  }
  return [...links];
}
