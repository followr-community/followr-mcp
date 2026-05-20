// Personal brand: solopreneurs, content creators, coaches, influencers
// with a personal-name domain or about-me-first home page.

import type { IndustryProfile } from "./types.js";

export const PERSONAL_BRAND_PROFILE: IndustryProfile = {
  id: "personal_brand",
  display_name: "Marca personal / creator / coach",
  keywords: {
    strong: ["about me", "sobre mí", "podcast", "newsletter", "speaking", "coach", "creator", "my work"],
    weak: ["personal", "bio", "blog", "contact me", "hire me", "follow me"],
  },
  extractors: {
    primary: [
      {
        field: "bio",
        strategy: "css_selector",
        hint: "About-me block on home or about page",
        selectors: ["[class*='about']", "[class*='bio']", "section[id*='about']"],
        paths_to_crawl: ["/about", "/sobre-mi", "/me"],
        max_items: 5,
        required: false,
      },
      {
        field: "content_pillars",
        strategy: "css_selector",
        hint: "What this person publishes about (categories on blog / podcast)",
        selectors: ["[class*='category']", "[class*='topic']", "[class*='theme']"],
        max_items: 10,
        required: false,
      },
      {
        field: "recent_content",
        strategy: "css_selector",
        hint: "Recent articles / episodes / posts",
        selectors: ["article", "[class*='post']", "[class*='episode']"],
        paths_to_crawl: ["/blog", "/posts", "/episodes"],
        max_items: 15,
        required: false,
      },
    ],
    secondary: [
      {
        field: "sponsors",
        strategy: "css_selector",
        hint: "Sponsor / partner blocks",
        selectors: ["[class*='sponsor']", "[class*='partner']", "[class*='supporter']"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "thought_post",
    "personal_story",
    "content_recap",
    "sponsor_callout",
    "behind_scenes",
    "Q_and_A",
  ],
  format_bias: {
    hero_video: 0.6,
    carousel: 0.6,
    single_photo: 0.7,
    promo: 0.3,
    lifestyle: 0.6,
  },
};
