/**
 * Network spec types for cross-network post validation.
 *
 * The raw shape mirrors what Followr's frontend encodes for its composer's
 * client-side validation. Source of truth: `data/social-network-specs.json`.
 * Extracted from app.followr.ai's main bundle.
 */

export type NetworkType =
  | "medium"
  | "pinterest"
  | "twitter"
  | "facebook"
  | "instagram"
  | "tiktok"
  | "linkedin"
  | "youtube"
  | "threads"
  | "bluesky";

export type ProductType = "feed" | "reel" | "story" | "short";

export type SpecKey = `${NetworkType}_${ProductType}`;

export type AssetType = "image" | "video" | "gif";

// ──────────────────────────────────────────────────────────
// Raw spec shape (matches the JSON 1-to-1)
// ──────────────────────────────────────────────────────────

export interface MediaUrlsSpec {
  allow_multiple_types?: boolean;
  max_images_length?: number;
  max_videos_length?: number;
  max_gifs_length?: number;
  /** Carousel cap (aggregate across image/video/gif). */
  max_length?: number;
  required?: boolean;
  /** Bytes. null/undefined means unspecified (use platform default). */
  image_max_size_bytes?: number | null;
  video_max_size_bytes?: number;
  video_min_duration_seconds?: number;
  /**
   * Seconds. For TikTok this is a static default (600); the actual cap is
   * resolved at runtime from `RuntimeContext.tiktok_max_duration_seconds`.
   */
  video_max_duration_seconds?: number;
  video_max_width?: number;
  video_min_width?: number;
  /** [min, max] as decimal width/height ratios. e.g. [0.5, 1.91] for IG Feed. */
  allowed_aspect_ratios?: [number, number];
  allow_file_cover?: boolean;
  allow_frame_cover?: boolean;
  required_cover?: boolean;
  /** Pinterest only: all carousel items must share aspect ratio. */
  same_ratio?: boolean;
}

export interface NetworkSpecEntry {
  connection?: { required?: boolean };
  title?: { max_length?: number; required?: boolean };
  description?: {
    max_length?: number;
    /** Twitter only. Used when `RuntimeContext.twitter_verified` is true. */
    max_length_if_verified?: number;
    required?: boolean;
  };
  /** Pinterest only. */
  board_id?: { required?: boolean };
  /** TikTok only. */
  privacy_level?: { required?: boolean };
  media_urls?: MediaUrlsSpec;
}

export interface SpecsMeta {
  source?: string;
  verified_at?: string;
  extraction_method?: string;
  structure_note?: string;
}

/** The full registry as loaded from the JSON. */
export type NetworkSpecsRegistry = {
  _meta?: SpecsMeta;
} & {
  [K in SpecKey]?: NetworkSpecEntry;
};

// ──────────────────────────────────────────────────────────
// Runtime context (resolved per company × network)
// ──────────────────────────────────────────────────────────

export interface RuntimeContext {
  /** Twitter Premium subscriber flag. Affects description.max_length. */
  twitter_verified?: boolean;
  /** TikTok account-specific max video duration in seconds. */
  tiktok_max_duration_seconds?: number;
  /** TikTok account-allowed privacy levels (enum values). */
  tiktok_privacy_level_options?: string[];
  /** TikTok account-level interaction toggles. */
  tiktok_duet_disabled?: boolean;
  tiktok_stitch_disabled?: boolean;
  tiktok_comment_disabled?: boolean;
}

// ──────────────────────────────────────────────────────────
// Post payload (input to validateAgainstSpec)
// ──────────────────────────────────────────────────────────

export interface PostAsset {
  id?: number;
  type: AssetType;
  width?: number;
  height?: number;
  size_bytes?: number;
  duration_seconds?: number;
}

export interface PostPayload {
  network: NetworkType;
  product_type: ProductType;
  description?: string;
  title?: string;
  link?: string;
  assets?: PostAsset[];
  /**
   * Network-specific extras (privacy_level for TikTok, board_id for Pinterest,
   * category_id for YouTube, notify_followers / media_product_type for IG, etc.).
   */
  preferences?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────
// Validation output
// ──────────────────────────────────────────────────────────

/**
 * Severity of a validation warning. None block execution — they're advisory.
 *
 * - `hard_fail`: The network's API will reject this. Strong signal to fix.
 * - `display_behavior`: Network accepts the upload but transforms it
 *   (e.g., LinkedIn crops 9:16 video to 1:1 center). Cross-network concern.
 * - `recommendation`: Soft hint (best-practice). Reserved for future use.
 */
export type WarningSeverity = "hard_fail" | "display_behavior" | "recommendation";

export interface SpecWarning {
  /** Spec key the warning came from. e.g. "instagram_feed". */
  spec_key: SpecKey;
  /** Dotted field path. e.g. "description.max_length" or "media_urls.max_images_length". */
  field: string;
  /** Human-readable rule description. */
  rule: string;
  /** Value seen in the post payload. */
  current_value: unknown;
  /** Spec's expected value, range, or list. */
  expected: unknown;
  severity: WarningSeverity;
  /** Concrete action the caller (LLM or user) can take. */
  suggestion?: string;
}
