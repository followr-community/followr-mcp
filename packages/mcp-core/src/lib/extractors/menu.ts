// Menu / dish extractor for restaurant profile.
//
// Two strategies:
//   1. Schema.org Menu / MenuSection / MenuItem.
//   2. CSS selectors over common menu markup (.menu-item, .dish).

import type { ParsedHtml } from "./html-parser.js";
import { extractJsonLd, imageUrlsField, stringField } from "./json-ld.js";

export interface MenuItem {
  name: string;
  description: string | null;
  price_text: string | null;
  image_urls: string[];
  section: string | null;
  source: "json_ld" | "css_selector";
}

export interface ExtractMenuOptions {
  selectors?: string[];
  maxItems?: number;
}

export function extractMenu(parsed: ParsedHtml, options?: ExtractMenuOptions): MenuItem[] {
  const maxItems = options?.maxItems ?? 50;
  const out: MenuItem[] = [];
  const seen = new Set<string>();

  // Strategy 1: JSON-LD MenuItem entries (flat or under MenuSection.hasMenuItem).
  const menuEntries = extractJsonLd(parsed, ["Menu", "MenuSection", "MenuItem"]);
  for (const entry of menuEntries) {
    if (out.length >= maxItems) break;
    walkMenuEntry(entry, null, parsed, out, seen, maxItems);
  }

  // Strategy 2: CSS selector fallback.
  if (out.length < maxItems && options?.selectors && options.selectors.length > 0) {
    const cards = parsed.querySelectorAll(options.selectors);
    for (const card of cards) {
      if (out.length >= maxItems) break;
      const name = readDishName(card);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const descEl = card.querySelector("[class*='description'], [class*='desc'], p");
      const description = descEl?.textContent?.trim() ?? null;

      const priceEl = card.querySelector("[class*='price']");
      const price_text = priceEl?.textContent?.trim() ?? null;

      const imgs = Array.from(card.querySelectorAll("img"));
      const image_urls: string[] = [];
      for (const img of imgs) {
        const raw = img.getAttribute("src") ?? img.getAttribute("data-src") ?? null;
        const resolved = raw ? parsed.resolveUrl(raw) : null;
        if (resolved) image_urls.push(resolved);
      }

      out.push({ name, description, price_text, image_urls, section: null, source: "css_selector" });
    }
  }

  return out.slice(0, maxItems);
}

function walkMenuEntry(
  entry: Record<string, unknown>,
  parentSection: string | null,
  parsed: ParsedHtml,
  out: MenuItem[],
  seen: Set<string>,
  maxItems: number,
): void {
  if (out.length >= maxItems) return;

  const type = entry["@type"];
  const isMenuItem = type === "MenuItem" || (Array.isArray(type) && type.includes("MenuItem"));

  if (isMenuItem) {
    const name = stringField(entry, "name");
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    let price_text: string | null = null;
    const offers = entry["offers"];
    if (offers && typeof offers === "object") {
      const o = Array.isArray(offers) ? offers[0] : offers;
      if (o && typeof o === "object") {
        const oo = o as Record<string, unknown>;
        const p = oo["price"];
        const c = oo["priceCurrency"];
        if (typeof p === "string" || typeof p === "number") {
          price_text = typeof c === "string" ? `${c} ${p}` : String(p);
        }
      }
    }

    const image_urls = imageUrlsField(entry, "image")
      .map((u) => parsed.resolveUrl(u))
      .filter((u): u is string => typeof u === "string");

    out.push({
      name,
      description: stringField(entry, "description") ?? null,
      price_text,
      image_urls,
      section: parentSection,
      source: "json_ld",
    });
    return;
  }

  // MenuSection: recurse into hasMenuItem and hasMenuSection.
  const sectionName = stringField(entry, "name") ?? parentSection;
  for (const childKey of ["hasMenuItem", "hasMenuSection"]) {
    const children = entry[childKey];
    if (!children) continue;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child && typeof child === "object") {
        walkMenuEntry(child as Record<string, unknown>, sectionName, parsed, out, seen, maxItems);
      }
    }
  }
}

function readDishName(card: Element): string | null {
  const candidates = [
    card.querySelector("[class*='dish-name']"),
    card.querySelector("[class*='item-name']"),
    card.querySelector("[class*='name']"),
    card.querySelector("h1, h2, h3, h4, h5"),
  ];
  for (const c of candidates) {
    const txt = c?.textContent?.trim();
    if (txt && txt.length > 0 && txt.length < 200) return txt;
  }
  return null;
}
