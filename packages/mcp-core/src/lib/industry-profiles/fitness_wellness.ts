// Gym / yoga / pilates / wellness studios. Class schedules, trainers,
// membership tiers, member transformation stories.

import type { IndustryProfile } from "./types.js";

export const FITNESS_WELLNESS_PROFILE: IndustryProfile = {
  id: "fitness_wellness",
  display_name: "Gimnasio / yoga / wellness",
  keywords: {
    strong: ["clases", "classes", "entrenador", "trainer", "membresía", "membership", "gimnasio", "gym", "yoga", "crossfit", "pilates", "wellness", "fitness"],
    weak: ["workout", "training", "instructor", "ejercicio", "rutina", "studio", "spa"],
  },
  extractors: {
    primary: [
      {
        field: "classes_schedule",
        strategy: "css_selector",
        hint: "Class schedule grid",
        selectors: ["[class*='schedule']", "[class*='class-grid']", "[class*='timetable']", "table[class*='class']"],
        paths_to_crawl: ["/classes", "/schedule", "/clases", "/horarios"],
        max_items: 50,
        required: false,
      },
      {
        field: "trainers",
        strategy: "css_selector",
        hint: "Trainer / instructor profiles",
        selectors: ["[class*='trainer']", "[class*='instructor']", "[class*='coach']"],
        paths_to_crawl: ["/trainers", "/instructors", "/team"],
        max_items: 15,
        required: false,
      },
      {
        field: "membership_tiers",
        strategy: "css_selector",
        hint: "Membership tier cards",
        selectors: ["[class*='membership']", "[class*='plan']", "[class*='pricing']"],
        paths_to_crawl: ["/membership", "/pricing", "/planes"],
        max_items: 10,
        required: false,
      },
    ],
    secondary: [
      {
        field: "transformation_gallery",
        strategy: "css_selector",
        hint: "Before / after / member transformation photos",
        selectors: ["[class*='transformation']", "[class*='before-after']", "[class*='results']"],
        max_items: 20,
        required: false,
      },
      {
        field: "location",
        strategy: "json_ld",
        hint: "Studio address from LocalBusiness / HealthAndBeautyBusiness schema",
        jsonld_types: ["LocalBusiness", "HealthAndBeautyBusiness", "SportsActivityLocation"],
        max_items: 1,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "class_intro",
    "trainer_spotlight",
    "member_transformation",
    "workout_tip",
    "schedule_post",
    "motivation_quote",
  ],
  format_bias: {
    hero_video: 0.8,
    carousel: 0.7,
    single_photo: 0.5,
    promo: 0.5,
    lifestyle: 0.7,
  },
};
