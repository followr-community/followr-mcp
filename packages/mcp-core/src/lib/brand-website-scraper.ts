// Brand-aware website scraper used by setup_brand_visual_identity.
//
// THE GOAL
// ========
// Pull as much visual brand signal as we can from the company's website with
// a best-effort, single-pass scrape. Extracts:
//   - og:image / twitter:image / meta description
//   - candidate logo images (heuristic: "logo" in class/id/alt OR <link rel="icon">)
//   - hero / banner candidates (img near top of <header> / <main>)
//   - product gallery candidates (img inside .product / .card / .item / .gallery)
//   - inline <svg> icons (small, atomic)
//   - color palette (hex frequency from inline <style> + first stylesheet)
//   - typography (font-family declarations + Google Fonts links)
//
// All output is rated heuristically and presented to the user for curation.
// The MCP never auto-saves scraped findings without explicit approval.
//
// LIMITS (good-citizen)
//   - 10s timeout
//   - 1MB body cap (HTML)
//   - 500KB body cap per linked stylesheet
//   - At most 1 linked stylesheet fetched (the first one)
//   - Respects HTTP redirects but stops at non-OK responses
//   - No JS execution; we read static HTML only. Sites that render
//     client-side (SPAs without SSR) will yield poor signal here.

const HTML_FETCH_TIMEOUT_MS = 10_000;
const HTML_MAX_BYTES = 1_000_000;
const CSS_MAX_BYTES = 500_000;
const USER_AGENT = "FollowrMCP/0.5 (+https://followr.ai) brand-identity-scraper";

// ──────────────────────────────────────────────────────────
// Output shape
// ──────────────────────────────────────────────────────────

export type FetchStatus = "ok" | "timeout" | "http_error" | "no_url" | "network_error";

export interface ScrapedImageCandidate {
  /** Absolute URL of the image. */
  url: string;
  /** alt attribute when present. */
  alt: string | null;
  /** Hint used to classify this candidate (class/id/parent tag). */
  src_hint: string;
}

export interface ScrapedInlineSvg {
  /** Raw SVG content (for re-uploading as an asset). */
  svg_content: string;
  /** width / height hint when present (e.g. "24x24"). */
  size_hint: string | null;
}

export interface BrandWebsiteSignals {
  /** The URL we ended up fetching after normalization. */
  fetched_url: string;
  fetch_status: FetchStatus;
  fetch_error_detail: string | null;
  /** ms the fetch took (HTML only). */
  fetch_duration_ms: number;

  // Page metadata
  page_title: string | null;
  meta_description: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image_url: string | null;
  twitter_image_url: string | null;
  site_name: string | null;
  locale: string | null;

  // Visual asset candidates (already de-duplicated, absolute URLs)
  logo_candidates: ScrapedImageCandidate[];
  hero_candidates: ScrapedImageCandidate[];
  gallery_candidates: ScrapedImageCandidate[];
  favicon_url: string | null;
  inline_svg_icons: ScrapedInlineSvg[];

  // Color signals (hex, lowercase, deduplicated, ordered by frequency)
  palette_candidates: string[];
  /** True if we fetched an external stylesheet (deeper signal). */
  stylesheet_fetched: boolean;

  // Typography signals
  font_families_detected: string[];
  google_fonts: string[];

  // Top headings (useful for industry / content cues; not visual)
  top_headings: string[];
}

// ──────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────

/**
 * Scrape a single page for brand visual signals. Returns a structured
 * BrandWebsiteSignals object regardless of whether the fetch succeeded:
 * a failure surfaces as fetch_status != "ok" and empty arrays.
 *
 * The caller (the brand setup wizard) shows these candidates to the user
 * for curation. Items the user approves get uploaded to the brand folders
 * and tagged according to their bucket (logo / hero / gallery / icon).
 */
export async function scrapeBrandSignalsFromWebsite(
  url: string | null | undefined,
): Promise<BrandWebsiteSignals> {
  const empty = (status: FetchStatus, detail: string | null = null, fetchedUrl = ""): BrandWebsiteSignals => ({
    fetched_url: fetchedUrl,
    fetch_status: status,
    fetch_error_detail: detail,
    fetch_duration_ms: 0,
    page_title: null,
    meta_description: null,
    og_title: null,
    og_description: null,
    og_image_url: null,
    twitter_image_url: null,
    site_name: null,
    locale: null,
    logo_candidates: [],
    hero_candidates: [],
    gallery_candidates: [],
    favicon_url: null,
    inline_svg_icons: [],
    palette_candidates: [],
    stylesheet_fetched: false,
    font_families_detected: [],
    google_fonts: [],
    top_headings: [],
  });

  if (!url || typeof url !== "string" || url.trim().length === 0) {
    return empty("no_url");
  }

  const target = normalizeUrl(url.trim());
  const start = Date.now();
  let html: string | null = null;
  try {
    html = await fetchTextWithTimeout(target, HTML_MAX_BYTES, "text/html");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return empty(isAbort ? "timeout" : "network_error", detail, target);
  }
  const fetch_duration_ms = Date.now() - start;
  if (html === null) {
    return empty("http_error", "non-200 response", target);
  }

  // Pull metadata, image candidates, headings, favicon, inline SVGs from HTML.
  const meta = extractMetaTags(html);
  const headings = extractHeadings(html);
  const allImages = extractImages(html, target);
  const inlineSvgs = extractInlineSvgs(html);
  const favicon = extractFavicon(html, target);

  // Classify images into logo / hero / gallery buckets.
  const { logo, hero, gallery } = classifyImageCandidates(allImages);

  // CSS extraction: try inline <style> blocks first, then ONE linked stylesheet.
  const inlineCss = extractInlineStyleBlocks(html);
  let externalCss = "";
  let stylesheet_fetched = false;
  const firstSheetHref = extractFirstStylesheetHref(html);
  if (firstSheetHref) {
    const absoluteSheet = absoluteUrl(firstSheetHref, target);
    try {
      const sheet = await fetchTextWithTimeout(absoluteSheet, CSS_MAX_BYTES, "text/css");
      if (sheet) {
        externalCss = sheet;
        stylesheet_fetched = true;
      }
    } catch {
      // Best-effort. Stylesheet failed -> we only use inline.
    }
  }
  const cssCombined = inlineCss + "\n\n" + externalCss + "\n\n" + html;
  const palette_candidates = extractPaletteCandidates(cssCombined);
  const font_families_detected = extractFontFamilies(cssCombined);
  const google_fonts = extractGoogleFontsLinks(html);

  return {
    fetched_url: target,
    fetch_status: "ok",
    fetch_error_detail: null,
    fetch_duration_ms,
    page_title: meta.page_title,
    meta_description: meta.meta_description,
    og_title: meta.og_title,
    og_description: meta.og_description,
    og_image_url: meta.og_image_url ? absoluteUrl(meta.og_image_url, target) : null,
    twitter_image_url: meta.twitter_image_url ? absoluteUrl(meta.twitter_image_url, target) : null,
    site_name: meta.site_name,
    locale: meta.locale,
    logo_candidates: logo,
    hero_candidates: hero,
    gallery_candidates: gallery,
    favicon_url: favicon,
    inline_svg_icons: inlineSvgs,
    palette_candidates,
    stylesheet_fetched,
    font_families_detected,
    google_fonts,
    top_headings: headings,
  };
}

// ──────────────────────────────────────────────────────────
// Internal: fetch + parse helpers
// ──────────────────────────────────────────────────────────

function normalizeUrl(raw: string): string {
  let target = raw.trim();
  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target;
  }
  return target;
}

async function fetchTextWithTimeout(url: string, maxBytes: number, acceptType: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTML_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: acceptType },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
  } finally {
    clearTimeout(timer);
  }
}

function absoluteUrl(maybeRelative: string, base: string): string {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

// ──────────────────────────────────────────────────────────
// Internal: meta tag extraction
// ──────────────────────────────────────────────────────────

interface ParsedMeta {
  page_title: string | null;
  meta_description: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image_url: string | null;
  twitter_image_url: string | null;
  site_name: string | null;
  locale: string | null;
}

function extractMetaTags(html: string): ParsedMeta {
  return {
    page_title: matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i)?.trim() ?? null,
    meta_description: matchAttr(html, "name", "description") ?? null,
    og_title: matchAttr(html, "property", "og:title") ?? null,
    og_description: matchAttr(html, "property", "og:description") ?? null,
    og_image_url: matchAttr(html, "property", "og:image") ?? null,
    twitter_image_url: matchAttr(html, "name", "twitter:image") ?? null,
    site_name: matchAttr(html, "property", "og:site_name") ?? null,
    locale: matchAttr(html, "property", "og:locale") ?? matchFirst(html, /<html[^>]+lang=["']([^"']+)["']/i) ?? null,
  };
}

function matchAttr(html: string, attr: "name" | "property", value: string): string | null {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${escapeRegex(value)}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  return matchFirst(html, re);
}

function matchFirst(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m && m[1] ? m[1] : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ──────────────────────────────────────────────────────────
// Internal: image candidates + classification
// ──────────────────────────────────────────────────────────

interface RawImg {
  url: string;
  alt: string | null;
  classHint: string;
  idHint: string;
  context: "header" | "main" | "footer" | "unknown";
}

function extractImages(html: string, base: string): RawImg[] {
  // Locate header / footer / main spans so we can attribute images to a section.
  const headerSpan = locateSpan(html, /<header[\s>]/i, /<\/header\s*>/i);
  const footerSpan = locateSpan(html, /<footer[\s>]/i, /<\/footer\s*>/i);
  const mainSpan = locateSpan(html, /<main[\s>]/i, /<\/main\s*>/i);

  const imgs: RawImg[] = [];
  const seen = new Set<string>();
  const re = /<img\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? "";
    const src = extractAttr(attrs, "src") ?? extractAttr(attrs, "data-src") ?? null;
    if (!src) continue;
    if (src.startsWith("data:")) continue;
    const url = absoluteUrl(src, base);
    if (seen.has(url)) continue;
    seen.add(url);
    const idx = m.index;
    let context: RawImg["context"] = "unknown";
    if (footerSpan && idx >= footerSpan[0] && idx < footerSpan[1]) context = "footer";
    else if (headerSpan && idx >= headerSpan[0] && idx < headerSpan[1]) context = "header";
    else if (mainSpan && idx >= mainSpan[0] && idx < mainSpan[1]) context = "main";
    imgs.push({
      url,
      alt: extractAttr(attrs, "alt"),
      classHint: extractAttr(attrs, "class") ?? "",
      idHint: extractAttr(attrs, "id") ?? "",
      context,
    });
  }
  return imgs;
}

function classifyImageCandidates(all: RawImg[]): {
  logo: ScrapedImageCandidate[];
  hero: ScrapedImageCandidate[];
  gallery: ScrapedImageCandidate[];
} {
  const logo: ScrapedImageCandidate[] = [];
  const hero: ScrapedImageCandidate[] = [];
  const gallery: ScrapedImageCandidate[] = [];

  const seenInLogo = new Set<string>();
  const seenInHero = new Set<string>();
  const seenInGallery = new Set<string>();

  for (const img of all) {
    const haystack = `${img.classHint} ${img.idHint} ${img.alt ?? ""}`.toLowerCase();
    const inHeader = img.context === "header";
    const inFooter = img.context === "footer";

    // Logo heuristics: "logo" / "brand" in class/id/alt OR header-located img.
    if (
      !seenInLogo.has(img.url) &&
      logo.length < 3 &&
      (/(logo|brand-?mark|wordmark|isotype)/u.test(haystack) || (inHeader && logo.length < 1))
    ) {
      logo.push({ url: img.url, alt: img.alt, src_hint: inHeader ? "in <header>" : "class/id/alt match" });
      seenInLogo.add(img.url);
      continue;
    }

    // Hero heuristics: in <header> or <main>, near top, big alt.
    if (
      !seenInHero.has(img.url) &&
      hero.length < 5 &&
      !inFooter &&
      (/(hero|banner|cover|jumbotron|feature-?img)/u.test(haystack) || img.context === "main")
    ) {
      hero.push({ url: img.url, alt: img.alt, src_hint: img.context });
      seenInHero.add(img.url);
      continue;
    }

    // Gallery heuristics: anything else not in footer, capped at 10.
    if (!seenInGallery.has(img.url) && gallery.length < 10 && !inFooter) {
      gallery.push({ url: img.url, alt: img.alt, src_hint: img.context });
      seenInGallery.add(img.url);
    }
  }

  return { logo, hero, gallery };
}

function extractAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = re.exec(attrs);
  return m && m[1] ? m[1] : null;
}

function locateSpan(html: string, openRe: RegExp, closeRe: RegExp): [number, number] | null {
  const o = openRe.exec(html);
  if (!o) return null;
  const after = html.slice(o.index);
  const c = closeRe.exec(after);
  if (!c) return null;
  return [o.index, o.index + c.index + c[0].length];
}

// ──────────────────────────────────────────────────────────
// Internal: favicon
// ──────────────────────────────────────────────────────────

function extractFavicon(html: string, base: string): string | null {
  // Try <link rel="icon"> variants in priority order: apple-touch-icon,
  // icon (svg / png / ico). First match wins.
  const candidates = [
    /<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const re of candidates) {
    const u = matchFirst(html, re);
    if (u) return absoluteUrl(u, base);
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// Internal: inline SVG icons
// ──────────────────────────────────────────────────────────

function extractInlineSvgs(html: string): ScrapedInlineSvg[] {
  const out: ScrapedInlineSvg[] = [];
  const re = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 8) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    // Skip tiny accent SVGs (e.g. 1x1 pixels)
    const widthAttr = extractAttr(attrs, "width");
    const heightAttr = extractAttr(attrs, "height");
    const viewBox = extractAttr(attrs, "viewBox");
    const w = widthAttr ? parseFloat(widthAttr) : null;
    const h = heightAttr ? parseFloat(heightAttr) : null;
    // Only keep SVGs that have either explicit non-trivial dimensions or a
    // viewBox (which signals they're real icons).
    if (!viewBox && (!w || w < 8 || !h || h < 8)) continue;
    // Skip absurdly large SVGs (>200kb) which are likely full illustrations
    // not atomic icons; they bloat the asset library.
    const wholeSvg = m[0] ?? "";
    if (wholeSvg.length > 200_000) continue;
    const sizeHint =
      w && h
        ? `${Math.round(w)}x${Math.round(h)}`
        : viewBox
          ? `viewBox=${viewBox}`
          : null;
    out.push({ svg_content: wholeSvg, size_hint: sizeHint });
    void inner;
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Internal: CSS extraction (palette + fonts)
// ──────────────────────────────────────────────────────────

function extractInlineStyleBlocks(html: string): string {
  const blocks: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks.join("\n\n");
}

function extractFirstStylesheetHref(html: string): string | null {
  const re = /<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/i;
  return matchFirst(html, re);
}

function extractPaletteCandidates(css: string): string[] {
  // Hex colors: #rgb, #rrggbb, #rrggbbaa. Normalize to #rrggbb lowercase.
  // Plus rgb()/rgba() converted to hex.
  const counts = new Map<string, number>();
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(css))) {
    const norm = normalizeHex(m[0]);
    if (!norm) continue;
    if (isGreyscaleish(norm)) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  const rgbRe = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
  while ((m = rgbRe.exec(css))) {
    const r = clampByte(parseInt(m[1] ?? "0", 10));
    const g = clampByte(parseInt(m[2] ?? "0", 10));
    const b = clampByte(parseInt(m[3] ?? "0", 10));
    const norm = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toLowerCase();
    if (!isGreyscaleish(norm)) {
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 10).map(([color]) => color);
}

function normalizeHex(raw: string): string | null {
  let hex = raw.replace(/^#/, "").toLowerCase();
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  } else if (hex.length === 8) {
    hex = hex.slice(0, 6); // drop alpha
  } else if (hex.length !== 6) {
    return null;
  }
  return "#" + hex;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Filter out near-black, near-white, and pure greys. These are typically
 * text / background / border colors and not brand colors.
 */
function isGreyscaleish(hex: string): boolean {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  // Near-black or near-white
  if (Math.max(r, g, b) < 30) return true;
  if (Math.min(r, g, b) > 225) return true;
  // Pure grey: r ≈ g ≈ b within tolerance
  const maxDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
  if (maxDiff < 10) return true;
  return false;
}

function extractFontFamilies(css: string): string[] {
  const out = new Set<string>();
  const re = /font-family\s*:\s*([^;}"'\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const value = m[1] ?? "";
    // The value can be a list: "Inter, sans-serif". Split and clean each entry.
    const parts = value.split(",").map((p) => p.trim().replace(/^["']|["']$/g, ""));
    for (const p of parts) {
      if (!p) continue;
      // Skip generic CSS font families.
      if (/^(inherit|initial|revert|unset|var)\b/i.test(p)) continue;
      if (/^(sans-?serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded)$/i.test(p)) continue;
      if (p.length < 2 || p.length > 60) continue;
      out.add(p);
    }
    if (out.size >= 10) break;
  }
  // Also scan @font-face declarations.
  const ffRe = /@font-face\s*{[^}]*font-family\s*:\s*["']?([^;"'}]+)["']?/gi;
  while ((m = ffRe.exec(css))) {
    if (m[1]) out.add(m[1].trim());
    if (out.size >= 10) break;
  }
  return [...out];
}

function extractGoogleFontsLinks(html: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/fonts\.googleapis\.com\/css2?\?family=([^"'&)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) out.push(decodeURIComponent(m[1]).replace(/\+/g, " "));
    if (out.length >= 5) break;
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Internal: headings (for industry / content cues, not visual)
// ──────────────────────────────────────────────────────────

function extractHeadings(html: string): string[] {
  const out: string[] = [];
  const re = /<h[12][^>]*>([\s\S]{1,200}?)<\/h[12]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 12) {
    const txt = stripTags(m[1] ?? "").trim();
    if (txt.length > 2 && txt.length < 200) out.push(txt);
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
