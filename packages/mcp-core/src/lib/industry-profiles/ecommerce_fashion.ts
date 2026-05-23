// Fashion / apparel ecommerce. Strong markers: talles guide, drop / collection
// vocabulary, look book, fit references, model photos.

import type { IndustryProfile } from "./types.js";

export const ECOMMERCE_FASHION_PROFILE: IndustryProfile = {
  id: "ecommerce_fashion",
  display_name: "E-commerce de moda / indumentaria",
  keywords: {
    strong: ["talles", "size guide", "lookbook", "drop", "colección", "outfit", "fit", "guía de talles"],
    weak: ["jean", "camiseta", "shirt", "moda", "fashion", "ropa", "clothing", "tee", "vestido", "campera", "wear", "remera"],
  },
  negative_keywords: ["restaurante", "menú del día", "obra social", "consulta médica"],
  extractors: {
    primary: [
      {
        field: "products",
        strategy: "json_ld",
        hint: "Schema.org Product entries (Shopify, WooCommerce, custom stores)",
        jsonld_types: ["Product"],
        max_items: 30,
        required: false,
      },
      {
        field: "products",
        strategy: "css_selector",
        hint: "Product cards on catalog pages when JSON-LD is absent",
        selectors: [".product", "[class*='product-card']", "[itemtype*='Product']", "article.product"],
        paths_to_crawl: ["/products", "/shop", "/catalog", "/tienda", "/store", "/collection"],
        max_items: 30,
        required: false,
      },
      {
        field: "product_images",
        strategy: "css_selector",
        hint: "Product photos for use as reference_image_url in AI generation",
        selectors: [".product img", "[class*='product-card'] img", ".product-gallery img"],
        max_items: 30,
        required: false,
      },
      {
        field: "model_photos",
        strategy: "css_selector",
        hint: "Lifestyle / model lookbook photos (heroes, banners)",
        selectors: ["[class*='hero'] img", "[class*='lookbook'] img", "[class*='banner'] img"],
        max_items: 15,
        required: false,
      },
    ],
    secondary: [
      {
        field: "categories",
        strategy: "css_selector",
        hint: "Navigation categories indicating the catalog structure",
        selectors: ["nav a", "[class*='menu'] a", "[class*='category'] a"],
        max_items: 30,
        required: false,
      },
      {
        field: "sale_indicators",
        strategy: "css_selector",
        hint: "Active promo banners and sale callouts",
        selectors: ["[class*='sale']", "[class*='offer']", "[class*='promo']", "[class*='discount']"],
        max_items: 5,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "product_drops",
    "lifestyle",
    "model_outfits",
    "sales_promo",
    "behind_scenes",
    "size_guide",
  ],
  format_bias: {
    hero_video: 0.5,
    carousel: 0.9,
    single_photo: 0.7,
    promo: 0.6,
    lifestyle: 0.8,
  },
  video_strategy: {
    default_video_kind: "ai_clip",
    rationale_short:
      "El producto en movimiento (try-on, drop, textura, variaciones de color) vende solo. El avatar entra cuando hace falta una persona explicando guías de talles, how-to-style, FAQ o POV de la marca.",
    flip_concepts: ["size_guide", "how_to_style", "faq", "brand_pov"],
  },
};
