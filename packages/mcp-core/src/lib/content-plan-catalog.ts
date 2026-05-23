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
  // Bucket gating: "premium" models require followr_plus_enabled=true on the
  // company subscription. When the flag is false the backend rejects these
  // models with HTTP 422 "selected model is invalid" before reaching the
  // generator. "regular" models work on any account. Mirrors the same field on
  // ImageModelInfo. Documented in
  // docs/followr-api/_credits-experiment-2026-05-20/_conclusions.md.
  bucket: "regular" | "premium";
  // Whether the model outputs a video with a native audio track.
  // - "with_native_audio": Google Veo 3 family generates dialogue, ambient SFX
  //   and incidental music as part of the output mp4. The audio comes from
  //   the model itself; no separate audio generation or muxing is involved.
  // - "silent_only": the model returns a muted clip. There is NO Followr tool
  //   today that can mux an external audio track onto an AI-generated clip,
  //   so when a sub_post uses one of these models the user has to add audio
  //   manually in a video editor after publishing. The preview surfaces this
  //   to the user so they don't get a silent Reel as a surprise.
  audio_capability: "with_native_audio" | "silent_only";
}

const VIDEO_MODEL_RECOMMENDED_DURATION = 8;

// Video models (used by generate_ai_video_clip). All display_name, model_id,
// cost_per_second and driver values verified against the Followr frontend
// React state on 2026-05-22 (Fix E4). The display_name format matches what
// users see in /company-settings/ai-videos, so the agent surfaces names the
// user can cross-reference verbatim.
//
// Out of scope for this catalog (handled by other tools):
//   - veed_fabric_1.0 / veed_fabric_1.0_fast: lipsync models used internally
//     by generate_avatar_lipsync_clip and generate_avatar_video; not exposed
//     as choices for AI video clips.
//   - creatomate_video / creatomate_short: template-driven video, billed
//     separately (0 cr/sec in the catalog) and not part of the AI clip flow.
export const VIDEO_MODELS: VideoModelInfo[] = [
  {
    model_id: "veo_3.1_fast",
    display_name: "Google Veo 3.1 Fast",
    cost_per_second: 50,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 50 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "platform default for social-media video on Followr Plus accounts; balanced cost and quality",
    recommended: true,
    recommended_rank: 0,
    bucket: "premium",
    audio_capability: "with_native_audio",
  },
  {
    model_id: "veo_3_fast",
    display_name: "Google Veo 3 Fast",
    cost_per_second: 400,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 400 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "first step up in quality from Google Veo 3.1 Fast",
    recommended: true,
    recommended_rank: 1,
    bucket: "premium",
    audio_capability: "with_native_audio",
  },
  {
    model_id: "veo_3.1",
    display_name: "Google Veo 3.1",
    cost_per_second: 600,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 600 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "premium quality, hero content; second quality step",
    recommended: true,
    recommended_rank: 2,
    bucket: "premium",
    audio_capability: "with_native_audio",
  },
  {
    model_id: "veo_3",
    display_name: "Google Veo 3",
    cost_per_second: 1000,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 1000 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "Google",
    recommended_for: "top tier, only use with explicit user authorization of the cost; third quality step",
    recommended: true,
    recommended_rank: 3,
    bucket: "premium",
    audio_capability: "with_native_audio",
  },
  {
    // UI display label is just "Wan 2" (no version suffix) despite the
    // model_id being wan_2.2. Verified empirically.
    model_id: "wan_2.2",
    display_name: "Wan 2",
    cost_per_second: 150,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 150 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "default for accounts without followr_plus_enabled; only regular-bucket video model available on every plan",
    recommended: false,
    bucket: "regular",
    audio_capability: "silent_only",
  },
  {
    model_id: "seedance_1.1_light",
    display_name: "SeeDance 1.1 Light",
    cost_per_second: 20,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 20 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request when user wants cheaper than the platform default; requires Followr Plus",
    recommended: false,
    bucket: "premium",
    audio_capability: "silent_only",
  },
  {
    model_id: "seedance_1.1_pro",
    display_name: "SeeDance 1.1 Pro",
    cost_per_second: 40,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 40 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request; requires Followr Plus",
    recommended: false,
    bucket: "premium",
    audio_capability: "silent_only",
  },
  {
    model_id: "seedance_2.0_fast",
    display_name: "SeeDance 2.0 Fast",
    cost_per_second: 100,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 100 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request; requires Followr Plus",
    recommended: false,
    bucket: "premium",
    audio_capability: "silent_only",
  },
  {
    model_id: "seedance_2.0",
    display_name: "SeeDance 2.0",
    cost_per_second: 175,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 175 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request; requires Followr Plus",
    recommended: false,
    bucket: "premium",
    audio_capability: "silent_only",
  },
  {
    // UI label is "Hailuo 0.2 Standard" (with a dot in the version). The
    // model_id uses hailuo_02_* with no separator, verified empirically.
    model_id: "hailuo_02_standard",
    display_name: "Hailuo 0.2 Standard",
    cost_per_second: 20,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 20 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request; requires Followr Plus",
    recommended: false,
    bucket: "premium",
    audio_capability: "silent_only",
  },
  {
    model_id: "hailuo_02_premium",
    display_name: "Hailuo 0.2 Premium",
    cost_per_second: 30,
    default_duration_seconds: VIDEO_MODEL_RECOMMENDED_DURATION,
    cost_for_default_duration: 30 * VIDEO_MODEL_RECOMMENDED_DURATION,
    provider: "fal",
    recommended_for: "available on request; requires Followr Plus",
    recommended: false,
    bucket: "premium",
    audio_capability: "silent_only",
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

// Image models are sorted by recommendation rank (best → worst). The agent
// surfaces the first entry as the default. Quality ranking + display names +
// per-image costs + canonical model_ids all confirmed empirically against
// the Followr frontend React state on 2026-05-22 (see Fix E3 in the audit).
//
// Off-ladder entries (recommended:false) are still callable; the agent only
// surfaces them when the user explicitly asks for them. Two cases:
//   1. Nano Banana Pro and Flux Pro Kontext: present in the Followr UI but
//      not part of the user's explicit quality ranking. Available on request.
//   2. Z-Image Turbo: cheapest and lowest quality, intended as fallback for
//      throwaway drafts.
export const IMAGE_MODELS: ImageModelInfo[] = [
  {
    model_id: "nano_banana_2",
    display_name: "Google Nano Banana 2",
    cost_per_image: 25,
    bucket: "regular",
    provider: "Google",
    recommended_for:
      "platform default for images, balanced quality and cost; works on every plan including Free",
    recommended: true,
    recommended_rank: 0,
  },
  {
    model_id: "gpt_image_2",
    display_name: "OpenAI GPT Image 2",
    cost_per_image: 70,
    bucket: "premium",
    provider: "OpenAI",
    recommended_for:
      "flagship-tier quality from OpenAI; recommended ladder step up from the default for hero, launch and brand-critical pieces; requires Followr Plus",
    recommended: true,
    recommended_rank: 1,
  },
  {
    // Distinct from nano_banana_2: cheaper (12 cr vs 25) and ranked just
    // below GPT Image 2 in raw quality per the Followr team.
    model_id: "nano_banana",
    display_name: "Google Nano Banana",
    cost_per_image: 12,
    bucket: "premium",
    provider: "Google",
    recommended_for:
      "high tier Google image model, sits just below GPT Image 2 in raw quality but much cheaper; strong subject and lighting rendering; requires Followr Plus",
    recommended: true,
    recommended_rank: 2,
  },
  {
    model_id: "imagen4_preview",
    display_name: "Google Imagen 4",
    cost_per_image: 12,
    bucket: "premium",
    provider: "Google",
    recommended_for:
      "Google premium image model; strong photorealism and lighting; requires Followr Plus",
    recommended: true,
    recommended_rank: 3,
  },
  {
    model_id: "imagen4_preview_fast",
    display_name: "Google Imagen 4 Fast",
    cost_per_image: 6,
    bucket: "premium",
    provider: "Google",
    recommended_for:
      "faster (and cheaper) Imagen 4 variant; slight quality dip vs Imagen 4 but well above the regular bucket; requires Followr Plus",
    recommended: true,
    recommended_rank: 4,
  },
  {
    // Older OpenAI image model. Uses HYPHENS not underscores in the id
    // (verified against Followr frontend state); driver is "openai" rather
    // than "fal" unlike most other premium models.
    model_id: "gpt-image-1-auto",
    display_name: "GPT Image",
    cost_per_image: 10,
    bucket: "premium",
    provider: "OpenAI",
    recommended_for:
      "older OpenAI image model, cheaper alternative to GPT Image 2 with a noticeable quality dip; requires Followr Plus",
    recommended: true,
    recommended_rank: 5,
  },
  {
    model_id: "ideogram_v3",
    display_name: "Ideogram V3",
    cost_per_image: 18,
    bucket: "premium",
    provider: "Ideogram",
    recommended_for:
      "strong text-in-image rendering; use when the design needs legible typographic copy baked into the image (badges, posters, social cards with text); requires Followr Plus",
    recommended: true,
    recommended_rank: 6,
  },
  {
    // Backend id has NO dot or underscore between 2 and 5 (it's "wan_25"
    // not "wan_2.5" nor "wan_2_5"). Unlike Wan video models which DO use a
    // dot (wan_2.2). Verified empirically.
    model_id: "wan_25_preview",
    display_name: "Wan 2.5 Preview",
    cost_per_image: 15,
    bucket: "premium",
    provider: "fal",
    recommended_for:
      "Wan preview image model; mid tier quality, distinct aesthetic from the Google and OpenAI families; requires Followr Plus",
    recommended: true,
    recommended_rank: 7,
  },
  {
    model_id: "flux_pro_1.1",
    display_name: "Fal Flux Pro 1.1",
    cost_per_image: 12,
    bucket: "premium",
    provider: "fal",
    recommended_for:
      "alternative Flux Pro aesthetic; ranks below the Imagen / GPT options for general use but useful when the brand specifically wants the Flux look and feel; requires Followr Plus",
    recommended: true,
    recommended_rank: 8,
  },
  {
    // Backend id is "flux_dev" (no "1" anywhere) despite the UI label
    // showing "Flux.1 Dev". Verified empirically.
    model_id: "flux_dev",
    display_name: "Fal Flux.1 Dev",
    cost_per_image: 8,
    bucket: "premium",
    provider: "fal",
    recommended_for:
      "cheaper Flux Dev variant; usable when the user wants Flux aesthetic on a budget; quality dip vs Flux Pro 1.1; requires Followr Plus",
    recommended: true,
    recommended_rank: 9,
  },
  {
    model_id: "seedream_v4",
    display_name: "Seedream V4",
    cost_per_image: 10,
    bucket: "premium",
    provider: "fal",
    recommended_for:
      "ByteDance Seedream image model; lower tier in raw quality than the Imagen / GPT / Nano Banana stack, available on request when the user wants a different aesthetic; requires Followr Plus",
    recommended: true,
    recommended_rank: 10,
  },
  {
    // Backend id is "recraftv3" (single word, no separator). The "Digital"
    // suffix from the UI label is implicit; this is the only Recraft v3
    // variant exposed by Followr today. Driver is "recraft" not "fal".
    model_id: "recraftv3",
    display_name: "Recraft v3 - Digital",
    cost_per_image: 3,
    bucket: "premium",
    provider: "Recraft",
    recommended_for:
      "cheap digital-illustration style from Recraft; lowest premium-bucket cost, useful for vector / flat illustration aesthetics; requires Followr Plus",
    recommended: true,
    recommended_rank: 11,
  },
  {
    model_id: "z_image_turbo",
    display_name: "Z-Image Turbo",
    cost_per_image: 2,
    bucket: "regular",
    provider: "fal",
    recommended_for:
      "cheapest image model; lowest quality of the catalog, OK for rapid drafts and throwaway tests; works on every plan including Free",
    recommended: false,
  },
  {
    // Active in the Followr UI as "Best New" but excluded from the user's
    // explicit quality ranking. Available on request; not part of the
    // default recommended ladder.
    model_id: "nano_banana_pro",
    display_name: "Google Nano Banana Pro",
    cost_per_image: 45,
    bucket: "premium",
    provider: "Google",
    recommended_for:
      "higher tier Google Nano Banana variant flagged 'best' in the Followr UI; available on request when the user wants more detail than Nano Banana 2; requires Followr Plus",
    recommended: false,
  },
  {
    // Flux Pro with Kontext mode. Present in the Followr UI but not part of
    // the user's explicit ranking; available on request.
    model_id: "flux_pro_kontext",
    display_name: "Fal Flux Pro Kontext",
    cost_per_image: 12,
    bucket: "premium",
    provider: "fal",
    recommended_for:
      "Flux Pro Kontext variant, same cost as Flux Pro 1.1; available on request when the user specifically wants the Kontext capability; requires Followr Plus",
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

  video_reference_constraint:
    "AI video generation (generate_ai_video_clip / assets_strategy.video_source ai_generate) accepts exactly ONE reference_image_url. There is no multi-image composite mode. If the rationale or caption_concept mentions composing several products/colors/items into a single video (e.g. 'video con los 4 colores del buzo', 'video combinando las 3 prendas', 'showcase de la línea completa en un clip'), do NOT plan it as a single AI video: the model will invent the missing items from text alone, which is hallucination. Use one of these instead: (a) carousel_images on networks that accept it, with one image per item/color (cheaper and faithful to the catalog), (b) avatar_video multi-scene where each scene shows a different item with its own reference, (c) single AI video showing ONE product close-up with the brand's real photo as reference. Never imply the user will see all variants in one AI clip unless every variant has its own ai_generate sub_post.",

  video_aspect_priority_policy:
    "When a plan_item contains MULTIPLE AI-generated videos (one per network), execute_content_plan resolves a SINGLE shared aspect ratio for the whole plan_item so the videos dedupe and the user is billed once. Priority used to pick that aspect:\n" +
    "- P1 (forces 9:16 vertical): TikTok, Instagram (feed/reel/story), Facebook (feed/reel/story), YouTube Short. These are video-native and vertical-first.\n" +
    "- P2 (forces 16:9 horizontal): LinkedIn. Horizontal-first, desktop-heavy audience.\n" +
    "- P3 (flexible, follows whichever priority is present): X / Twitter, Threads, Pinterest, Bluesky. Default to 9:16 when alone.\n" +
    "- Exception: YouTube long_video stays 16:9 regardless of the plan_item context. Coupling a long_video to a 9:16 reel would break the long-form layout. Do NOT include YouTube long_video in the same plan_item as a P1 reel hoping to share the asset; it cannot share.\n\n" +
    "PRACTICAL CONSEQUENCES for the agent:\n" +
    "1. When proposing a cross-network reel (IG Reel + FB Reel + TikTok), describe the asset as 9:16 vertical even if LinkedIn is added later; LinkedIn auto-couples down.\n" +
    "2. When proposing a LinkedIn-only or LinkedIn + X video plan_item, the asset will be 16:9. Mention this so the user understands why.\n" +
    "3. When a plan_item mixes a 9:16 P1 reel with a LinkedIn video that the user explicitly wants horizontal (e.g. a recorded talking-head), the agent must split into TWO plan_items so they keep their natural aspect ratios; the same plan_item cannot serve both.\n" +
    "4. If the user explicitly overrides ('quiero el video de LinkedIn en 16:9 aunque el de IG sea 9:16'), respect the override by splitting into two plan_items. The priority policy is an optimization default, not a hard rule.",

  youtube_feed_policy:
    "YouTube long_video (the youtube:long_video slot in the compatibility matrix) is a long-form publishing pipeline, NOT a cross-postable surface. DO NOT propose YouTube long_video in any plan_item unless:\n" +
    "(a) the user explicitly asks for long-form YouTube content for the week, or\n" +
    "(b) the user mentions they have pre-recorded long videos ready to upload (then assets_strategy.video_source = { type: 'asset_id', id } or 'url', NEVER 'ai_generate' because AI video clips top out at ~8 seconds and would be unwatchable as YT feed content).\n" +
    "YouTube Short is FINE to propose: it shares the 9:16 reel aspect with TikTok and IG/FB Reel, so it amortizes the same generation cost. When the user is opted in to YouTube Short, treat it as a P1 network and include it in the cross-post reel slot.\n" +
    "If the agent is unsure whether to include YouTube at all, default to: include youtube:short when the brand is video-native and shipping reels; OMIT youtube:long_video unless asked.",

  never_show_internal_ids:
    "User-facing messages NEVER mention internal Followr ids: post_group_id, asset_id, ai_result_id, company_id, prompt_id, tag_id, folder_id, rule_group_id, avatar_id, voice_id. The user does not care about ids and they make the agent sound like it is reading from a database. Refer to entities by name or by humanized description instead: 'el posteo del lunes' (not 'PostGroup 709047'), 'el video del fit check' (not 'asset 990941'), 'la marca VCP' (not 'company 7'). Internal ids may appear in the tool return JSON; treat those as data the agent uses to call the next tool, NOT as something to surface verbatim in user prose.",

  user_facing_language_lock:
    "PROHIBITED: never expose internal MCP / planner concepts to the user. The user wants results, not a tour of how the system thinks. Treat the list below as a hard ban: do NOT mention these names in any user-facing message, summary, explanation, status update, or apology. They are valid internally (for tool calls, for reasoning traces, for debugging) but they NEVER appear in conversation prose.\n\n" +
    "BANNED TERMS (and the natural-language replacement to use instead):\n" +
    "- shared_concept_key -> do not mention; just say 'la misma imagen se usa en las dos redes' or 'unifiqué las dos imágenes que iban a salir casi idénticas' (NEVER explain the mechanic by name; if the dedup happened, the user only needs to see one image listed, not the why).\n" +
    "- asset_layout / single_image / carousel_images / single_video / single_gif / carousel_mixed -> say 'una foto', 'un carrusel', 'un video', 'un gif', 'un carrusel mixto con foto y video'.\n" +
    "- assets_strategy / image_source / video_source / carousel_sources -> say 'imagen', 'video', 'imágenes del carrusel'.\n" +
    "- sub_post / sub_posts -> say 'el post para Instagram', 'el post para TikTok', etc. The user thinks in posts per red, not sub_posts.\n" +
    "- plan_item / plan_items -> say 'el posteo del lunes', 'los posteos de esta semana'.\n" +
    "- context_id / plan_id / ai_result_id -> never quote; they're opaque.\n" +
    "- caption_concept / copy_draft -> say 'el copy' or 'el texto del post'; the user does not need to know the planner has two text fields.\n" +
    "- product_type / feed / reel / story / short / long_video -> say 'feed', 'Reel', 'Story', 'Short', 'video largo'.\n" +
    "- blockers / warnings / validation / validate_against_specs -> describe the actual issue ('TikTok solo acepta video, así que ese post como foto no va a publicar'); do not say 'el validador devolvió un warning'.\n" +
    "- auto_dedupe / auto_resolved / near_duplicate / similarity score -> never mention; if the planner already resolved a duplicate silently, say nothing.\n" +
    "- update_content_plan / draft_content_plan / execute_content_plan / preview_plan_item / prepare_content_plan_context -> never name the tools. Phrase actions as 'ajusto el plan', 'lanzo las generaciones', 'te muestro el detalle', 'cargo el contexto de la marca'.\n" +
    "- replace_sub_post / split_subposts_by_network / add_sub_post / remove_sub_post / convert_to_carousel / shift_dates -> describe the change in plain words ('cambio el formato a carrusel', 'separo el posteo de TikTok del de Instagram', 'agrego una pieza el miércoles', 'corro toda la semana al lunes siguiente').\n" +
    "- ai_generate / ai_avatar_lipsync / ai_avatar_video / veo_3.1_fast / nano_banana_2 / wan_2.2 / model_id values -> say 'video con IA', 'avatar lipsync', 'avatar multi-escena', and the model's display_name when truly relevant ('Google Veo 3.1 Fast'). NEVER the model_id with underscores and dots.\n" +
    "- reference_image_url / reference_image_urls / use_brand_visual_identity / inspired_by_brand -> say 'imagen de referencia' if you need to mention one, otherwise omit.\n" +
    "- shared_concept_key / fingerprint / dedupe -> see first entry; do not surface.\n\n" +
    "BANNED PHRASING PATTERNS (real leaks from past sessions):\n" +
    "- 'voy a aplicar el fix automático con shared_concept_key' -> just unify silently; if you must mention, say 'unifiqué las dos imágenes que iban a salir casi idénticas para no duplicar la generación'.\n" +
    "- 'el plan tiene varios warnings de imágenes duplicadas' -> the user does not need to hear the word 'warning'. If actionable, say 'detecté que dos imágenes iban a salir parecidas, las unifiqué'. If silent, say nothing.\n" +
    "- 'apliqué shared_concept_key en las imágenes que se cruzan IG/FB' -> say 'la misma imagen se publica en Instagram y Facebook, una sola generación'.\n" +
    "- 'voy a llamar update_content_plan con replace_sub_post para cambiar el asset_layout' -> say 'ajusto el formato del viernes a carrusel'.\n" +
    "- 'el validator surface un blocker / warning' -> say 'TikTok no acepta foto, ese post no va a publicarse así'.\n\n" +
    "The result the user pays for is the post: visible copies, visible assets, visible schedule, visible cost. Everything else is plumbing. When a warning has a user_facing_message set, the agent MAY surface it verbatim. When a warning has user_facing_message: null (or absent), the agent NEVER mentions it; that warning exists only as a debug signal for the planner.",

  quality_upgrade_check:
    "Before drafting, scan the rationale and concept_shared of each plan_item for 'hero' signals: launch, hero piece, drop principal, key promo, featured, flagship, cinematic. For those items default to a higher-tier model than the platform baseline: image -> nano_banana_pro (45 cr) or flux_pro_1.1 (12 cr) instead of nano_banana_2 (25 cr); video -> veo_3_fast (~3200 cr/8s) or veo_3.1 (~4800) instead of veo_3.1_fast (~400). For the rest of the week (regular feed posts, lifestyle, recurring promos), the cheaper default is correct. After drafting, SURFACE the model choices to the user one-line per hero item: 'Para la pieza hero del viernes usé veo_3.1 (~4800 cr); si querés bajar a veo_3_fast (~3200) lo ajusto'. The user is the final arbiter of quality vs cost. Do not silently upgrade every item.",

  brand_voice_handling:
    "If brand_context.voice_prompt_missing is true at this point, surface that BEFORE drafting the plan: offer to either (a) create a brand-voice prompt from the company's best-performing posts via create_prompt (recommended for any meaningful campaign), or (b) proceed with Followr default voice. Do not draft 7 posts with default voice and only mention this at the end of the plan.",

  website_summary_use:
    "brand_context.website_summary is fetched server-side from the company's website (when present) and contains current product categories, audience hints, season context, active promotions. Use it to ground the plan: do NOT propose 'café en sábado de sol' if the season is winter, do not assume unisex if the brand is men-only, etc.",

  best_performing_posts_use:
    "best_performing_posts_last_60d lists the top posts the company shipped in the last 60 days with engagement rate and format. Use these as inspiration for what works for THIS brand specifically: if reels dominate, plan reels; if carousels rank, plan carousels. CRITICAL exception: when the array is empty (brand has not posted via Followr yet), do NOT treat the absence as 'no reels needed'. Empty history is a starting point, not evidence of preference. Apply the format_mix_per_network defaults below instead.",

  format_mix_per_network: {
    rationale:
      "Format variety within a single network drives algorithmic reach and prevents audience fatigue. A week of identical formats on the same network underperforms a balanced mix. Reels in particular have carried organic distribution on Instagram and Facebook since 2024 and remain the highest-reach surface in 2026. These targets are DEFAULTS, not hard constraints: deviate when the brief explicitly demands it (e.g. all-promo week, network-specific play) or when best_performing_posts_last_60d shows a different mix already works for THIS brand. The targets are per-network and per-week; cross-posting identical content from IG to FB is the common Followr-friendly default (see cross_post_default below).",
    recommended_mix_per_week: {
      instagram: {
        target_5_to_7_posts: { reel: "1-2", carousel: "1-2", single_image: "1-3", story: "optional" },
        minimum_floor: "At least 1 reel in any week with 5+ posts. Reels are first-class, not bonus.",
      },
      facebook: {
        target_5_to_7_posts: { reel: "1-2", carousel: "1-2", single_image: "1-3" },
        minimum_floor: "At least 1 reel in any week with 5+ posts. Same logic as instagram.",
      },
      tiktok: {
        target_5_to_7_posts: { reel_video: "all (network only accepts video)" },
        minimum_floor: "Trivially met: TikTok requires video.",
      },
      linkedin: {
        target_5_to_7_posts: { single_image: "2-3", carousel: "1-2", single_video: "0-1" },
        minimum_floor: "No video required; LinkedIn audience absorbs static carousels and long captions well.",
      },
      x: {
        target_5_to_7_posts: { single_image: "3-4", carousel: "0-1", single_video: "0-1" },
        minimum_floor: "No reel-equivalent; X is text-first with image support.",
      },
      youtube: {
        target_5_to_7_posts: { short: "1-2 per week when included as a cross-post of the IG/TikTok reel asset", long_video: "OFF by default, opt-in only" },
        minimum_floor:
          "youtube:short is FINE to propose as cross-post of the P1 9:16 reel asset (zero extra cost, shares the same generation). youtube:long_video is OFF by default: never propose it in a plan_item unless the user explicitly asked for long-form YouTube content this week OR mentioned they have pre-recorded long videos ready (in which case use assets_strategy.video_source = { type: 'asset_id' } or 'url', NEVER 'ai_generate' since AI clips top out at ~8s).",
      },
    },
    cross_post_default:
      "When both instagram and facebook are connected, identical per-slot content (same concept, same asset, same format) is the COMMON Followr-friendly default and aligns with the cross-post workflow. Differentiate IG vs FB only when the brief explicitly demands it (audience age gap, network-specific promo wording, native FB long-caption play). The mix table above applies per network; identical mix on IG and FB is expected, not lazy.",
    reel_concept_seeds:
      "Reel-native concepts to seed at least one reel per IG/FB week when the brand has not posted reels before: try-on / fitting moment, before/after, behind-the-scenes / packing / studio shot, transition cut (outfit change, lighting change, location change), 3-second hook + product reveal, satisfying close-up (texture, stitching, hardware, plating), POV first-person, day-in-the-life mini-vlog, customer reaction reaction-cam, time-lapse of a process. For fashion specifically: fit check, outfit transition, try-on with quick cuts. For food: plating shot, first-bite reaction, pour-and-reveal. For service businesses: process montage, day in the studio, client-result reveal.",
    cross_post_amortization:
      "A 9:16 vertical reel asset serves Instagram Reel + Facebook Reel + TikTok + YouTube Short with ZERO extra generation cost. When TikTok is in the plan (i.e. video already being generated), the reel slot for IG and FB is essentially free: reuse the same asset across all four networks. This compounds the case for including reels: the cost amortizes across every video-capable network the brand has connected.",
    anti_pattern:
      "Planning 5 IG posts for the week with 0 reels because the brand has no past reels and falling back to 'safe' feed/carousel. This is the EXACT inertia the planner should help break, not reinforce. Defaulting to feed because 'past data shows feed' (or because past data is empty) is reinforcement of status quo, not strategy. Pick the most movement-friendly concept of the week (try-on, transition, BTS, before/after) and propose it as a reel even when the brand has only posted statics before. The user can always push back; the planner should not silently default to the safe choice.",
  },

  copy_drafting_principle:
    "EVERY sub_post needs TWO fields when running inside an interactive session: caption_concept (your editorial brief, NOT shown to the user) AND copy_draft (the publication-ready text the user will actually see in Followr). copy_draft is the user-facing post body; caption_concept is your reasoning trace.\n\n" +
    "WHY both: execute_content_plan persists copy_draft verbatim into the post's description. If you leave copy_draft undefined, the resolver falls back to a server-side generate_text call using caption_concept as the brief (path B, costs ai_text_budget words, OK quality), and if THAT fails too, the directive itself becomes the post body (path C, looks like reading a prompt). The 2026-05-21 audit found a PostApprove session where 10 posts shipped as drafts containing literal directive text ('Hook: \"X\". Explicar el flow de 3 pasos: schedule normal, ...'). That is the failure mode this field exists to prevent.\n\n" +
    "PER-NETWORK COPY GUIDELINES (target length, hashtag count) when you write copy_draft:\n" +
    "- LinkedIn: 100-200 words. Include 3-5 hashtags at the end. Hook on line 1, value on lines 2-4, CTA at the end. Professional tone unless brand declares otherwise.\n" +
    "- Instagram feed/carousel: 100-150 words. 5-8 hashtags on the last line (mix of broad + niche). First sentence is the hook; the rest can be more conversational.\n" +
    "- Instagram Reel/Story: 60-120 words. 3-5 hashtags. Hook-heavy because Reels surface from suggested feeds.\n" +
    "- X / Twitter: <=280 characters total. 1-3 hashtags integrated in the body, not as a tail.\n" +
    "- TikTok: 50-150 characters. 3-5 hashtags integrated or trailing. Trending-hashtag-aware (use sparingly when relevant).\n" +
    "- Threads: <=500 characters. 0-3 hashtags optional.\n" +
    "- Pinterest: 20-80 character title; hashtags are NOT useful (Pinterest is keyword-driven). Skip them.\n" +
    "- Facebook feed: 80-180 words. 1-3 hashtags optional, light usage works best.\n" +
    "- YouTube Short: 60-120 words description, 3-5 hashtags. YouTube long_video: 150-400 words with timestamps if applicable.\n" +
    "- Bluesky: <=300 characters, 1-3 hashtags optional.\n\n" +
    "LANGUAGE: copy_draft must match user_answers.language (default = company.language). Do NOT mix languages between sub_posts of the same plan_item (the 2026-05-21 PostApprove audit had LinkedIn in English and Instagram in Spanish for the same concept, wrong; both should match the audience's language). When the audience is LATAM but company.language is 'en', ASK the user to pick before writing copy.\n\n" +
    "HASHTAG POLICY: if user_answers.hashtags_policy === 'off', include NO hashtags in any network. Otherwise apply the per-network counts above.\n\n" +
    "ANTI-PATTERN: writing copy_draft only for Instagram and leaving LinkedIn / X / TikTok with empty copy_draft. That dumps the fallback path onto every other network and produces inconsistent quality across the same plan_item. Be consistent: either write copy_draft for all sub_posts, or none (and rely on path B fallback for the whole plan_item).",

  image_reuse_principle:
    "Within a single plan_item, when two sub_posts (typically two different networks) need conceptually the same asset (cover slide, step illustration, CTA card), DO NOT duplicate the AssetSourceAiImage with two prompts that only differ by a stylistic adjective. The 2026-05-21 PostApprove audit found two cases (cover LinkedIn vs cover IG; step01 LinkedIn vs step01 IG) where the prompts differed only by 'generous negative space' / 'professional SaaS aesthetic' at the tail. The model rendered visually indistinguishable outputs and burned 2 credits per pair for zero differentiation (28% of the post's image budget wasted).\n\n" +
    "PRINCIPLE: differentiation by ADJECTIVE in the prompt is decorative and unreliable; differentiation by ASPECT_RATIO or COPY-TEXT is structural and reliable.\n\n" +
    "Practical rules:\n" +
    "1. SAME CONCEPT, SAME RATIO, SAME COPY-TEXT-ON-IMAGE: use ONE AssetSourceAiImage with shared_concept_key set (e.g. 'cover', 'step-01'). Reference the SAME ref by shared_concept_key in carousel_sources of both networks. The resolver collapses them to one generation. This is the canonical path and the validator looks for it.\n" +
    "2. DIFFERENT RATIO (LinkedIn 16:9 vs IG 1:1): generate TWO refs but set aspect_ratio explicitly on each, with the same prompt text. The fingerprint includes aspect_ratio so they are distinct generations, but the differentiation is meaningful and structural.\n" +
    "3. DIFFERENT COPY TEXT ON IMAGE (localized covers, e.g. EN vs ES): generate TWO refs with prompts that include the different copy text. The differentiation is meaningful.\n" +
    "4. Prompt variations like 'generous negative space', 'professional aesthetic', 'minimalist', etc.: the model treats these as soft style hints and rarely produces visibly different outputs. NEVER use them as the ONLY differentiation between two near-identical concepts.\n\n" +
    "ASPECT RATIO defaults per network and product_type (use aspect_ratio explicitly in AssetSourceAiImage to override the company's ai_preferences.image_aspect_ratio):\n" +
    "- LinkedIn feed single_image: 1.91:1 closest enum = 16:9 (or 1:1 for portrait-friendly). LinkedIn carousel: 1:1.\n" +
    "- Instagram feed single_image: 1:1 (default) or 3:4 for portrait emphasis. Instagram carousel: 1:1.\n" +
    "- Instagram Reel / Story: 9:16.\n" +
    "- Facebook feed: 1:1 or 16:9. Facebook Reel: 9:16.\n" +
    "- TikTok: 9:16 ALWAYS (the network only accepts 9:16 video; for the cover/preview image, still 9:16 if used).\n" +
    "- YouTube Short: 9:16. YouTube long_video thumbnail: 16:9.\n" +
    "- X / Twitter: 16:9 or 1:1.\n" +
    "- Pinterest: 3:4 vertical (2:3 vertical also accepted; 3:4 is the closest enum).\n" +
    "- Threads: same as Instagram, 1:1 default.\n" +
    "- Bluesky: 16:9 or 1:1.\n\n" +
    "VALIDATOR BACKSTOP: draft_content_plan runs a normalized Levenshtein similarity check between every pair of AssetSourceAiImage prompts inside the same plan_item. Pairs >=85% similar surface a non-blocking warning with resolution_options (merge_with_shared_concept_key / differentiate_by_aspect_ratio / acknowledge_and_proceed). Take the merge_with_shared_concept_key option unless the user has a creative reason to keep them distinct.",

  no_networks_connected_handling:
    "When prepare_content_plan_context returns connected_networks.length === 0, STOP before drafting the plan. The _assistant_guidance.no_networks_connected_blocker field will be populated; surface its user_message verbatim and ask the user to pick one of the resolution_options (abort_and_connect / proceed_as_drafts_only). The point is to avoid spending the agent's context on a 7-day plan that will sit as un-publishable drafts because no LinkedIn / IG / TikTok integration exists.",

  brand_voice_setup_handling:
    "When prepare_content_plan_context returns brand_voice_setup_proposal != null (i.e. the company has no brand voice prompt loaded), STOP before drafting the plan. Surface the proposal's user_message verbatim. If the user picks 'create_brand_voice_first', call create_prompt with the suggested_create_prompt_seed values from the response (a single tool call). After it succeeds, re-call prepare_content_plan_context to refresh the brief, then proceed with draft_content_plan. If the user picks 'proceed_with_default_voice', acknowledge the trade-off and continue.",

  validator_auto_resolve_principle:
    "When draft_content_plan returns warnings with resolution_options (e.g. rationale_suggests_carousel_but_layout_is_single, near_duplicate_ai_image_prompts, ai_video_implies_multiple_references), do NOT pass the decision to the user every time. For the OBVIOUS fixes apply them via update_content_plan automatically and tell the user 'lo corregí porque la diferencia era trivial, avisame si querías que se quede así'. Specifically:\n" +
    "- rationale_suggests_carousel_but_layout_is_single: auto-promote to carousel_images with 3-5 AssetSourceAiImage slides based on the rationale + caption_concept. The single_image was a planner slip, not a deliberate choice.\n" +
    "- near_duplicate_ai_image_prompts (similarity >= 0.95): auto-merge using shared_concept_key derived from the concept (e.g. 'cover-{date}', 'step-01-{slug}'). Tell the user 'unifiqué la cover entre redes; eran prompts casi idénticos'.\n" +
    "- network_not_connected: auto-drop the sub_post and mention it to the user 'saqué LinkedIn del lunes porque no está conectada'.\n" +
    "Use the user's judgment ONLY for warnings where the trade-off is genuinely subjective (quality_upgrade_check, format_mix_per_network suggestions, near_duplicate at 0.85-0.94 which could be intentional). Don't dump every warning as a question.",

  brand_visual_identity_principle:
    "Followr's Brand Visual Identity (BVI) is a persistent visual style profile for a company, stored as a delimited JSON block inside Company.description (parsed via parseBrandIdentityFromDescription). When BVI is configured, execute_content_plan AUTO-INJECTS it into every AI image generation: the brief is appended to the prompt, and 3-5 tagged template/element assets are added as reference_image_urls.\n\n" +
    "LIFECYCLE (5-tool setup + 2-tool refresh):\n" +
    "  Setup: assess_brand_visual_identity -> draft_brand_visual_identity -> execute_brand_visual_identity -> manufacture_brand_templates (cost-gated, ~325 cr for 12 templates) -> finalize_brand_templates.\n" +
    "  Refresh: propose_brand_template_refresh -> apply_brand_template_refresh.\n\n" +
    "WHEN TO SUGGEST SETUP:\n" +
    "  - Any time prepare_content_plan_context returns brand_visual_identity_status='missing' AND the user is about to generate >=3 AI images, surface the setup proactively. The output quality gap is dramatic: brands without BVI ship generic stock-looking visuals; brands with BVI ship cohesive on-brand content.\n" +
    "  - When the user explicitly says 'quiero que mis posts se sientan más mi marca' or similar.\n" +
    "  - When the user complains that a previous generation was off-brand.\n\n" +
    "WHEN NOT TO SUGGEST SETUP:\n" +
    "  - The user is generating 1-2 throwaway / experimental images.\n" +
    "  - The user explicitly said 'no quiero brand grounding'.\n" +
    "  - The company has fewer than 30 days of activity (too early for past-winner refresh signal).\n\n" +
    "PER-CALL OPT-OUT:\n" +
    "  AssetSourceAiImage.use_brand_visual_identity = false skips BVI auto-injection for that source. Useful for anti-pattern examples, brand-agnostic mockups, or comparison material. Defaults to true.\n\n" +
    "USER NEVER MENTIONS THE BLOCK BY NAME. The block lives inside description but the agent surfaces it as 'identidad visual cargada' or 'tu paleta y refs de marca'. NEVER quote the JSON to the user.",

  carousel_consistency_principle:
    "When a carousel sub_post has 2+ AI image slides, execute_content_plan automatically processes them SEQUENTIALLY (not in parallel) and feeds slide N-1's output URL as an extra reference into slide N's generation. This produces visual continuity across slides: same typography, same lighting, same framing. The trade-off is latency: a 5-slide chained carousel takes 5 × generation_time instead of max(generation_times).\n\n" +
    "DETECTION: shouldChainCarousel returns true when asset_layout='carousel_images' AND >=2 carousel_sources are AI image generations. Mixed carousels (asset_id + ai_generate) still chain because the asset_id slides have stable URLs that can be passed forward.\n\n" +
    "WHEN TO PROACTIVELY OFFER CHAINING:\n" +
    "  The agent does not toggle chaining manually; it's auto-detected. But mention the latency in the preview when a chained carousel is detected: 'es un carrusel de 5 slides AI, voy a generarlas en cadena para que se sientan parte del mismo set. Va a tardar ~5 minutos en lugar de 1, pero la consistencia visual mejora notoriamente'.\n\n" +
    "FINGERPRINT IMPACT:\n" +
    "  The fingerprint includes reference_image_urls. Chained slides get unique fingerprints because the injected previous-URL differs per slide. No accidental cache hits.\n\n" +
    "PARTIAL FAILURES:\n" +
    "  If slide N fails, slide N+1 (and onward) get whatever URL was last successfully resolved as their chain ref. The agent surfaces partial output in the result so the user can decide whether to retry the missing slides.",

  typography_reference_principle:
    "Asset tagged with brand:typography-reference provides ONLY typographic style guidance (font weight, letter shapes, kerning, alignment). The resolver auto-detects when such a ref is included in an AI image generation and appends a 'negative literal copy' suffix to the prompt instructing the model to use the typographic STYLE without copying the literal text from the reference.\n\n" +
    "USE CASES:\n" +
    "  - User uploaded a screenshot of their brand wordmark or a banner with their custom font. Tag as TYPOGRAPHY_REFERENCE in __brand_elements. The resolver picks it up and applies the suffix automatically.\n" +
    "  - Aspirational brand og:images often contain typography (wordmark + headline). autoClassifyAsset auto-tags them as both ASPIRATIONAL and TYPOGRAPHY_REFERENCE so the resolver applies the suffix.\n\n" +
    "MULTI-REF FOR STRONGER SIGNAL:\n" +
    "  A single typography reference gives the model one example to abstract from. 2-3 references of the SAME font in DIFFERENT contexts (banner, headline, body text) gives the model better signal that 'typography is the constant, content varies'. The current 5-ref cap limits how many typography refs we can include; subject of TODO_V2.md item.\n\n" +
    "ANTI-PATTERN:\n" +
    "  Including typography refs WITHOUT the suffix → the model copies the literal text into the output. NEVER turn off the suffix while typography refs are present.",

  ai_image_styles_neutralization_principle:
    "Company.ai_image_styles is a Followr UI field where the user can pick from 69 preset image styles (Hyperrealism, Anime, Watercolor, etc.). Empirical A/B test on 2026-05-22 with company id 7 and nano_banana_2 confirmed the field is VESTIGIAL: setting 'Pencil Art' did NOT affect the output of a 'red apple' generation, and the POST body to /api/aiResults/image does NOT include ai_image_styles in any form.\n\n" +
    "IMPLICATIONS FOR PLANNING:\n" +
    "  - The MCP does NOT need to manage ai_image_styles for generation correctness. It has no effect on nano_banana_2.\n" +
    "  - During setup_brand_visual_identity the wizard offers to clear ai_image_styles (defensive: cosmetic only, but avoids user confusion seeing 'Hyperrealism selected' in Followr UI while the brand identity says otherwise).\n" +
    "  - Unverified for premium image models (gpt_image_2, imagen4_*, ideogram_v3, flux_pro_1.1). If a future test shows premium models DO consume the field, this principle needs updating. Tracked in TODO_V2.md.\n\n" +
    "DO NOT spend agent context explaining ai_image_styles to the user. If they ask, say 'es un campo de Followr UI sin efecto en la generación con el modelo default; no afecta tu Brand Visual Identity'.",
};
