// Local business: catch-all for services tied to a physical location
// (mechanic, salon, plumber, gym not classified as fitness_wellness, etc).

import type { IndustryProfile } from "./types.js";

export const LOCAL_BUSINESS_PROFILE: IndustryProfile = {
  id: "local_business",
  display_name: "Negocio local / servicios físicos",
  keywords: {
    strong: ["horario", "hours", "dirección", "address", "agendar", "book appointment", "atención al cliente"],
    weak: ["servicio", "service", "local", "barrio", "neighborhood", "atención", "consulta"],
  },
  extractors: {
    primary: [
      {
        field: "services",
        strategy: "css_selector",
        hint: "Services offered by the local business",
        selectors: ["[class*='service']", "[class*='offer']", "ul.services li"],
        paths_to_crawl: ["/services", "/servicios"],
        max_items: 30,
        required: false,
      },
      {
        field: "hours",
        strategy: "json_ld",
        hint: "openingHours from LocalBusiness schema",
        jsonld_types: ["LocalBusiness"],
        max_items: 1,
        required: false,
      },
      {
        field: "location",
        strategy: "json_ld",
        hint: "address from LocalBusiness schema",
        jsonld_types: ["LocalBusiness"],
        max_items: 1,
        required: false,
      },
      {
        field: "premises_photos",
        strategy: "css_selector",
        hint: "Photos of the physical location",
        selectors: ["[class*='gallery'] img", "[class*='location'] img", "[class*='interior'] img"],
        max_items: 20,
        required: false,
      },
    ],
    secondary: [
      {
        field: "team_members",
        strategy: "css_selector",
        hint: "Staff members",
        selectors: ["[class*='team']", "[class*='staff']", "[class*='employee']"],
        max_items: 15,
        required: false,
      },
      {
        field: "reviews_excerpt",
        strategy: "css_selector",
        hint: "Customer reviews / testimonials",
        selectors: ["[class*='review']", "[class*='testimonial']", "blockquote"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "service_intro",
    "before_after",
    "team_intro",
    "promo_local",
    "customer_review",
    "behind_scenes",
  ],
  format_bias: {
    hero_video: 0.4,
    carousel: 0.7,
    single_photo: 0.7,
    promo: 0.6,
    lifestyle: 0.5,
  },
};
