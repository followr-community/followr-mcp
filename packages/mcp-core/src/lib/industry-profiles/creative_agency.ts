// Creative / design / branding / marketing agencies. Portfolio-heavy.

import type { IndustryProfile } from "./types.js";

export const CREATIVE_AGENCY_PROFILE: IndustryProfile = {
  id: "creative_agency",
  display_name: "Agencia creativa / diseño / branding",
  keywords: {
    strong: ["portfolio", "portafolio", "casos", "clientes", "brand", "branding", "design studio", "creative agency", "agencia", "diseño"],
    weak: ["creative", "rebrand", "identity", "campaign", "art direction", "studio"],
  },
  extractors: {
    primary: [
      {
        field: "portfolio_projects",
        strategy: "css_selector",
        hint: "Portfolio / case items",
        selectors: ["[class*='portfolio']", "[class*='project']", "[class*='work-item']", "[class*='case']"],
        paths_to_crawl: ["/work", "/portfolio", "/projects", "/cases"],
        max_items: 30,
        required: false,
      },
      {
        field: "clients_logos",
        strategy: "css_selector",
        hint: "Notable client logos",
        selectors: ["[class*='clients'] img", "[class*='logo-grid'] img", "[class*='trusted-by'] img", "[class*='partners'] img"],
        paths_to_crawl: ["/clients"],
        max_items: 40,
        required: false,
      },
      {
        field: "services",
        strategy: "css_selector",
        hint: "Service categories offered",
        selectors: ["[class*='service']", "[class*='offer']"],
        paths_to_crawl: ["/services", "/servicios", "/what-we-do"],
        max_items: 20,
        required: false,
      },
    ],
    secondary: [
      {
        field: "team",
        strategy: "css_selector",
        hint: "Team / studio members",
        selectors: ["[class*='team']", "[class*='member']", "[class*='people']"],
        paths_to_crawl: ["/team", "/people", "/about"],
        max_items: 15,
        required: false,
      },
      {
        field: "awards",
        strategy: "css_selector",
        hint: "Award badges / accolade callouts",
        selectors: ["[class*='award']", "[class*='accolade']", "[class*='recognition']"],
        max_items: 15,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "case_reveal",
    "process_breakdown",
    "client_logo_grid",
    "team_intro",
    "award_announcement",
    "design_tip",
  ],
  format_bias: {
    hero_video: 0.6,
    carousel: 0.9,
    single_photo: 0.7,
    promo: 0.2,
    lifestyle: 0.4,
  },
  video_strategy: {
    default_video_kind: "ai_clip",
    rationale_short:
      "El trabajo visual de la agencia (portfolio, proceso, before/after) habla más fuerte que un narrador. El avatar entra para opinión, walkthrough de un case o cómo encaramos un proyecto.",
    flip_concepts: ["opinion_piece", "case_study_walkthrough", "process_explainer"],
  },
};
