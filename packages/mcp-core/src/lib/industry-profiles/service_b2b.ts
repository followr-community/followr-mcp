// B2B services: consulting, agencies, professional services for enterprise.
// Markers: case studies, industries served, team seniors, thought leadership.

import type { IndustryProfile } from "./types.js";

export const SERVICE_B2B_PROFILE: IndustryProfile = {
  id: "service_b2b",
  display_name: "Servicios B2B / consultoría / advisory",
  keywords: {
    strong: ["case studies", "case study", "industries", "enterprise", "consulting", "advisory", "client logos", "casos de éxito", "casos de cliente"],
    weak: ["b2b", "expertise", "experience", "industry", "client", "service", "consult", "advisor"],
  },
  extractors: {
    primary: [
      {
        field: "case_studies",
        strategy: "css_selector",
        hint: "Case study cards / links",
        selectors: ["[class*='case-study']", "[class*='casestudy']", "[class*='case']", "article[class*='success']"],
        paths_to_crawl: ["/case-studies", "/casos", "/work", "/clients"],
        max_items: 20,
        required: false,
      },
      {
        field: "industries_served",
        strategy: "css_selector",
        hint: "List of verticals the firm services",
        selectors: ["[class*='industries'] li", "[class*='verticals'] li", "[class*='sectors'] a"],
        paths_to_crawl: ["/industries", "/sectors"],
        max_items: 15,
        required: false,
      },
      {
        field: "team_seniors",
        strategy: "css_selector",
        hint: "Senior team members (partners, directors)",
        selectors: ["[class*='team'] [class*='member']", "[class*='leadership'] li", "[class*='partner']"],
        paths_to_crawl: ["/team", "/about", "/leadership", "/people"],
        max_items: 15,
        required: false,
      },
    ],
    secondary: [
      {
        field: "thought_leadership",
        strategy: "css_selector",
        hint: "Recent articles / whitepapers / research",
        selectors: ["[class*='article']", "[class*='insight']", "[class*='research']"],
        paths_to_crawl: ["/insights", "/blog", "/research"],
        max_items: 15,
        required: false,
      },
      {
        field: "client_logos",
        strategy: "css_selector",
        hint: "Logos of notable clients",
        selectors: ["[class*='clients'] img", "[class*='logo-grid'] img", "[class*='trusted-by'] img"],
        max_items: 30,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "case_study_summary",
    "thought_leadership",
    "team_expertise",
    "industry_insight",
    "event_recap",
    "client_announcement",
  ],
  format_bias: {
    hero_video: 0.3,
    carousel: 0.9,
    single_photo: 0.4,
    promo: 0.1,
    lifestyle: 0.2,
  },
  video_strategy: {
    default_video_kind: "ai_avatar_video",
    rationale_short:
      "Servicios profesionales se compran a una persona, no a un brochure. El avatar transmite seniority y confianza para case studies, opiniones, walkthroughs y explainers. El AI clip puro solo cuando lo central es un dato visual o un diagrama en movimiento.",
    flip_concepts: ["data_in_motion", "process_diagram", "before_after_metric"],
  },
};
