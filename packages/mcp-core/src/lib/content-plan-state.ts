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
  reference_image_url?: string;
  model?: string;
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

export interface SubPost {
  social_network: SocialNetwork;
  product_type: ProductType;
  asset_layout: AssetLayout;
  assets_strategy: AssetsStrategy;
  caption_concept: string;
  tags?: string[];
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
