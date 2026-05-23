// Hotel / hostel / posada / hospitality. Bookable rooms, amenities, location.

import type { IndustryProfile } from "./types.js";

export const HOTEL_HOSPITALITY_PROFILE: IndustryProfile = {
  id: "hotel_hospitality",
  display_name: "Hotel / hostería / hospitality",
  keywords: {
    strong: ["reservar habitación", "amenities", "booking", "hostel", "posada", "hotel", "check-in", "stay with us", "rooms"],
    weak: ["habitación", "room", "estadía", "stay", "resort", "lodge", "suite"],
  },
  extractors: {
    primary: [
      {
        field: "rooms",
        strategy: "css_selector",
        hint: "Room type cards",
        selectors: ["[class*='room']", "[class*='suite']", "[class*='accommodation']"],
        paths_to_crawl: ["/rooms", "/habitaciones", "/accommodation"],
        max_items: 15,
        required: false,
      },
      {
        field: "amenities",
        strategy: "css_selector",
        hint: "Amenities lists (pool, wifi, restaurant, etc)",
        selectors: ["[class*='amenities'] li", "[class*='amenity']", "[class*='facilities'] li"],
        max_items: 30,
        required: false,
      },
      {
        field: "location",
        strategy: "json_ld",
        hint: "address from Hotel / LodgingBusiness schema",
        jsonld_types: ["Hotel", "LodgingBusiness", "BedAndBreakfast"],
        max_items: 1,
        required: false,
      },
      {
        field: "gallery",
        strategy: "css_selector",
        hint: "Property photo gallery",
        selectors: ["[class*='gallery'] img", "[class*='photos'] img", "[class*='slideshow'] img"],
        max_items: 30,
        required: false,
      },
    ],
    secondary: [
      {
        field: "packages",
        strategy: "css_selector",
        hint: "Stay packages and offers",
        selectors: ["[class*='package']", "[class*='offer']", "[class*='special']"],
        paths_to_crawl: ["/offers", "/packages", "/ofertas"],
        max_items: 10,
        required: false,
      },
      {
        field: "reviews_excerpt",
        strategy: "css_selector",
        hint: "Guest reviews / testimonials",
        selectors: ["[class*='review']", "[class*='testimonial']", "blockquote"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "room_showcase",
    "amenity_highlight",
    "local_attraction",
    "guest_review",
    "season_promo",
    "behind_concierge",
  ],
  format_bias: {
    hero_video: 0.7,
    carousel: 0.9,
    single_photo: 0.7,
    promo: 0.5,
    lifestyle: 0.7,
  },
  video_strategy: {
    default_video_kind: "ai_clip",
    rationale_short:
      "El lugar físico (habitación, vista, amenity) vende solo, la cámara lo muestra y alcanza. El avatar entra para narrar un tour, contar el barrio o dar una bienvenida del host.",
    flip_concepts: ["tour_narration", "neighborhood_overview", "host_welcome"],
  },
};
