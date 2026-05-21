// Ecommerce platform detection + documented JSON catalog APIs.
//
// Some store sites are SPAs at the HTML level (home page rendered client-side
// by Hydrogen, Next.js Commerce, custom React shells) but still expose stable
// JSON catalog APIs over plain HTTP. Detecting the platform and hitting its
// documented endpoint is more reliable than CSS-scraping a JS-rendered home,
// gives richer data (full image arrays, prices, descriptions) and works
// without a headless browser.
//
// Supported platforms:
//   - Shopify:     GET /products.json?limit=250
//   - WooCommerce: GET /wp-json/wc/store/v1/products?per_page=100
//   - VTEX:        GET /api/catalog_system/pub/products/search/?_from=0&_to=49
//
// Sitemap fallback: any site (recognized or not) that exposes an XML sitemap
// with product URLs can be unblocked by fetching the first N product detail
// pages in parallel and reading JSON-LD Product entries from each (typically
// SSR even when the home is CSR).

import { extractJsonLd, imageUrlsField, stringField } from "./json-ld.js";
import { parseHtml } from "./html-parser.js";
import type { ExtractedProduct } from "./products.js";

export type EcommercePlatform = "shopify" | "woocommerce" | "vtex";

const USER_AGENT = "FollowrMCP-DeepResearch/1.0 (contact: marcos@followr.ai)";

// ── Platform detection ─────────────────────────────────────────────────────

/**
 * Detect the ecommerce platform from a fetched home page. Reads:
 * - Response headers (link, set-cookie, shopify-*).
 * - Inline HTML markers (meta generator, script src patterns).
 *
 * Headers keys are expected to be lowercased by the caller. Returns null
 * when no platform is recognized.
 */
export function detectEcommercePlatform(
  headers: Record<string, string>,
  html: string,
): EcommercePlatform | null {
  const linkHeader = headers["link"] ?? "";
  const setCookie = headers["set-cookie"] ?? "";
  const hasShopifyHeader = Object.keys(headers).some((k) => k.startsWith("shopify-"));
  if (
    /cdn\.shopify\.com/i.test(linkHeader) ||
    /_shopify_(y|s|essential|analytics)/i.test(setCookie) ||
    hasShopifyHeader ||
    /cdn\.shopify\.com/i.test(html)
  ) {
    return "shopify";
  }

  // WooCommerce: meta generator tag or known plugin path in scripts/links.
  if (
    /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*woocommerce/i.test(html) ||
    /wp-content\/plugins\/woocommerce/i.test(html) ||
    /\/wp-json\/wc\//i.test(html)
  ) {
    return "woocommerce";
  }

  // VTEX: assets domain or storeframework markers.
  if (
    /vtex(assets|commerce|cdn)\.com/i.test(html) ||
    /vtex\.com\.br/i.test(html) ||
    /__RUNTIME__\s*=/.test(html)
  ) {
    return "vtex";
  }

  return null;
}

// ── Platform fast-paths ────────────────────────────────────────────────────

export interface FastPathOptions {
  timeoutMs: number;
  maxItems: number;
}

interface ShopifyImage {
  src: string;
}
interface ShopifyVariant {
  sku?: string | null;
  price?: string | number;
}
interface ShopifyProductRaw {
  id: number;
  title: string;
  handle: string;
  product_type?: string;
  vendor?: string;
  body_html?: string;
  images?: ShopifyImage[];
  variants?: ShopifyVariant[];
}

async function fetchShopifyCatalog(baseUrl: string, opts: FastPathOptions): Promise<ExtractedProduct[]> {
  const url = new URL("/products.json", baseUrl);
  url.searchParams.set("limit", String(Math.min(250, Math.max(1, opts.maxItems))));
  const body = await fetchJson(url.toString(), opts.timeoutMs);
  if (!body || typeof body !== "object") return [];
  const raw = (body as { products?: ShopifyProductRaw[] }).products ?? [];
  const out: ExtractedProduct[] = [];
  for (const p of raw.slice(0, opts.maxItems)) {
    if (!p.title) continue;
    const variant = p.variants?.[0];
    const priceRaw = variant?.price;
    const price_text =
      typeof priceRaw === "string" ? priceRaw : typeof priceRaw === "number" ? String(priceRaw) : null;
    const productUrl = new URL(`/products/${p.handle}`, baseUrl).toString();
    out.push({
      name: p.title,
      sku: variant?.sku ?? null,
      description: p.body_html ? stripHtml(p.body_html) : null,
      price_text,
      image_urls: (p.images ?? []).map((i) => i.src).filter(Boolean),
      url: productUrl,
      source: "platform_api",
    });
  }
  return out;
}

interface WooImage {
  src?: string;
  thumbnail?: string;
}
interface WooProductRaw {
  id: number;
  name: string;
  slug?: string;
  permalink?: string;
  short_description?: string;
  description?: string;
  sku?: string;
  prices?: { price?: string; currency_code?: string };
  images?: WooImage[];
}

async function fetchWooCatalog(baseUrl: string, opts: FastPathOptions): Promise<ExtractedProduct[]> {
  // WC Store API (no auth) since WC 6.x; available at /wp-json/wc/store/v1/products.
  const url = new URL("/wp-json/wc/store/v1/products", baseUrl);
  url.searchParams.set("per_page", String(Math.min(100, Math.max(1, opts.maxItems))));
  const body = await fetchJson(url.toString(), opts.timeoutMs);
  if (!Array.isArray(body)) return [];
  const raw = body as WooProductRaw[];
  const out: ExtractedProduct[] = [];
  for (const p of raw.slice(0, opts.maxItems)) {
    if (!p.name) continue;
    const priceRaw = p.prices?.price;
    const currency = p.prices?.currency_code;
    const price_text = priceRaw
      ? currency
        ? `${currency} ${priceRaw}`
        : String(priceRaw)
      : null;
    out.push({
      name: p.name,
      sku: p.sku ?? null,
      description: p.short_description ? stripHtml(p.short_description) : p.description ? stripHtml(p.description) : null,
      price_text,
      image_urls: (p.images ?? []).map((i) => i.src ?? i.thumbnail ?? "").filter(Boolean),
      url: p.permalink ?? (p.slug ? new URL(`/product/${p.slug}`, baseUrl).toString() : null),
      source: "platform_api",
    });
  }
  return out;
}

interface VtexProductRaw {
  productId: string;
  productName: string;
  linkText?: string;
  link?: string;
  description?: string;
  brand?: string;
  items?: Array<{
    itemId?: string;
    sellers?: Array<{ commertialOffer?: { Price?: number } }>;
    images?: Array<{ imageUrl?: string }>;
  }>;
}

async function fetchVtexCatalog(baseUrl: string, opts: FastPathOptions): Promise<ExtractedProduct[]> {
  const to = Math.min(49, Math.max(0, opts.maxItems - 1));
  const url = new URL("/api/catalog_system/pub/products/search/", baseUrl);
  url.searchParams.set("_from", "0");
  url.searchParams.set("_to", String(to));
  const body = await fetchJson(url.toString(), opts.timeoutMs);
  if (!Array.isArray(body)) return [];
  const raw = body as VtexProductRaw[];
  const out: ExtractedProduct[] = [];
  for (const p of raw.slice(0, opts.maxItems)) {
    if (!p.productName) continue;
    const firstItem = p.items?.[0];
    const seller = firstItem?.sellers?.[0]?.commertialOffer;
    const price_text = typeof seller?.Price === "number" ? String(seller.Price) : null;
    const productUrl =
      p.link ?? (p.linkText ? new URL(`/${p.linkText}/p`, baseUrl).toString() : null);
    out.push({
      name: p.productName,
      sku: firstItem?.itemId ?? null,
      description: p.description ? stripHtml(p.description) : null,
      price_text,
      image_urls: (firstItem?.images ?? []).map((i) => i.imageUrl ?? "").filter(Boolean),
      url: productUrl,
      source: "platform_api",
    });
  }
  return out;
}

export async function fetchPlatformCatalog(
  platform: EcommercePlatform,
  baseUrl: string,
  opts: FastPathOptions,
): Promise<ExtractedProduct[]> {
  switch (platform) {
    case "shopify":
      return fetchShopifyCatalog(baseUrl, opts);
    case "woocommerce":
      return fetchWooCatalog(baseUrl, opts);
    case "vtex":
      return fetchVtexCatalog(baseUrl, opts);
  }
}

// ── Sitemap fallback ───────────────────────────────────────────────────────

export interface SitemapFallbackResult {
  /** Product detail URLs discovered in the sitemap. */
  sitemap_urls: string[];
  /** Products successfully extracted from the fetched product pages. */
  products: ExtractedProduct[];
  /** Diagnostics for the caller (succeeded paths, error reasons). */
  diagnostics: { fetched_count: number; extracted_count: number; sitemap_url: string | null };
}

export interface SitemapFallbackOptions {
  timeoutMs: number;
  maxProductFetches: number;
}

const COMMON_PRODUCT_SITEMAP_PATHS = [
  "/sitemap_products_1.xml",
  "/sitemap_products.xml",
  "/wp-sitemap-posts-product-1.xml",
  "/product-sitemap.xml",
  "/sitemap-products.xml",
  "/sitemap.xml",
];

const PRODUCT_URL_HINTS = [/\/products?\//i, /\/product\//i, /\/p\//i, /\/shop\//i, /\/tienda\//i];

/**
 * Try to discover and extract products via the site's XML sitemap.
 *
 * Strategy:
 * 1. Try a handful of well-known sitemap paths. The first that returns 200 is used.
 * 2. Parse <loc> entries. If they look like a sitemap index (nested sitemaps),
 *    fetch the first product-looking child sitemap.
 * 3. Filter <loc> entries to those that look like product detail URLs.
 * 4. Fetch the first N in parallel and pull JSON-LD Product or og:image+title
 *    from each.
 */
export async function fetchProductsViaSitemap(
  baseUrl: string,
  opts: SitemapFallbackOptions,
): Promise<SitemapFallbackResult> {
  const diagnostics = { fetched_count: 0, extracted_count: 0, sitemap_url: null as string | null };

  let sitemapXml: string | null = null;
  let sitemapUrlUsed: string | null = null;
  for (const path of COMMON_PRODUCT_SITEMAP_PATHS) {
    const url = new URL(path, baseUrl).toString();
    const text = await fetchText(url, opts.timeoutMs);
    if (text && /<loc>/i.test(text)) {
      sitemapXml = text;
      sitemapUrlUsed = url;
      break;
    }
  }
  diagnostics.sitemap_url = sitemapUrlUsed;
  if (!sitemapXml) {
    return { sitemap_urls: [], products: [], diagnostics };
  }

  let locs = extractLocs(sitemapXml);

  // If this looks like a sitemap index, find a child sitemap that mentions products.
  const isIndex = /<sitemapindex/i.test(sitemapXml);
  if (isIndex) {
    const productChild = locs.find((u) => /product|tienda|shop/i.test(u));
    if (productChild) {
      const childXml = await fetchText(productChild, opts.timeoutMs);
      if (childXml) {
        locs = extractLocs(childXml);
        diagnostics.sitemap_url = productChild;
      } else {
        return { sitemap_urls: [], products: [], diagnostics };
      }
    } else {
      return { sitemap_urls: [], products: [], diagnostics };
    }
  }

  const productLocs = locs.filter((u) => PRODUCT_URL_HINTS.some((re) => re.test(u))).slice(0, 200);
  if (productLocs.length === 0) {
    return { sitemap_urls: locs.slice(0, 50), products: [], diagnostics };
  }

  const fetchTargets = productLocs.slice(0, Math.max(1, opts.maxProductFetches));
  const fetched = await Promise.all(
    fetchTargets.map(async (u) => {
      const html = await fetchText(u, opts.timeoutMs);
      if (!html) return null;
      return { url: u, html };
    }),
  );
  const products: ExtractedProduct[] = [];
  for (const f of fetched) {
    if (!f) continue;
    diagnostics.fetched_count += 1;
    const parsed = parseHtml(f.html, f.url);
    const jsonLd = extractJsonLd(parsed, ["Product"]);
    if (jsonLd.length > 0) {
      const entry = jsonLd[0]!;
      const name = stringField(entry, "name");
      if (!name) continue;
      const imagesRaw = imageUrlsField(entry, "image");
      const image_urls = imagesRaw
        .map((u) => parsed.resolveUrl(u))
        .filter((u): u is string => typeof u === "string");
      products.push({
        name,
        sku: stringField(entry, "sku") ?? stringField(entry, "mpn") ?? null,
        description: stringField(entry, "description") ?? null,
        price_text: extractPriceFromJsonLd(entry),
        image_urls,
        url: f.url,
        source: "sitemap_jsonld",
      });
      diagnostics.extracted_count += 1;
      continue;
    }
    // Fallback: og:image + og:title.
    const ogTitle = matchMeta(f.html, /property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const ogImage = matchMeta(f.html, /property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitle && ogImage) {
      products.push({
        name: ogTitle,
        sku: null,
        description: null,
        price_text: null,
        image_urls: [ogImage],
        url: f.url,
        source: "sitemap_jsonld",
      });
      diagnostics.extracted_count += 1;
    }
  }

  return { sitemap_urls: productLocs.slice(0, 50), products, diagnostics };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml;q=0.9" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const v = m[1]?.trim();
    if (v) out.push(decodeXmlEntities(v));
    if (out.length > 1000) break;
  }
  return out;
}

// Sitemap XML uses standard XML entity escapes for URLs that contain query
// strings or special chars (most notably &amp; for &). fetch() does NOT decode
// these, so we have to do it ourselves before sending the URL back into fetch.
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function matchMeta(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m && m[1] ? m[1] : null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function extractPriceFromJsonLd(entry: Record<string, unknown>): string | null {
  const offers = entry["offers"];
  if (!offers || typeof offers !== "object") return null;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== "object") return null;
  const o = offer as Record<string, unknown>;
  const p = o["price"];
  const c = o["priceCurrency"];
  if (typeof p === "string" || typeof p === "number") {
    return typeof c === "string" ? `${c} ${p}` : String(p);
  }
  return null;
}
