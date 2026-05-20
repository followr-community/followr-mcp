// HTML parser wrapper around linkedom.
//
// linkedom is a small, zero-runtime-dependency DOM implementation that
// works in Node and in Cloudflare Workers. It parses HTML lenient enough
// for real-world pages (Shopify, WordPress, hand-rolled markup) and
// exposes a familiar DOM API including querySelectorAll.
//
// We wrap linkedom to:
//   - centralize the parsing entry point
//   - normalize URL resolution against the page's <base href> or origin
//   - precompute the body text for use by classifiers and regex helpers
//   - expose a typed surface that the rest of the extractors can rely on
//
// IMPORTANT: NEVER use regex over the raw HTML to extract structure.
// Always go through the parsed document. Regex is reserved for plain
// text mining (emails, phones, price hints).

import { parseHTML } from "linkedom";

export interface ParsedHtml {
  /** linkedom Document. Use querySelectorAll / querySelector via the helpers below. */
  document: ReturnType<typeof parseHTML>["document"];
  /** linkedom Window, exposed for advanced use cases. */
  window: ReturnType<typeof parseHTML>["window"];
  /** Base URL used to resolve relative paths. Either <base href> or the fetch URL. */
  base_url: string;
  /** Cached body text content with scripts and styles stripped. */
  body_text: string;
  /** Convenience: querySelectorAll across a list of selectors, deduped by node identity. */
  querySelectorAll: (selectors: string[]) => Element[];
  /** Resolve a possibly-relative URL against base_url. Returns absolute URL or null on parse failure. */
  resolveUrl: (href: string) => string | null;
}

/**
 * Parse an HTML string. The fetched_from_url is used to resolve relative
 * URLs when the page does not declare a <base href>.
 */
export function parseHtml(html: string, fetched_from_url: string): ParsedHtml {
  const { document, window } = parseHTML(html);

  // Resolve effective base URL: explicit <base href> wins, otherwise the
  // URL we fetched from.
  let base_url = fetched_from_url;
  const baseEl = document.querySelector("base[href]");
  if (baseEl) {
    const raw = baseEl.getAttribute("href");
    if (raw) {
      try {
        base_url = new URL(raw, fetched_from_url).toString();
      } catch {
        // Ignore invalid <base href> and stick with fetched_from_url.
      }
    }
  }

  // Strip scripts and styles before pulling text. linkedom's textContent
  // would otherwise include the contents of <script type="text/x-template">
  // and other noise. We snapshot a shallow clone and remove the tags.
  const clone = document.cloneNode(true) as typeof document;
  for (const node of Array.from(clone.querySelectorAll("script, style, noscript"))) {
    node.remove();
  }
  const body_text = (clone.body?.textContent ?? "").replace(/\s+/g, " ").trim();

  const resolveUrl = (href: string): string | null => {
    if (!href) return null;
    try {
      return new URL(href, base_url).toString();
    } catch {
      return null;
    }
  };

  const querySelectorAll = (selectors: string[]): Element[] => {
    const seen = new Set<Element>();
    for (const sel of selectors) {
      try {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          seen.add(el as unknown as Element);
        }
      } catch {
        // Invalid CSS selector. Skip rather than throw; the caller's
        // selector list may include best-effort patterns that fail on
        // some markup variants.
      }
    }
    return Array.from(seen);
  };

  return { document, window, base_url, body_text, querySelectorAll, resolveUrl };
}

/**
 * Slice the body text to a max length safe to pass into an LLM prompt
 * or store inline in a JSON response. Truncates on a word boundary when
 * possible.
 */
export function bodyTextExcerpt(parsed: ParsedHtml, limit: number = 2000): string {
  if (parsed.body_text.length <= limit) return parsed.body_text;
  const slice = parsed.body_text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > limit * 0.8) return slice.slice(0, lastSpace) + " ...";
  return slice + "...";
}
