// Product extractor.
//
// Combines two strategies:
//   1. JSON-LD Product entries. Reliable when present.
//   2. CSS selectors over the HTML. Fallback for sites without JSON-LD.
//
// Returns a normalized Product[] shape that the planning agent can use
// regardless of source. Price is captured as TEXT (the original price
// string from the site, e.g. "$ 28.500" or "USD 49.99") because:
//   a. We do not need a numeric value for planning decisions.
//   b. Currency conversion is out of scope for the MCP.
//   c. The pricing policy of the project explicitly forbids surfacing
//      converted USD prices.
//
// The agent receives the raw text, presents it in the user's preferred
// way (or simply omits it), and never recomputes.

import { extractImages } from "./images.js";
import type { ParsedHtml } from "./html-parser.js";
import { extractJsonLd, imageUrlsField, stringArrayField, stringField } from "./json-ld.js";

export interface ExtractedProduct {
  name: string;
  sku: string | null;
  description: string | null;
  /** Raw price text as it appeared on the site. NEVER converted to USD. */
  price_text: string | null;
  /** Absolute image URLs (resolved via base_url). */
  image_urls: string[];
  /** Absolute URL to the product detail page when discoverable. */
  url: string | null;
  /** Where the entry came from. Useful for diagnostics and dedupe. */
  source: "json_ld" | "css_selector" | "platform_api" | "sitemap_jsonld";
}

export interface ExtractProductsOptions {
  /** CSS selectors to find product cards when JSON-LD is absent. */
  selectors?: string[];
  /** Cap on returned items. */
  maxItems?: number;
}

export function extractProducts(parsed: ParsedHtml, options?: ExtractProductsOptions): ExtractedProduct[] {
  const maxItems = options?.maxItems ?? 30;
  const out: ExtractedProduct[] = [];
  const seenKeys = new Set<string>();

  // Strategy 1: JSON-LD Product.
  const jsonLdEntries = extractJsonLd(parsed, ["Product"]);
  for (const entry of jsonLdEntries) {
    if (out.length >= maxItems) break;
    const name = stringField(entry, "name");
    if (!name) continue;

    const sku = stringField(entry, "sku") ?? stringField(entry, "mpn") ?? null;
    const description = stringField(entry, "description") ?? null;
    const urlRaw = stringField(entry, "url");
    const url = urlRaw ? parsed.resolveUrl(urlRaw) : null;

    // Price: read from `offers` if present (Offer.price + priceCurrency).
    let price_text: string | null = null;
    const offers = entry["offers"];
    if (offers && typeof offers === "object") {
      const offer = Array.isArray(offers) ? offers[0] : offers;
      if (offer && typeof offer === "object") {
        const o = offer as Record<string, unknown>;
        const p = o["price"];
        const c = o["priceCurrency"];
        if (typeof p === "string" || typeof p === "number") {
          price_text = typeof c === "string" ? `${c} ${p}` : String(p);
        }
      }
    }

    const imagesRaw = imageUrlsField(entry, "image");
    const image_urls = imagesRaw
      .map((u) => parsed.resolveUrl(u))
      .filter((u): u is string => typeof u === "string");

    // Add identifying SKUs / additional ids to keep dedupe robust.
    const additionalIds = stringArrayField(entry, "identifier");
    const key = (sku ?? additionalIds[0] ?? name).toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    out.push({ name, sku, description, price_text, image_urls, url, source: "json_ld" });
  }

  // Strategy 2: CSS selectors fallback. Only run if we still have room
  // and the caller provided selectors. We never duplicate names from
  // strategy 1.
  if (out.length < maxItems && options?.selectors && options.selectors.length > 0) {
    const cards = parsed.querySelectorAll(options.selectors);
    for (const card of cards) {
      if (out.length >= maxItems) break;
      const name = readCardName(card);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      // Reuse images extractor for this single card's subtree.
      const image_urls = extractImages(parsed, {
        selectors: [`img`],
        maxItems: 5,
      }).filter((u) => isUrlNearElement(u, card));

      // If filtering by proximity left nothing, fall back to all descendant imgs.
      const fallbackImages =
        image_urls.length > 0
          ? image_urls
          : Array.from(card.querySelectorAll("img"))
              .map((img) => readImgUrl(img, parsed))
              .filter((u): u is string => Boolean(u))
              .slice(0, 5);

      const link = card.querySelector("a[href]");
      const url = link ? parsed.resolveUrl(link.getAttribute("href") ?? "") : null;

      out.push({
        name,
        sku: null,
        description: null,
        price_text: readCardPriceText(card),
        image_urls: fallbackImages,
        url,
        source: "css_selector",
      });
    }
  }

  return out.slice(0, maxItems);
}

function readCardName(card: Element): string | null {
  const candidates = [
    card.querySelector("[class*='product-title']"),
    card.querySelector("[class*='title']"),
    card.querySelector("h1, h2, h3, h4"),
    card.querySelector("[class*='name']"),
    card.querySelector("a"),
  ];
  for (const c of candidates) {
    const txt = c?.textContent?.trim();
    if (txt && txt.length > 0 && txt.length < 200) return txt;
  }
  return null;
}

function readCardPriceText(card: Element): string | null {
  const candidates = [
    card.querySelector("[class*='price']"),
    card.querySelector("[itemprop='price']"),
    card.querySelector("[data-price]"),
  ];
  for (const c of candidates) {
    const txt = c?.textContent?.trim();
    if (txt && txt.length > 0 && txt.length < 50) return txt;
  }
  return null;
}

function readImgUrl(img: Element, parsed: ParsedHtml): string | null {
  const raw = img.getAttribute("src") ?? img.getAttribute("data-src") ?? null;
  return raw ? parsed.resolveUrl(raw) : null;
}

// Best-effort proximity check: returns true when the URL is one of the
// img descendants of the given element. We use this to avoid attaching
// unrelated images (header logos, etc) to a product card after running
// the global image extractor.
function isUrlNearElement(url: string, el: Element): boolean {
  for (const img of Array.from(el.querySelectorAll("img"))) {
    const candidates = [
      img.getAttribute("src"),
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
    ];
    if (candidates.some((c) => c && url.includes(c.split("?")[0]!))) return true;
  }
  return false;
}
