// Restaurant / food service. Markers: menu, reservations, hours, delivery.

import type { IndustryProfile } from "./types.js";

export const RESTAURANT_PROFILE: IndustryProfile = {
  id: "restaurant",
  display_name: "Restaurante / gastronomía",
  keywords: {
    strong: ["menú", "menu", "reservar", "delivery", "carta", "horario", "reservation", "book a table", "happy hour"],
    weak: ["plato", "dish", "comida", "food", "chef", "cocina", "bar", "café"],
  },
  extractors: {
    primary: [
      {
        field: "menu_items",
        strategy: "json_ld",
        hint: "Schema.org Menu / MenuItem when present",
        jsonld_types: ["Menu", "MenuItem", "MenuSection"],
        max_items: 50,
        required: false,
      },
      {
        field: "menu_items",
        strategy: "css_selector",
        hint: "Menu items in HTML when JSON-LD absent",
        selectors: ["[class*='menu-item']", "[class*='dish']", ".menu li", ".carta li"],
        paths_to_crawl: ["/menu", "/carta", "/food"],
        max_items: 50,
        required: false,
      },
      {
        field: "dish_photos",
        strategy: "css_selector",
        hint: "Photos of plated dishes for use as reference images",
        selectors: ["[class*='menu-item'] img", "[class*='dish'] img", "[class*='gallery'] img"],
        max_items: 30,
        required: false,
      },
      {
        field: "hours",
        strategy: "json_ld",
        hint: "openingHours from LocalBusiness / Restaurant schema",
        jsonld_types: ["Restaurant", "LocalBusiness", "FoodEstablishment"],
        max_items: 1,
        required: false,
      },
      {
        field: "location",
        strategy: "json_ld",
        hint: "address from LocalBusiness schema",
        jsonld_types: ["Restaurant", "LocalBusiness"],
        max_items: 1,
        required: false,
      },
    ],
    secondary: [
      {
        field: "daily_specials",
        strategy: "css_selector",
        hint: "Daily / weekly special callouts",
        selectors: ["[class*='special']", "[class*='today']", "[class*='daily']"],
        max_items: 5,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "dish_spotlight",
    "behind_kitchen",
    "daily_special",
    "ambient_shots",
    "chef_personality",
    "happy_hour",
  ],
  format_bias: {
    hero_video: 0.7,
    carousel: 0.7,
    single_photo: 0.9,
    promo: 0.6,
    lifestyle: 0.7,
  },
};
