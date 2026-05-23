// News / media outlets: digital newspapers, magazines, blogs with editorial
// staff. RSS / Atom feeds are common; latest_articles is the priority signal.

import type { IndustryProfile } from "./types.js";

export const NEWS_MEDIA_PROFILE: IndustryProfile = {
  id: "news_media",
  display_name: "Diario / portal de noticias / medio digital",
  keywords: {
    strong: ["noticias", "última hora", "news", "actualidad", "editorial", "redacción", "periodismo", "diario", "portal", "breaking"],
    weak: ["nota", "article", "story", "headline", "columnist", "opinion", "reportaje"],
  },
  extractors: {
    primary: [
      {
        field: "latest_articles",
        strategy: "rss_feed",
        hint: "RSS / Atom feed if discoverable via <link rel='alternate'>",
        max_items: 50,
        required: false,
      },
      {
        field: "latest_articles",
        strategy: "json_ld",
        hint: "NewsArticle / Article entries on the home page",
        jsonld_types: ["NewsArticle", "Article", "BlogPosting"],
        max_items: 30,
        required: false,
      },
      {
        field: "latest_articles",
        strategy: "css_selector",
        hint: "Article cards fallback",
        selectors: ["article", "[class*='article']", "[class*='news-item']", "[class*='story']"],
        max_items: 30,
        required: false,
      },
      {
        field: "categories",
        strategy: "css_selector",
        hint: "Top-level sections (Politics, Sports, etc)",
        selectors: ["nav a", "[class*='section']", "[class*='category']"],
        max_items: 30,
        required: false,
      },
    ],
    secondary: [
      {
        field: "top_stories",
        strategy: "css_selector",
        hint: "Featured / top story block",
        selectors: ["[class*='top-story']", "[class*='featured']", "[class*='hero-article']"],
        max_items: 10,
        required: false,
      },
      {
        field: "authors",
        strategy: "css_selector",
        hint: "Bylines / author names",
        selectors: ["[class*='author']", "[class*='byline']", "[class*='columnist']"],
        max_items: 30,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "breaking_news",
    "opinion",
    "deep_dive",
    "infographic_carousel",
    "video_report",
    "poll_engagement",
  ],
  format_bias: {
    hero_video: 0.5,
    carousel: 0.7,
    single_photo: 0.5,
    promo: 0.2,
    lifestyle: 0.2,
  },
  video_strategy: {
    default_video_kind: "ai_avatar_video",
    rationale_short:
      "Opinión, breakdowns y deep dives suenan mejor con un narrador. El avatar entra para columnas, análisis editorial y resúmenes con voz. El AI clip queda para B-roll tipo footage o infografías en movimiento.",
    flip_concepts: ["broll_footage", "infographic_motion", "data_visualization"],
  },
};
