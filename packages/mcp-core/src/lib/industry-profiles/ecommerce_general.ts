// Generic ecommerce. Use when products are present but the brand is not
// fashion-specific (electronics, home, pet supplies, sports gear, etc).

import type { IndustryProfile } from "./types.js";

export const ECOMMERCE_GENERAL_PROFILE: IndustryProfile = {
  id: "ecommerce_general",
  display_name: "E-commerce general (productos no específicos de moda)",
  keywords: {
    strong: ["tienda", "comprar", "carrito", "envío", "checkout", "cart", "shop now", "free shipping"],
    weak: ["producto", "product", "stock", "categoría", "category", "sku"],
  },
  negative_keywords: ["lookbook", "talles", "fit guide"],
  extractors: {
    primary: [
      {
        field: "products",
        strategy: "json_ld",
        hint: "Schema.org Product",
        jsonld_types: ["Product"],
        max_items: 30,
        required: false,
      },
      {
        field: "products",
        strategy: "css_selector",
        hint: "Product cards fallback",
        selectors: [".product", "[class*='product-card']", "[itemtype*='Product']"],
        paths_to_crawl: ["/products", "/shop", "/catalog", "/tienda"],
        max_items: 30,
        required: false,
      },
      {
        field: "categories",
        strategy: "css_selector",
        hint: "Top-level category navigation",
        selectors: ["nav a", "[class*='menu'] a", "[class*='category'] a"],
        max_items: 30,
        required: false,
      },
    ],
    secondary: [
      {
        field: "top_sellers",
        strategy: "css_selector",
        hint: "Featured / bestseller blocks on the home page",
        selectors: ["[class*='featured']", "[class*='bestseller']", "[class*='popular']"],
        max_items: 10,
        required: false,
      },
      {
        field: "shipping_info",
        strategy: "regex_text",
        hint: "Free shipping thresholds and similar offers",
        regex: "(envío gratis|free shipping|envío|shipping)\\s+(\\w+\\s+){0,5}",
        max_items: 3,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "product_drops",
    "unboxing",
    "customer_reviews",
    "promo",
    "how_to_use",
    "comparison",
  ],
  format_bias: {
    hero_video: 0.4,
    carousel: 0.8,
    single_photo: 0.7,
    promo: 0.7,
    lifestyle: 0.5,
  },
  video_strategy: {
    default_video_kind: "ai_clip",
    rationale_short:
      "El producto en uso (unboxing, demo, primer plano de detalle, motion del item) cuenta la historia. El avatar entra para how-to, comparativas con narración o FAQ.",
    flip_concepts: ["how_to_use", "faq", "comparison_narration", "brand_pov"],
  },
};
