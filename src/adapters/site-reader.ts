import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { extractSameOriginLinks, extractSitemapLocs, parsePage } from '../core/html.js';
import type { SiteReaderAdapter } from '../core/types.js';

export type FetchLike = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;

export type HttpSiteReaderOptions = {
  baseUrl: string;
  maxPages?: number;
  maxCrawlDepth?: number;
  fetchImpl?: FetchLike;
  userAgent?: string;
};

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_CRAWL_DEPTH = 2;

/**
 * Read-only site reader over HTTP (DESIGN.md 9.1). Deliberately has no write
 * methods, so a Milestone 1A command cannot reach a site-mutation code path
 * even by mistake. Prefers sitemap.xml; falls back to a bounded shallow
 * crawl from baseUrl. Respects robots.txt Disallow rules for the relevant
 * user-agent (or "*").
 */
export class HttpSiteReaderAdapter implements SiteReaderAdapter {
  constructor(private readonly options: HttpSiteReaderOptions) {}

  private get fetchImpl(): FetchLike {
    return this.options.fetchImpl ?? ((url: string) => fetch(url));
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  private async loadRobotsDisallow(): Promise<string[]> {
    const robotsUrl = new URL('/robots.txt', this.options.baseUrl).toString();
    const text = await this.fetchText(robotsUrl);
    if (!text) return [];
    const disallow: string[] = [];
    let applies = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (/^user-agent:/i.test(line)) {
        const ua = line.slice(line.indexOf(':') + 1).trim();
        applies = ua === '*' || ua.toLowerCase() === (this.options.userAgent ?? '').toLowerCase();
      } else if (applies && /^disallow:/i.test(line)) {
        const path = line.slice(line.indexOf(':') + 1).trim();
        if (path) disallow.push(path);
      }
    }
    return disallow;
  }

  private isDisallowed(url: string, disallow: string[]): boolean {
    const path = new URL(url).pathname;
    return disallow.some((rule) => rule !== '' && path.startsWith(rule));
  }

  async listPages(): Promise<Array<{ path: string; source: 'sitemap' | 'crawl' }>> {
    const maxPages = this.options.maxPages ?? DEFAULT_MAX_PAGES;
    const disallow = await this.loadRobotsDisallow();

    const sitemapUrl = new URL('/sitemap.xml', this.options.baseUrl).toString();
    const sitemapXml = await this.fetchText(sitemapUrl);
    if (sitemapXml) {
      const urls = extractSitemapLocs(sitemapXml).filter((u) => !this.isDisallowed(u, disallow));
      return urls.slice(0, maxPages).map((path) => ({ path, source: 'sitemap' as const }));
    }

    const maxDepth = this.options.maxCrawlDepth ?? DEFAULT_MAX_CRAWL_DEPTH;
    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: this.options.baseUrl, depth: 0 }];
    const result: string[] = [];

    while (queue.length > 0 && result.length < maxPages) {
      const next = queue.shift()!;
      if (visited.has(next.url) || this.isDisallowed(next.url, disallow)) continue;
      visited.add(next.url);
      const html = await this.fetchText(next.url);
      if (html === null) continue;
      result.push(next.url);
      if (next.depth < maxDepth) {
        for (const link of extractSameOriginLinks(html, next.url)) {
          if (!visited.has(link)) queue.push({ url: link, depth: next.depth + 1 });
        }
      }
    }
    return result.slice(0, maxPages).map((path) => ({ path, source: 'crawl' as const }));
  }

  async readPage(path: string): ReturnType<SiteReaderAdapter['readPage']> {
    const html = await this.fetchText(path);
    if (html === null) throw new Error(`failed to fetch page: ${path}`);
    const parsed = parsePage(html);
    return { path, html, text: parsed.text, title: parsed.title, headings: parsed.headings };
  }
}

const CONTENT_EXTENSIONS = new Set(['.html', '.htm', '.md']);

/**
 * Read-only reader over a local content directory (DESIGN.md 9.1). No apply
 * method exists on this type — Milestone 2's SiteWriterAdapter is separate.
 */
export class FilesystemSiteReaderAdapter implements SiteReaderAdapter {
  constructor(private readonly contentRoot: string) {}

  async listPages(): Promise<Array<{ path: string; source: 'sitemap' | 'crawl' }>> {
    const files: string[] = [];
    async function walk(dir: string, root: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, root);
        } else if (CONTENT_EXTENSIONS.has(extname(entry.name))) {
          files.push(`/${relative(root, full).split('\\').join('/')}`);
        }
      }
    }
    await walk(this.contentRoot, this.contentRoot);
    return files.sort().map((path) => ({ path, source: 'crawl' as const }));
  }

  async readPage(path: string): ReturnType<SiteReaderAdapter['readPage']> {
    const file = join(this.contentRoot, path.replace(/^\/+/, ''));
    const raw = await readFile(file, 'utf8');
    if (extname(file) === '.html' || extname(file) === '.htm') {
      const parsed = parsePage(raw);
      return { path, html: raw, text: parsed.text, title: parsed.title, headings: parsed.headings };
    }
    // Markdown: treat as plain text; headline extraction via leading '#'/'##' lines.
    const headings = raw
      .split('\n')
      .filter((line) => /^#{1,6}\s+/.test(line))
      .map((line) => line.replace(/^#{1,6}\s+/, '').trim());
    const titleLine = raw.split('\n').find((line) => /^#\s+/.test(line));
    return {
      path,
      html: raw,
      text: raw.replace(/^#{1,6}\s+.*$/gm, '').trim(),
      title: titleLine?.replace(/^#\s+/, '').trim(),
      headings,
    };
  }
}

export type FixturePage = {
  path: string;
  title?: string;
  headings: string[];
  text: string;
  html?: string;
};

/**
 * Test/`--fixture`-mode reader: serves a fixed, in-memory set of pages.
 * Never performs network or filesystem access to a real site.
 */
export class FixtureSiteReaderAdapter implements SiteReaderAdapter {
  constructor(private readonly pages: FixturePage[]) {}

  async listPages(): Promise<Array<{ path: string; source: 'sitemap' | 'crawl' }>> {
    return this.pages.map((p) => ({ path: p.path, source: 'sitemap' as const }));
  }

  async readPage(path: string): ReturnType<SiteReaderAdapter['readPage']> {
    const page = this.pages.find((p) => p.path === path);
    if (!page) throw new Error(`no fixture page for path: ${path}`);
    return { path: page.path, html: page.html ?? page.text, text: page.text, title: page.title, headings: page.headings };
  }
}
