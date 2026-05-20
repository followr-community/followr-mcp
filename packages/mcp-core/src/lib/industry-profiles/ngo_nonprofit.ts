// NGO / nonprofit / foundation. Mission-driven, donation-asking, impact stories.

import type { IndustryProfile } from "./types.js";

export const NGO_NONPROFIT_PROFILE: IndustryProfile = {
  id: "ngo_nonprofit",
  display_name: "ONG / sin fines de lucro / fundación",
  keywords: {
    strong: ["donar", "donate", "causa", "cause", "voluntarios", "volunteers", "impacto social", "ONG", "NGO", "fundación", "foundation", "misión", "mission"],
    weak: ["impact", "comunidad", "community", "ayuda", "help", "social", "philanthropy", "nonprofit"],
  },
  extractors: {
    primary: [
      {
        field: "mission",
        strategy: "css_selector",
        hint: "Mission statement block",
        selectors: ["[class*='mission']", "[class*='about']", "section[id*='mission']"],
        paths_to_crawl: ["/about", "/mission", "/quienes-somos"],
        max_items: 3,
        required: false,
      },
      {
        field: "current_campaigns",
        strategy: "css_selector",
        hint: "Active campaign / appeal blocks",
        selectors: ["[class*='campaign']", "[class*='appeal']", "[class*='current']"],
        paths_to_crawl: ["/campaigns", "/causas", "/projects"],
        max_items: 15,
        required: false,
      },
      {
        field: "impact_metrics",
        strategy: "css_selector",
        hint: "Statistics / impact numbers",
        selectors: ["[class*='stat']", "[class*='metric']", "[class*='impact']", "[class*='counter']"],
        max_items: 15,
        required: false,
      },
      {
        field: "donation_methods",
        strategy: "css_selector",
        hint: "Ways to donate / contribute",
        selectors: ["[class*='donate']", "[class*='contribute']", "[class*='give']"],
        paths_to_crawl: ["/donate", "/donar"],
        max_items: 10,
        required: false,
      },
    ],
    secondary: [
      {
        field: "volunteer_opportunities",
        strategy: "css_selector",
        hint: "Volunteering programs and openings",
        selectors: ["[class*='volunteer']", "[class*='get-involved']"],
        paths_to_crawl: ["/volunteer", "/voluntariado", "/get-involved"],
        max_items: 15,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "impact_story",
    "beneficiary_spotlight",
    "donation_callout",
    "volunteer_recruitment",
    "transparency_report",
    "event_update",
  ],
  format_bias: {
    hero_video: 0.7,
    carousel: 0.8,
    single_photo: 0.6,
    promo: 0.5,
    lifestyle: 0.5,
  },
};
