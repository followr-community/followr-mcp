// OpenGraph and meta-tag extractor.
//
// Reads <head> meta tags into a flat record. Captures the most useful
// signals for industry classification and content summary:
//   - title (<title> or og:title)
//   - description (meta[name=description] or og:description)
//   - og:* family (og:image, og:type, og:site_name, og:locale)
//   - twitter:* family (often a fallback when og:* is missing)
//   - canonical URL
//   - html lang attribute (for language detection)

import type { ParsedHtml } from "./html-parser.js";

export interface OgMetaResult {
  title: string | null;
  description: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  og_site_name: string | null;
  og_type: string | null;
  og_locale: string | null;
  twitter_title: string | null;
  twitter_description: string | null;
  twitter_image: string | null;
  canonical_url: string | null;
  html_lang: string | null;
  favicon: string | null;
  rss_url: string | null;
}

export function extractOgMeta(parsed: ParsedHtml): OgMetaResult {
  const doc = parsed.document;

  const titleEl = doc.querySelector("head > title, title");
  const title = titleEl?.textContent?.trim() || null;

  const meta = (selector: string): string | null => {
    const el = doc.querySelector(selector);
    if (!el) return null;
    const v = el.getAttribute("content");
    return v?.trim() || null;
  };

  const linkHref = (selector: string): string | null => {
    const el = doc.querySelector(selector);
    if (!el) return null;
    const v = el.getAttribute("href");
    if (!v) return null;
    return parsed.resolveUrl(v);
  };

  const og_image_raw = meta('meta[property="og:image"]') ?? meta('meta[name="og:image"]');
  const twitter_image_raw = meta('meta[name="twitter:image"]') ?? meta('meta[property="twitter:image"]');

  const htmlEl = doc.querySelector("html");
  const html_lang = htmlEl?.getAttribute("lang")?.trim() || null;

  return {
    title,
    description: meta('meta[name="description"]'),
    og_title: meta('meta[property="og:title"]') ?? meta('meta[name="og:title"]'),
    og_description: meta('meta[property="og:description"]') ?? meta('meta[name="og:description"]'),
    og_image: og_image_raw ? parsed.resolveUrl(og_image_raw) : null,
    og_site_name: meta('meta[property="og:site_name"]'),
    og_type: meta('meta[property="og:type"]'),
    og_locale: meta('meta[property="og:locale"]'),
    twitter_title: meta('meta[name="twitter:title"]'),
    twitter_description: meta('meta[name="twitter:description"]'),
    twitter_image: twitter_image_raw ? parsed.resolveUrl(twitter_image_raw) : null,
    canonical_url: linkHref('link[rel="canonical"]'),
    html_lang,
    favicon:
      linkHref('link[rel="icon"]') ??
      linkHref('link[rel="shortcut icon"]') ??
      linkHref('link[rel="apple-touch-icon"]'),
    rss_url:
      linkHref('link[rel="alternate"][type="application/rss+xml"]') ??
      linkHref('link[rel="alternate"][type="application/atom+xml"]'),
  };
}
