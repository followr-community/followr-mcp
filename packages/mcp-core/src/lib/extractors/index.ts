// Barrel for the extractors module.
//
// All extractors share a contract: they take the ParsedHtml produced by
// html-parser plus a small options object, and return a normalized shape
// the planning agent can consume regardless of source (JSON-LD, CSS
// selectors, RSS feed, regex over text).

export { parseHtml, bodyTextExcerpt } from "./html-parser.js";
export type { ParsedHtml } from "./html-parser.js";

export { extractJsonLd, stringField, stringArrayField, imageUrlsField } from "./json-ld.js";
export type { JsonLdEntry } from "./json-ld.js";

export { extractOgMeta } from "./og-meta.js";
export type { OgMetaResult } from "./og-meta.js";

export { extractImages } from "./images.js";
export type { ExtractImagesOptions } from "./images.js";

export { extractContact } from "./contact.js";
export type { ContactInfo } from "./contact.js";

export { extractProducts } from "./products.js";
export type { ExtractedProduct, ExtractProductsOptions } from "./products.js";

export { extractMenu } from "./menu.js";
export type { MenuItem, ExtractMenuOptions } from "./menu.js";

export { extractArticles } from "./articles.js";
export type { ArticleEntry, ExtractArticlesOptions } from "./articles.js";
