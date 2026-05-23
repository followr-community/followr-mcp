// Event organizers: festivals, conferences, recurring event venues, fairs.

import type { IndustryProfile } from "./types.js";

export const EVENTS_ORGANIZER_PROFILE: IndustryProfile = {
  id: "events_organizer",
  display_name: "Organizador de eventos / venue / festival",
  keywords: {
    strong: ["evento", "event", "entradas", "tickets", "venue", "festival", "conferencia", "conference", "ediciones pasadas", "lineup"],
    weak: ["agenda", "schedule", "speakers", "panelist", "edición", "edition", "feria", "expo"],
  },
  extractors: {
    primary: [
      {
        field: "upcoming_events",
        strategy: "json_ld",
        hint: "Event entries from schema",
        jsonld_types: ["Event", "BusinessEvent", "Festival", "MusicEvent", "TheaterEvent"],
        max_items: 30,
        required: false,
      },
      {
        field: "upcoming_events",
        strategy: "css_selector",
        hint: "Upcoming event cards fallback",
        selectors: ["[class*='event']", "[class*='upcoming']", "article[class*='event']"],
        paths_to_crawl: ["/events", "/agenda", "/calendar"],
        max_items: 30,
        required: false,
      },
      {
        field: "speakers",
        strategy: "css_selector",
        hint: "Speaker / lineup profiles",
        selectors: ["[class*='speaker']", "[class*='artist']", "[class*='performer']", "[class*='lineup']"],
        paths_to_crawl: ["/speakers", "/lineup", "/artistas"],
        max_items: 30,
        required: false,
      },
    ],
    secondary: [
      {
        field: "past_events_gallery",
        strategy: "css_selector",
        hint: "Photos from past editions",
        selectors: ["[class*='past']", "[class*='previous']", "[class*='archive'] img", "[class*='gallery'] img"],
        max_items: 30,
        required: false,
      },
      {
        field: "sponsors",
        strategy: "css_selector",
        hint: "Sponsor logos",
        selectors: ["[class*='sponsor'] img", "[class*='partner'] img"],
        max_items: 20,
        required: false,
      },
      {
        field: "ticket_tiers",
        strategy: "css_selector",
        hint: "Ticket types and tiers",
        selectors: ["[class*='ticket']", "[class*='pass']", "[class*='entry-type']"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "event_announcement",
    "speaker_reveal",
    "countdown",
    "past_recap",
    "behind_organizing",
    "sponsor_shoutout",
  ],
  format_bias: {
    hero_video: 0.7,
    carousel: 0.8,
    single_photo: 0.5,
    promo: 0.7,
    lifestyle: 0.5,
  },
  video_strategy: {
    default_video_kind: "ai_clip",
    rationale_short:
      "Ediciones pasadas, reveals del venue y countdowns funcionan con motion puro. El avatar entra para anunciar speakers o que el host hable directo a cámara.",
    flip_concepts: ["speaker_reveal", "host_announcement"],
  },
};
