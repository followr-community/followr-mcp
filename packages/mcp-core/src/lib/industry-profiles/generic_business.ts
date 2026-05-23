// Generic business profile. Used as the fallback when:
//   - the classifier cannot match the website to any of the 16 specific
//     industries with sufficient confidence, OR
//   - the website is unreachable / SPA-only / returned empty body, OR
//   - the user explicitly asked us to skip industry detection.
//
// The extractors here are universal: company name, description, contact
// info, logo, social links. No industry-specific assumptions.

import type { IndustryProfile } from "./types.js";

export const GENERIC_BUSINESS_PROFILE: IndustryProfile = {
  id: "generic_business",
  display_name: "Negocio genérico / sin clasificación específica",
  keywords: {
    strong: [],
    weak: [],
  },
  extractors: {
    primary: [
      {
        field: "company_name",
        strategy: "og_meta",
        hint: "og:site_name or <title> for the business name",
        required: true,
      },
      {
        field: "description",
        strategy: "og_meta",
        hint: "og:description or <meta name=description>",
        required: true,
      },
      {
        field: "logo_url",
        strategy: "css_selector",
        hint: "best-effort logo discovery from common header markup",
        selectors: ["header img[alt*='logo' i]", "img.logo", "[class*='logo'] img", "img[src*='logo']"],
        max_items: 1,
        required: false,
      },
      {
        field: "contact_emails",
        strategy: "regex_text",
        hint: "any email-shaped string in the body text",
        regex: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
        max_items: 5,
        required: false,
      },
      {
        field: "social_links",
        strategy: "css_selector",
        hint: "links to known social network domains",
        selectors: [
          "a[href*='instagram.com']",
          "a[href*='facebook.com']",
          "a[href*='tiktok.com']",
          "a[href*='youtube.com']",
          "a[href*='linkedin.com']",
          "a[href*='twitter.com']",
          "a[href*='x.com']",
          "a[href*='threads.net']",
          "a[href*='pinterest.com']",
        ],
        max_items: 20,
        required: false,
      },
    ],
    secondary: [
      {
        field: "value_props",
        strategy: "css_selector",
        hint: "headlines on the home page that hint at the business proposition",
        selectors: ["h1", "h2", "[class*='hero'] p", "[class*='headline']"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "business_intro",
    "value_prop",
    "customer_proof",
    "news_update",
    "behind_scenes",
  ],
  format_bias: {
    hero_video: 0.4,
    carousel: 0.5,
    single_photo: 0.6,
    promo: 0.4,
    lifestyle: 0.4,
  },
  video_strategy: {
    default_video_kind: "ai_avatar_video",
    rationale_short:
      "Industria no clasificada. Sin señales claras, conviene preguntarle al usuario: avatar para conceptos messaging-driven (alguien explica algo), AI clip cuando el concepto es puramente visual.",
    flip_concepts: ["visual_only_concept", "atmosphere_b_roll"],
    is_ambiguous: true,
  },
};
