// Static catalogue for content-plan tools: compatibility matrix between
// networks, product types and asset layouts; video / image model catalog with
// per-second costs; capabilities summary.
//
// Source of truth for the compatibility matrix is
// packages/mcp-core/src/data/social-network-specs.json (loaded at runtime by
// the validate engine). The matrix here mirrors those constraints in a
// shape that's friendlier to the planning agent (one row per network with
// human-readable notes).
//
// Source of truth for model costs is docs/followr-api/ai-results.md sections
// "Image models" and "Video models" (Catálogo de modelos disponibles). Costs
// are credits PER SECOND of generated video. Veo clips are ~8 seconds so we
// pre-multiply for the agent's convenience.

import type { AssetLayout, ProductType, SocialNetwork } from "./content-plan-state.js";

// ── Compatibility matrix ────────────────────────────────────────────────────

interface NetworkSlotSpec {
  /** Followr's internal social_network_type string passed to create_post. */
  internal_id: string;
  /** Human-readable label for the user. */
  display_name: string;
  max_images_in_carousel: number;
  max_videos: number;
  allow_mixed_media: boolean;
  // Which (product_type, asset_layout) pairs are accepted on this slot.
  accepts: Array<{ product_type: ProductType; asset_layouts: AssetLayout[] }>;
}

export const NETWORK_FORMAT_COMPATIBILITY: Record<string, NetworkSlotSpec> = {
  // Instagram has three product slots that the planner cares about.
  "instagram:feed": {
    internal_id: "instagram",
    display_name: "Instagram Feed",
    max_images_in_carousel: 10,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [
      {
        product_type: "feed",
        asset_layouts: ["single_image", "carousel_images", "single_video"],
      },
    ],
  },
  "instagram:reel": {
    internal_id: "instagram",
    display_name: "Instagram Reel",
    max_images_in_carousel: 0,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [{ product_type: "reel", asset_layouts: ["single_video"] }],
  },
  "instagram:story": {
    internal_id: "instagram",
    display_name: "Instagram Story",
    max_images_in_carousel: 1,
    max_videos: 1,
    allow_mixed_media: true,
    accepts: [{ product_type: "story", asset_layouts: ["single_image", "single_video"] }],
  },

  "facebook:feed": {
    internal_id: "facebook",
    display_name: "Facebook Feed",
    max_images_in_carousel: 10,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [
      { product_type: "feed", asset_layouts: ["single_image", "carousel_images", "single_video"] },
    ],
  },
  "facebook:reel": {
    internal_id: "facebook",
    display_name: "Facebook Reel",
    max_images_in_carousel: 0,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [{ product_type: "reel", asset_layouts: ["single_video"] }],
  },
  "facebook:story": {
    internal_id: "facebook",
    display_name: "Facebook Story",
    max_images_in_carousel: 1,
    max_videos: 1,
    allow_mixed_media: true,
    accepts: [{ product_type: "story", asset_layouts: ["single_image", "single_video"] }],
  },

  "tiktok:feed": {
    internal_id: "tiktok",
    display_name: "TikTok",
    max_images_in_carousel: 0,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [{ product_type: "feed", asset_layouts: ["single_video"] }],
  },

  "linkedin:feed": {
    internal_id: "linkedin",
    display_name: "LinkedIn",
    max_images_in_carousel: 9,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [
      { product_type: "feed", asset_layouts: ["single_image", "carousel_images", "single_video"] },
    ],
  },

  "x:feed": {
    internal_id: "twitter",
    display_name: "X / Twitter",
    max_images_in_carousel: 4,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [
      { product_type: "feed", asset_layouts: ["single_image", "carousel_images", "single_video", "single_gif"] },
    ],
  },

  "pinterest:feed": {
    internal_id: "pinterest",
    display_name: "Pinterest",
    max_images_in_carousel: 5,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [
      { product_type: "feed", asset_layouts: ["single_image", "carousel_images", "single_video"] },
    ],
  },

  "threads:feed": {
    internal_id: "threads",
    display_name: "Threads",
    max_images_in_carousel: 20,
    max_videos: 20,
    allow_mixed_media: true,
    accepts: [
      {
        product_type: "feed",
        asset_layouts: ["single_image", "carousel_images", "single_video", "carousel_mixed"],
      },
    ],
  },

  "youtube:feed": {
    internal_id: "youtube",
    display_name: "YouTube Long",
    max_images_in_carousel: 0,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [{ product_type: "long_video", asset_layouts: ["single_video"] }],
  },
  "youtube:short": {
    internal_id: "youtube",
    display_name: "YouTube Short",
    max_images_in_carousel: 0,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [{ product_type: "short", asset_layouts: ["single_video"] }],
  },

  "bluesky:feed": {
    internal_id: "bluesky",
    display_name: "Bluesky",
    max_images_in_carousel: 4,
    max_videos: 1,
    allow_mixed_media: false,
    accepts: [{ product_type: "feed", asset_layouts: ["single_image", "carousel_images", "single_video"] }],
  },
};

// Convenience helper: returns the per-network slot definitions accessible by
// the planning agent (only the union of slots from the networks actually
// connected to the company).
export function compatibilityFor(networks: SocialNetwork[]): Record<string, NetworkSlotSpec> {
  const result: Record<string, NetworkSlotSpec> = {};
  for (const [slot, spec] of Object.entries(NETWORK_FORMAT_COMPATIBILITY)) {
    const [net] = slot.split(":");
    if (net && networks.includes(net as SocialNetwork)) {
      result[slot] = spec;
    }
  }
  return result;
}

// ── Video models catalogue ──────────────────────────────────────────────────

// Costs are PER SECOND of video. Veo clips default to ~8 seconds.
// Confirmed in docs/followr-api/ai-results.md (2026-05-20 correction).
// "affordable" is computed at runtime against the user's
// ai_image_and_video_budget.

export interface VideoModelInfo {
  model_id: string;
  display_name: string;
  cost_per_second: number;
  default_duration_seconds: number;
  cost_for_default_duration: number;
  provider: string;
  recommended_for: string;
  // True if this model is part of the platform-curated recommendation ladder.
  // The agent should default to a recommended model when the company has no
  // explicit ai_preferences.video_model. Models without `recommended: true`
  // are still available, but only surface them when the user explicitly
  // requests cheaper / different / experimental options.
  recommended: boolean;
  // Sort order within the recommendation ladder (lower = more recommended).
  // 0 = default to use, 1 = first quality step up, etc. Undefined when
  // recommended is false.
  recommended_rank?: number;
}

const VIDEO_MODEL_RECOMMENDED_DURATION = 8;

export const VIDEO_MODELS: VideoModelInfo[] = [
  {
    model_id: "veo_3_1_fast",
    display_name: "Veo 3.1 Fast",
    cost_per_second: 50,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 50 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "platform default for social-media video, balanced cost and quality",
    recommended: true,
    recommended_rank: 0,
  },
  {
    model_id: "veo_3_fast",
    display_name: "Veo 3 Fast",
    cost_per_second: 400,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 400 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "first step up in quality from veo_3_1_fast",
    recommended: true,
    recommended_rank: 1,
  },
  {
    model_id: "veo_3_1",
    display_name: "Veo 3.1",
    cost_per_second: 600,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 600 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "premium quality, hero content; second quality step",
    recommended: true,
    recommended_rank: 2,
  },
  {
    model_id: "veo_3",
    display_name: "Veo 3",
    cost_per_second: 1000,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 1000 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "top tier, only use with explicit user authorization of the cost; third quality step",
    recommended: true,
    recommended_rank: 3,
  },
  {
    model_id: "wan_2",
    display_name: "Wan 2",
    cost_per_second: 150,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 150 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "fallback default for accounts without premium model access (followr_plus_enabled=false)",
    recommended: false,
  },
  {
    model_id: "seedance_1_1_light",
    display_name: "SeeDance 1.1 Light",
    cost_per_second: 20,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 20 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request when user wants cheaper than the platform default",
    recommended: false,
  },
  {
    model_id: "seedance_1_1_pro",
    display_name: "SeeDance 1.1 Pro",
    cost_per_second: 40,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 40 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request",
    recommended: false,
  },
  {
    model_id: "seedance_2_0_fast",
    display_name: "SeeDance 2.0 Fast",
    cost_per_second: 100,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 100 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request",
    recommended: false,
  },
  {
    model_id: "seedance_2_0",
    display_name: "SeeDance 2.0",
    cost_per_second: 175,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 175 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request",
    recommended: false,
  },
  {
    model_id: "hailuo_0_2_standard",
    display_name: "Hailuo Standard",
    cost_per_second: 20,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 20 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request",
    recommended: false,
  },
  {
    model_id: "hailuo_0_2_premium",
    display_name: "Hailuo Premium",
    cost_per_second: 30,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 30 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request",
    recommended: false,
  },
];

// ── Image models catalogue ──────────────────────────────────────────────────

export interface ImageModelInfo {
  model_id: string;
  display_name: string;
  cost_per_image: number;
  bucket: "regular" | "premium";
  provider: string;
  recommended_for: string;
  // See VideoModelInfo.recommended for semantics.
  recommended: boolean;
  recommended_rank?: number;
}

export const IMAGE_MODELS: ImageModelInfo[] = [
  {
    model_id: "nano_banana_2",
    display_name: "Nano Banana 2",
    cost_per_image: 25,
    bucket: "regular",
    provider: "fal",
    recommended_for: "platform default for images, available on most plans",
    recommended: true,
    recommended_rank: 0,
  },
  {
    model_id: "nano_banana_pro",
    display_name: "Nano Banana Pro",
    cost_per_image: 45,
    bucket: "premium",
    provider: "fal",
    recommended_for: "higher quality nano variant; requires followr_plus_enabled",
    recommended: false,
  },
  {
    model_id: "gpt_image_2",
    display_name: "GPT Image 2",
    cost_per_image: 70,
    bucket: "premium",
    provider: "OpenAI",
    recommended_for: "OpenAI flagship; requires followr_plus_enabled",
    recommended: false,
  },
  {
    model_id: "imagen4_preview_fast",
    display_name: "Imagen 4 Fast",
    cost_per_image: 6,
    bucket: "regular",
    provider: "Google",
    recommended_for: "available on request when user wants cheaper than the platform default",
    recommended: false,
  },
  {
    model_id: "imagen4_preview",
    display_name: "Imagen 4",
    cost_per_image: 12,
    bucket: "regular",
    provider: "Google",
    recommended_for: "available on request",
    recommended: false,
  },
  {
    model_id: "ideogram_v3",
    display_name: "Ideogram V3",
    cost_per_image: 18,
    bucket: "regular",
    provider: "Ideogram",
    recommended_for: "available on request, strong text-in-image rendering",
    recommended: false,
  },
  {
    model_id: "flux_pro_1_1",
    display_name: "Flux Pro 1.1",
    cost_per_image: 12,
    bucket: "regular",
    provider: "fal",
    recommended_for: "available on request",
    recommended: false,
  },
  {
    model_id: "z_image_turbo",
    display_name: "Z-Image Turbo",
    cost_per_image: 2,
    bucket: "regular",
    provider: "fal",
    recommended_for: "available on request, cheapest available",
    recommended: false,
  },
];

// ── Capabilities summary ────────────────────────────────────────────────────

export const FOLLOWR_CAPABILITIES_SUMMARY = {
  can_generate: [
    "Static images via AI (Nano Banana, Imagen, Flux, GPT Image, etc.)",
    "Single short text-to-video clips up to 8 seconds (Veo, Wan, SeeDance, Hailuo)",
    "Multi-scene avatar videos with burned-in subtitles and concatenation",
    "Avatar lipsync clips (talking-head)",
    "Text-to-speech audio (ElevenLabs)",
    "Post copies, hashtag suggestions, brand voice prompts",
  ],
  can_upload: [
    "Images from public URL into the asset library",
    "Videos from public URL into the asset library",
    "Canva designs imported as ready-to-publish posts",
  ],
  can_publish_to: [
    "Instagram feed (image / carousel up to 10 / video)",
    "Instagram Reel (video, 9:16)",
    "Instagram Story (image or video)",
    "Facebook feed (image / carousel up to 10 / video)",
    "Facebook Reel and Story",
    "TikTok feed (video only)",
    "YouTube Short and YouTube long-form (video only)",
    "LinkedIn (image / carousel up to 9 / video)",
    "X / Twitter (image / carousel up to 4 / video / gif)",
    "Pinterest (image / carousel up to 5 / video)",
    "Threads (image / carousel up to 20 / video / mixed)",
    "Bluesky (image / carousel up to 4 / video)",
  ],
  cannot_do: [
    "Filming actual people in physical settings (use existing footage or avatar videos)",
    "Native interactive stories (polls, quizzes, sliders) - the Followr API publishes media but not interactive widgets",
    "Custom video editing beyond what Creatomate scenes support",
    "Scheduling 'best time' auto-detection beyond the company's configured publishing rules",
    "Real-time replies / engagement automation",
  ],
};

// ── Assistant guidance defaults ─────────────────────────────────────────────

// Returned inside _assistant_guidance.planning_strategy of
// prepare_content_plan_context. The agent reads this to know HOW to think
// about the plan (carousel decisions, network splits, ultrathink).

export const PLANNING_STRATEGY = {
  ultrathink_required:
    "This task requires careful, deliberate reasoning. Allocate extended-thinking budget. Do NOT call draft_content_plan in the same turn as receiving this context: first identify what user intent is still ambiguous, ask ONE multi-decision question, wait for the answer, then craft the plan_items array with care.",

  network_split_rule:
    "Each plan_item represents ONE PostGroup. A PostGroup can contain MULTIPLE sub_posts, one per social network, each with its OWN asset_layout and assets_strategy. Use heterogeneous sub_posts when the same conceptual post needs different assets on different networks (e.g. a photo for Instagram feed and a generated Reel for TikTok on the same day at the same time). Two separate plan_items (with paired_with) are only needed when the user wants DIFFERENT publish times for the same concept across networks.",

  duplicate_network_rule:
    "Within the same (date, publish_at_time_local) slot, the union of social_network values across all sub_posts in all plan_items MUST be unique. Publishing two things to Instagram at the same exact time is rejected by the validator (resolution_options: consolidate the items into one PostGroup with heterogeneous sub_posts, drop the duplicate network from one of them, or move one to a different publish_at_time_local).",

  carousel_strategy: {
    use_carousel_when: [
      "Multiple related products to showcase (line drop, collection, comparison)",
      "Step-by-step / how-to (3 ways to combine X, 5 looks of Y)",
      "Explicit comparisons (baggy vs cargo, before/after)",
      "Multi-angle product views (front, side, detail, fit, price tag)",
      "Tip stacks (5 tips for using Z)",
      "Sequential storytelling with multiple beats",
    ],
    use_single_image_when: [
      "Clean drop of one principal product with strong focus",
      "Lifestyle mood shot with strong caption",
      "Promo with overlay text, single message",
      "Cinematic asset that tells the whole story in one frame",
    ],
    use_video_when: [
      "Movement is part of the concept (try-on, transition)",
      "Sound-on storytelling",
      "Dynamic cinematic lifestyle",
      "Tutorials with voice / audio",
    ],
    carousel_max_per_network: {
      instagram: 10,
      facebook: 10,
      linkedin: 9,
      x: 4,
      pinterest: 5,
      threads: 20,
      bluesky: 4,
    },
    anti_pattern:
      "Promising 'carousel' in the rationale or caption_concept and then passing a single asset. The validator surfaces a warning, but it's wasteful to round-trip: match asset_layout to the concept from the start. The real failure from a past VCP session: 'Carrusel mostrando los modelos Jean Baggy Kamu VT1, Jean Cargo Volt y variantes' planned, then executed as feed_image with 1 asset, leaving an incoherent post.",
  },

  brand_voice_handling:
    "If brand_context.voice_prompt_missing is true at this point, surface that BEFORE drafting the plan: offer to either (a) create a brand-voice prompt from the company's best-performing posts via create_prompt (recommended for any meaningful campaign), or (b) proceed with Followr default voice. Do not draft 7 posts with default voice and only mention this at the end of the plan.",

  website_summary_use:
    "brand_context.website_summary is fetched server-side from the company's website (when present) and contains current product categories, audience hints, season context, active promotions. Use it to ground the plan: do NOT propose 'café en sábado de sol' if the season is winter, do not assume unisex if the brand is men-only, etc.",

  best_performing_posts_use:
    "best_performing_posts_last_60d lists the top posts the company shipped in the last 60 days with engagement rate and format. Use these as inspiration for what works for THIS brand specifically: if reels dominate, plan reels; if carousels rank, plan carousels.",
};
