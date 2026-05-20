// JSON-LD extractor.
//
// Reads <script type="application/ld+json"> blocks, parses each as JSON,
// flattens @graph wrappers, and returns the entries that match any of the
// requested Schema.org @type values.
//
// Reliability ranking among extraction strategies:
//   1. JSON-LD (this module): structured data the site explicitly authored.
//      When present, this is the canonical source. Shopify, many
//      restaurants, hotel chains, and most news outlets ship JSON-LD.
//   2. og:meta tags: lighter, but well-defined.
//   3. CSS selectors over HTML: brittle, fallback only.
//
// We never throw on malformed JSON-LD; we just skip the block.

import type { ParsedHtml } from "./html-parser.js";

/** A loosely-typed JSON-LD entry. Schema.org shapes are open; consumers narrow as needed. */
export type JsonLdEntry = Record<string, unknown>;

/**
 * Extract JSON-LD entries from the parsed document. When `types` is
 * provided, returns only entries whose @type (string or array of strings)
 * intersects with the list. When omitted, returns all entries.
 *
 * Handles three common JSON-LD shapes:
 *   1. Single object: { "@type": "Product", "name": "..." }
 *   2. Array of objects: [ {...}, {...} ]
 *   3. @graph wrapper: { "@graph": [ {...}, {...} ] }
 *
 * Nested entries inside @graph are flattened to the top level.
 */
export function extractJsonLd(parsed: ParsedHtml, types?: string[]): JsonLdEntry[] {
  const out: JsonLdEntry[] = [];
  const scripts = Array.from(
    parsed.document.querySelectorAll('script[type="application/ld+json"]'),
  );

  for (const script of scripts) {
    const raw = script.textContent;
    if (!raw) continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue;
    }

    flatten(parsedJson, out);
  }

  if (!types || types.length === 0) return out;

  const typeSet = new Set(types);
  return out.filter((entry) => matchesAnyType(entry, typeSet));
}

function flatten(value: unknown, out: JsonLdEntry[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out);
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as JsonLdEntry;

  if (Array.isArray(obj["@graph"])) {
    for (const item of obj["@graph"] as unknown[]) flatten(item, out);
    return;
  }

  out.push(obj);
}

function matchesAnyType(entry: JsonLdEntry, typeSet: Set<string>): boolean {
  const t = entry["@type"];
  if (typeof t === "string") return typeSet.has(t);
  if (Array.isArray(t)) {
    for (const v of t) {
      if (typeof v === "string" && typeSet.has(v)) return true;
    }
  }
  return false;
}

/** Read a string field, returning undefined if missing or not a string. */
export function stringField(entry: JsonLdEntry, key: string): string | undefined {
  const v = entry[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a possibly-array string field, normalized to a string[]. */
export function stringArrayField(entry: JsonLdEntry, key: string): string[] {
  const v = entry[key];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Read an "image" field that can be a string URL, an object with `url`,
 * or an array of either. Returns a flat array of URL strings.
 */
export function imageUrlsField(entry: JsonLdEntry, key: string = "image"): string[] {
  const v = entry[key];
  const collect = (item: unknown): string[] => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const url = (item as Record<string, unknown>)["url"];
      if (typeof url === "string") return [url];
    }
    return [];
  };
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(collect);
  return collect(v);
}
