// Session-scoped state for Brand Visual Identity drafts.
//
// A draft is created by draft_brand_visual_identity, persists in MCP memory
// for up to 24h, and is consumed (committed to Followr) by
// execute_brand_visual_identity. No persistence across server restarts; the
// agent has to re-collect user answers if the server bounced before execute.
//
// 24h TTL (vs content-plan's 2h) because the brand identity setup involves
// the user reviewing dozens of scraped thumbnails and possibly uploading
// their own images, which can span a multi-day conversation in practice.

import type { BrandVisualIdentity } from "./brand-identity.js";

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFTS_IN_MEMORY = 64;

export type ProposedActionKind =
  | "create_folder"
  | "upload_url_to_folder"
  | "upload_svg_to_folder"
  | "fetch_og_image_then_upload"
  | "update_company_description"
  | "clear_ai_image_styles"
  | "create_tag"
  | "tag_asset";

export interface ProposedAction {
  kind: ProposedActionKind;
  /** Short human description for preview rendering. */
  human_description: string;
  /** Free-form payload; shape depends on kind. The executor reads this. */
  payload: Record<string, unknown>;
  /**
   * Optional ordering hint. Folders create at order=10, asset uploads at
   * order=20, og:image fetches at order=30, description update at order=90,
   * ai_image_styles clear at order=95. Within the same order they can run
   * in parallel.
   */
  order: number;
}

export interface BrandIdentityDraft {
  draft_id: string;
  company_id: number;
  created_at_ms: number;
  expires_at_ms: number;
  status: "draft" | "executing" | "executed" | "failed";
  execution_started_at_ms?: number;
  execution_finished_at_ms?: number;
  /** Filled by the draft tool from the user's curated answers. */
  user_answers: {
    visual_style: string;
    aspirational_brands: string[];
    anti_patterns: string[];
    language_override: string | null;
    clear_ai_image_styles: boolean;
  };
  /** The synthesized identity object that will be persisted (folder ids
   * still null at draft time; filled by execute when folders are created). */
  proposed_identity: BrandVisualIdentity;
  /** Ordered list of mutations that execute will perform. */
  proposed_actions: ProposedAction[];
  /** AiResult id of the generateChat call that produced brief_text. Null if
   * the brief was synthesized without an AI call (manual override). */
  brief_synthesis_ai_result_id: number | null;
  /** Words consumed from ai_text_budget for brief synthesis. */
  brief_synthesis_words: number;
}

const drafts = new Map<string, BrandIdentityDraft>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, d] of drafts) {
    if (d.expires_at_ms < now) drafts.delete(id);
  }
}

function enforceCap(): void {
  if (drafts.size <= MAX_DRAFTS_IN_MEMORY) return;
  // Evict the oldest by created_at_ms.
  const sorted = [...drafts.entries()].sort((a, b) => a[1].created_at_ms - b[1].created_at_ms);
  while (drafts.size > MAX_DRAFTS_IN_MEMORY) {
    const oldest = sorted.shift();
    if (!oldest) break;
    drafts.delete(oldest[0]);
  }
}

function generateDraftId(): string {
  // Simple random id; not crypto-secure, just unique enough for session memory.
  return `bid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createDraft(
  args: Omit<BrandIdentityDraft, "draft_id" | "created_at_ms" | "expires_at_ms" | "status">,
): BrandIdentityDraft {
  pruneExpired();
  enforceCap();
  const now = Date.now();
  const draft: BrandIdentityDraft = {
    draft_id: generateDraftId(),
    created_at_ms: now,
    expires_at_ms: now + DRAFT_TTL_MS,
    status: "draft",
    ...args,
  };
  drafts.set(draft.draft_id, draft);
  return draft;
}

export function getDraft(draftId: string): BrandIdentityDraft | undefined {
  pruneExpired();
  return drafts.get(draftId);
}

export function updateDraft(
  draftId: string,
  patch: Partial<Omit<BrandIdentityDraft, "draft_id" | "company_id" | "created_at_ms" | "expires_at_ms">>,
): BrandIdentityDraft | undefined {
  const d = drafts.get(draftId);
  if (!d) return undefined;
  const next = { ...d, ...patch };
  drafts.set(draftId, next);
  return next;
}

export function listDraftsForCompany(companyId: number): BrandIdentityDraft[] {
  pruneExpired();
  return [...drafts.values()].filter((d) => d.company_id === companyId);
}

/** Test helper. Do not call from production code paths. */
export function _clearAllDraftsForTests(): void {
  drafts.clear();
}
