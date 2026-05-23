// Session-scoped state for content plans.
//
// A "content plan" lives entirely in MCP server memory. It is created by
// draft_content_plan, optionally mutated by update_content_plan, and consumed
// by execute_content_plan. There is NO persistence: if the MCP server process
// restarts, all in-flight plans are lost. This is intentional for v1: it keeps
// the design simple and matches the typical conversation lifecycle (draft,
// review, execute, all within one session).
//
// To allow recovery across restarts we would need a Followr backend resource
// (e.g. ContentPlan table). That is tracked as a future enhancement; for now,
// expiry + a hard cap on simultaneous plans keeps memory bounded.

export type AssetSourceUrl = { type: "url"; url: string };
export type AssetSourceAssetId = { type: "asset_id"; id: number };
export type AssetSourceAiImage = {
  type: "ai_generate";
  prompt: string;
  /** Legacy single-ref field. Use reference_image_urls for new code. */
  reference_image_url?: string;
  /**
   * Up to 5 reference images passed alongside the prompt. The model uses
   * them as style guidance (image-to-image). When the resolver auto-injects
   * brand references (because use_brand_visual_identity is true and a
   * BrandVisualIdentity block exists), they're concatenated here with the
   * caller-provided refs, capped at 5 total.
   */
  reference_image_urls?: string[];
  model?: string;
  /**
   * Output aspect ratio override. When omitted, the platform falls back to
   * the company's ai_preferences.image_aspect_ratio. Use to differentiate
   * cover assets between networks structurally (LinkedIn 16:9 vs Instagram
   * 1:1) instead of via adjective tweaks to the prompt.
   */
  aspect_ratio?: "1:1" | "4:3" | "16:9" | "3:4" | "9:16";
  /**
   * Optional dedupe key. When two AssetSourceAiImage refs within the same
   * plan_item share the same shared_concept_key, the resolver collapses
   * them into ONE generation and reuses the resulting asset across all
   * sub_posts that referenced it. Use this whenever the cover, a step
   * illustration, or a CTA card is conceptually the same across networks.
   * Without this key the dedupe falls back to exact prompt + model +
   * aspect_ratio equality, which silently misses near-duplicates.
   */
  shared_concept_key?: string;
  /**
   * When true (default), the resolver auto-injects this company's Brand
   * Visual Identity into the generation: the brief is appended to the
   * prompt and 3-5 tagged template/element assets are added as
   * reference_image_urls. Set to false ONLY when the agent wants a
   * completely fresh generation untouched by brand grounding (e.g.
   * generating an example of an anti-pattern, or a brand-agnostic mockup).
   * The brand identity block must exist on the company; if it doesn't,
   * this flag is a no-op.
   */
  use_brand_visual_identity?: boolean;
  /**
   * Optional aspirational brand name (e.g. "Stripe", "Notion") to fetch
   * an extra style reference from. The resolver fetches the brand's
   * og:image at generation time and adds it as one more
   * reference_image_url. Use sparingly: each reference dilutes the
   * brand's own identity. Not implemented in v1 (lands when the resolver
   * supports inline aspirational fetch). For now reserved for forward
   * compat; the field is accepted by the schema but ignored at execute.
   */
  inspired_by_brand?: string;
};
export type AssetSourceAiVideo = {
  type: "ai_generate";
  model: string;
  prompt: string;
  reference_image_url?: string;
  duration_seconds: number;
};
export type AssetSourceAvatarLipsync = {
  type: "ai_avatar_lipsync";
  script: string;
  avatar_id: number;
};
export type AssetSourceAvatarVideo = {
  type: "ai_avatar_video";
  scripts: string[];
  avatar_id: number;
  generate_backgrounds?: boolean;
};

export type AssetLayout =
  | "single_image"
  | "carousel_images"
  | "single_video"
  | "carousel_mixed"
  | "single_gif";

export type ProductType = "feed" | "reel" | "story" | "short" | "long_video";

export type SocialNetwork =
  | "instagram"
  | "tiktok"
  | "facebook"
  | "linkedin"
  | "x"
  | "pinterest"
  | "threads"
  | "youtube"
  | "bluesky";

export interface AssetsStrategy {
  image_source?: AssetSourceUrl | AssetSourceAssetId | AssetSourceAiImage;
  carousel_sources?: Array<AssetSourceUrl | AssetSourceAssetId | AssetSourceAiImage>;
  video_source?:
    | AssetSourceUrl
    | AssetSourceAssetId
    | AssetSourceAiVideo
    | AssetSourceAvatarLipsync
    | AssetSourceAvatarVideo;
}

/**
 * Detailed asset plan for a sub_post. Optional and additive over the
 * existing assets_strategy (back-compat: plans that pre-date this field
 * are still valid). When both are present the asset_plan is the
 * primary source of truth and the agent / executor should reconcile.
 *
 * type values:
 *   - ai_image:           pure or reference-grounded AI image
 *   - ai_video_clip:      text-to-video clip (or image-to-video with
 *                         reference_image_urls[0] as seed)
 *   - avatar_video:       generated avatar reel (audio + lipsync + concat)
 *   - reuse_asset:        existing asset from the library (reference_asset_ids)
 *   - upload_from_website:download from source_website_product_url and upload
 *   - composite:          multi-reference AI generation (logo + product photo
 *                         + lifestyle pose, etc.)
 */
export interface AssetPlan {
  type:
    | "ai_image"
    | "ai_video_clip"
    | "avatar_video"
    | "reuse_asset"
    | "upload_from_website"
    | "composite";
  /** Visual specification of what the resulting asset should show. */
  description: string;
  /** AI generation prompt when applicable. */
  prompt?: string;
  /** Reference image URLs (from website, recent assets, or external). */
  reference_image_urls?: string[];
  /** When true, the brand logo should be present in the final composition. */
  include_logo?: boolean;
  /** Followr asset ids to reuse (for reuse_asset / composite). */
  reference_asset_ids?: number[];
  /** URL of the product detail page on the company website, for traceability. */
  source_website_product_url?: string;
  /** Recommended model id (e.g. "nano_banana_2", "veo_3.1_fast"). */
  model_recommendation?: string;
  /** How confident the agent is in this plan; surfaces during validation as a soft warning when low. */
  confidence_level?: "high" | "medium" | "low";
}

export interface SubPost {
  social_network: SocialNetwork;
  product_type: ProductType;
  asset_layout: AssetLayout;
  assets_strategy: AssetsStrategy;
  caption_concept: string;
  tags?: string[];

  /**
   * Final publication-ready copy for this sub_post. Optional for
   * back-compat with v0.4.2 plans; new plans SHOULD set this so the
   * user sees the exact text that will be published, not a concept
   * placeholder.
   */
  copy_draft?: string;

  /**
   * Detailed asset plan: type, description, references, logo flag,
   * recommended model. Optional for back-compat. Adds traceability and
   * supports the asset-strategy priority order (reuse > upload >
   * reference-grounded AI > pure AI; see instructions Rule 17).
   */
  asset_plan?: AssetPlan;
}

/**
 * Source-of-truth pointer back to the deep research that informed this
 * plan item. Optional; populated when the plan was built on top of a
 * deep_research call.
 */
export interface SourceResearch {
  /** URL of the page on the company website that inspired this concept. */
  website_page?: string;
  /** Concrete product / SKU names featured by this plan item. */
  products_featured?: string[];
  /** Active campaign / sale / launch this item ties into. */
  campaign?: string;
  /** True when the assets for this item come from the company's real catalog (vs pure AI). */
  assets_from_website: boolean;
}

export interface PlanItem {
  slug: string;
  date: string; // YYYY-MM-DD
  publish_at_time_local: string; // HH:mm
  timezone: string;
  concept_shared: string;
  rationale: string;
  paired_with?: string[];
  sub_posts: SubPost[];
  /**
   * Optional reference back to the deep_research output that drove this
   * plan item. Helps the agent explain "we chose this because the
   * website showed X" and lets the executor trace asset choices back
   * to real brand material.
   */
  source_research?: SourceResearch;
}

export interface ContentPlan {
  plan_id: string;
  context_id: string;
  company_id: number;
  created_at_ms: number;
  expires_at_ms: number;
  time_window: { start: string; end: string };
  user_answers: {
    posts_per_day?: number;
    networks_intent?: SocialNetwork[];
    theme?: string;
    promo_context?: string;
    /**
     * Declared language tag for every copy_draft and AI text generation
     * triggered by this plan (e.g. "es", "en", "es-AR"). Falls back to
     * company.language when omitted. The validator surfaces a warning if
     * any sub_post copy_draft appears to be in a different language.
     */
    language?: string;
    /**
     * Hashtag inclusion policy across networks. "auto" (default) includes
     * per-network typical counts (IG 5-8, LinkedIn 3-5, X 1-3, TikTok 3-5,
     * Threads 0-3). "off" suppresses hashtags entirely.
     */
    hashtags_policy?: "auto" | "off";
  };
  plan_items: PlanItem[];
  use_brand_voice: boolean;
  auto_publish_schedule?: {
    timezone: string;
    time_per_day: string;
  };
  status: "draft" | "executing" | "executed" | "failed";
  execution_started_at_ms?: number;
  execution_finished_at_ms?: number;
}

export interface ContextSnapshot {
  context_id: string;
  company_id: number;
  created_at_ms: number;
  expires_at_ms: number;
  // We persist a tiny subset of what prepare_content_plan_context returns so
  // draft_content_plan can verify the context_id is still valid and bound to
  // the right company. The full payload returned to the agent does not need to
  // be re-served by us; the agent keeps it in conversation context.
  networks_connected: SocialNetwork[];
  brand_has_voice_prompt: boolean;
  // Industry id parsed from Company.description at bootstrap time. null when
  // the company has never been classified via deep_research. draft_content_plan
  // emits an industry_classification_required blocker when this is null so the
  // industry-aware policies (recommended_video_strategy, format biases) have a
  // valid value to dispatch on.
  cached_industry_id: string | null;
}

// ── Memory store ────────────────────────────────────────────────────────────

// 2 hours: matches typical content-planning session length. Beyond this the
// budgets, asset library, etc. may be stale.
const PLAN_TTL_MS = 2 * 60 * 60 * 1000;
const CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

// Hard cap: prevents one runaway client from filling memory. If hit, oldest
// entries are evicted first.
const MAX_PLANS = 64;
const MAX_CONTEXTS = 64;

const plans = new Map<string, ContentPlan>();
const contexts = new Map<string, ContextSnapshot>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, p] of plans) {
    if (p.expires_at_ms < now) plans.delete(id);
  }
  for (const [id, c] of contexts) {
    if (c.expires_at_ms < now) contexts.delete(id);
  }
}

function evictOldestIfNeeded(map: Map<string, { created_at_ms: number }>, max: number): void {
  if (map.size < max) return;
  let oldestId: string | null = null;
  let oldestT = Infinity;
  for (const [id, entry] of map) {
    if (entry.created_at_ms < oldestT) {
      oldestT = entry.created_at_ms;
      oldestId = id;
    }
  }
  if (oldestId) map.delete(oldestId);
}

function genId(prefix: string): string {
  // Short, human-readable. Not cryptographically random: this is session-local,
  // not externally referenceable. Collision odds are negligible at 64-entry cap.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export function createContext(snapshot: Omit<ContextSnapshot, "context_id" | "created_at_ms" | "expires_at_ms">): ContextSnapshot {
  pruneExpired();
  evictOldestIfNeeded(contexts, MAX_CONTEXTS);
  const now = Date.now();
  const ctx: ContextSnapshot = {
    ...snapshot,
    context_id: genId("ctx"),
    created_at_ms: now,
    expires_at_ms: now + CONTEXT_TTL_MS,
  };
  contexts.set(ctx.context_id, ctx);
  return ctx;
}

export function getContext(context_id: string): ContextSnapshot | null {
  pruneExpired();
  return contexts.get(context_id) ?? null;
}

export function createPlan(
  init: Omit<ContentPlan, "plan_id" | "created_at_ms" | "expires_at_ms" | "status">,
): ContentPlan {
  pruneExpired();
  evictOldestIfNeeded(plans, MAX_PLANS);
  const now = Date.now();
  const plan: ContentPlan = {
    ...init,
    plan_id: genId("plan"),
    created_at_ms: now,
    expires_at_ms: now + PLAN_TTL_MS,
    status: "draft",
  };
  plans.set(plan.plan_id, plan);
  return plan;
}

export function getPlan(plan_id: string): ContentPlan | null {
  pruneExpired();
  return plans.get(plan_id) ?? null;
}

export function updatePlan(plan_id: string, patch: Partial<ContentPlan>): ContentPlan | null {
  const existing = getPlan(plan_id);
  if (!existing) return null;
  const merged: ContentPlan = { ...existing, ...patch, plan_id: existing.plan_id };
  plans.set(plan_id, merged);
  return merged;
}

export function deletePlan(plan_id: string): boolean {
  return plans.delete(plan_id);
}

// Test / introspection helpers. NOT exposed via tools.
export function _debugListPlans(): ContentPlan[] {
  return Array.from(plans.values());
}

export function _debugClearAll(): void {
  plans.clear();
  contexts.clear();
}
