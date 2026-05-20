// Image URL extractor.
//
// Walks <img> elements matched by a CSS selector list and returns a
// deduped, length-capped list of absolute URLs. Handles three flavors of
// image URL that modern pages use:
//   - src: classic.
//   - data-src: most lazy-loading libraries (lozad, vanilla-lazyload, etc).
//   - srcset: responsive images. We pick the highest-resolution candidate.
//
// Filters obvious non-product noise: spacer GIFs, base64 placeholders,
// 1x1 transparent PNGs by file size hint.

import type { ParsedHtml } from "./html-parser.js";

export interface ExtractImagesOptions {
  selectors: string[];
  maxItems?: number;
  /** Skip data URIs (base64-inlined images). Default true. */
  skipDataUris?: boolean;
}

export function extractImages(parsed: ParsedHtml, options: ExtractImagesOptions): string[] {
  const maxItems = options.maxItems ?? 30;
  const skipDataUris = options.skipDataUris ?? true;

  const out: string[] = [];
  const seen = new Set<string>();

  const nodes = parsed.querySelectorAll(options.selectors);
  for (const node of nodes) {
    if (out.length >= maxItems) break;

    // Direct <img> case.
    if (node.tagName === "IMG") {
      pushUrl(node, out, seen, parsed, skipDataUris);
      continue;
    }

    // Container case: pull descendant <img>s.
    const imgs = Array.from(node.querySelectorAll("img"));
    for (const img of imgs) {
      if (out.length >= maxItems) break;
      pushUrl(img, out, seen, parsed, skipDataUris);
    }
  }

  return out.slice(0, maxItems);
}

function pushUrl(
  img: Element,
  out: string[],
  seen: Set<string>,
  parsed: ParsedHtml,
  skipDataUris: boolean,
): void {
  const raw = pickBestImageUrl(img);
  if (!raw) return;
  if (skipDataUris && raw.startsWith("data:")) return;
  const resolved = parsed.resolveUrl(raw);
  if (!resolved) return;
  if (seen.has(resolved)) return;
  seen.add(resolved);
  out.push(resolved);
}

/**
 * Pick the best URL for an <img>:
 *   1. srcset highest-resolution candidate (responsive images often
 *      have the canonical hi-res URL only in srcset).
 *   2. src attribute.
 *   3. data-src (lazy load).
 *   4. data-original (older lazy-load libs).
 */
function pickBestImageUrl(img: Element): string | null {
  const srcset = img.getAttribute("srcset");
  if (srcset) {
    const best = pickHighestSrcsetCandidate(srcset);
    if (best) return best;
  }
  return (
    img.getAttribute("src") ??
    img.getAttribute("data-src") ??
    img.getAttribute("data-original") ??
    img.getAttribute("data-lazy-src") ??
    null
  );
}

/**
 * Parse srcset and return the URL of the candidate with the highest
 * width descriptor. Falls back to the last candidate when no widths
 * are specified.
 */
function pickHighestSrcsetCandidate(srcset: string): string | null {
  const candidates = srcset
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;

  let bestUrl: string | null = null;
  let bestWidth = -1;
  for (const c of candidates) {
    const parts = c.split(/\s+/);
    const url = parts[0];
    if (!url) continue;
    const desc = parts[1];
    let width = 0;
    if (desc && desc.endsWith("w")) {
      const n = Number(desc.slice(0, -1));
      if (Number.isFinite(n)) width = n;
    }
    if (width > bestWidth) {
      bestWidth = width;
      bestUrl = url;
    }
  }
  // If no widths were specified (e.g. all "2x" / "3x" descriptors), fall
  // back to the last candidate.
  if (bestUrl === null) {
    const last = candidates[candidates.length - 1];
    if (last) {
      const url = last.split(/\s+/)[0];
      return url ?? null;
    }
  }
  return bestUrl;
}
