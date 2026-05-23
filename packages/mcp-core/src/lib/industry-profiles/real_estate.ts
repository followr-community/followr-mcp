// Real estate: listings, agents, market reports, neighborhood guides.

import type { IndustryProfile } from "./types.js";

export const REAL_ESTATE_PROFILE: IndustryProfile = {
  id: "real_estate",
  display_name: "Inmobiliaria / real estate",
  keywords: {
    strong: ["propiedades", "listings", "m2", "alquiler", "venta", "real estate", "for sale", "for rent", "departamentos", "casas", "broker"],
    weak: ["agente", "agent", "habitaciones", "rooms", "barrio", "neighborhood", "property", "inmobiliaria"],
  },
  extractors: {
    primary: [
      {
        field: "properties",
        strategy: "css_selector",
        hint: "Property listing cards",
        selectors: ["[class*='listing']", "[class*='property']", "article[class*='estate']"],
        paths_to_crawl: ["/listings", "/propiedades", "/properties", "/for-sale", "/for-rent"],
        max_items: 30,
        required: false,
      },
      {
        field: "agents",
        strategy: "css_selector",
        hint: "Real-estate agent profiles",
        selectors: ["[class*='agent']", "[class*='broker']", "[class*='team-member']"],
        paths_to_crawl: ["/agents", "/team", "/brokers"],
        max_items: 15,
        required: false,
      },
    ],
    secondary: [
      {
        field: "market_reports",
        strategy: "css_selector",
        hint: "Market report / area trend blocks",
        selectors: ["[class*='report']", "[class*='market']", "[class*='trends']"],
        paths_to_crawl: ["/market", "/reports", "/blog"],
        max_items: 10,
        required: false,
      },
      {
        field: "locations",
        strategy: "css_selector",
        hint: "Service areas / neighborhoods covered",
        selectors: ["[class*='neighborhood']", "[class*='area']", "[class*='location']"],
        max_items: 20,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "listing_drop",
    "market_update",
    "neighborhood_spotlight",
    "agent_intro",
    "success_story",
    "buying_tip",
  ],
  format_bias: {
    hero_video: 0.7,
    carousel: 0.9,
    single_photo: 0.6,
    promo: 0.3,
    lifestyle: 0.5,
  },
  video_strategy: {
    default_video_kind: "ai_clip",
    rationale_short:
      "La propiedad (espacios, vista, amenity) vende sola en cámara. El avatar entra para narrar el recorrido, contar el barrio o presentar al agente.",
    flip_concepts: ["tour_narration", "neighborhood_overview", "agent_intro"],
  },
};
