// Article / news extractor.
//
// Three strategies in priority order:
//   1. RSS / Atom feed if discoverable from <link rel="alternate">.
//      Most reliable: structured, recently updated.
//   2. Schema.org NewsArticle / Article / BlogPosting.
//   3. CSS selectors over the home page article cards.
//
// Output is normalized so the planning agent can read latest_articles
// regardless of source.

import { parseHTML } from "linkedom";

import type { ParsedHtml } from "./html-parser.js";
import { extractJsonLd, stringField } from "./json-ld.js";

export interface ArticleEntry {
  title: string;
  url: string | null;
  description: string | null;
  published_at: string | null;
  author: string | null;
  source: "rss_feed" | "json_ld" | "css_selector";
}

export interface ExtractArticlesOptions {
  selectors?: string[];
  maxItems?: number;
  /** When provided, fetch the RSS feed URL and parse it. */
  rss_url?: string;
  /** Caller-injected fetch function so we can mock in tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export async function extractArticles(
  parsed: ParsedHtml,
  options?: ExtractArticlesOptions,
): Promise<ArticleEntry[]> {
  const maxItems = options?.maxItems ?? 30;
  const out: ArticleEntry[] = [];
  const seenKeys = new Set<string>();

  // Strategy 1: RSS feed.
  if (options?.rss_url) {
    try {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const res = await fetchImpl(options.rss_url, {
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml" },
      });
      if (res.ok) {
        const text = await res.text();
        const feedEntries = parseFeed(text, maxItems);
        for (const entry of feedEntries) {
          if (out.length >= maxItems) break;
          const key = (entry.url ?? entry.title).toLowerCase();
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          out.push(entry);
        }
      }
    } catch {
      // Fall through to other strategies on any RSS fetch failure.
    }
  }

  // Strategy 2: JSON-LD NewsArticle / Article / BlogPosting.
  if (out.length < maxItems) {
    const ldEntries = extractJsonLd(parsed, ["NewsArticle", "Article", "BlogPosting"]);
    for (const entry of ldEntries) {
      if (out.length >= maxItems) break;
      const title = stringField(entry, "headline") ?? stringField(entry, "name");
      if (!title) continue;
      const urlRaw = stringField(entry, "url") ?? stringField(entry, "mainEntityOfPage");
      const url = urlRaw ? parsed.resolveUrl(urlRaw) : null;
      const key = (url ?? title).toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      let author: string | null = null;
      const a = entry["author"];
      if (typeof a === "string") author = a;
      else if (a && typeof a === "object") {
        const ao = Array.isArray(a) ? a[0] : a;
        if (ao && typeof ao === "object") {
          author = (ao as Record<string, unknown>)["name"] as string | undefined ?? null;
        }
      }

      out.push({
        title,
        url,
        description: stringField(entry, "description") ?? null,
        published_at: stringField(entry, "datePublished") ?? null,
        author,
        source: "json_ld",
      });
    }
  }

  // Strategy 3: CSS selectors fallback.
  if (out.length < maxItems && options?.selectors && options.selectors.length > 0) {
    const cards = parsed.querySelectorAll(options.selectors);
    for (const card of cards) {
      if (out.length >= maxItems) break;
      const link = card.querySelector("a[href]");
      const url = link ? parsed.resolveUrl(link.getAttribute("href") ?? "") : null;

      const titleEl =
        card.querySelector("h1, h2, h3, [class*='title'], [class*='headline']") ?? link;
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      const key = (url ?? title).toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const descEl = card.querySelector("[class*='excerpt'], [class*='summary'], p");
      const description = descEl?.textContent?.trim() ?? null;

      out.push({
        title,
        url,
        description,
        published_at: null,
        author: null,
        source: "css_selector",
      });
    }
  }

  return out.slice(0, maxItems);
}

/**
 * Parse an RSS 2.0 or Atom feed and return up to maxItems entries.
 * linkedom can parse XML via its DOM API; we route both formats through
 * the same selector queries.
 */
function parseFeed(xml: string, maxItems: number): ArticleEntry[] {
  const out: ArticleEntry[] = [];
  try {
    const { document } = parseHTML(xml);

    // RSS 2.0: <item><title/><link/><description/><pubDate/></item>
    const rssItems = Array.from(document.querySelectorAll("channel > item, item"));
    for (const item of rssItems) {
      if (out.length >= maxItems) break;
      const title = item.querySelector("title")?.textContent?.trim();
      if (!title) continue;
      const linkEl = item.querySelector("link");
      const url = linkEl?.textContent?.trim() || linkEl?.getAttribute("href") || null;
      out.push({
        title,
        url,
        description: item.querySelector("description")?.textContent?.trim() ?? null,
        published_at: item.querySelector("pubDate")?.textContent?.trim() ?? null,
        author: item.querySelector("dc\\:creator, author")?.textContent?.trim() ?? null,
        source: "rss_feed",
      });
    }

    if (out.length === 0) {
      // Atom: <entry><title/><link href/><summary/><published/></entry>
      const atomEntries = Array.from(document.querySelectorAll("feed > entry, entry"));
      for (const entry of atomEntries) {
        if (out.length >= maxItems) break;
        const title = entry.querySelector("title")?.textContent?.trim();
        if (!title) continue;
        const linkEl = entry.querySelector("link[href]");
        const url = linkEl?.getAttribute("href") ?? null;
        out.push({
          title,
          url,
          description: entry.querySelector("summary, content")?.textContent?.trim() ?? null,
          published_at: entry.querySelector("published, updated")?.textContent?.trim() ?? null,
          author: entry.querySelector("author > name")?.textContent?.trim() ?? null,
          source: "rss_feed",
        });
      }
    }
  } catch {
    // Return whatever we collected up to the parse failure.
  }
  return out.slice(0, maxItems);
}
