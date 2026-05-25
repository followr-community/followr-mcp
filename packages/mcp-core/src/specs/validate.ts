/**
 * Pure spec validation.
 *
 * Given a PostPayload + RuntimeContext, emit advisory SpecWarning[] for any
 * spec rule the payload violates. Pure, synchronous, deterministic. Never
 * throws, never blocks: warnings are informational. Callers decide what to do
 * with them.
 *
 * Runtime-resolved values (Twitter verified, TikTok max duration) come from
 * `RuntimeContext`. If absent, falls back to the static defaults in the spec.
 */

import { getSpec } from "./loader.js";
import type {
  MediaUrlsSpec,
  NetworkSpecEntry,
  PostPayload,
  RuntimeContext,
  SpecKey,
  SpecWarning,
} from "./types.js";

export function validateAgainstSpec(
  payload: PostPayload,
  context: RuntimeContext = {},
): SpecWarning[] {
  const spec = getSpec(payload.network, payload.product_type);
  if (!spec) return [];

  const specKey = `${payload.network}_${payload.product_type}` as SpecKey;
  const warnings: SpecWarning[] = [];

  warnings.push(...validateTitle(spec, payload, specKey));
  warnings.push(...validateDescription(spec, payload, specKey, context));
  warnings.push(...validateBoardId(spec, payload, specKey));
  warnings.push(...validatePrivacyLevel(spec, payload, specKey, context));
  warnings.push(...validateMedia(spec, payload, specKey, context));

  return warnings;
}

// ──────────────────────────────────────────────────────────
// Title (medium, pinterest, youtube)
// ──────────────────────────────────────────────────────────

function validateTitle(
  spec: NetworkSpecEntry,
  payload: PostPayload,
  specKey: SpecKey,
): SpecWarning[] {
  const rule = spec.title;
  if (!rule) return [];
  const warnings: SpecWarning[] = [];
  const title = payload.title?.trim() ?? "";

  if (rule.required && title.length === 0) {
    warnings.push({
      spec_key: specKey,
      field: "title",
      rule: "required",
      current_value: payload.title ?? null,
      expected: "non-empty string",
      severity: "hard_fail",
      suggestion: `Title is required for ${payload.network} ${payload.product_type}.`,
    });
  }

  if (rule.max_length != null && title.length > rule.max_length) {
    warnings.push({
      spec_key: specKey,
      field: "title.max_length",
      rule: "max_length_exceeded",
      current_value: title.length,
      expected: rule.max_length,
      severity: "hard_fail",
      suggestion: `Trim title to ${rule.max_length} characters or less. Currently ${title.length}.`,
    });
  }

  return warnings;
}

// ──────────────────────────────────────────────────────────
// Description / caption
// ──────────────────────────────────────────────────────────

function validateDescription(
  spec: NetworkSpecEntry,
  payload: PostPayload,
  specKey: SpecKey,
  context: RuntimeContext,
): SpecWarning[] {
  const rule = spec.description;
  if (!rule) return [];
  const warnings: SpecWarning[] = [];
  const description = payload.description ?? "";
  const descTrimmed = description.trim();

  if (rule.required && descTrimmed.length === 0) {
    warnings.push({
      spec_key: specKey,
      field: "description",
      rule: "required",
      current_value: payload.description ?? null,
      expected: "non-empty string",
      severity: "hard_fail",
      suggestion: `Description is required for ${payload.network} ${payload.product_type}.`,
    });
  }

  // Twitter: verified accounts get the longer cap
  let effectiveMax = rule.max_length;
  let bumpedByVerified = false;
  if (
    payload.network === "twitter" &&
    context.twitter_verified === true &&
    rule.max_length_if_verified != null
  ) {
    effectiveMax = rule.max_length_if_verified;
    bumpedByVerified = true;
  }

  if (effectiveMax == null) return warnings;

  if (effectiveMax === 0 && description.length > 0) {
    warnings.push({
      spec_key: specKey,
      field: "description",
      rule: "not_supported",
      current_value: description.length,
      expected: 0,
      severity: "hard_fail",
      suggestion: `${payload.network} ${payload.product_type} doesn't support a caption. The description field is ignored.`,
    });
    return warnings;
  }

  if (description.length > effectiveMax) {
    let verifiedNote = "";
    if (
      payload.network === "twitter" &&
      !context.twitter_verified &&
      rule.max_length_if_verified != null
    ) {
      verifiedNote = ` (Twitter Premium subscribers get up to ${rule.max_length_if_verified}.)`;
    }
    warnings.push({
      spec_key: specKey,
      field: "description.max_length",
      rule: "max_length_exceeded",
      current_value: description.length,
      expected: effectiveMax,
      severity: "hard_fail",
      suggestion: `Trim caption to ${effectiveMax} characters or less. Currently ${description.length}.${verifiedNote}`,
    });
  }

  // Sanity hint: if account is NOT verified but caller wrote >280 to twitter
  // expecting 25k, surface why it would fail.
  if (
    !bumpedByVerified &&
    payload.network === "twitter" &&
    rule.max_length_if_verified != null &&
    description.length > rule.max_length! &&
    description.length <= rule.max_length_if_verified
  ) {
    // already covered by the max_length_exceeded above, just don't duplicate
  }

  return warnings;
}

// ──────────────────────────────────────────────────────────
// Pinterest board_id
// ──────────────────────────────────────────────────────────

function validateBoardId(
  spec: NetworkSpecEntry,
  payload: PostPayload,
  specKey: SpecKey,
): SpecWarning[] {
  if (!spec.board_id?.required) return [];
  const boardId = (payload.preferences as Record<string, unknown> | undefined)?.["board_id"];
  if (boardId != null && boardId !== "") return [];
  return [
    {
      spec_key: specKey,
      field: "preferences.board_id",
      rule: "required",
      current_value: boardId ?? null,
      expected: "Pinterest board id (number)",
      severity: "hard_fail",
      suggestion:
        "Pinterest requires a destination board. Set preferences.board_id to a valid board id.",
    },
  ];
}

// ──────────────────────────────────────────────────────────
// TikTok privacy_level
// ──────────────────────────────────────────────────────────

function validatePrivacyLevel(
  spec: NetworkSpecEntry,
  payload: PostPayload,
  specKey: SpecKey,
  context: RuntimeContext,
): SpecWarning[] {
  if (!spec.privacy_level?.required) return [];
  const warnings: SpecWarning[] = [];
  const prefs = payload.preferences as Record<string, unknown> | undefined;
  const level = prefs?.["privacy_level"];

  if (level == null || typeof level !== "string" || level === "") {
    // Bias the suggestion toward the most common default. Most public
    // accounts allow PUBLIC_TO_EVERYONE; the agent can use it without a
    // confirmation round-trip unless the runtime context says otherwise.
    // Private / brand-only accounts will be flagged in the second branch
    // when the runtime context reports a restricted option set.
    const optionsList = context.tiktok_privacy_level_options;
    const safeDefault =
      optionsList && optionsList.length > 0
        ? optionsList.includes("PUBLIC_TO_EVERYONE")
          ? "PUBLIC_TO_EVERYONE"
          : optionsList[0]
        : "PUBLIC_TO_EVERYONE";
    warnings.push({
      spec_key: specKey,
      field: "preferences.privacy_level",
      rule: "required",
      current_value: level ?? null,
      expected: optionsList ?? "one of TikTok's privacy levels",
      severity: "hard_fail",
      suggestion: `TikTok requires preferences.privacy_level (UPPERCASE_WITH_UNDERSCORES). Common safe default: "${safeDefault}". ${
        optionsList
          ? `Allowed for this connected account: ${optionsList.join(", ")}.`
          : "Allowed values vary per connected account. Confirm with the user that the post should be public, or call gatherRuntimeContext (this happens automatically inside create_post / create_post_group_with_posts) to discover the live options."
      } Pre-validate by calling validate_against_specs(network: "tiktok", product_type: "feed", preferences: { privacy_level: "${safeDefault}", ... }) before invoking the create tools so this never blocks the create call.`,
    });
    return warnings;
  }

  if (
    context.tiktok_privacy_level_options &&
    !context.tiktok_privacy_level_options.includes(level)
  ) {
    warnings.push({
      spec_key: specKey,
      field: "preferences.privacy_level",
      rule: "value_not_allowed",
      current_value: level,
      expected: context.tiktok_privacy_level_options,
      severity: "hard_fail",
      suggestion: `Privacy level "${level}" is not enabled for this TikTok account. Allowed: ${context.tiktok_privacy_level_options.join(
        ", ",
      )}.`,
    });
  }

  return warnings;
}

// ──────────────────────────────────────────────────────────
// Media (assets, counts, sizes, durations, dimensions, aspect ratio)
// ──────────────────────────────────────────────────────────

function validateMedia(
  spec: NetworkSpecEntry,
  payload: PostPayload,
  specKey: SpecKey,
  context: RuntimeContext,
): SpecWarning[] {
  const m = spec.media_urls;
  if (!m) return [];
  const warnings: SpecWarning[] = [];
  const assets = payload.assets ?? [];

  // Required: at least one asset
  if (m.required && assets.length === 0) {
    warnings.push({
      spec_key: specKey,
      field: "assets",
      rule: "required",
      current_value: 0,
      expected: ">=1 asset",
      severity: "hard_fail",
      suggestion: `${payload.network} ${payload.product_type} requires at least one media asset.`,
    });
    return warnings;
  }

  if (assets.length === 0) return warnings;

  // Product-type-driven asset type check.
  // Reels and Shorts require a VIDEO asset by the social network's own rules
  // (Instagram Reels, Facebook Reels, YouTube Shorts). Image-only payloads
  // would be rejected at publish time. Surface as a hard_fail so callers can
  // block creation up front.
  if (payload.product_type === "reel" || payload.product_type === "short") {
    const videoCount = assets.filter((a) => a.type === "video").length;
    if (videoCount === 0) {
      warnings.push({
        spec_key: specKey,
        field: "assets.types",
        rule: "video_required_for_product_type",
        current_value: assets.map((a) => a.type),
        expected: "at least one asset with type=video",
        severity: "hard_fail",
        suggestion: `${payload.network} ${payload.product_type} requires a video asset. Generate one via generate_avatar_video / generate_avatar_lipsync_clip / generate_ai_video_clip, or upload one via upload_video_from_url, then attach the resulting asset id as { id, type: "video" }.`,
      });
    }
  }

  // Mixed types not allowed
  if (m.allow_multiple_types === false) {
    const types = new Set(assets.map((a) => a.type));
    if (types.size > 1) {
      warnings.push({
        spec_key: specKey,
        field: "assets.types",
        rule: "no_mixed_media",
        current_value: Array.from(types),
        expected: "single media type",
        severity: "hard_fail",
        suggestion: `${payload.network} ${payload.product_type} doesn't allow mixed media types in one post. Use either all images, all videos, or all GIFs.`,
      });
    }
  }

  // Counts per type
  const counts = {
    image: assets.filter((a) => a.type === "image").length,
    video: assets.filter((a) => a.type === "video").length,
    gif: assets.filter((a) => a.type === "gif").length,
  };

  if (m.max_images_length != null && counts.image > m.max_images_length) {
    warnings.push(
      countWarning(specKey, payload, "images", counts.image, m.max_images_length),
    );
  }
  if (m.max_videos_length != null && counts.video > m.max_videos_length) {
    warnings.push(
      countWarning(specKey, payload, "videos", counts.video, m.max_videos_length),
    );
  }
  if (m.max_gifs_length != null && counts.gif > m.max_gifs_length) {
    warnings.push(countWarning(specKey, payload, "gifs", counts.gif, m.max_gifs_length));
  }
  if (m.max_length != null && assets.length > m.max_length) {
    warnings.push({
      spec_key: specKey,
      field: "assets",
      rule: "max_total_exceeded",
      current_value: assets.length,
      expected: m.max_length,
      severity: "hard_fail",
      suggestion: `${payload.network} ${payload.product_type} accepts up to ${m.max_length} total assets. You attached ${assets.length}.`,
    });
  }

  // Per-asset checks
  const effectiveVideoMaxDuration = resolveVideoMaxDuration(payload, context, m);
  for (let i = 0; i < assets.length; i++) {
    warnings.push(...validateAsset(assets[i]!, i, specKey, payload, m, effectiveVideoMaxDuration));
  }

  return warnings;
}

function resolveVideoMaxDuration(
  payload: PostPayload,
  context: RuntimeContext,
  m: MediaUrlsSpec,
): number | undefined {
  if (payload.network === "tiktok" && context.tiktok_max_duration_seconds != null) {
    return context.tiktok_max_duration_seconds;
  }
  return m.video_max_duration_seconds;
}

function validateAsset(
  asset: PostPayload["assets"] extends (infer A)[] | undefined ? A : never,
  index: number,
  specKey: SpecKey,
  payload: PostPayload,
  m: MediaUrlsSpec,
  effectiveVideoMaxDuration: number | undefined,
): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  const prefix = `assets[${index}]`;

  // Size
  if (
    asset.type === "image" &&
    m.image_max_size_bytes != null &&
    asset.size_bytes != null &&
    asset.size_bytes > m.image_max_size_bytes
  ) {
    warnings.push({
      spec_key: specKey,
      field: `${prefix}.size_bytes`,
      rule: "max_size_exceeded",
      current_value: asset.size_bytes,
      expected: m.image_max_size_bytes,
      severity: "hard_fail",
      suggestion: `Image at index ${index} is ${formatBytes(asset.size_bytes)}, max is ${formatBytes(m.image_max_size_bytes)} for ${payload.network} ${payload.product_type}.`,
    });
  }
  if (
    asset.type === "video" &&
    m.video_max_size_bytes != null &&
    asset.size_bytes != null &&
    asset.size_bytes > m.video_max_size_bytes
  ) {
    warnings.push({
      spec_key: specKey,
      field: `${prefix}.size_bytes`,
      rule: "max_size_exceeded",
      current_value: asset.size_bytes,
      expected: m.video_max_size_bytes,
      severity: "hard_fail",
      suggestion: `Video at index ${index} is ${formatBytes(asset.size_bytes)}, max is ${formatBytes(m.video_max_size_bytes)} for ${payload.network} ${payload.product_type}.`,
    });
  }

  // Video duration
  if (asset.type === "video" && asset.duration_seconds != null) {
    if (effectiveVideoMaxDuration != null && asset.duration_seconds > effectiveVideoMaxDuration) {
      warnings.push({
        spec_key: specKey,
        field: `${prefix}.duration_seconds`,
        rule: "video_too_long",
        current_value: asset.duration_seconds,
        expected: effectiveVideoMaxDuration,
        severity: "hard_fail",
        suggestion: `Video at index ${index} is ${asset.duration_seconds}s, max is ${effectiveVideoMaxDuration}s for ${payload.network} ${payload.product_type}.`,
      });
    }
    if (
      m.video_min_duration_seconds != null &&
      asset.duration_seconds < m.video_min_duration_seconds
    ) {
      warnings.push({
        spec_key: specKey,
        field: `${prefix}.duration_seconds`,
        rule: "video_too_short",
        current_value: asset.duration_seconds,
        expected: m.video_min_duration_seconds,
        severity: "hard_fail",
        suggestion: `Video at index ${index} is ${asset.duration_seconds}s, min is ${m.video_min_duration_seconds}s for ${payload.network} ${payload.product_type}.`,
      });
    }
  }

  // Video dimensions
  if (asset.type === "video" && asset.width != null) {
    if (m.video_max_width != null && asset.width > m.video_max_width) {
      warnings.push({
        spec_key: specKey,
        field: `${prefix}.width`,
        rule: "video_max_width_exceeded",
        current_value: asset.width,
        expected: m.video_max_width,
        severity: "hard_fail",
        suggestion: `Video at index ${index} is ${asset.width}px wide, max is ${m.video_max_width}px.`,
      });
    }
    if (m.video_min_width != null && asset.width < m.video_min_width) {
      warnings.push({
        spec_key: specKey,
        field: `${prefix}.width`,
        rule: "video_min_width_below",
        current_value: asset.width,
        expected: m.video_min_width,
        severity: "hard_fail",
        suggestion: `Video at index ${index} is ${asset.width}px wide, min is ${m.video_min_width}px.`,
      });
    }
  }

  // Aspect ratio (range check)
  if (m.allowed_aspect_ratios && asset.width != null && asset.height != null && asset.height > 0) {
    const ratio = asset.width / asset.height;
    const [min, max] = m.allowed_aspect_ratios;
    if (ratio < min || ratio > max) {
      warnings.push({
        spec_key: specKey,
        field: `${prefix}.aspect_ratio`,
        rule: "aspect_ratio_out_of_range",
        current_value: round(ratio, 3),
        expected: m.allowed_aspect_ratios,
        severity: "hard_fail",
        suggestion: `Asset at index ${index} has aspect ratio ${round(ratio, 3)} (${asset.width}×${asset.height}). ${payload.network} ${payload.product_type} accepts [${min}, ${max}].`,
      });
    }
  }

  return warnings;
}

function countWarning(
  specKey: SpecKey,
  payload: PostPayload,
  kind: "images" | "videos" | "gifs",
  actual: number,
  max: number,
): SpecWarning {
  return {
    spec_key: specKey,
    field: `assets.${kind}`,
    rule: "max_count_exceeded",
    current_value: actual,
    expected: max,
    severity: "hard_fail",
    suggestion: `${payload.network} ${payload.product_type} accepts up to ${max} ${kind === "videos" && max === 1 ? "video" : kind === "images" && max === 1 ? "image" : kind === "gifs" && max === 1 ? "GIF" : kind}. You attached ${actual}.`,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
