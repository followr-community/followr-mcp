// Normalizer: maps Tier 1 (Lite) plan_items to the canonical Tier 3 (PlanItem)
// shape, expanding assets_strategy_lite into AssetsStrategy with
// concept_only_image / concept_only_video AssetSource entries.
//
// After normalization, ALL downstream consumers (validator, cost,
// fingerprint, preview, executor) operate on PlanItem[] uniformly. Tier 3
// inputs pass through unchanged; Tier 1 inputs are expanded.
//
// Auto-derived aspect_ratio rules mirror what the schema description
// promises to the agent (so the LLM does not have to spell them out per
// sub_post).
//
// Added 2026-05-27 / v0.6.1 (Tier 1 / concept-only mode).

import type {
  AssetLayout,
  AssetsStrategy,
  AssetSourceConceptImage,
  AssetSourceConceptVideo,
  PlanItem,
  PlanItemLite,
  PlanDefaults,
  ProductType,
  SocialNetwork,
  SubPost,
  SubPostLite,
  AssetsStrategyLite,
} from "./content-plan-state.js";
import { isSubPostLite } from "./content-plan-state.js";

export interface NormalizationError {
  slug: string;
  sub_post_index: number;
  reason: string;
  user_facing_message: string;
}

export interface NormalizationResult {
  /** Normalized plan_items, ready to feed runValidation. */
  plan_items: PlanItem[];
  /** Blocking errors that prevent normalization (return as toolError to LLM). */
  errors: NormalizationError[];
}

/**
 * Derive aspect ratio from network + asset_layout when the agent did not
 * provide an override. Mirrors the documented per-network defaults in the
 * AssetSourceAiImageSchema description.
 */
export function deriveAspectRatio(
  network: SocialNetwork,
  product_type: ProductType,
  layout: AssetLayout,
): "1:1" | "4:3" | "16:9" | "3:4" | "9:16" {
  // Vertical formats always 9:16
  if (product_type === "reel" || product_type === "short" || product_type === "story") {
    return "9:16";
  }
  // YouTube long is landscape
  if (product_type === "long_video") {
    return "16:9";
  }
  // LinkedIn feed prefers landscape; carousel = 1:1
  if (network === "linkedin") {
    return layout === "carousel_images" ? "1:1" : "16:9";
  }
  // Twitter / X
  if (network === "x") {
    return "16:9";
  }
  // Pinterest: vertical preferred
  if (network === "pinterest") {
    return "3:4";
  }
  // Instagram / Facebook / Threads / Bluesky: 1:1 feed default
  return "1:1";
}

/**
 * Resolve which routing mode applies given the override block. art_direction_hint
 * and literal_prompt are mutually exclusive (enforced upstream by the zod refine).
 */
function resolveAssetMode(
  override: SubPostLite["assets_strategy_lite"]["override"],
): "concept_only" | "explicit_brief" | "literal_prompt" {
  if (override?.literal_prompt) return "literal_prompt";
  if (override?.art_direction_hint) return "explicit_brief";
  return "concept_only";
}

/**
 * Resolve effective model with plan-level fallback. Honors override > plan_default
 * > hardcoded default (nano_banana_2 for images, wan_2.2 for video).
 */
function resolveImageModel(
  override: SubPostLite["assets_strategy_lite"]["override"],
  plan_defaults: PlanDefaults | undefined,
): string {
  return override?.model ?? plan_defaults?.image_model ?? "nano_banana_2";
}

function resolveVideoModel(
  override: SubPostLite["assets_strategy_lite"]["override"],
  plan_defaults: PlanDefaults | undefined,
): string {
  return override?.model ?? plan_defaults?.video_model ?? "wan_2.2";
}

function resolveVideoDuration(
  override: SubPostLite["assets_strategy_lite"]["override"],
  plan_defaults: PlanDefaults | undefined,
): number {
  return override?.duration_seconds ?? plan_defaults?.video_duration_seconds ?? 8;
}

function resolveAvatarId(
  ali: AssetsStrategyLite,
  plan_defaults: PlanDefaults | undefined,
): number | undefined {
  return ali.override?.avatar_id_override ?? plan_defaults?.avatar_id;
}

/**
 * Build the concept_only_image AssetSource for a single slot. Carousels call
 * this once per slot with the matching slot_index / slot_count.
 */
function buildConceptImageSource(
  ali: AssetsStrategyLite,
  network: SocialNetwork,
  product_type: ProductType,
  layout: AssetLayout,
  plan_defaults: PlanDefaults | undefined,
  slot_index: number,
  slot_count: number,
): AssetSourceConceptImage {
  const override = ali.override;
  const mode = resolveAssetMode(override);
  const aspect = override?.aspect_ratio ?? deriveAspectRatio(network, product_type, layout);
  const src: AssetSourceConceptImage = {
    type: "concept_only_image",
    mode,
    slot_index,
    slot_count,
    model: resolveImageModel(override, plan_defaults),
    aspect_ratio: aspect,
  };
  if (mode === "explicit_brief" && override?.art_direction_hint) {
    src.art_direction_hint = override.art_direction_hint;
  }
  if (mode === "literal_prompt" && override?.literal_prompt) {
    src.literal_prompt = override.literal_prompt;
  }
  if (override?.reference_image_urls && override.reference_image_urls.length > 0) {
    src.reference_image_urls = override.reference_image_urls;
  }
  return src;
}

function buildConceptVideoSource(
  ali: AssetsStrategyLite,
  network: SocialNetwork,
  product_type: ProductType,
  layout: AssetLayout,
  plan_defaults: PlanDefaults | undefined,
): AssetSourceConceptVideo {
  const override = ali.override;
  const mode = resolveAssetMode(override);
  const aspect = override?.aspect_ratio ?? deriveAspectRatio(network, product_type, layout);
  const src: AssetSourceConceptVideo = {
    type: "concept_only_video",
    mode,
    model: resolveVideoModel(override, plan_defaults),
    aspect_ratio: aspect,
    duration_seconds: resolveVideoDuration(override, plan_defaults),
  };
  if (mode === "explicit_brief" && override?.art_direction_hint) {
    src.art_direction_hint = override.art_direction_hint;
  }
  if (mode === "literal_prompt" && override?.literal_prompt) {
    src.literal_prompt = override.literal_prompt;
  }
  if (
    override?.reference_image_urls &&
    override.reference_image_urls.length > 0 &&
    override.reference_image_urls[0]
  ) {
    src.reference_image_url = override.reference_image_urls[0];
  }
  return src;
}

interface NormalizeSubPostResult {
  sub_post?: SubPost;
  error?: { reason: string; user_facing_message: string };
}

function normalizeSubPost(
  spLite: SubPostLite,
  plan_defaults: PlanDefaults | undefined,
): NormalizeSubPostResult {
  const ali = spLite.assets_strategy_lite;
  const layout = spLite.asset_layout;
  const network = spLite.social_network;
  const product_type = spLite.product_type;
  let strategy: AssetsStrategy;

  switch (ali.asset_kind) {
    case "image": {
      strategy = {
        image_source: buildConceptImageSource(
          ali,
          network,
          product_type,
          layout,
          plan_defaults,
          0,
          1,
        ),
      };
      break;
    }
    case "image_url": {
      if (!ali.source_url) {
        return {
          error: {
            reason: "missing_source_url",
            user_facing_message:
              "asset_kind=image_url requires source_url. Add the URL of the image to upload.",
          },
        };
      }
      strategy = { image_source: { type: "url", url: ali.source_url } };
      break;
    }
    case "image_asset_id": {
      if (typeof ali.source_asset_id !== "number") {
        return {
          error: {
            reason: "missing_source_asset_id",
            user_facing_message:
              "asset_kind=image_asset_id requires source_asset_id. Pass the existing asset id from the library.",
          },
        };
      }
      strategy = { image_source: { type: "asset_id", id: ali.source_asset_id } };
      break;
    }
    case "carousel_image": {
      const count = ali.slot_count;
      if (typeof count !== "number" || count < 2) {
        return {
          error: {
            reason: "missing_slot_count",
            user_facing_message:
              "asset_kind=carousel_image requires slot_count between 2 and 20.",
          },
        };
      }
      const sources: AssetSourceConceptImage[] = [];
      for (let i = 0; i < count; i++) {
        sources.push(
          buildConceptImageSource(ali, network, product_type, layout, plan_defaults, i, count),
        );
      }
      strategy = { carousel_sources: sources };
      break;
    }
    case "video": {
      strategy = {
        video_source: buildConceptVideoSource(
          ali,
          network,
          product_type,
          layout,
          plan_defaults,
        ),
      };
      break;
    }
    case "video_url": {
      if (!ali.source_url) {
        return {
          error: {
            reason: "missing_source_url",
            user_facing_message:
              "asset_kind=video_url requires source_url.",
          },
        };
      }
      strategy = { video_source: { type: "url", url: ali.source_url } };
      break;
    }
    case "video_asset_id": {
      if (typeof ali.source_asset_id !== "number") {
        return {
          error: {
            reason: "missing_source_asset_id",
            user_facing_message:
              "asset_kind=video_asset_id requires source_asset_id.",
          },
        };
      }
      strategy = { video_source: { type: "asset_id", id: ali.source_asset_id } };
      break;
    }
    case "avatar_lipsync": {
      const scripts = ali.avatar_scripts;
      if (!scripts || scripts.length !== 1 || !scripts[0]) {
        return {
          error: {
            reason: "missing_avatar_script",
            user_facing_message:
              "asset_kind=avatar_lipsync requires exactly one entry in avatar_scripts with the verbatim line the avatar will speak.",
          },
        };
      }
      const avatarId = resolveAvatarId(ali, plan_defaults);
      if (typeof avatarId !== "number") {
        return {
          error: {
            reason: "missing_avatar_id",
            user_facing_message:
              "asset_kind=avatar_lipsync requires either plan_defaults.avatar_id or override.avatar_id_override.",
          },
        };
      }
      strategy = {
        video_source: {
          type: "ai_avatar_lipsync",
          script: scripts[0],
          avatar_id: avatarId,
        },
      };
      break;
    }
    case "avatar_multi_scene": {
      const scripts = ali.avatar_scripts;
      const expectedCount = ali.scene_count;
      if (
        !scripts ||
        scripts.length === 0 ||
        typeof expectedCount !== "number" ||
        scripts.length !== expectedCount
      ) {
        return {
          error: {
            reason: "avatar_scripts_mismatch",
            user_facing_message:
              "asset_kind=avatar_multi_scene requires scene_count to match avatar_scripts.length (each script is the verbatim text spoken in one scene).",
          },
        };
      }
      const avatarId = resolveAvatarId(ali, plan_defaults);
      if (typeof avatarId !== "number") {
        return {
          error: {
            reason: "missing_avatar_id",
            user_facing_message:
              "asset_kind=avatar_multi_scene requires either plan_defaults.avatar_id or override.avatar_id_override.",
          },
        };
      }
      strategy = {
        video_source: {
          type: "ai_avatar_video",
          scripts,
          avatar_id: avatarId,
        },
      };
      break;
    }
    default: {
      const exhaustive: never = ali.asset_kind;
      void exhaustive;
      return {
        error: {
          reason: "unknown_asset_kind",
          user_facing_message: `Unknown asset_kind. Pick one of: image, image_url, image_asset_id, carousel_image, video, video_url, video_asset_id, avatar_lipsync, avatar_multi_scene.`,
        },
      };
    }
  }

  const out: SubPost = {
    social_network: network,
    product_type,
    asset_layout: layout,
    assets_strategy: strategy,
    caption_concept: spLite.caption_concept,
  };
  if (spLite.copy_draft) out.copy_draft = spLite.copy_draft;
  if (spLite.tags) out.tags = spLite.tags;
  return { sub_post: out };
}

/**
 * Normalize a Lite plan_item to canonical PlanItem. Tier 3 items pass through.
 * Mixed plans (some Lite, some Full sub_posts inside the same plan_item) are
 * supported: each sub_post is normalized independently.
 */
export function normalizeIncomingPlanItem(
  item: PlanItem | PlanItemLite,
  plan_defaults: PlanDefaults | undefined,
): { item?: PlanItem; errors: NormalizationError[] } {
  const errors: NormalizationError[] = [];
  const out_sub_posts: SubPost[] = [];

  for (let i = 0; i < item.sub_posts.length; i++) {
    const sp = item.sub_posts[i] as SubPost | SubPostLite;
    if (isSubPostLite(sp)) {
      const result = normalizeSubPost(sp, plan_defaults);
      if (result.error) {
        errors.push({
          slug: item.slug,
          sub_post_index: i,
          reason: result.error.reason,
          user_facing_message: result.error.user_facing_message,
        });
      } else if (result.sub_post) {
        out_sub_posts.push(result.sub_post);
      }
    } else {
      // Tier 3: pass through.
      out_sub_posts.push(sp);
    }
  }

  if (errors.length > 0) return { errors };

  const out: PlanItem = {
    slug: item.slug,
    date: item.date,
    publish_at_time_local: item.publish_at_time_local,
    timezone: item.timezone,
    concept_shared: item.concept_shared,
    // PlanItem.rationale is required (string), Lite makes it optional.
    // Provide an empty default when omitted so downstream code that reads
    // rationale does not crash. The validator surfaces a soft warning if
    // rationale is empty (we keep that signal for Tier 3 authors).
    rationale: item.rationale ?? "",
    sub_posts: out_sub_posts,
  };
  if (item.paired_with) out.paired_with = item.paired_with;
  return { item: out, errors: [] };
}

/**
 * Top-level: normalize an array of mixed Lite/Full plan_items. Returns the
 * normalized array (or empty when any item errored) plus the aggregated error
 * list for the LLM to fix.
 */
export function normalizeIncomingPlan(
  plan_items: Array<PlanItem | PlanItemLite>,
  plan_defaults: PlanDefaults | undefined,
): NormalizationResult {
  const out: PlanItem[] = [];
  const errors: NormalizationError[] = [];
  for (const item of plan_items) {
    const r = normalizeIncomingPlanItem(item, plan_defaults);
    if (r.item) out.push(r.item);
    if (r.errors.length > 0) errors.push(...r.errors);
  }
  if (errors.length > 0) return { plan_items: [], errors };
  return { plan_items: out, errors: [] };
}
