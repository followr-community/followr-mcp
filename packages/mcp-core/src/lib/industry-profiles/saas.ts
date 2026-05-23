// SaaS / software as a service. Markers: pricing tiers, free trial, features
// grid, integrations, API docs link.

import type { IndustryProfile } from "./types.js";

export const SAAS_PROFILE: IndustryProfile = {
  id: "saas",
  display_name: "SaaS / software as a service",
  keywords: {
    strong: ["pricing", "free trial", "features", "integrations", "api", "dashboard", "plataforma", "platform", "sign up", "saas"],
    weak: ["software", "cloud", "subscription", "monthly", "yearly", "team plan", "enterprise plan"],
  },
  extractors: {
    primary: [
      {
        field: "features",
        strategy: "css_selector",
        hint: "Feature cards on the home or features page",
        selectors: ["[class*='feature']", "[class*='benefit']", "section[id*='feature'] li"],
        paths_to_crawl: ["/features", "/product", "/why-us"],
        max_items: 30,
        required: false,
      },
      {
        field: "pricing_tiers",
        strategy: "css_selector",
        hint: "Pricing tier cards (Starter / Pro / Enterprise patterns)",
        selectors: ["[class*='pricing']", "[class*='plan-card']", "[class*='tier']"],
        paths_to_crawl: ["/pricing", "/plans"],
        max_items: 10,
        required: false,
      },
      {
        field: "use_cases",
        strategy: "css_selector",
        hint: "Use-case sections describing customer scenarios",
        selectors: ["[class*='use-case']", "[class*='case']", "section[id*='use'] li"],
        paths_to_crawl: ["/use-cases", "/solutions"],
        max_items: 15,
        required: false,
      },
    ],
    secondary: [
      {
        field: "integrations",
        strategy: "css_selector",
        hint: "Logos of integration partners",
        selectors: ["[class*='integration'] img", "[class*='partner'] img", "[class*='logo-cloud'] img"],
        max_items: 20,
        required: false,
      },
      {
        field: "testimonials",
        strategy: "css_selector",
        hint: "Customer quote blocks",
        selectors: ["[class*='testimonial']", "[class*='quote']", "blockquote"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "feature_announcement",
    "use_case_story",
    "integration_news",
    "customer_testimonial",
    "thought_leadership",
    "tutorial",
  ],
  format_bias: {
    hero_video: 0.5,
    carousel: 0.8,
    single_photo: 0.3,
    promo: 0.3,
    lifestyle: 0.2,
  },
  video_strategy: {
    default_video_kind: "ai_avatar_video",
    rationale_short:
      "B2B cierra con voz humana. El producto SaaS es abstracto y necesita un narrador para explicar value prop, workflow, use case o por qué se construyó. El AI clip puro solo entra para data-in-motion, demos de UI o feature reveals donde el movimiento es el mensaje.",
    flip_concepts: ["data_in_motion", "ui_flow_demo", "feature_reveal_visual"],
  },
};
