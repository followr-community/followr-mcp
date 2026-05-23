// Industry-aware deep research types.
//
// A "profile" is a declarative bundle describing one kind of business
// (fashion ecommerce, restaurant, SaaS, news outlet, etc.) with:
//   - keywords used to classify a website as belonging to this industry
//   - extractor specs telling the deep-research engine WHAT to look for
//     in HTML (product catalogs, menu items, articles, gallery photos)
//   - content pillar suggestions surfaced to the planning agent
//   - format-bias weights used when ranking suggested formats
//
// Profiles are pure data. Extraction logic lives in lib/extractors and
// is invoked by deep_research given a profile id. This keeps each
// profile small and reviewable, and lets new industries be added by
// dropping a single declarative file in industry-profiles/.

/**
 * Closed set of recognized industries. When a website does not match
 * any of the 16 industry-specific profiles, the classifier falls back
 * to "generic_business" and the agent asks the user to disambiguate.
 */
export type IndustryId =
  | "ecommerce_fashion"
  | "ecommerce_general"
  | "saas"
  | "restaurant"
  | "service_b2b"
  | "education"
  | "real_estate"
  | "healthcare"
  | "creative_agency"
  | "local_business"
  | "personal_brand"
  | "news_media"
  | "hotel_hospitality"
  | "fitness_wellness"
  | "events_organizer"
  | "ngo_nonprofit"
  | "generic_business";

/**
 * Strategy that an extractor uses to pull data from the website.
 *
 * - json_ld: parse <script type="application/ld+json"> and look for the
 *   declared Schema.org type. Most reliable when present (Shopify, many
 *   restaurants, hotel chains).
 * - css_selector: query the parsed DOM via CSS selectors. Falls back when
 *   JSON-LD is absent. Selectors are guesses based on common CMS markup
 *   patterns; per-profile selector lists keep the noise contained.
 * - og_meta: read OpenGraph / Twitter / oembed meta tags from <head>.
 *   Always cheap; useful for fallback summaries.
 * - regex_text: run a regex against the extracted body text. Reserved for
 *   simple patterns like prices, phone numbers, emails. NEVER used to
 *   extract HTML structure (parser handles that).
 * - sitemap_path: read /sitemap.xml and follow product / article URLs
 *   in the `thorough` depth mode. Optional in `standard`.
 * - rss_feed: read an RSS / Atom feed if discoverable from <link rel="alternate">.
 *   Used by news_media profile primarily.
 */
export type ExtractorStrategy =
  | "json_ld"
  | "css_selector"
  | "og_meta"
  | "regex_text"
  | "sitemap_path"
  | "rss_feed";

/**
 * One unit of extraction work. Multiple extractors can target the same
 * output `field`; the engine merges and dedupes. `required: true` means
 * the profile's `sufficiency` score drops if this extractor returns
 * nothing.
 */
export interface ExtractorSpec {
  /** Result field where the extractor writes (e.g. "products", "menu_items"). */
  field: string;
  strategy: ExtractorStrategy;
  /** One-line rationale shown in extractor failure logs for debugging. */
  hint: string;
  /** CSS selectors. Required when strategy === "css_selector". */
  selectors?: string[];
  /** Regex pattern as a string. Required when strategy === "regex_text". */
  regex?: string;
  /** URL paths to crawl in addition to the home page (depth >= standard). */
  paths_to_crawl?: string[];
  /** JSON-LD @type to match. Required when strategy === "json_ld". */
  jsonld_types?: string[];
  /** Cap on items the extractor adds. Engine clips beyond this. */
  max_items?: number;
  /** True if the profile considers itself "thin" when this extractor returns nothing. */
  required: boolean;
}

/**
 * Format-bias weights. Used by the planning agent to rank suggested
 * formats when building a plan_items array. 0 = avoid; 1 = strongly
 * prefer. Sum is NOT required to be 1.
 */
export interface FormatBias {
  hero_video: number;
  carousel: number;
  single_photo: number;
  promo: number;
  lifestyle: number;
}

/**
 * The two video-generation paths the agent can default to when planning a
 * video sub_post. Excludes upload paths (those are user-driven, not industry
 * driven) and excludes avatar_lipsync (single-scene variant; the multi-scene
 * generate_avatar_video is the documented default for avatar work).
 *
 * - ai_clip: cinematic / motion / lifestyle clip from a text prompt
 *   (generate_ai_video_clip). No human face, no speech. Some models in the
 *   catalog generate native audio (Veo 3 family); the rest are silent.
 * - ai_avatar_video: multi-scene avatar reel with burned subtitles and
 *   synthetic voice of the script (generate_avatar_video). A human-shaped
 *   avatar speaks across one or more scenes.
 */
export type VideoKind = "ai_clip" | "ai_avatar_video";

/**
 * Industry default for video kind. Encodes the prose chart in
 * instructions.ts (section "INDUSTRY GUIDANCE") as structured data so the
 * planning code can read it without parsing prose, and so the LLM cannot
 * silently skip the rule. Read by prepare_content_plan_context to derive
 * a recommended_video_strategy block exposed to the agent.
 *
 * - default_video_kind: which kind the planner should pick when no concept
 *   override applies.
 * - rationale_short: human-language one-liner the agent surfaces to the
 *   user when proposing avatar setup or explaining the choice. NO mentions
 *   of internal MCP terms (avatar_id, asset_layout, sub_post, etc.).
 * - flip_concepts: shortlist of plan-item concept tags that flip the
 *   choice to the other VideoKind. For a default of ai_avatar_video,
 *   these concepts use ai_clip instead, and vice versa. Empty array means
 *   the default holds for every concept this industry would post about.
 * - is_ambiguous: true only for generic_business; signals the agent must
 *   pick per concept rather than industry, and should ask the user.
 */
export interface VideoStrategy {
  default_video_kind: VideoKind;
  rationale_short: string;
  flip_concepts: string[];
  is_ambiguous?: boolean;
}

/**
 * Keyword set with weighted matches. The classifier sums:
 *   3 * count(strong matches) + 1 * count(weak matches) - 2 * count(negative matches)
 * across the home page text and meta. Highest-scoring profile wins, as
 * long as the runner-up is at least 2x weaker.
 *
 * Localization: include common synonyms in es + en. Other languages can
 * fall back to the LLM-side classifier path (handled by the deep_research
 * tool, not by the profile data).
 */
export interface ProfileKeywords {
  strong: string[];
  weak: string[];
}

/**
 * Suggested content pillars for plans built on this profile. Surfaced
 * verbatim to the planning agent inside DeepResearchResult.content_pillars_inferred.
 * Each pillar string is a short slug; the agent translates it to natural
 * language when presenting to the user.
 */
export type ContentPillar = string;

export interface IndustryProfile {
  id: IndustryId;
  display_name: string;
  keywords: ProfileKeywords;
  negative_keywords?: string[];
  extractors: {
    primary: ExtractorSpec[];
    secondary: ExtractorSpec[];
  };
  content_pillars_suggested: ContentPillar[];
  format_bias: FormatBias;
  video_strategy: VideoStrategy;
}
