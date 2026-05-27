// Content-plan tools: prepare_content_plan_context, draft_content_plan,
// update_content_plan, execute_content_plan.
//
// This is the orchestrator flow that replaces the "compose a plan by chaining
// 10 individual tool calls" pattern from previous MCP versions. Each tool
// has a narrow responsibility:
//
//   prepare_content_plan_context  : load EVERYTHING (brief, budget, avatars,
//                                   voices, networks, models with cost,
//                                   website summary, capabilities matrix,
//                                   planning strategy) in parallel and return
//                                   a single payload + a context_id.
//
//   draft_content_plan            : validate a structured plan_items array
//                                   against networks/specs/budget and persist
//                                   it in session memory with a plan_id.
//
//   update_content_plan           : apply mutations to a draft plan (replace,
//                                   add, remove, shift dates, split sub_posts
//                                   per network, convert to carousel).
//
//   execute_content_plan          : with explicit confirm:true, run uploads,
//                                   AI generations and PostGroup creates in
//                                   parallel, return granular per-item
//                                   results with raw backend errors when
//                                   something fails.
//
// This file currently implements prepare_content_plan_context. The remaining
// three tools land in follow-up commits.

import type { AiPreferences, Company, Prompt, RuleGroup, Asset, PostGroup, Avatar, Voice, Tag, Folder } from "@followr-mcp/shared";
import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_IDEMPOTENT, READ_ONLY } from "../lib/annotations.js";
import {
  FOLLOWR_CAPABILITIES_SUMMARY,
  IMAGE_MODELS,
  NETWORK_FORMAT_COMPATIBILITY,
  PLANNING_STRATEGY,
  VIDEO_MODELS,
  compatibilityFor,
  sanitizeImageModelPref,
} from "../lib/content-plan-catalog.js";
import {
  BRAND_TAGS,
  type BrandTag,
  type BrandVisualIdentity,
  parseBrandIdentityFromDescription,
  pickBrandReferenceAssetIds,
  suggestedTagsForConcept,
} from "../lib/brand-identity.js";
import { parseVisualStyleMarker } from "../lib/visual-style-marker.js";
import {
  AI_DECIDES_SLUG,
  isValidStyleSlug,
} from "../lib/creative-studio-styles.js";
import {
  type StandardAspectRatio,
  toCreativeStudioAspectRatio,
} from "../lib/aspect-ratio-translate.js";
import { resolveDriver } from "../lib/driver-resolver.js";
import {
  ALL_INDUSTRY_IDS,
  type IndustryId,
  type VideoStrategy,
  getProfile,
} from "../lib/industry-profiles/index.js";
import { normalizePreferences } from "../lib/normalize-preferences.js";
import { getAiPreferences } from "../lib/preferences.js";
import { readCachedIndustry } from "./research.js";
import { localDateTimeToUtcIso, resolveTimezone } from "../lib/timezone.js";
import {
  type AssetLayout,
  type AssetSourceAiImage,
  type AssetsStrategy,
  type ContentPlan,
  type PlanItem,
  type ProductType,
  type SocialNetwork,
  type SubPost,
  createContext,
  createPlan,
  getContext,
  getPlan,
  updatePlan as updatePlanInState,
} from "../lib/content-plan-state.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";
import { uploadFromUrl } from "./assets.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SocialNetworkLite {
  id: number;
  type?: string;
  status?: string | null;
}

const KNOWN_NETWORKS: ReadonlySet<SocialNetwork> = new Set<SocialNetwork>([
  "instagram",
  "tiktok",
  "facebook",
  "linkedin",
  "x",
  "pinterest",
  "threads",
  "youtube",
  "bluesky",
]);

function normalizeNetworkType(type: string | undefined | null): SocialNetwork | null {
  if (!type) return null;
  // Followr uses "twitter" internally for X. Normalize to "x" for consistency
  // with the planner's enum.
  const mapped = type === "twitter" ? "x" : type;
  return KNOWN_NETWORKS.has(mapped as SocialNetwork) ? (mapped as SocialNetwork) : null;
}

function sanitizeCompany(company: Company) {
  // Strip secrets and payment-method PII before exposing to the LLM. Same
  // policy as tools/context.ts:sanitizeCompany; duplicated here so this file
  // doesn't need to import private internals.
  const { webhook_secret, ai_keys, ...safe } = company as Company & { webhook_secret?: unknown; ai_keys?: Array<{ provider: string }> };
  return {
    ...safe,
    webhook_secret_present: Boolean(webhook_secret),
    ai_keys_configured_providers: (ai_keys ?? []).map((k) => k.provider),
  };
}

// Resolve a "company hint" (name fragment or numeric id) to an actual
// company_id. The caller passes one of these in prepare_content_plan_context
// to anchor the rest of the work.
//
// Name matching is tolerant by design. The 2026-05-23 PostApprove share
// triggered a wasted round-trip because the user typed "Post Approve" (with
// a space) while the brand is named "PostApprove" (no space) on Followr; the
// includes() check missed the match and the agent had to call list_companies
// and retry. We now compare AFTER stripping case, whitespace AND accents on
// both sides. We also prefer exact-after-normalization matches over partial
// includes so picking up "VCP" doesn't accidentally return "VCP Reviews 2025"
// when both exist.
function normalizeCompanyName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, ""); // drop punctuation so "AT&T" matches "atandt" too
}

async function resolveCompany(
  client: FollowrClient,
  hint: string | number,
): Promise<{ company: Company; matches?: Company[] }> {
  // Numeric id path: fetch directly.
  const asNum = typeof hint === "number" ? hint : Number.isFinite(Number(hint)) ? Number(hint) : null;
  if (asNum && Number.isInteger(asNum) && asNum > 0) {
    const company = await client.getCompany(asNum);
    return { company };
  }
  const rawSearch = String(hint).trim();
  const normalizedSearch = normalizeCompanyName(rawSearch);
  if (!normalizedSearch) {
    throw new Error(`Empty company hint. Call list_companies to see what's available.`);
  }
  // Two-bucket collection: exact (after normalization) wins over partial.
  const exactMatches: Company[] = [];
  const partialMatches: Company[] = [];
  // Page through companies (Followr enforces page_size=30 server-side).
  for (let page = 1; page <= 10; page++) {
    const batch = await client.listCompanies({ pageSize: 30, pageNumber: page });
    if (batch.length === 0) break;
    for (const c of batch) {
      const normalizedName = normalizeCompanyName(c.name ?? "");
      if (!normalizedName) continue;
      if (normalizedName === normalizedSearch) {
        exactMatches.push(c);
      } else if (normalizedName.includes(normalizedSearch)) {
        partialMatches.push(c);
      }
    }
    if (batch.length < 30) break;
  }
  const candidates = exactMatches.length > 0 ? exactMatches : partialMatches;
  if (candidates.length === 0) {
    throw new Error(`No company matches "${hint}". Call list_companies to see what's available.`);
  }
  if (candidates.length > 1) {
    // Return a synthetic "company" with the first match plus all candidates
    // for disambiguation. The handler surfaces this to the user.
    return { company: candidates[0] as Company, matches: candidates };
  }
  return { company: candidates[0] as Company };
}

// Best-effort website summary. Fetches the URL, parses the title tag, meta
// description, and Open Graph metadata. Returns null if anything fails.
// Capped at 10s and 1MB to be a good citizen.
const WEBSITE_FETCH_TIMEOUT_MS = 10_000;
const WEBSITE_FETCH_MAX_BYTES = 1_000_000;

async function fetchWebsiteSummary(url: string): Promise<Record<string, unknown> | null> {
  try {
    // Normalize URL: add https:// if missing.
    let target = url.trim();
    if (!/^https?:\/\//i.test(target)) {
      target = "https://" + target;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WEBSITE_FETCH_TIMEOUT_MS);
    const resp = await fetch(target, {
      method: "GET",
      headers: {
        "User-Agent": "FollowrMCP/0.5 (+https://followr.ai)",
        Accept: "text/html",
      },
      signal: ctl.signal,
      redirect: "follow",
    }).catch((e) => {
      clearTimeout(timer);
      throw e;
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    // Cap the body read.
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < WEBSITE_FETCH_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    return parseHtmlSummary(html, target);
  } catch {
    return null;
  }
}

function parseHtmlSummary(html: string, target: string): Record<string, unknown> {
  const title = matchFirst(html, /<title[^>]*>([^<]+)<\/title>/i)?.trim();
  const description = matchFirst(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  const ogTitle = matchFirst(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const ogDescription = matchFirst(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const ogImage = matchFirst(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const ogSiteName = matchFirst(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  const ogLocale = matchFirst(html, /<meta[^>]+property=["']og:locale["'][^>]+content=["']([^"']+)["']/i);
  const lang = matchFirst(html, /<html[^>]+lang=["']([^"']+)["']/i);
  // Cheap heuristic: grab text near common shop / catalog markers.
  const headings: string[] = [];
  const hRe = /<h[12][^>]*>([\s\S]{1,200}?)<\/h[12]>/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = hRe.exec(html)) && count < 12) {
    const txt = stripTags(m[1] ?? "").trim();
    if (txt.length > 2 && txt.length < 200) {
      headings.push(txt);
      count += 1;
    }
  }
  return {
    fetched_url: target,
    title: title ?? null,
    meta_description: description ?? null,
    og_title: ogTitle ?? null,
    og_description: ogDescription ?? null,
    og_image_url: ogImage ?? null,
    site_name: ogSiteName ?? null,
    locale: ogLocale ?? lang ?? null,
    top_headings_sample: headings.slice(0, 12),
    _agent_hint:
      "This is a shallow heuristic summary parsed server-side from the company's website. Use it to ground the plan in current reality (season, target demographic, active promos, product categories). If you need deeper detail, ask the user or call WebFetch on a specific page.",
  };
}

function matchFirst(s: string, re: RegExp): string | undefined {
  const m = re.exec(s);
  return m && m[1] ? m[1] : undefined;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

// Compute budget buckets the same way subscription.ts does, so callers can
// embed them in this composite response.
interface AiBudget {
  remaining: number;
  used: number;
  total: number;
  percent_used: number;
  note: string | null;
}

interface AllBudgets {
  ai_text_budget: AiBudget;
  ai_image_and_video_budget: AiBudget;
  storage_budget: AiBudget & { remaining_gb: number; used_gb: number; total_gb: number };
  followr_plus_enabled: boolean;
}

async function loadBudgets(client: FollowrClient): Promise<AllBudgets | null> {
  try {
    const balance = await client.getSubscriptionBalance();
    const bytesSpent =
      typeof balance.bytes_spent === "string" ? Number(balance.bytes_spent) : Number(balance.bytes_spent ?? 0);

    const textRemaining = balance.words_allowed - balance.words_spent;
    const imagesRemaining = balance.images_allowed - balance.images_spent;
    const bytesRemaining = balance.bytes_allowed - bytesSpent;

    const pct = (used: number, total: number) => (total > 0 ? Number((used / total).toFixed(3)) : 0);
    const noteHigh = (p: number) => (p > 0.9 ? "over 90% used: warn before any batch operation" : null);

    return {
      ai_text_budget: {
        remaining: textRemaining,
        used: balance.words_spent,
        total: balance.words_allowed,
        percent_used: pct(balance.words_spent, balance.words_allowed),
        note: noteHigh(pct(balance.words_spent, balance.words_allowed)),
      },
      ai_image_and_video_budget: {
        remaining: imagesRemaining,
        used: balance.images_spent,
        total: balance.images_allowed,
        percent_used: pct(balance.images_spent, balance.images_allowed),
        note:
          noteHigh(pct(balance.images_spent, balance.images_allowed)) ??
          "video and image generation share this bucket; no separate video quota",
      },
      storage_budget: {
        remaining: bytesRemaining,
        used: bytesSpent,
        total: balance.bytes_allowed,
        percent_used: pct(bytesSpent, balance.bytes_allowed),
        note: noteHigh(pct(bytesSpent, balance.bytes_allowed)),
        remaining_gb: Number((bytesRemaining / 1e9).toFixed(2)),
        used_gb: Number((bytesSpent / 1e9).toFixed(2)),
        total_gb: Number((balance.bytes_allowed / 1e9).toFixed(2)),
      },
      followr_plus_enabled: Boolean(balance.plus_chat_enabled),
    };
  } catch {
    return null;
  }
}

// Mark video models with affordable: true/false given current budget, then
// sort by (recommended_rank ASC, cost ASC). The agent should default to
// the first entry unless the user explicitly asks for a different one.
// When prefs.video_model is set, that model is bumped to recommended_rank 0
// (company preference overrides catalog default).
//
// Plan gating: premium-bucket models (Veo 3/3.1 variants) require
// followr_plus_enabled=true. On accounts without it the backend rejects them
// with HTTP 422 "selected model is invalid". When plus is off we mark every
// premium model as blocked_by_plan + non-affordable, and promote wan_2 (the
// documented fallback) to rank 0 so the agent's "pick first entry" policy
// surfaces a model that actually works.
function annotateVideoModels(
  imageVideoRemaining: number,
  followrPlusEnabled: boolean,
  prefs?: AiPreferences,
) {
  const preferredModelId = prefs?.video_model;
  const annotated = VIDEO_MODELS.map((m) => {
    const isCompanyDefault = preferredModelId === m.model_id;
    const blocked_by_plan = m.bucket === "premium" && !followrPlusEnabled;
    const affordable =
      m.bucket === "premium"
        ? followrPlusEnabled && m.cost_for_default_duration <= imageVideoRemaining
        : m.cost_for_default_duration <= imageVideoRemaining;
    // Treat wan_2.2 as the recommended default (rank 0) for accounts without
    // Followr Plus, since the catalog's rank-0 (veo_3.1_fast) is gated. It is
    // the only regular-bucket video model the backend accepts. Other models
    // stay non-recommended; the user can pick them on request.
    const isWanFallbackDefault = !followrPlusEnabled && m.model_id === "wan_2.2";
    const overrides: Partial<{ recommended: boolean; recommended_rank: number; is_company_default: true; is_plan_fallback_default: true }> = {};
    if (isCompanyDefault) {
      overrides.recommended = true;
      overrides.recommended_rank = 0;
      overrides.is_company_default = true;
    } else if (isWanFallbackDefault) {
      overrides.recommended = true;
      overrides.recommended_rank = 0;
      overrides.is_plan_fallback_default = true;
    } else if (blocked_by_plan) {
      // Demote: keep visible in the catalog (so the agent can answer
      // questions about it) but push to the back of the sort so "pick first"
      // never lands here.
      overrides.recommended = false;
      overrides.recommended_rank = 99;
    }
    return {
      ...m,
      affordable_at_default_duration: affordable,
      blocked_by_plan,
      cost_note: `${m.cost_per_second} credits per second of video (${m.default_duration_seconds}s default = ${m.cost_for_default_duration} cr total).`,
      ...overrides,
    };
  });
  // Sort: company default first (rank 0 via override), then plan-fallback
  // (wan_2 when plus is off), then platform-curated recommended ladder by
  // recommended_rank, then non-recommended by cost.
  return annotated.sort((a, b) => {
    const aRank = a.recommended ? a.recommended_rank ?? 99 : 100;
    const bRank = b.recommended ? b.recommended_rank ?? 99 : 100;
    if (aRank !== bRank) return aRank - bRank;
    return a.cost_per_second - b.cost_per_second;
  });
}

function annotateImageModels(
  imagesRemaining: number,
  followrPlusEnabled: boolean,
  prefs?: AiPreferences,
) {
  const preferredModelId = prefs?.image_model;
  const annotated = IMAGE_MODELS.map((m) => {
    const isCompanyDefault = preferredModelId === m.model_id;
    // Premium models require followr_plus_enabled true. Without it the
    // backend rejects them at runtime regardless of how many credits the
    // user has in image_and_video. Regular models only need budget.
    const affordable =
      m.bucket === "premium"
        ? followrPlusEnabled && imagesRemaining >= m.cost_per_image
        : imagesRemaining >= m.cost_per_image;
    const blocked_by_plan = m.bucket === "premium" && !followrPlusEnabled;
    return {
      ...m,
      affordable,
      blocked_by_plan,
      cost_note: `${m.cost_per_image} credits per image (${m.bucket} bucket).`,
      ...(isCompanyDefault
        ? { recommended: true, recommended_rank: 0, is_company_default: true as const }
        : {}),
    };
  });
  return annotated.sort((a, b) => {
    const aRank = a.recommended ? a.recommended_rank ?? 99 : 100;
    const bRank = b.recommended ? b.recommended_rank ?? 99 : 100;
    if (aRank !== bRank) return aRank - bRank;
    return a.cost_per_image - b.cost_per_image;
  });
}

// ── prepare_content_plan_context tool ───────────────────────────────────────

export function registerContentPlanTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "prepare_content_plan_context",
    {
      annotations: READ_ONLY,
      title: "Bootstrap a content planning task: load brand, budget, capabilities, models, website in one call",
      description: `Loads everything an agent needs to draft a coherent content plan, in a single tool call: brand brief, the four AI budgets, connected networks, the company's existing avatars / voices / tags / folders / prompts / rule groups, recent assets, recent published posts, a server-side summary of the company's website (when present), the per-network format compatibility matrix, the catalog of video and image AI models with cost calculated for typical durations and whether the user can afford each, and a structured planning_strategy block with ultrathink guidance.

USE THIS at the start of any content-planning task (a week of posts, a campaign, a launch, a series). Replaces a chain of get_company_creative_brief + get_ai_budget + list_avatars + list_voices + list_tags + list_folders + list_prompts + list_rule_groups + list_assets + list_drafts + WebFetch(website). Always faster, always more consistent, always less likely to skip a key piece of context.

OUTPUT: a context_id you pass to draft_content_plan. The context expires after 2 hours; re-call if you come back later.

MUTATION: none. As of 2026-05-26 this tool is fully read-only. Earlier versions auto-classified the industry via a keyword heuristic and persisted the result, but that wrote bad data for minimalist B2B SaaS landings and downstream tools then trusted the wrong cache. Industry classification now goes through two explicit steps: (1) deep_research(company_id) does the actual detection and writes an auto marker, (2) confirm_industry(company_id, industry_id) accepts the user's final pick and writes the :confirmed marker that unblocks draft_content_plan. The proposals industry_setup_proposal and industry_confirmation_required in this response tell the agent which step is missing.

IMPORTANT: even though this returns a lot of data, it does NOT draft a plan. After receiving this context: (1) identify what user intent is still ambiguous (window, posts per day, networks, theme, promo, brand voice creation); (2) ask the user ONE multi-decision question; (3) ONLY THEN call draft_content_plan with your crafted plan_items array. Do not skip to drafting in the same turn.`,
      inputSchema: {
        company: z
          .union([z.number().int().positive(), z.string().min(1)])
          .describe(
            "Either the company id (integer) or a name fragment to search for. If the search returns multiple matches the tool surfaces them and asks the user to pick by exact name.",
          ),
        include_website_summary: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Default true. Fetches the company's website (if set on the Company resource) and returns a shallow summary (title, meta description, og:* tags, top headings). Skip with false only if the website is known to be unreachable.",
          ),
        auto_classify_industry: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Default true. Historical name (kept for backwards compatibility). When true, the response includes industry_setup_proposal / industry_confirmation_required to guide the agent through the deep_research → confirm_industry flow. When false, those proposals are suppressed: use this only if the agent is driving industry classification manually and does not want the proposal hints surfaced. The hard block in draft_content_plan still requires a :confirmed marker regardless of this flag.",
          ),
      },
    },
    async ({ company, include_website_summary, auto_classify_industry }) => {
      // 1. Resolve company first; everything else depends on company_id.
      let companyResolved: Company;
      let disambiguation: Company[] | undefined;
      try {
        const resolved = await resolveCompany(client, company);
        companyResolved = resolved.company;
        disambiguation = resolved.matches;
      } catch (err) {
        return toolErrorFromException(err);
      }
      const company_id = companyResolved.id;

      // 2. Fan out everything else in parallel. Each lookup is tolerant: if a
      // sub-call fails, that section comes back null / [] and we surface a
      // partial_failures map in the guidance so the agent knows what's missing.
      const [
        meR,
        socialNetworksR,
        promptsR,
        tagsR,
        foldersR,
        ruleGroupsR,
        avatarsR,
        voicesR,
        assetsRecentR,
        postGroupsRecentR,
        budgetsR,
      ] = await Promise.allSettled([
        client.getMe(),
        client.listSocialNetworks(company_id),
        client.listPrompts({ companyId: company_id, pageSize: 100 }),
        client.listTags(company_id, { pageSize: 100 }),
        client.listFolders(company_id, { pageSize: 100 }),
        client.listRuleGroups(company_id, { include: "rules,tags" }),
        client.listAvatars(company_id, { include: "image.thumbnail,voice" }),
        client.listVoices(company_id, { pageSize: 100 }),
        client.listAssets(company_id, { pageSize: 30, include: "thumbnail" }),
        client.listCompanyPostGroups(company_id, {
          sort: "-id",
          pageSize: 10,
          draft: false,
          include: "posts",
        }),
        loadBudgets(client),
      ]);

      // 3. Website summary (only if include_website_summary is true AND the
      // company has a website URL).
      let websiteSummary: Record<string, unknown> | null = null;
      const websiteUrl = (companyResolved as Company & { website?: string }).website;
      if (include_website_summary && websiteUrl && typeof websiteUrl === "string" && websiteUrl.trim()) {
        websiteSummary = await fetchWebsiteSummary(websiteUrl);
      }

      // 4. Unwrap results.
      const me = meR.status === "fulfilled" ? meR.value : null;
      const socialNetworks =
        socialNetworksR.status === "fulfilled" ? (socialNetworksR.value as SocialNetworkLite[]) : [];
      const prompts: Prompt[] = promptsR.status === "fulfilled" ? promptsR.value : [];
      const tags: Tag[] = tagsR.status === "fulfilled" ? tagsR.value : [];
      const folders: Folder[] = foldersR.status === "fulfilled" ? foldersR.value : [];
      const ruleGroups: RuleGroup[] = ruleGroupsR.status === "fulfilled" ? ruleGroupsR.value : [];

      // 4b. Enrich each Autopilot rule group (Autolist) with queue + history +
      // overlap so the agent can reason about WHICH autolists are healthy /
      // starving / zombie / out-of-season WITHOUT additional API round-trips.
      // No LLM call here: just raw signals. The downstream LLM infers theme,
      // temporal relevance, health status, and recommends feed / pause /
      // create-new / merge based on these.
      const enrichmentByRgId = new Map<
        number,
        { queue: PostGroup[]; history: PostGroup[] }
      >();
      if (ruleGroups.length > 0) {
        const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const perRgResults = await Promise.allSettled(
          ruleGroups.map(async (rg) => {
            const tagIds = (rg.tags ?? []).map((t) => t.id);
            if (tagIds.length === 0) {
              return { rgId: rg.id, queue: [] as PostGroup[], history: [] as PostGroup[] };
            }
            const [queueR, historyR] = await Promise.allSettled([
              client.listCompanyPostGroups(company_id, {
                tagIds,
                draft: false,
                publishAtNull: true,
                status: "pending",
                pageSize: 15,
                sort: "-id",
              }),
              client.listCompanyPostGroups(company_id, {
                tagIds,
                status: "published",
                publishAtAfter: thirtyDaysAgoIso,
                pageSize: 30,
                sort: "-id",
              }),
            ]);
            return {
              rgId: rg.id,
              queue: queueR.status === "fulfilled" ? queueR.value : ([] as PostGroup[]),
              history: historyR.status === "fulfilled" ? historyR.value : ([] as PostGroup[]),
            };
          }),
        );
        for (const r of perRgResults) {
          if (r.status === "fulfilled") {
            enrichmentByRgId.set(r.value.rgId, { queue: r.value.queue, history: r.value.history });
          }
        }
      }

      // Tag overlap between rule groups. A tag may belong to at most ONE active
      // rule group at a time (backend constraint), so overlap among ACTIVES is
      // surprising (and worth surfacing). Among any-state groups, overlap means
      // a tag is shared, useful for consolidation suggestions.
      const overlapByRgId = new Map<
        number,
        Array<{ rule_group_name: string; rule_group_active: boolean; overlapping_tag_names: string[] }>
      >();
      for (const rg of ruleGroups) {
        const myTags = (rg.tags ?? []).map((t) => ({ id: t.id, name: t.name }));
        if (myTags.length === 0) continue;
        const overlaps: Array<{
          rule_group_name: string;
          rule_group_active: boolean;
          overlapping_tag_names: string[];
        }> = [];
        for (const other of ruleGroups) {
          if (other.id === rg.id) continue;
          const otherTagIds = new Set((other.tags ?? []).map((t) => t.id));
          const shared = myTags.filter((t) => otherTagIds.has(t.id));
          if (shared.length > 0) {
            overlaps.push({
              rule_group_name: other.name,
              rule_group_active: !!other.active,
              overlapping_tag_names: shared.map((t) => t.name),
            });
          }
        }
        if (overlaps.length > 0) overlapByRgId.set(rg.id, overlaps);
      }
      const avatars: Avatar[] = avatarsR.status === "fulfilled" ? avatarsR.value : [];
      const voices: Voice[] = voicesR.status === "fulfilled" ? voicesR.value : [];
      const assetsRecent: Asset[] = assetsRecentR.status === "fulfilled" ? assetsRecentR.value : [];
      const postGroupsRecent: PostGroup[] =
        postGroupsRecentR.status === "fulfilled" ? postGroupsRecentR.value : [];
      const budgets = budgetsR.status === "fulfilled" ? budgetsR.value : null;

      // 5. Compute derived data.
      const connectedNetworks: SocialNetwork[] = Array.from(
        new Set(
          socialNetworks
            .map((n) => normalizeNetworkType(n.type ?? null))
            .filter((n): n is SocialNetwork => n !== null),
        ),
      );
      const compatMatrix = compatibilityFor(connectedNetworks);

      const hasBrandVoice = prompts.length > 0;
      const defaultsByNetwork: Record<string, string[]> = {};
      for (const p of prompts) {
        if (p.default) {
          (defaultsByNetwork[p.social_network_type] ??= []).push(p.name);
        }
      }
      // Networks that are connected but lack a brand voice prompt. Surface
      // these so the LLM knows which network-specific voices are still
      // missing AFTER the initial setup. Useful when the company connects a
      // new network later: the agent should propose extending the voice.
      const networksWithoutBrandVoice = connectedNetworks.filter(
        (net) => !(defaultsByNetwork[net]?.length),
      );

      // Brand Visual Identity state. Detect by parsing the BrandVisualIdentity
      // marker in Company.description. When absent we surface a proactive
      // proposal: setting up BVI before drafting upgrades image generations
      // from generic-AI to grounded-on-templates. See instructions Rule 8b.
      const parsedBvi = parseBrandIdentityFromDescription(
        companyResolved.description ?? null,
      );
      const hasBvi = parsedBvi.status === "ok";

      const imageVideoRemaining = budgets?.ai_image_and_video_budget.remaining ?? Number.POSITIVE_INFINITY;
      const followrPlusEnabled = budgets?.followr_plus_enabled ?? false;
      // Read company AI preferences so we can highlight the user-configured
      // default model in the catalog response (recommended_rank 0). The
      // image_model field may carry a stale id (e.g. "dall-e-3" left over
      // from an older version of the Followr UI). When it does, we strip it
      // from the prefs passed into annotateImageModels so no entry gets
      // promoted to rank 0 based on an invalid string, and we surface a
      // dedicated warning to the agent so the user can clean up the
      // preference from the Followr UI. Without this, downstream consumers
      // (ai-results, manufacture, avatars) leak the stale value to the AI
      // image API, which rejects the call with HTTP 422 "selected model is
      // invalid" the first time the user tries to generate.
      const rawCompanyPrefs = (companyResolved as Company & { ai_preferences?: AiPreferences }).ai_preferences;
      const rawImageModelPref = rawCompanyPrefs?.image_model ?? null;
      const sanitizedImageModelPref = sanitizeImageModelPref(rawImageModelPref);
      const imageModelPrefInvalid =
        rawImageModelPref !== null &&
        rawImageModelPref !== "" &&
        sanitizedImageModelPref === null;
      const companyPrefs: AiPreferences | undefined = rawCompanyPrefs
        ? imageModelPrefInvalid
          ? { ...rawCompanyPrefs, image_model: undefined }
          : rawCompanyPrefs
        : undefined;
      const videoModels = annotateVideoModels(imageVideoRemaining, followrPlusEnabled, companyPrefs);
      const imageModels = annotateImageModels(imageVideoRemaining, followrPlusEnabled, companyPrefs);
      const aiPreferencesValidation = imageModelPrefInvalid
        ? {
            image_model: {
              raw_value: rawImageModelPref,
              is_valid: false,
              reason: `"${rawImageModelPref}" is not a known image model id in the current Followr catalog. Likely a stale value persisted by an older version of the Followr UI.`,
              effective_fallback: "nano_banana_2",
              recommended_user_message:
                `Detecté que la marca tiene seteado como modelo de imagen default un identificador que ya no existe en Followr ("${rawImageModelPref}"). Lo ignoré para esta sesión y usé Google Nano Banana 2 como fallback. Recomiendo entrar a la UI de Followr (Company Settings → AI Images) y elegir uno de los modelos vigentes para que no vuelva a pasar.`,
            },
          }
        : null;

      // Industry cache + confirmation gate (rewritten 2026-05-26).
      //
      // Previous behavior: when no marker existed we called the fast keyword
      // heuristic (ensureIndustryClassified) and PERSISTED its guess. That
      // wrote bad data for minimalist landings (PipeLime SaaS misclassified
      // as local_business by keyword frequency), and downstream tools then
      // trusted the bad cache because the deep_research gate at
      // content-plan.ts:1917 only fires when no marker exists at all.
      //
      // New behavior: we ONLY use the cache when the marker carries the
      // :confirmed suffix (set by confirm_industry after the user agreed).
      // First-time companies get an industry_setup_proposal that tells the
      // agent to call deep_research first. Auto-detected markers (written
      // by deep_research without explicit confirmation) get an
      // industry_confirmation_required proposal that tells the agent to
      // present the auto result to the user before drafting.
      //
      // The auto_classify_industry input parameter is retained for backwards
      // compatibility but is now a no-op when true (default). When set to
      // false, the agent is signalling "I will drive industry myself, do not
      // emit proposals"; in that case we skip both proposals and let the
      // hard gate in draft_content_plan handle the unconfirmed state.
      const description = companyResolved.description ?? "";
      const cacheReadResult = readCachedIndustry(description);
      const cachedIndustry: {
        industry_id: string;
        cached_at: string;
        confirmed: boolean;
      } | null = cacheReadResult
        ? {
            industry_id: cacheReadResult.id,
            cached_at: cacheReadResult.cached_at,
            confirmed: cacheReadResult.confirmed,
          }
        : null;
      const emitIndustryProposals = auto_classify_industry !== false;
      const industrySetupProposal =
        emitIndustryProposals && cachedIndustry === null
          ? {
              severity: "clarification_required_before_draft" as const,
              instruction:
                "Antes de armar el plan, llamá deep_research(company_id) UNA SOLA VEZ. Esta llamada NO es solo para clasificar la industria: además extrae productos, fotos de catálogo, menu items, artículos, pillars de contenido, contactos y social links del sitio. Esa data se usa después para que las imágenes generadas se parezcan al catálogo real y los copies se anclen en lo que la marca realmente vende. Saltearla porque 'el usuario ya dijo SaaS' es un error: el usuario te dio la industria, pero te falta TODO el resto del contexto del sitio (productos, fotos reales, pillars, contactos). Una vez que deep_research vuelva, PRESENTALE al usuario el detected_industry junto con la lista de industrias disponibles y pedile confirmación. Si el usuario confirma o nombra exactamente la misma industria detectada, llamá confirm_industry con ese industry_id. Si el usuario dice otra cosa (ej: 'no, es Software B2C'), mapealo a la mejor industria del catálogo y llamá confirm_industry con ese id. NO empieces a draftear hasta tener un marker `:confirmed` en Company.description.",
              user_message:
                "Para armar un plan ajustado a tu marca voy a investigar tu sitio (saca productos, fotos de catálogo y ángulos de contenido reales, no inventados). Tarda 30 seg a 2 min, sin cargo. Después te muestro la industria detectada y vos confirmás antes de seguir.",
              available_industries: ALL_INDUSTRY_IDS.filter((id) => id !== "generic_business"),
              option_actions: [
                {
                  id: "run_deep_research",
                  label: "Investigar sitio y confirmar (única ruta recomendada)",
                  description:
                    "Llamá deep_research(company_id). Detecta industria + extrae catálogo / productos / artículos / menu / pillars del sitio. Cuando vuelva, presentale al user la industry detectada junto con available_industries y pedile confirmación. Luego confirm_industry({ company_id, industry_id }).",
                  next_tool: "deep_research",
                },
              ],
              skip_path_intentionally_omitted:
                "No existe una opción 'saltar deep_research y preguntar la industria directamente'. Esa puerta fue removida 2026-05-26 (real session PipeLime) porque agentes la tomaban cuando el usuario mencionaba la industria al pasar, perdiendo así la extracción del catálogo (productos, fotos, pillars) que es el VALOR principal de deep_research, no la clasificación. Si el usuario explícitamente dice 'no investigues el sitio, hacé algo genérico', el agente puede llamar prepare_content_plan_context con auto_classify_industry=false para suprimir este bloque y luego confirm_industry a mano. Esa es la única vía explícita de salida.",
            }
          : null;
      const industryConfirmationRequired =
        emitIndustryProposals && cachedIndustry !== null && cachedIndustry.confirmed === false
          ? {
              severity: "clarification_required_before_draft" as const,
              instruction: `Hay una industria cacheada en Company.description (${cachedIndustry.industry_id}, ${cachedIndustry.cached_at}) pero todavía no fue confirmada por el usuario. PRESENTALE al usuario qué industria fue detectada y pedile que confirme o corrija. Si el usuario confirma, llamá confirm_industry({ company_id, industry_id: "${cachedIndustry.industry_id}" }). Si el usuario menciona otra industria (texto libre, ej: 'no, es Software B2C'), mapealo a la mejor opción de available_industries y llamá confirm_industry con ese id. NO drafftees el plan hasta resolver esto.`,
              user_message: `Detecté que tu industria es "${cachedIndustry.industry_id}". ¿Es correcto o tu marca cae en otra categoría?`,
              detected_industry_id: cachedIndustry.industry_id,
              detected_at: cachedIndustry.cached_at,
              available_industries: ALL_INDUSTRY_IDS.filter((id) => id !== "generic_business"),
            }
          : null;

      // Derive recommended_video_strategy from the cached industry profile.
      // When the agent knows the industry, the profile.video_strategy block
      // says whether avatar or AI clip is the default for THIS kind of
      // business (source-of-truth lives in src/lib/industry-profiles/<id>.ts).
      // When industry is unknown, we leave this null and rely on the
      // deep_research blocker raised in draft_content_plan to force the
      // classification before the plan is built.
      const KNOWN_INDUSTRY_IDS = new Set<IndustryId>([
        "ecommerce_fashion", "ecommerce_general", "saas", "restaurant",
        "service_b2b", "education", "real_estate", "healthcare",
        "creative_agency", "local_business", "personal_brand", "news_media",
        "hotel_hospitality", "fitness_wellness", "events_organizer",
        "ngo_nonprofit", "generic_business",
      ]);
      let recommendedVideoStrategy:
        | {
            industry_id: IndustryId;
            display_name: string;
            default_video_kind: VideoStrategy["default_video_kind"];
            rationale_short: string;
            flip_concepts: string[];
            is_ambiguous: boolean;
          }
        | null = null;
      // Only derive the strategy when the industry is USER-CONFIRMED. An auto
      // marker without confirmation is treated as "not yet trusted": the
      // industry_confirmation_required proposal will force the agent to ask
      // the user before we let the planner dispatch on this profile.
      if (
        cachedIndustry &&
        cachedIndustry.confirmed &&
        KNOWN_INDUSTRY_IDS.has(cachedIndustry.industry_id as IndustryId)
      ) {
        const profile = getProfile(cachedIndustry.industry_id as IndustryId);
        recommendedVideoStrategy = {
          industry_id: profile.id,
          display_name: profile.display_name,
          default_video_kind: profile.video_strategy.default_video_kind,
          rationale_short: profile.video_strategy.rationale_short,
          flip_concepts: profile.video_strategy.flip_concepts,
          is_ambiguous: profile.video_strategy.is_ambiguous === true,
        };
      }

      // Avatar inventory snapshot. When the recommended_video_strategy says
      // avatar is the default for this industry AND the company has zero
      // avatars loaded, the planner cannot fulfill that recommendation. We
      // surface an avatar_setup_proposal at the same severity level as
      // brand_voice_setup_proposal and brand_visual_identity_setup_proposal:
      // clarification_required_before_draft. This is the analog to those
      // proposals (you should not start drafting until the gap is decided).
      const availableAvatarsCount = avatars.length;
      const needsAvatarProposal =
        recommendedVideoStrategy !== null &&
        recommendedVideoStrategy.default_video_kind === "ai_avatar_video" &&
        recommendedVideoStrategy.is_ambiguous === false &&
        availableAvatarsCount === 0;

      // 6. Persist the context snapshot for later validation by
      // draft_content_plan.
      const hasVisualStyleMarker =
        parseVisualStyleMarker(companyResolved.description ?? null) !== null;
      const ctx = createContext({
        company_id,
        networks_connected: connectedNetworks,
        brand_has_voice_prompt: hasBrandVoice,
        cached_industry_id: cachedIndustry ? cachedIndustry.industry_id : null,
        cached_industry_confirmed: cachedIndustry ? cachedIndustry.confirmed : false,
        has_visual_style_marker: hasVisualStyleMarker,
      });

      // 6b. Build clarifying_questions_v2: structured questions ready to be
      // mapped 1:1 to a host AskUserQuestion call. Two phases:
      //   - phase_1_foundational: brand voice / brand visual identity / avatar
      //     setup. These BLOCK the plan. They are asked alone in a single
      //     AskUserQuestion turn (never mixed with phase_2). Without these,
      //     downstream copies and visuals come out generic, which is the
      //     failure mode the user is paying us to avoid.
      //   - phase_2_plan_scope: window, frequency, theme, promo. Standard plan
      //     intent questions; asked after phase_1 is resolved (or skipped when
      //     empty).
      // pre_resolved_decisions: defaults that the agent must NOT ask. e.g.
      // language matches the brand language; networks_intent defaults to all
      // connected networks.
      // BVI setup ya no es phase1. El flow de assess/draft/execute fue
      // deprecado 2026-05-25. Las "foundational" questions que disparan gating
      // dura son brand voice, avatar (cuando la industry lo requiere), y
      // visual_style (cuando la company no tiene marker fijado).
      // El visual_style_setup_proposal vive en su propio block (más abajo)
      // con severity clarification_required_before_draft; el draft también
      // emite visual_style_missing como upfront_decision warning para que
      // si el agente saltea phase1 igual lo levante antes del summary.
      const hasMandatoryPhase1 =
        !hasBrandVoice || needsAvatarProposal || !hasVisualStyleMarker;

      const phase1Questions: Array<Record<string, unknown>> = [];

      if (!hasBrandVoice) {
        phase1Questions.push({
          id: "brand_voice_setup",
          phase: "foundational",
          blocks_plan_until_resolved: true,
          rationale_for_agent:
            "Company has no brand voice prompt loaded. Without it, every generated copy uses the platform default tone and the user notices immediately. Ask this BEFORE phase_2 scope questions; never bury it as a side-note.",
          ask_user_question_payload: {
            question:
              "Esta empresa todavía no tiene voz de marca cargada. Sin ella los copies salen con el tono default de Followr, más genéricos. ¿La armamos antes del plan?",
            header: "Voz de marca",
            options: [
              {
                label: "Sí, armarla ahora",
                description:
                  "Una sola llamada, deriva del brief de la empresa. Se aplica al plan automáticamente.",
              },
              {
                label: "Avanzar sin voz",
                description:
                  "Los copies van a usar el tono default, más genérico. Se puede agregar después.",
              },
            ],
          },
          option_actions: [
            {
              option_index: 0,
              next_action: "call_setup_tool",
              setup_tool: "create_brand_voice_for_company",
              setup_args_template: {
                company_id,
                name: `${companyResolved.name} brand voice`,
                default: true,
                prompt_preamble_from: "brand_voice_setup_proposal.suggested_create_prompt_seed.prompt_preamble",
              },
            },
            { option_index: 1, next_action: "proceed_to_next_phase_or_draft" },
          ],
        });
      }

      // brand_visual_identity_setup phase1 question REMOVIDA 2026-05-25.
      // Las tools assess/draft/execute_brand_visual_identity quedaron
      // deprecadas. Ese gate fue reemplazado por visual_style_setup abajo,
      // que cubre el caso con el flow nuevo de Creative Studio (detect →
      // confirm → marker).

      // visual_style_setup: agregado 2026-05-26 después del anti-pattern
      // PipeLime donde el agente ofreció el visual_style como aviso al pie
      // del plan. Mismo treatment que brand_voice_setup: phase_1, bloquea
      // el plan hasta resolverse, se mapea 1:1 a AskUserQuestion.
      // Detect cuesta 10-30 cr (image captions sobre 1 home + ~5 posts);
      // las otras opciones son gratis.
      if (!hasVisualStyleMarker) {
        phase1Questions.push({
          id: "visual_style_setup",
          phase: "foundational",
          blocks_plan_until_resolved: true,
          rationale_for_agent:
            "Company has no [visual_style:slug@date] marker on description. Without it, every image generated by execute_content_plan falls back to style_key='ai_decides' (the backend picks per generation), so the feed comes out in mixed styles. The marker is set by confirm_visual_style and read automatically by Creative Studio. Ask BEFORE phase_2 scope questions, same as brand_voice_setup.",
          ask_user_question_payload: {
            question:
              "Tu marca todavía no tiene un visual style fijado (Bold Typography, Minimalist Clean, etc.). Sin esto, cada imagen del plan puede salir en un estilo distinto y el feed se ve menos coherente. ¿Lo fijamos antes del plan?",
            header: "Estilo visual",
            options: [
              {
                label: "Sí, detectar de mi marca",
                description:
                  "Corro detección sobre tu sitio y posts recientes (~10-30 cr una sola vez) y te muestro el top 3. Vos elegís.",
              },
              {
                label: "Mostrame el catálogo",
                description:
                  "Te muestro los templates disponibles (3 a la vez) y elegís sin gastar créditos en detección.",
              },
              {
                label: "Avanzar sin fijar",
                description:
                  "Cada imagen del plan se genera con un estilo distinto (la AI decide). OK para test rápido o si después querés iterar.",
              },
            ],
          },
          option_actions: [
            {
              option_index: 0,
              next_action: "call_setup_tool",
              setup_tool: "detect_brand_visual_style",
              setup_args_template: { company_id },
            },
            {
              option_index: 1,
              next_action: "call_setup_tool",
              setup_tool: "propose_visual_style_options",
              setup_args_template: {},
            },
            { option_index: 2, next_action: "proceed_to_next_phase_or_draft" },
          ],
        });
      }

      if (needsAvatarProposal && recommendedVideoStrategy) {
        phase1Questions.push({
          id: "avatar_setup",
          phase: "foundational",
          blocks_plan_until_resolved: true,
          rationale_for_agent: `Industry profile (${recommendedVideoStrategy.display_name}) defaults to avatar videos for B2B trust signal, and company has zero avatars loaded. Without an avatar the videos fall back to AI clips (no human face / voice), which underperforms for this kind of brand. Ask BEFORE phase_2.`,
          ask_user_question_payload: {
            question: `Por el tipo de marca (${recommendedVideoStrategy.display_name}), los videos rinden mejor con un avatar (persona virtual hablando a cámara) que con animaciones genéricas. No tenés ninguno cargado. ¿Creamos uno antes del plan?`,
            header: "Avatar",
            options: [
              {
                label: "Sí, crear avatar",
                description:
                  "Genero un avatar para esta marca. Después los videos del plan lo van a usar por default.",
              },
              {
                label: "Avanzar sin avatar",
                description:
                  "Los videos del plan salen como AI clips puros (sin persona ni voz). OK para test rápido.",
              },
            ],
          },
          option_actions: [
            {
              option_index: 0,
              next_action: "call_setup_tool",
              setup_tool: "create_avatar_full_flow",
              setup_args_template: { company_id },
            },
            { option_index: 1, next_action: "proceed_to_next_phase_or_draft" },
          ],
        });
      }

      const phase2Questions: Array<Record<string, unknown>> = [
        {
          id: "time_window",
          phase: "scope",
          blocks_plan_until_resolved: true,
          rationale_for_agent:
            "Defines the window the plan covers. Ask in a SINGLE tap question; convert option_id to concrete YYYY-MM-DD start/end when calling draft_content_plan.",
          ask_user_question_payload: {
            question: "¿Qué ventana de días querés para el plan?",
            header: "Ventana",
            options: [
              {
                label: "Esta semana",
                description: "De lunes a domingo de la semana en curso.",
              },
              {
                label: "Próximos 7 días",
                description: "Desde mañana, durante 7 días corridos.",
              },
              {
                label: "Próximas 2 semanas",
                description: "Desde mañana, durante 14 días corridos.",
              },
            ],
          },
          option_actions: [
            { option_index: 0, next_action: "use_value", value: "this_week" },
            { option_index: 1, next_action: "use_value", value: "next_7_days" },
            { option_index: 2, next_action: "use_value", value: "next_14_days" },
          ],
        },
        {
          id: "posts_per_day",
          phase: "scope",
          blocks_plan_until_resolved: true,
          rationale_for_agent:
            "Cadence: how many PostGroups per day. Each PostGroup can fan out to multiple networks via sub_posts.",
          ask_user_question_payload: {
            question: "¿Cuántos posts por día?",
            header: "Frecuencia",
            options: [
              { label: "1 por día", description: "Cadencia más sostenible." },
              { label: "2 por día", description: "Más volumen, requiere más copies y assets." },
              { label: "3 por día", description: "Alta intensidad, recomendado solo para promo o launch." },
            ],
          },
          option_actions: [
            { option_index: 0, next_action: "use_value", value: 1 },
            { option_index: 1, next_action: "use_value", value: 2 },
            { option_index: 2, next_action: "use_value", value: 3 },
          ],
        },
        {
          id: "theme",
          phase: "scope",
          blocks_plan_until_resolved: true,
          rationale_for_agent:
            "Editorial axis the agent uses when picking concept_shared per plan_item.",
          ask_user_question_payload: {
            question: "¿Qué eje temático priorizamos?",
            header: "Eje",
            options: [
              {
                label: "Mix balanceado",
                description: "Producto / lifestyle / cultura distribuidos en la semana.",
              },
              { label: "Foco producto", description: "Mayormente features / catálogo." },
              { label: "Foco lifestyle", description: "Cultura, behind-the-scenes, comunidad." },
              { label: "Foco promo / lanzamiento", description: "Drive a una acción comercial concreta." },
            ],
          },
          option_actions: [
            { option_index: 0, next_action: "use_value", value: "mix" },
            { option_index: 1, next_action: "use_value", value: "product" },
            { option_index: 2, next_action: "use_value", value: "lifestyle" },
            { option_index: 3, next_action: "use_value", value: "promo" },
          ],
        },
        {
          id: "promo_context",
          phase: "scope",
          blocks_plan_until_resolved: true,
          rationale_for_agent:
            "Surfaces an active sale or launch the plan should ride. If yes, the agent asks a follow-up freeform for the details; if no, proceed.",
          ask_user_question_payload: {
            question: "¿Hay alguna promo o lanzamiento activo en esta ventana?",
            header: "Promo",
            options: [
              { label: "No hay promo", description: "Plan editorial estándar." },
              {
                label: "Sí, hay promo activa",
                description: "Voy a pedirte el detalle (qué es, fechas, CTA).",
              },
            ],
          },
          option_actions: [
            { option_index: 0, next_action: "use_value", value: { active: false } },
            {
              option_index: 1,
              next_action: "ask_follow_up_freeform",
              follow_up_question:
                "Contame en una línea qué promo o lanzamiento es, las fechas y la acción que querés que tome el usuario.",
            },
          ],
        },
      ];

      const preResolvedDecisions: Record<string, unknown> = {};
      const brandLanguage = companyResolved.language;
      if (brandLanguage) {
        preResolvedDecisions["language"] = {
          value: brandLanguage,
          confidence: "high",
          reason_es: `La marca está cargada en ${brandLanguage}. Los copies salen en ese idioma por default, salvo que el usuario pida explícitamente otro. NO preguntar.`,
        };
      }
      if (connectedNetworks.length > 0) {
        preResolvedDecisions["networks_intent"] = {
          value: connectedNetworks,
          confidence: "high",
          reason_es: `Default: usar todas las redes conectadas (${connectedNetworks.join(", ")}). Preguntar SOLO si el usuario quiere recortar; nunca preguntar como decisión obligatoria.`,
        };
      }
      if (me?.timezone) {
        preResolvedDecisions["timezone"] = {
          value: me.timezone,
          confidence: "high",
          reason_es: `Zona horaria del usuario. Aplicar a publish_at_time_local. NO preguntar.`,
        };
      }

      const tikTokOrYouTubeConnected =
        connectedNetworks.includes("tiktok") || connectedNetworks.includes("youtube");

      const clarifyingFlowInstructions = [
        "EXECUTION ORDER (read carefully):",
        "0. PRECONDITION CHECK. If you did NOT call get_company_creative_brief earlier in this conversation for this company, do that FIRST and then re-call prepare_content_plan_context. The brief carries the brand voice prompts per network, audience_types, tones, language and existing tags that you need to ground every plan_item. Without it you end up improvising audience and tone from the company description scrape, which silently overrides the user's explicit brand voice. Real failure mode (PostApprove 2026-05-23): the agent skipped get_company_creative_brief and ad-libbed 'audience: agencies, social media managers' from the description; it happened to match but only by luck.",
        "1. INDUSTRY CHECK. Inspect brand_context.cached_industry and brand_context.industry_setup_proposal / industry_confirmation_required. When cached_industry is non-null AND cached_industry.confirmed === true, proceed without any industry work. When industry_setup_proposal is present, call deep_research(company_id) first, then present its detected industry to the user with the available_industries list, then call confirm_industry({ company_id, industry_id }) with the user's choice (which can be the detected one OR a different one they prefer; map free-text answers like 'es Software B2C' to the closest entry in available_industries). When industry_confirmation_required is present (auto marker exists but not user-confirmed yet), skip deep_research, present the detected industry to the user with available_industries, and call confirm_industry with their choice. NEVER bypass these proposals: draft_content_plan rejects any plan attempt while the industry is unconfirmed.",
        "2. If phase_1_foundational has questions, ask THOSE in a SINGLE AskUserQuestion call this turn. NEVER mix phase_1 with phase_2 in the same turn. The phase_1 questions are blockers: the user picking 'avanzar sin' is acceptable, but you cannot skip the question itself.",
        "3. For each phase_1 question the user picks 'call_setup_tool' on, invoke option_actions[i].setup_tool with the suggested args (resolve the *_from references against the matching proposal block in this same _assistant_guidance). After every setup tool completes, re-call prepare_content_plan_context to refresh state, then continue.",
        "4. When phase_1 is empty OR fully resolved, ask phase_2_plan_scope in ONE AskUserQuestion call. There are 4 questions; AskUserQuestion supports up to 4, so submit them together.",
        "5. Treat pre_resolved_decisions as already decided. NEVER ask the user about these (language, networks_intent, timezone). Apply them as defaults when building plan_items[].",
        "6. After phase_2 answers come in, IMMEDIATELY call draft_content_plan with the structured plan_items[] you build. DO NOT propose the plan to the user in prose first. The summary_for_user that draft_content_plan returns is what you show the user, not your own table.",
        "7. ask_user_question_payload on each question is shaped to match the host's AskUserQuestion tool: copy question, header and options verbatim. Use option_actions to interpret what the user picked.",
        "8. If multiSelect is needed (e.g. user picks two themes at once), AskUserQuestion supports it but the default here is single-select. Keep single-select unless the user signals otherwise.",
      ].join("\n");

      const videoOnlyNetworksStrategy = tikTokOrYouTubeConnected
        ? {
            networks: connectedNetworks.filter((n) => n === "tiktok" || n === "youtube"),
            rule:
              "TikTok and YouTube only accept video assets. For every plan_item where the concept is prose-heavy (explainer, security, behind-the-scenes, manifesto), do NOT silently drop these networks. Either: (a) flip the asset_layout to single_video using a talking-head avatar script (when an avatar is available) or a short text-on-motion AI clip (when no avatar), keeping the same concept; or (b) explicitly drop the network for that plan_item and surface the trade-off to the user. Default recommendation: flip when an avatar exists, drop when no avatar AND the concept is too prose-heavy for an 8s AI clip.",
            decision_table: [
              {
                concept_kind: "product_showcase / launch / promo / lifestyle",
                recommendation: "flip to single_video (AI clip with product reference); covers IG/FB/TikTok/YT with one generation",
              },
              {
                concept_kind: "explainer / security / manifesto / long-form prose",
                recommendation:
                  "flip to single_video as avatar talking-head script when avatar available; drop TikTok/YT when no avatar and concept cannot be compressed to 8s motion",
              },
              {
                concept_kind: "carousel-native (step-by-step, comparison, listicle)",
                recommendation:
                  "TikTok and YouTube do NOT accept carousel. Either flip the same listicle into a text-on-motion AI clip with quick cuts, OR drop those networks for that specific plan_item",
              },
            ],
          }
        : null;

      // 7. Build response.
      const response: Record<string, unknown> = {
        context_id: ctx.context_id,
        expires_at_iso: new Date(ctx.expires_at_ms).toISOString(),
        user: me
          ? {
              id: me.id,
              name: me.name,
              email: me.email,
              timezone: me.timezone ?? null,
              language: me.language ?? null,
            }
          : null,
        company: sanitizeCompany(companyResolved),
        brand_context: {
          name: companyResolved.name,
          description: companyResolved.description ?? null,
          website_url: websiteUrl ?? null,
          website_summary: websiteSummary,
          language: companyResolved.language ?? null,
          country_iso_code: companyResolved.country_iso_code ?? null,
          tones: (companyResolved as Company & { tones?: string[] }).tones ?? null,
          ai_image_styles: (companyResolved as Company & { ai_image_styles?: string[] }).ai_image_styles ?? null,
          brand_voice_prompts: prompts.map((p) => ({
            id: p.id,
            name: p.name,
            social_network_type: p.social_network_type,
            is_default_for_network: p.default,
            prompt_preview: typeof p.prompt === "string" ? p.prompt.slice(0, 200) : null,
          })),
          voice_prompt_missing: !hasBrandVoice,
          voice_prompt_warning: hasBrandVoice
            ? null
            : "This company has no brand voice prompt loaded. Generated copies will use Followr default voice. Strongly consider creating one with create_prompt (preferably derived from the company's best-performing posts) BEFORE drafting a multi-post plan; the quality improvement is large.",
          default_brand_voice_prompts_by_network: defaultsByNetwork,
          cached_industry: cachedIndustry,
          industry_cache_warning:
            cachedIndustry === null
              ? "No industry classification cached on this company. Resolve the industry_setup_proposal below: call deep_research(company_id), present its detected_industry to the user along with available_industries, and persist the user's confirmed choice via confirm_industry. draft_content_plan will reject any attempt to build a plan while industry is unconfirmed."
              : cachedIndustry.confirmed === false
                ? `Industry "${cachedIndustry.industry_id}" is cached but not user-confirmed yet (marker written ${cachedIndustry.cached_at}). Resolve the industry_confirmation_required block below before drafting: present the detected industry to the user and call confirm_industry with the final id.`
                : null,
          industry_setup_proposal: industrySetupProposal,
          industry_confirmation_required: industryConfirmationRequired,
        },
        ai_budgets: budgets ?? {
          _error: "Could not load subscription balance. Budget gating below may be unreliable.",
        },
        networks_connected: socialNetworks.map((n) => ({
          internal_id: n.id,
          type: n.type ?? null,
          normalized_type: normalizeNetworkType(n.type ?? null),
          status: n.status ?? null,
        })),
        network_format_compatibility_matrix: compatMatrix,
        full_network_format_compatibility_matrix_reference: NETWORK_FORMAT_COMPATIBILITY,
        available_avatars: avatars.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? null,
          is_default: a.default ?? false,
          voice_id: a.voice_id ?? null,
        })),
        available_voices: voices.map((v) => ({
          id: v.id,
          name: v.name,
          provider: (v as Voice & { provider?: string }).provider ?? null,
        })),
        existing_tags: tags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color ?? null,
        })),
        existing_folders: folders.map((f) => ({
          id: f.id,
          name: f.name,
          color: f.color ?? null,
          parent_id: (f as Folder & { parent_id?: number | null }).parent_id ?? null,
        })),
        existing_brand_voice_prompts: prompts.map((p) => ({
          id: p.id,
          name: p.name,
          social_network_type: p.social_network_type,
          is_default_for_network: p.default,
        })),
        publishing_rule_groups: ruleGroups.map((rg) => {
          const enrich = enrichmentByRgId.get(rg.id) ?? { queue: [] as PostGroup[], history: [] as PostGroup[] };
          const slotsWeekly = (rg.rules ?? []).filter((r) => r.frequency === "weekly").length;
          const sortedHistoryDates = enrich.history
            .map((p) => (p as PostGroup & { publish_at?: string | null }).publish_at)
            .filter((d): d is string => !!d)
            .sort()
            .reverse();
          const lastPublishedAt = sortedHistoryDates[0] ?? null;
          const updatedAt = (rg as RuleGroup & { updated_at?: string }).updated_at ?? null;
          const pausedForDays = !rg.active && updatedAt
            ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / (24 * 60 * 60 * 1000))
            : null;
          return {
            id: rg.id,
            name: rg.name,
            description: (rg as RuleGroup & { description?: string | null }).description ?? null,
            active: rg.active,
            random_minutes: rg.random_minutes,
            posts_active_from:
              (rg as RuleGroup & { posts_active_from?: string | null }).posts_active_from ?? null,
            paused_for_days: pausedForDays,
            tags: (rg.tags ?? []).map((t) => ({
              id: t.id,
              name: t.name,
              color: (t as Tag & { color?: string | null }).color ?? null,
            })),
            slots: (rg.rules ?? []).map((r) => ({
              id: r.id,
              frequency: r.frequency,
              day_of_week: r.day_of_week,
              day_of_month: r.day_of_month,
              week_of_month: r.week_of_month,
              month: r.month,
              time_utc: r.time,
            })),
            slots_per_week: slotsWeekly,
            queue: {
              pending_count: enrich.queue.length,
              has_more: enrich.queue.length >= 15,
              weeks_of_runway:
                slotsWeekly > 0 ? Number((enrich.queue.length / slotsWeekly).toFixed(2)) : null,
              sample: enrich.queue.slice(0, 5).map((p) => ({
                id: p.id,
                title: (p as PostGroup & { title?: string | null }).title ?? null,
                topic: (p as PostGroup & { topic?: string | null }).topic ?? null,
              })),
            },
            history: {
              last_30d_published_count: enrich.history.length,
              has_more: enrich.history.length >= 30,
              last_published_at: lastPublishedAt,
              recent_posts: enrich.history.slice(0, 10).map((p) => ({
                id: p.id,
                title: (p as PostGroup & { title?: string | null }).title ?? null,
                topic: (p as PostGroup & { topic?: string | null }).topic ?? null,
                publish_at:
                  (p as PostGroup & { publish_at?: string | null }).publish_at ?? null,
              })),
            },
            overlap_with_other_autolists: overlapByRgId.get(rg.id) ?? [],
          };
        }),
        recent_assets: assetsRecent.slice(0, 30).map((a) => ({
          id: a.id,
          type: a.type,
          original_name: (a as Asset & { original_name?: string }).original_name ?? null,
          url: (a as Asset & { url?: string }).url ?? null,
        })),
        recent_published_post_groups: postGroupsRecent.slice(0, 10).map((g) => ({
          id: g.id,
          title: (g as PostGroup & { title?: string }).title ?? null,
          published_at: (g as PostGroup & { published_at?: string | null }).published_at ?? null,
          networks: ((g as PostGroup & { posts?: Array<{ social_network_type: string }> }).posts ?? []).map(
            (p) => p.social_network_type,
          ),
        })),
        available_video_models: videoModels,
        available_image_models: imageModels,
        ai_preferences_validation: aiPreferencesValidation,
        followr_capabilities_summary: FOLLOWR_CAPABILITIES_SUMMARY,
        _assistant_guidance: {
          ultrathink_required: PLANNING_STRATEGY.ultrathink_required,
          planning_strategy: PLANNING_STRATEGY,
          // EARLY BLOCKER: when zero social networks are connected on the
          // company, the entire content plan would produce drafts that the
          // user cannot publish until they connect networks. This used to
          // surface only as a per-sub_post warning AFTER the agent built
          // the whole plan, wasting tokens. Now we raise the alarm at
          // bootstrap so the agent can ask upfront: "abort and connect
          // networks first, or build drafts anyway?".
          no_networks_connected_blocker: connectedNetworks.length === 0
            ? {
                severity: "blocker_at_flow_start",
                user_message:
                  "Esta empresa todavía no tiene ninguna red social conectada en Followr. Si seguimos adelante, todo el plan va a quedar como drafts y no se va a poder publicar hasta que conectes al menos una red. ¿Querés (a) abortar el plan y conectar redes primero, o (b) armar drafts igual para revisarlos y publicar manualmente más adelante?",
                resolution_options: [
                  {
                    id: "abort_and_connect",
                    description:
                      "Detener el flujo. El usuario abre Followr (Settings > Social Networks) y conecta las redes objetivo. Una vez conectadas, re-llamar prepare_content_plan_context para que connected_networks deje de estar vacío.",
                  },
                  {
                    id: "proceed_as_drafts_only",
                    description:
                      "Continuar con el plan. Los PostGroups quedan como draft con auto_publish=true; cuando el usuario conecte las redes los aprobará desde la UI de Followr. Mencionar este flujo al usuario antes de invertir contexto.",
                  },
                ],
              }
            : null,
          // EARLY PROPOSAL: when the company lacks a Brand Visual Identity
          // AND the agent is about to plan content with AI imagery, surface
          // a proactive setup proposal. Without BVI the generated images
          // are generic (no curated templates, no palette grounding, no
          // anti-patterns). Setting it up takes 4 questions plus ~12 AI
          // template generations (~300 cr image-and-video budget).
          // The proposal is OPTIONAL: for a quick test plan, fast pivot, or
          // a brand that already has visuals it does not want to formalize
          // yet, the agent can proceed without BVI and mention the trade
          // off to the user. See Rule 8b for the decision framework.
          // brand_visual_identity_setup_proposal: REMOVIDO 2026-05-25.
          // El flow de assess/draft/execute del BVI quedó deprecado. La
          // configuración visual ahora se reduce a: (a) que el user llene
          // company.description + company.palettes + company.logo en Followr
          // UI (manual o via scrape automático al crear company), y (b)
          // correr detect_brand_visual_style + confirm_visual_style cuando
          // quiera fijar un visual style preferido. Sin BVI block, no hay
          // gate aquí.
          //
          // EARLY PROPOSAL: visual style preferido cacheado vía marker
          // [visual_style:slug@date] en company.description. Si no hay marker,
          // proponemos detect+confirm. Soft (no bloqueante).
          //
          // 2026-05-25: este bloque reemplaza al antiguo gate basado en
          // BVI.recommended_visual_style. Ahora usa el marker simple.
          visual_style_setup_proposal: hasVisualStyleMarker
            ? null
            : {
                severity: "clarification_required_before_draft",
                assistant_action_required:
                  "Antes de armar el plan, preguntale al user verbatim: '¿Querés que detecte tu estilo visual antes de armar el plan? Así todas las imágenes salen en el mismo template. Cuesta ~10-30 créditos (una sola vez), o podemos elegir uno del catálogo gratis.' NO empezar a draftear hasta tener respuesta del usuario. Si dice 'sí, detect': llamá detect_brand_visual_style → mostrar top 3 con previews → confirm_visual_style. Si dice 'mostrá catálogo': llamá propose_visual_style_options → mostrar 3 con previews → confirm_visual_style. Si dice 'avanzar sin fijar': proceder al draft mencionando que cada imagen del plan puede salir en estilo distinto. Equivalente a brand_voice_setup_proposal en severity: ambos son upfront decisions que bloquean el draft hasta resolverse.",
                user_message:
                  "Tu marca no tiene un visual style fijado todavía (Minimalist Clean, Bold Typography, etc.). Si avanzamos así, cada imagen del plan puede salir en un estilo distinto y el feed se ve menos coherente. Te propongo: corro detección visual sobre tu sitio + posts recientes (10-30 créditos, una vez) y fijamos tu template default. Después cada post del plan usa ese estilo. ¿Lo hago?",
                marker_present: false,
                resolution_options: [
                  {
                    id: "detect_and_confirm_first",
                    description:
                      "RECOMENDADO. Llamar detect_brand_visual_style(company_id) → recibir top 3 ranked → mostrar al user con preview_url images → confirm_visual_style(company_id, primary_slug=<pick>) → recién después draft_content_plan. Garantiza que las 7+ imágenes del plan salgan en el mismo estilo.",
                  },
                  {
                    id: "skip_and_use_ai_decides",
                    description:
                      "Saltar el detect. Cada imagen del plan se genera con style_key=ai_decides (el backend elige). El feed puede salir en estilos distintos. OK para iteración rápida cuando el user no quiere gastar 10-30 cr en setup.",
                  },
                  {
                    id: "pick_manually_from_catalog",
                    description:
                      "Llamar list_visual_styles para ver los 32 disponibles, dejar que el user elija uno a mano, después confirm_visual_style. Más control que detect, sin costo de imageCaption. Útil cuando el user ya sabe qué estilo quiere.",
                  },
                ],
              },
          // EARLY PROPOSAL: when the company lacks a brand voice prompt
          // AND the agent is about to plan multiple posts, the copy
          // quality drop is large enough to warrant offering the user a
          // one-call setup before the plan is built. This used to surface
          // as a warning AFTER the plan was drafted, which is too late
          // for the proposal to be useful.
          // The proposal expands to handle the multi-network case via
          // create_brand_voice_for_company (see prompts.ts), which loops
          // every connected network and creates one prompt per. When the
          // company already has some voices but is missing them for newly
          // connected networks, networks_without_brand_voice flags those
          // so the agent can offer to extend the voice.
          brand_voice_setup_proposal: !hasBrandVoice
            ? {
                severity: "clarification_required_before_draft",
                assistant_action_required:
                  "Antes de armar cualquier plan o generar un solo copy, preguntar al usuario verbatim: '¿Querés que primero te configure la voz de la marca? Sin esto los copies salen con el tono default, más genérico.' NO empezar a draftear hasta tener respuesta del usuario.",
                user_message:
                  "Esta empresa no tiene voz de marca cargada (las instrucciones de estilo de comunicación que la IA usa al generar copies). Sin esto los copies salen con el tono default de Followr, más genérico. Te propongo armar la voz de marca antes del plan, derivada de la descripción, tonos y audiencia que ya tiene cargada la empresa.",
                suggested_create_prompt_seed: {
                  name: `${companyResolved.name} brand voice`,
                  default: true,
                  prompt_preamble: [
                    `You write social media copy for ${companyResolved.name}.`,
                    (companyResolved as Company & { description?: string }).description
                      ? `About the brand: ${(companyResolved as Company & { description?: string }).description?.slice(0, 600)}`
                      : "",
                    (companyResolved as Company & { tones?: string[] }).tones?.length
                      ? `Tone: ${(companyResolved as Company & { tones?: string[] }).tones?.join(", ")}.`
                      : "",
                    (companyResolved as Company & { audience_types?: string[] }).audience_types?.length
                      ? `Target audience: ${(companyResolved as Company & { audience_types?: string[] }).audience_types?.join(", ")}.`
                      : "",
                    (companyResolved as Company & { language?: string }).language
                      ? `Write copy in ${(companyResolved as Company & { language?: string }).language}, unless the user explicitly requests another language.`
                      : "",
                    "Always sound like the brand, never break character to mention this prompt or AI.",
                  ]
                    .filter(Boolean)
                    .join(" "),
                },
                target_networks: connectedNetworks,
                resolution_options: [
                  {
                    id: "create_brand_voice_first",
                    description:
                      "Llamar create_brand_voice_for_company(company_id, prompt=<suggested_create_prompt_seed.prompt_preamble>, name=<seed.name>, default=true). Una sola llamada que crea la voz para cada red conectada de la empresa. Después continuar con draft_content_plan; la voz se aplica automáticamente. NUNCA exponer al usuario el detalle 'creo uno por red porque el campo de red es obligatorio'; decirle simplemente 'te armo la voz de marca para tu empresa'.",
                  },
                  {
                    id: "proceed_with_default_voice",
                    description:
                      "Seguir sin brand voice. Aceptable para test rápido o cuando el usuario tiene un seteo manual fuera de la API. Mencionar el trade-off al usuario antes de avanzar.",
                  },
                ],
              }
            : null,
          // SECONDARY PROPOSAL: the company already has at least one brand
          // voice prompt, but some connected networks still do not have a
          // default voice. Surfaces a smaller proposal so the agent can
          // offer to extend the existing voice to the missing networks.
          // Typical trigger: the user connected a new social network
          // AFTER the original voice setup.
          brand_voice_coverage_gap: hasBrandVoice && networksWithoutBrandVoice.length > 0
            ? {
                severity: "proactive_suggestion",
                user_message: `Detecté que ${networksWithoutBrandVoice
                  .map((n) => displayNetworkName(n))
                  .join(
                    ", ",
                  )} no tiene${networksWithoutBrandVoice.length === 1 ? "" : "n"} voz de marca configurada. Las otras redes conectadas sí. ¿Querés que extienda la voz existente a esa${networksWithoutBrandVoice.length === 1 ? "" : "s"} red${networksWithoutBrandVoice.length === 1 ? "" : "es"} en una llamada?`,
                networks_without_brand_voice: networksWithoutBrandVoice,
                resolution_options: [
                  {
                    id: "extend_brand_voice_to_missing_networks",
                    description:
                      "Llamar create_brand_voice_for_company con la voz existente como base, limitando target_networks a las redes que faltan. Para reusar el prompt actual, leer un existing_brand_voice_prompts del bloque y pasar su .prompt como input.",
                  },
                  {
                    id: "ignore_coverage_gap",
                    description:
                      "Seguir sin extender la voz. Las redes nuevas van a usar la voz default de Followr (más genérica) hasta que el usuario decida agregar una específica.",
                  },
                ],
              }
            : null,
          // EARLY PROPOSAL: the industry default video kind is avatar but
          // the company has zero avatars loaded. Without this proposal the
          // agent silently defaults to AI clip generation, which for
          // industries like SaaS / service_b2b / personal_brand /
          // healthcare / education / fitness_wellness / news_media /
          // local_business / ngo_nonprofit underperforms vs an avatar
          // because the audience needs a human voice/face. Surfaces at the
          // same severity as voice and BVI setup proposals: agent must ask
          // before drafting. The recommended_video_strategy block below
          // exposes which industry triggered this and the rationale.
          avatar_setup_proposal: needsAvatarProposal && recommendedVideoStrategy
            ? {
                severity: "clarification_required_before_draft",
                assistant_action_required:
                  "Antes de armar el plan o generar cualquier video, preguntar al usuario verbatim algo como: 'Por el tipo de marca, los videos rinden mucho mejor con un avatar (una persona virtual hablando a cámara) que con animaciones genéricas. No tenés ninguno cargado. ¿Querés que cree uno antes del plan?' NO empezar a draftear hasta tener respuesta del usuario.",
                user_message: `Por el tipo de marca (${recommendedVideoStrategy.display_name}), los videos rinden mejor con un avatar (persona virtual hablando a cámara) que con animaciones genéricas. ${recommendedVideoStrategy.rationale_short} No tenés ningún avatar cargado todavía. Te propongo crear uno antes del plan.`,
                industry_id: recommendedVideoStrategy.industry_id,
                default_video_kind: recommendedVideoStrategy.default_video_kind,
                resolution_options: [
                  {
                    id: "create_avatar_first",
                    description:
                      "Llamar create_avatar_full_flow con uno de sus 3 modos (text-to-image, reference photo of a real person, o use_image_directly_url para una foto ya enmarcada). Después continuar con draft_content_plan; los videos van a usar avatar_video por default cuando el concepto no esté en la lista de flip_concepts del profile.",
                  },
                  {
                    id: "proceed_with_ai_clip_anyway",
                    description:
                      "Seguir sin avatar. Los videos van a generarse como AI clips puros (animación cinematográfica, sin persona ni voz). Aceptable para tests rápidos o cuando el usuario explícitamente quiere ese estilo. Mencionar el trade-off al usuario antes de avanzar.",
                  },
                ],
              }
            : null,
          // INFORMATIONAL: the recommendation derived from the cached
          // industry profile. Always non-null when cached_industry is set
          // and the id matches a known profile. The agent reads
          // default_video_kind when planning video sub_posts, and reads
          // flip_concepts to decide when to use the OTHER kind for a
          // specific plan_item (e.g. SaaS defaults to avatar_video but
          // flips to ai_clip for a feature_reveal_visual concept).
          recommended_video_strategy: recommendedVideoStrategy
            ? {
                ...recommendedVideoStrategy,
                available_avatars_count: availableAvatarsCount,
                policy_summary:
                  recommendedVideoStrategy.default_video_kind === "ai_avatar_video"
                    ? `Default para esta industria: reel multi-escena con avatar hablando y subtítulos quemados. En schema: video_source.type = "ai_avatar_video" con scripts: string[]. AI clip puro (video_source.type = "ai_generate") SOLO si el concepto del plan_item está entre [${recommendedVideoStrategy.flip_concepts.join(", ")}]. Para CUALQUIER otro concepto, usar avatar_video es la opción correcta. NO usar "ai_avatar_lipsync" para cumplir esta policy: lipsync es una SHAPE DEGRADADA (single-scene, sin subtítulos, sin transiciones) reservada solo para cuando el usuario PIDE EXPLÍCITAMENTE "una toma simple sin subtítulos, una sola escena". Si estás pensando degradar a lipsync porque el budget se ve apretado, AVISALE AL USER PRIMERO con la opción multi-escena vs simple y el costo diferencial; nunca elijas lipsync silencioso (Rule 21 del system prompt). El auto-corrector del validator promueve lipsync → avatar_video cuando se filtra en plan_items para industrias con default avatar.`
                    : `Default para esta industria: AI clip. Video con avatar SOLO si el concepto del plan_item está entre [${recommendedVideoStrategy.flip_concepts.join(", ")}]. Para CUALQUIER otro concepto, usar AI clip es la opción correcta.`,
                enforcement_policy:
                  "ESTA NO ES UNA SUGERENCIA, ES LA POLICY DE LA INDUSTRIA. Cuando construyas plan_items[] para draft_content_plan, cada video sub_post debe respetar default_video_kind a menos que el concepto matchee uno de los flip_concepts listados arriba. Si construís un plan con 6 AI clips para una industria con default avatar (o viceversa), estás INVIRTIENDO la policy. El validador de draft_content_plan emite warning video_strategy_inverted en ese caso y ofrece resolution_options al user. Anti-pattern observado 2026-05-25 en PipeLime (local_business, default avatar): el agente armó 6 AI clips + 1 avatar cuando debió ser ~6 avatars + 1 AI clip basado en flip_concepts. Anti-pattern observado 2026-05-26 en PipeLime (saas, default avatar_video): el agente armó 5 piezas con ai_avatar_lipsync (single-scene, sin subtítulos) en lugar de ai_avatar_video (multi-escena con subtítulos), perdiendo la SHAPE que la policy define como default. El auto-corrector hoy promueve lipsync → avatar_video silenciosamente para industrias avatar-default, así que si vos elegís lipsync sin que el user lo pida explícito, igualmente termina como avatar_video.",
              }
            : {
                status: "industry_not_confirmed_yet",
                policy_summary:
                  "La industria todavía no está user-confirmada en Company.description. Resolvé primero industry_setup_proposal (si no hay marker) o industry_confirmation_required (si hay marker auto sin confirmar) antes de pensar en formats. El flujo es: deep_research → presentar al user con la lista available_industries → confirm_industry({ company_id, industry_id }) → re-llamar prepare_content_plan_context.",
              },
          recommended_video_model_policy:
            "available_video_models is pre-sorted: the FIRST entry is the recommended default for this company. ALWAYS pick the first entry, and ALWAYS use the model_id verbatim from the catalog. Do NOT invent model IDs from memory: Followr's canonical format uses dots for major.minor versions (veo_3.1_fast, veo_3.1, wan_2.2, seedance_1.1_light, seedance_2.0_fast, etc.) and no separator for hailuo (hailuo_02_standard, hailuo_02_premium). Underscored variants like veo_3_1_fast or hailuo_0_2_premium do NOT exist in Followr; the backend rejects them with HTTP 422 'selected model is invalid'. The sort accounts for company ai_preferences.video_model (rank 0 when set, with is_company_default: true) and for plan gating (when followr_plus_enabled is false, wan_2.2 is promoted to rank 0 with is_plan_fallback_default: true and every premium-bucket model is marked blocked_by_plan: true and affordable_at_default_duration: false). On accounts WITHOUT Followr Plus the ONLY accepted video model is wan_2.2; never recommend a premium-bucket model on those accounts. If the user explicitly asks for a premium model and followr_plus_enabled is false, explain the limitation and point them to followr.ai to activate the Followr Plus add-on.",
          recommended_image_model_policy:
            "available_image_models is pre-sorted by quality (best → worst). The FIRST entry is the recommended default (company ai_preferences.image_model when set, otherwise Google Nano Banana 2). When passing the value to a tool, ALWAYS use model_id verbatim from the catalog (the backend is strict about format: gpt-image-1-auto uses hyphens, flux_pro_1.1 uses a dot, wan_25_preview has no separator between 2 and 5, recraftv3 is one word). When TALKING TO THE USER, use the human display_name (Google Nano Banana 2, OpenAI GPT Image 2, Google Imagen 4 Fast, etc.) and the quality positioning from recommended_for; never quote the model_id, never quote 'premium bucket' or HTTP error codes.\n\nQUALITY LADDER (Followr team ranking, all model_ids verified against backend on 2026-05-22, best → worst):\n  1. Google Nano Banana 2 (default, balanced, 25 cr)\n  2. OpenAI GPT Image 2 (flagship, 70 cr)\n  3. Google Nano Banana (12 cr, high tier just below GPT Image 2)\n  4. Google Imagen 4 (12 cr)\n  5. Google Imagen 4 Fast (6 cr)\n  6. GPT Image (10 cr, older OpenAI)\n  7. Ideogram V3 (18 cr, use when the image needs legible baked-in text)\n  8. Wan 2.5 Preview (15 cr)\n  9. Fal Flux Pro 1.1 (12 cr, Flux aesthetic)\n  10. Fal Flux.1 Dev (8 cr)\n  11. Seedream V4 (10 cr)\n  12. Recraft v3 - Digital (3 cr, flat illustration style)\n  Z-Image Turbo (2 cr, fallback, lowest quality)\n\nAVAILABLE ON REQUEST (not in default ladder, but still callable): Google Nano Banana Pro (45 cr, marked 'best' in the Followr UI but excluded from the user's explicit quality ranking) and Fal Flux Pro Kontext (12 cr, Kontext capability variant). Surface these only when the user specifically asks for them.\n\nTREAT EVERY PIECE EQUALLY. Do NOT auto-upgrade the image model for posts that look 'important' or 'hero' or 'launch'. The default model applies uniformly across the whole plan; users explicitly opt-in to an upgrade via update_content_plan when they want a specific piece in a different tier. Do NOT silently swap to a model with WORSE quality just because the cost is lower (anti-pattern from PostApprove 2026-05-22: suggesting 'Fal Flux Pro 1.1 (12 cr)' for a piece when it actually ranks BELOW Nano Banana 2 in raw quality).\n\nPLAN GATING: on accounts WITHOUT followr_plus_enabled the ONLY accepted image models are Google Nano Banana 2 and Z-Image Turbo; every other entry above is premium and the backend rejects them. If the user explicitly asks for a premium model on a non-Plus account, translate the limitation to plain language (without quoting field names or HTTP codes) and offer Google Nano Banana 2 as the alternative.",
          website_grounding_strategy:
            "brand_context.website_summary is a SHALLOW metadata scrape (title, meta description, og:* tags, top headings). It does NOT contain product image URLs. When the company has a product website AND the plan involves product imagery (fashion, beauty, food, retail, packaging), STRONGLY CONSIDER calling deep_research(company_id) BEFORE draft_content_plan to retrieve real product URLs and image URLs. Use the resulting image URLs as reference_image_url on each ai_generate source so the generated assets resemble the actual brand catalog instead of generic AI imaginings. If you skip this step on a product-heavy brand, mention it explicitly to the user so they can opt in.",
          per_item_preview_strategy:
            "Plan size playbook for confirmation flows. NEVER decide the detail level alone: always ASK the user first which view they want, presenting 2-3 options sized to the plan. Then act on the answer. Plan-size defaults to offer:\n(1) 1-3 items: surface summary_for_user, then ask 'Te muestro el detalle completo de cada uno (copy + descripción de cada imagen y video), o te alcanza con el resumen y avanzamos?'. If user picks detail, call preview_plan_item per item.\n(2) 4-7 items: surface summary_for_user, then ask 'Querés (a) ver el detalle completo de los 5, (b) que te muestre solo uno representativo y aprobás todos juntos, o (c) avanzamos con el resumen?'. Use preview_plan_item only on the chosen subset.\n(3) 8-15 items: surface summary_for_user, then ask 'Es un plan grande. Te lo (a) agrupo por día y vamos día por día, (b) te muestro 2-3 representativos (uno por concept type) y aprobás todo de una, (c) te dejo el resumen y avanzamos?'. Group by date or by concept_shared keyword.\n(4) 16+ items: surface summary_for_user, then ask 'Plan extenso. Para no abrumarte, te propongo (a) spot-check de 2-3 representativos antes de aprobar todo, (b) agrupar por semana y aprobar por semana, (c) avanzar con el resumen tal cual?'. Default recommendation: option (a) for product-heavy industries, (b) for cadence-based plans.\nNEVER dump 30 detailed previews in a row - it is unusable. NEVER pick the view yourself without asking.",
          industry_grounding_strategy:
            "brand_context.cached_industry is only TRUSTED for planning when cached_industry.confirmed === true (a user explicitly confirmed the industry via confirm_industry). When cached_industry is null OR confirmed=false, resolve the corresponding proposal (industry_setup_proposal or industry_confirmation_required) BEFORE you draft anything. The proposals carry available_industries (the full catalog) so you can present the options to the user if they want to override the auto-detection. Once industry is :confirmed, the recommended_video_strategy and avatar_setup_proposal will populate accordingly on the NEXT call to this tool. For brands with rich catalogs you want to ground on (fashion, beauty, food, retail, real estate), deep_research(company_id) already returns product image URLs and structured catalog data; pass those URLs as reference_image_url on each ai_generate source so the generated assets resemble the actual brand catalog instead of generic AI imaginings.",
          autolist_reasoning_strategy:
            "publishing_rule_groups contains every Autopilot autolist with rich signals. Before proposing a content plan, REASON over each autolist using these inputs (NO regex, NO keyword matching: use full LLM judgment):\n" +
            "- tags[].name + history.recent_posts[].topic + history.recent_posts[].title → infer the theme of the autolist in 1-2 sentences. If history is empty, infer from tag names + brand voice (lower confidence).\n" +
            "- history.recent_posts → infer tone (formal / informal / playful / etc.) and whether content is evergreen vs seasonal (Christmas, summer sale, Black Friday, back-to-school, etc.). NEVER use regex to detect seasonality; read the posts.\n" +
            "- queue.weeks_of_runway → health: <1 week = starving (feed urgently), 1-4 = healthy, >8 = oversaturated, 0 with active=true and no recent_posts = zombie.\n" +
            "- history.last_published_at older than 60 days while active=true → zombie autolist (was set up but unused).\n" +
            "- overlap_with_other_autolists → if a tag is in TWO ACTIVE rule groups, that's a surprise (backend usually rejects); flag for the user.\n" +
            "- paused_for_days → if a paused autolist has been paused for months, consider proposing delete (or leave alone if recent).\n" +
            "Then, based on (a) the user's target period and intent and (b) each autolist's inferred theme + temporal relevance + health, recommend actions per autolist: feed / pause / activate / delete / merge / leave_alone. ALWAYS surface autolists that are out-of-season for the target period (e.g. 'Navidad' when planning June) AND skip them from the default plan, BUT mention them so the user knows you noticed. NEVER propose alimentar an autolist whose theme doesn't fit the period.\n" +
            "Tools available for action: create_autolist (new with optional inline tag creation), update_rule_group (rename, toggle active, swap tags via REPLACE semantics on tags_ids), create_rule / delete_rule (edit slots; remember the UI deletes-and-recreates instead of PUT), delete_rule_group (destructive, cascade to rules), create_tag / find_or_create_tag / delete_tag for tag housekeeping. Backend CONSTRAINT: a tag may belong to at most ONE active rule group at a time; preflight by inspecting publishing_rule_groups overlap_with_other_autolists before activating.\n" +
            "USER-FACING FLOW: max 1 question before proposing a concrete plan. Show the autolist status snapshot, your recommended actions, and a default proposal (e.g. 'Feed Lifestile with 12 posts over 4 weeks, pause out-of-season Navidad, leave Promo alone'). Confirm verbatim before any destructive or active-toggle action.",
          // CANONICAL clarification surface (added 2026-05-23). Replaces the
          // pair (required_user_clarifications + user_clarification_template_es)
          // which is kept below for backwards compatibility but should not be
          // used by new agent versions. The block below is ready to be mapped
          // 1:1 onto a host AskUserQuestion call. Two phases, with the
          // foundational phase being a hard pause: brand voice, BVI and avatar
          // setup gate the plan when the company lacks them.
          clarifying_questions_v2: {
            phase_1_foundational: phase1Questions,
            phase_2_plan_scope: phase2Questions,
            pre_resolved_decisions: preResolvedDecisions,
            flow_instructions: clarifyingFlowInstructions,
          },
          // Hint about how to handle TikTok / YouTube when the plan includes
          // them. Without this, the agent silently drops these networks for
          // prose-heavy concepts (real failure mode seen 2026-05-23, see
          // PostApprove plan). Surfaces when at least one of those is
          // connected; null otherwise.
          video_only_networks_strategy: videoOnlyNetworksStrategy,
          next_step:
            industrySetupProposal !== null
              ? "resolve_industry_setup_proposal_first"
              : industryConfirmationRequired !== null
                ? "resolve_industry_confirmation_required_first"
                : hasMandatoryPhase1
                  ? "ask_phase_1_foundational_only_this_turn"
                  : "ask_phase_2_plan_scope_then_draft_directly",
          // DEPRECATED (2026-05-23): kept for backwards compatibility with
          // agents that read the old fields. New agents should consume
          // clarifying_questions_v2 above. These two will be removed in a
          // future version.
          required_user_clarifications: [
            "time_window (start and end dates, default: the week starting next Monday)",
            "posts_per_day (default: 1)",
            "networks_intent (default: all networks listed in networks_connected)",
            "theme (mix of product / lifestyle / promo, or a specific concept)",
            "promo_context (if any active sale, launch, seasonal campaign)",
            "brand_voice_creation_choice (only if voice_prompt_missing is true: create now from best performers, or proceed with default)",
          ],
          user_clarification_template_es:
            "Antes de armar el plan necesito:\n- Qué ventana de días (default: la semana que arranca el próximo lunes).\n- Cuántos posts por día (default: 1).\n- Qué redes usar (las conectadas son: <network list>). Aviso al pasar: TikTok y YouTube solo aceptan video, así que cada item con esas redes necesita asset de video.\n- Theme: mix producto + lifestyle, o algo específico.\n- Hay promo o lanzamiento activo esta semana?\n[Si voice_prompt_missing es true:] La empresa no tiene brand voice cargado. Lo creo desde sus posts que mejor performaron antes de armar el plan?",
          partial_failures: {
            user: meR.status === "rejected",
            networks: socialNetworksR.status === "rejected",
            prompts: promptsR.status === "rejected",
            tags: tagsR.status === "rejected",
            folders: foldersR.status === "rejected",
            rule_groups: ruleGroupsR.status === "rejected",
            avatars: avatarsR.status === "rejected",
            voices: voicesR.status === "rejected",
            assets: assetsRecentR.status === "rejected",
            recent_post_groups: postGroupsRecentR.status === "rejected",
            budgets: budgetsR.status === "rejected",
            website_summary: include_website_summary && websiteUrl ? websiteSummary === null : false,
          },
          ...(disambiguation
            ? {
                multiple_company_matches: disambiguation.map((c) => ({ id: c.id, name: c.name })),
                disambiguation_required:
                  "More than one company matched the name fragment. Ask the user to pick by exact name and re-call this tool with that exact name (or the numeric id) to anchor the rest of the planning.",
              }
            : {}),
        },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // draft_content_plan
  // ────────────────────────────────────────────────────────────────────────

  const SocialNetworkEnum = z.enum([
    "instagram",
    "tiktok",
    "facebook",
    "linkedin",
    "x",
    "pinterest",
    "threads",
    "youtube",
    "bluesky",
  ]);

  const ProductTypeEnum = z.enum(["feed", "reel", "story", "short", "long_video"]);
  const AssetLayoutEnum = z.enum([
    "single_image",
    "carousel_images",
    "single_video",
    "carousel_mixed",
    "single_gif",
  ]);

  const AssetSourceUrlSchema = z.object({
    type: z.literal("url"),
    url: z.string().url(),
  });
  const AssetSourceAssetIdSchema = z.object({
    type: z.literal("asset_id"),
    id: z.number().int().positive(),
  });
  const AssetSourceAiImageSchema = z.object({
    type: z.literal("ai_generate"),
    prompt: z.string().min(1).max(2000),
    reference_image_url: z.string().url().optional().describe(
      "Legacy single-reference field. Prefer reference_image_urls for new code.",
    ),
    reference_image_urls: z
      .array(z.string().url())
      .max(5)
      .optional()
      .describe(
        "Up to 5 reference images passed alongside the prompt as image-to-image guidance. Useful for keeping subject / style continuity (logo + hero + recent post). The resolver auto-injects brand reference URLs from the BrandVisualIdentity when use_brand_visual_identity is true; explicit URLs here are MERGED with brand auto-refs, capped at 5 total. The fingerprint cache includes this list, so refs that differ produce distinct generations even when the prompt is identical.",
      ),
    model: z.string().optional(),
    aspect_ratio: z
      .enum(["1:1", "4:3", "16:9", "3:4", "9:16"])
      .optional()
      .describe(
        "Output aspect ratio for the AI image. When omitted, the platform falls back to the company's ai_preferences.image_aspect_ratio. Recommended per-network defaults: LinkedIn feed = 1.91:1 closest match is 16:9 (otherwise 1:1); LinkedIn carrusel = 1:1; Instagram feed/carousel = 1:1 (4:5 if you want vertical, choose 3:4 here as the closest enum value); Instagram Reel / Story = 9:16; TikTok / YouTube Short = 9:16; YouTube long = 16:9; Twitter = 16:9 or 1:1; Pinterest = 3:4 vertical. PREFER differentiating by aspect_ratio (structural) over differentiating by adjectives in the prompt (decorative). Two near-identical prompts that only differ in style words will produce near-identical outputs and burn credits for zero differentiation.",
      ),
    shared_concept_key: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "Optional dedupe hint. When two AssetSourceAiImage sources within the same plan_item share the same shared_concept_key, the resolver guarantees ONE generation and reuses the asset across all sub_posts that reference that key. Use this when the cover or a step slide is the same concept across networks (covers, step illustrations, CTA cards). Without this key, dedupe falls back to exact prompt-equality, which silently misses near-duplicates.",
      ),
    use_brand_visual_identity: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "When true (default), the resolver auto-injects this company's BrandVisualIdentity: appends the brief + palette + typography + anti-patterns to the prompt, AND adds 3-5 tagged template/element assets as reference_image_urls. Set false ONLY when generating fresh untouched content (anti-pattern examples, brand-agnostic mockups). No-op if the company has no brand identity configured.",
      ),
    inspired_by_brand: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Optional aspirational brand name (e.g. 'Stripe', 'Notion') to fetch one extra reference from at execute time. Use sparingly; each ref dilutes the brand's own identity. Reserved for forward compat: in this version the field is accepted but not yet consumed by the resolver (tracked in TODO_V2.md).",
      ),
    use_creative_studio: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "When true (default), routes this image generation through Creative Studio (POST /api/companies/{id}/creative). Benefits: design system de 1850 chars enriquecido, style_key del visual_style marker cacheado, logo + colors auto-injected, copy text generada por text AI interno. Set false ONLY when a non-Creative-Studio model is required (recraftv3 for flat illustration, flux_pro for Flux aesthetic, ideogram_v3 for legible baked text, gpt-image-2 for flagship quality). Creative Studio currently supports nano_banana_2 (default 25 cr) and nano_banana_pro (45 cr). When false, the legacy /api/aiResults/image path runs with full model flexibility.",
      ),
  });
  const AssetSourceAiVideoSchema = z.object({
    type: z.literal("ai_generate"),
    model: z.string().min(1),
    prompt: z.string().min(1).max(2000).describe(
      "Single-scene visual prompt. The model produces ONE ~8-second clip; do NOT describe sequences with multiple cuts or multiple products. If the user wants to showcase several variants in one video, use carousel_images instead or split into multi-scene generate_avatar_video. See PLANNING_STRATEGY.video_reference_constraint.",
    ),
    reference_image_url: z.string().url().optional().describe(
      "Single reference frame for image-to-video. EXACTLY ONE URL. There is no multi-image composite mode: if the prompt mentions multiple distinct products or variants, the model will invent the ones not in this single reference (hallucination). Plan a carousel of images instead when multiple items must be shown faithfully.",
    ),
    duration_seconds: z.number().positive().max(60).default(8),
  });
  const AssetSourceAvatarLipsyncSchema = z.object({
    type: z.literal("ai_avatar_lipsync"),
    script: z.string().min(1).max(500),
    avatar_id: z.number().int().positive(),
  });
  const AssetSourceAvatarVideoSchema = z.object({
    type: z.literal("ai_avatar_video"),
    scripts: z.array(z.string().min(1).max(500)).min(1).max(10),
    avatar_id: z.number().int().positive(),
    generate_backgrounds: z.boolean().optional(),
  });

  const AssetsStrategySchema = z.object({
    image_source: z
      .union([AssetSourceUrlSchema, AssetSourceAssetIdSchema, AssetSourceAiImageSchema])
      .optional(),
    carousel_sources: z
      .array(z.union([AssetSourceUrlSchema, AssetSourceAssetIdSchema, AssetSourceAiImageSchema]))
      .min(2)
      .max(20)
      .optional()
      .describe(
        "Ordered list of carousel slides. Array position equals display order in the published carousel: index 0 is the cover, the last index is the closing slide. The order is preserved end-to-end (validator, resolver, execute_content_plan, create_post). Plan accordingly: cover -> steps in numeric order -> CTA. NEVER assume the platform re-sorts; it does not.",
      ),
    video_source: z
      .union([
        AssetSourceUrlSchema,
        AssetSourceAssetIdSchema,
        AssetSourceAiVideoSchema,
        AssetSourceAvatarLipsyncSchema,
        AssetSourceAvatarVideoSchema,
      ])
      .optional(),
  });

  const SubPostSchema = z.object({
    social_network: SocialNetworkEnum,
    product_type: ProductTypeEnum,
    asset_layout: AssetLayoutEnum,
    assets_strategy: AssetsStrategySchema,
    caption_concept: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "INTERNAL DIRECTIVE. Short brief that captures intent of the copy: hook, key points, tone hints, CTA, length target. This field is your reasoning trace, NOT the published copy. The user does NOT see it (unless copy_draft is empty, in which case it falls back to this string verbatim as a last resort). Always pair this with copy_draft when you have the conversational context.",
      ),
    copy_draft: z
      .string()
      .min(1)
      .max(3000)
      .optional()
      .describe(
        "FINAL COPY in the post's language, ready to publish. The agent SHOULD write this during draft_content_plan when running inside an interactive session, using brand_context (tones, audience, language, brand_voice_prompts) + the user's stated intent + the network's format constraints. execute_content_plan persists this string verbatim as the post description. Leave it undefined ONLY for non-interactive flows (scheduled cron, autonomous loops) where you want Followr's generate_text to fill it server-side at execute time using caption_concept as the prompt. Length guidelines per network: LinkedIn feed 100-200 words; Instagram feed 100-150 words + 3-8 hashtags; X/Twitter <=280 chars; TikTok caption 50-150 chars; Threads <=500 chars. Match the language declared in user_answers.language (default = company.language).",
      ),
    tags: z.array(z.string()).optional(),
  });

  const PlanItemSchema = z.object({
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9\-_]+$/i, "slug must be alphanumeric with - or _"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
    publish_at_time_local: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "expected HH:mm (24h)"),
    timezone: z.string().min(1).max(60),
    concept_shared: z.string().min(1).max(500),
    rationale: z.string().min(1).max(1000),
    paired_with: z.array(z.string().min(1).max(80)).optional(),
    sub_posts: z.array(SubPostSchema).min(1).max(10),
  });

  server.registerTool(
    "draft_content_plan",
    {
      annotations: MUTATION_IDEMPOTENT,
      title: "Validate a structured content plan and persist it for review before execution",
      description: `Take a fully-structured plan_items array (each plan_item = one PostGroup with one or more per-network sub_posts) and validate it against the connected networks, per-network specs, asset layout compatibility, carousel limits and the user's current AI budget. On success, persists the plan in session memory with a plan_id that the user can later approve via execute_content_plan.

EVERY sub_post must have BOTH caption_concept (your editorial brief) AND copy_draft (the publication-ready text) when running interactively. caption_concept is your reasoning trace; copy_draft is what the user actually sees in Followr. If you omit copy_draft, execute_content_plan falls back to Followr's generate_text using caption_concept as the brief (path B); the fallback works but produces more generic copy than a Claude-written draft. See PLANNING_STRATEGY.copy_drafting_principle for length and hashtag guidance per network. The 2026-05-21 PostApprove audit shipped 10 drafts where the directive text leaked into the post body as the visible copy because copy_draft did not exist yet; this field is what prevents that failure mode.

For AI image generation, when two sub_posts in the same plan_item need conceptually the same asset (cover, step illustration, CTA), set shared_concept_key on BOTH AssetSourceAiImage refs so the resolver collapses them to ONE generation. See PLANNING_STRATEGY.image_reuse_principle. The validator flags near-duplicate prompts (>=85% similar) within the same plan_item as a non-blocking warning with merge_with_shared_concept_key as the recommended resolution.

PRECONDITION: must have called prepare_content_plan_context first and pass its context_id here. The context anchors the company, the networks connected and the budget snapshot. If the context_id expired (2h TTL), re-call prepare_content_plan_context.

WHAT GETS VALIDATED:
- Each sub_post: social_network + product_type + asset_layout is a legal combination per the compatibility matrix. TikTok feed image is rejected. Instagram Reel carousel is rejected. Twitter carousel of 5 is rejected (max 4). Etc.
- Each sub_post: asset_layout matches the assets_strategy shape. single_image requires image_source; carousel_images requires carousel_sources (2 to N per network); single_video requires video_source. Mismatches block.
- Cross-items: within the same (date, publish_at_time_local) slot, the union of social_network values must be unique. Posting to Instagram twice at the same time triggers a blocker with resolution_options (consolidate, drop, different_time).
- Budget: estimated total cost of all AI generations (video clips + AI images) must fit ai_image_and_video_budget.remaining. Otherwise blocker with breakdown.
- Soft warnings (NON-blocking): rationale that suggests multiple items (carousel, comparativa, N looks, comparativa) but asset_layout is single_image. Brand voice missing. Network not connected on the company.

OUTPUT: plan_id (session-only, lost on server restart), a summary table for the user (display_name format), totals (counts + estimated cost + budget after), warnings (NON-blocking, for the user to read), blockers (BLOCKING, must be resolved before this plan can execute) with concrete resolution_options. If blockers are present, the plan is still persisted as draft so update_content_plan can fix individual fields without re-sending the whole structure.

THIS TOOL DOES NOT GENERATE OR UPLOAD ANYTHING. It is pure validation + persistence. Costs nothing.

MUTATION but IDEMPOTENT for the same input: re-calling with the same context_id and the same plan_items array returns a new plan_id pointing to the same content. No external side effects in Followr.

DO NOT PROPOSE THE PLAN IN PROSE BEFORE CALLING THIS TOOL. After the user answers the clarifying questions (clarifying_questions_v2.phase_2_plan_scope), build plan_items[] internally and call this tool DIRECTLY. The summary_for_user it returns is what you show the user, never your own prose table or "te propongo este plan: lun X, mar Y, ...". Surfacing a prose plan before validation creates two failure modes: (1) the user approves something the validator will then reject (carousel exceeding network limit, network duplicate slot, budget exhaustion); (2) the user fatigues during an extra confirmation turn and the conversation dies before draft is called. Real failure mode observed 2026-05-23 (PostApprove session, share id 5e1b6ec4): the agent built a 7-day prose table, the user never replied, draft_content_plan was never called.

AFTER THIS RETURNS: show summary_for_user verbatim, mention the cost (totals.estimated_total_credits_cost) and remaining budget (totals.budget_remaining_after_execution) in natural language, list any warnings (warnings[].user_facing_message), and ask for explicit approval. ONLY THEN call execute_content_plan(plan_id, confirm: true). If the user wants changes, call update_content_plan(plan_id, changes) instead.`,
      inputSchema: {
        context_id: z.string().min(1),
        time_window: z.object({
          start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        user_answers: z
          .object({
            posts_per_day: z.number().int().positive().max(20).optional(),
            networks_intent: z.array(SocialNetworkEnum).optional(),
            theme: z.string().max(500).optional(),
            promo_context: z.string().max(500).optional(),
            language: z
              .string()
              .min(2)
              .max(10)
              .optional()
              .describe(
                "ISO-like language tag for ALL copy_draft strings and AI text generations (e.g. 'es', 'en', 'es-AR', 'pt-BR'). When omitted, the platform defaults to company.language. The validator surfaces a warning if any copy_draft is in a different language than the declared one. Use this to disambiguate when the company's language setting doesn't match the audience (e.g. company language is en but the audience is LATAM => set language='es-LA' or 'es-AR').",
              ),
            hashtags_policy: z
              .enum(["auto", "off"])
              .optional()
              .describe(
                "Auto-include hashtags policy. 'auto' (default) means each network's copy_draft includes its typical hashtag count: Instagram 5-8, LinkedIn 3-5, X 1-3, TikTok 3-5, Threads 0-3. 'off' suppresses hashtags entirely. Past behavior generated hashtags only on Instagram; this field makes the cross-network expectation explicit so LinkedIn copy doesn't end up barren.",
              ),
          })
          .optional(),
        plan_items: z.array(PlanItemSchema).min(1).max(60),
        use_brand_voice: z.boolean().optional().default(true),
        auto_publish_schedule: z
          .object({
            timezone: z.string().min(1),
            time_per_day: z.string().regex(/^\d{2}:\d{2}$/),
          })
          .optional(),
      },
    },
    async (input) => {
      // 1. Validate context.
      const ctx = getContext(input.context_id);
      if (!ctx) {
        return toolError({
          reason: "context_id_invalid_or_expired",
          user_message:
            "El context de planning expiró o no es válido. Llamá a prepare_content_plan_context de nuevo para refrescar el contexto y reintentá.",
          suggested_actions: [
            {
              tool: "prepare_content_plan_context",
              rationale: "Re-load context with current budget and network state.",
            },
          ],
          blocking: true,
        });
      }

      // 1b. Industry classification gate. Two stages:
      //   (i)  No marker at all on Company.description → run deep_research,
      //        ask user, then confirm_industry.
      //   (ii) Marker present but not :confirmed (heuristic or deep_research
      //        auto-detection) → present the detected industry to the user
      //        and call confirm_industry with their answer (which can be the
      //        detected industry OR a different one they prefer).
      //
      // Plan is NOT persisted in either case; the agent receives a soft
      // error with the right resolution path.
      if (!ctx.cached_industry_id) {
        return toolError({
          reason: "industry_classification_required",
          user_message:
            "Antes de armar el plan necesito clasificar la industria de la empresa: la recomendación de tipo de video (avatar vs animación) depende de eso. Voy a investigar el sitio (toma 30 segundos a 2 minutos) y después te pido que confirmes lo que detecté antes de seguir.",
          suggested_actions: [
            {
              tool: "deep_research",
              rationale:
                "Llamá deep_research(company_id) UNA SOLA VEZ. Detecta la industria, trae productos / menú / properties / etc. (según el perfil), y persiste un marker auto en Company.description. Cuando termine, PRESENTALE al usuario el detected_industry junto con la lista de industrias disponibles (industry_setup_proposal.available_industries en la respuesta de prepare_content_plan_context). Esperá la respuesta del usuario y llamá confirm_industry({ company_id, industry_id }) con su elección. Recién después re-llamá prepare_content_plan_context y retry draft_content_plan.",
            },
          ],
          blocking: true,
        });
      }
      if (!ctx.cached_industry_confirmed) {
        return toolError({
          reason: "industry_confirmation_required",
          user_message: `Detecté que la marca es "${ctx.cached_industry_id}" pero todavía no me confirmaste si es correcto. ¿Es esta tu industria o tu marca cae en otra categoría?`,
          suggested_actions: [
            {
              tool: "confirm_industry",
              rationale: `La industria está cacheada como "${ctx.cached_industry_id}" pero el marker no tiene el flag :confirmed. PRESENTALE al usuario qué industria fue detectada y pedile que confirme o corrija (mostrale la lista available_industries de prepare_content_plan_context). Si el usuario confirma, llamá confirm_industry({ company_id, industry_id: "${ctx.cached_industry_id}" }). Si el usuario menciona otra (free-text como "es Software B2C"), mapealo a la mejor opción del catálogo y llamá confirm_industry con ese id. NO drafftees hasta resolver esto.`,
            },
          ],
          blocking: true,
        });
      }

      // 1c. Brand templates gate. When the company has a Brand Visual
      // Identity configured AND the plan generates at least one AI image,
      // we require the brand to have manufactured templates in
      // __brand_templates. Without templates the picker has nothing to
      // anchor on for feed images: it falls back to LOGO (often a small
      // favicon), pads with HERO or ASPIRATIONAL if available, and ends
      // up sending the model a tiny / generic ref for a cinematic prompt.
      // The provider then rejects the combination (Nano Banana 2 returns
      // "could not generate") and the user pays for failed retries. Hard
      // block here forces the manufacture step before drafting. Live-read
      // the folder so manual uploads to __brand_templates count even when
      // identity.templates_count is stale.
      //
      // Skip the gate when the company has no Brand Visual Identity at
      // all: that case is handled upstream by prepare_content_plan_context
      // via brand_visual_identity_setup_proposal.
      const planItemsArr = input.plan_items as PlanItem[];
      const planUsesAiImages = planItemsArr.some((it) =>
        it.sub_posts.some((sp) => {
          const s = sp.assets_strategy as {
            image_source?: { type?: string };
            carousel_sources?: Array<{ type?: string }>;
          };
          if (s.image_source?.type === "ai_generate") return true;
          if (s.carousel_sources?.some((cs) => cs.type === "ai_generate")) return true;
          return false;
        }),
      );
      // NOTE 2026-05-25: el gate `brand_templates_missing` (que bloqueaba
      // cuando __brand_templates estaba vacío) se REMOVIÓ. La nueva
      // arquitectura de generación usa Creative Studio (POST /api/companies/{id}/creative)
      // vía generate_brand_creative, que NO requiere templates pre-manufacturados:
      // el design system de Creative Studio se arma server-side desde el
      // brand_context (company.description con el bloque BVI). Manufacture_brand_templates
      // quedó deprecada por la misma razón.
      //
      // Lo único que importa para que las imágenes salgan on-brand es que
      // el BVI tenga `recommended_visual_style` cacheado, y si no, igual
      // Creative Studio usa "ai_decides" como fallback razonable. Por eso
      // este gate ya no bloquea, solo emite un hint opcional.
      void planUsesAiImages;

      // 2. Auto-resolve near-duplicate AI image prompts silently. The
      // resolver collapses any two ai_generate refs that share a
      // shared_concept_key to ONE generation, so the user pays for one
      // image even when the same concept appears across multiple
      // sub_posts. Done before validation so the (now-silent)
      // near_duplicate warning never fires.
      autoApplyImageDedupHints(planItemsArr);

      // 2b. Auto-correct inverted video_sources (silent). Si el agente armó
      // plan_items con video_kind contradiciendo el default de la industria
      // sin que el concepto matchee flip_concepts, los flippeamos in-place.
      // Las correcciones se exponen como `_internal_corrections_applied` (no
      // user-facing) para debugging y para que el agent no las repita en
      // future updates.
      // Agregado 2026-05-25 tras el anti-pattern PipeLime.
      const videoStrategyCorrections = await autoCorrectInvertedVideoSources(
        client,
        ctx.company_id,
        ctx.cached_industry_id,
        planItemsArr,
      );

      // 3. Run the validation pipeline (extracted helper so update_content_plan
      // can re-use it).
      const v = await runValidation({
        plan_items: planItemsArr,
        time_window: input.time_window,
        ctx,
        client,
        use_brand_voice: input.use_brand_voice ?? true,
      });

      // 3. Persist plan (even with blockers, so update_content_plan can fix
      // fields without resending the whole structure).
      const plan = createPlan({
        context_id: input.context_id,
        company_id: ctx.company_id,
        time_window: input.time_window,
        user_answers: input.user_answers ?? {},
        plan_items: planItemsArr,
        use_brand_voice: input.use_brand_voice ?? true,
        ...(input.auto_publish_schedule ? { auto_publish_schedule: input.auto_publish_schedule } : {}),
      });

      // 4. Build summary table for the user.
      const summaryRows = buildSummaryTable(plan);

      const manualMaterialization = collectManualMaterializationSteps(planItemsArr);
      const response = {
        plan_id: plan.plan_id,
        status: v.blockers.length > 0 ? "needs_revision" : "ready_for_execution",
        summary_for_user: summaryRows,
        totals: {
          plan_items_count: input.plan_items.length,
          sub_posts_count: input.plan_items.reduce((a, it) => a + it.sub_posts.length, 0),
          estimated_ai_image_generations: v.totals.image_ai_count,
          estimated_ai_video_generations: v.totals.video_ai_count,
          estimated_asset_uploads: v.totals.upload_count,
          estimated_existing_asset_reuse: v.totals.reuse_count,
          estimated_total_credits_cost: v.totals.total_ai_cost,
          budget_remaining_before_execution: v.budget_remaining,
          budget_remaining_after_execution:
            v.budget_remaining !== null ? v.budget_remaining - v.totals.total_ai_cost : null,
          // Text/words bucket. Avatar TTS + chat fallback for copy generation
          // consume words. estimated_text_words_cost is intentionally NOT
          // exposed because Followr does not publish a per-call word cost; we
          // surface only whether the plan has text-dependent pieces and the
          // current bucket state so the agent can decide. Honor Rule 21 of
          // the system prompt: if text budget is short or missing, surface to
          // the user BEFORE proposing model swaps or shape downgrades.
          text_dependent_pieces_count: v.text_dependent_count,
          ai_text_budget_total: v.text_budget_total,
          ai_text_budget_remaining: v.text_budget_remaining,
        },
        upfront_decisions_required: extractUpfrontDecisions(v.warnings),
        manual_materialization_required: manualMaterialization,
        warnings: filterUserFacingWarnings(v.warnings),
        _internal_warning_signals: extractInternalOnlyWarnings(v.warnings),
        _internal_corrections_applied:
          videoStrategyCorrections.length > 0
            ? {
                video_strategy: videoStrategyCorrections,
                guidance:
                  "DEBUG ONLY. NO MENCIONAR AL USER. El plan recibido por el agente fue auto-corregido en estos plan_items para alinearse con la default_video_kind de la industria. El user solo ve el plan corregido en summary_for_user. NO digas 'corregí esto' al user; el plan que ves YA es el correcto.",
              }
            : null,
        blockers: v.blockers,
        next_step_instructions:
          v.blockers.length > 0
            ? "There are blockers (listed above). Surface them to the user with the resolution_options for each, then call update_content_plan(plan_id, changes) with the chosen fixes. Do NOT call execute_content_plan until status is ready_for_execution."
            : `FIRST handle upfront_decisions_required if not empty: each entry has a user_facing_message phrased as a question. Surface it BEFORE the plan summary, ask the user how to proceed (typical: 'la armamos ahora / avanzamos sin'), and ONLY after that decision is resolved continue to the summary. Do NOT bury these in a 'PD' at the end of the plan: by then the user has mentally approved the plan and won't pause to add the missing piece.${manualMaterialization ? " SECOND, BEFORE the cost summary, surface manual_materialization_required.user_message to the user (see instructions_for_agent in that block for the post-approval execution dance: generate avatar -> update_content_plan replace_sub_post -> execute_content_plan with plan_item_slugs). NEVER call execute_content_plan on any slug in manual_materialization_required.affected_plan_item_slugs without first materializing the avatar asset and swapping video_source to asset_id." : ""} THEN show summary_for_user to the user (translate display_name fields, never expose ids) AND tell them the cost in natural language: read totals.estimated_total_credits_cost and totals.budget_remaining_after_execution and say something like 'el plan consume aprox N créditos de imagen y video, te quedarían M después de ejecutarlo'. NEVER omit the cost just because summary_for_user does not include it; the user is paying for these credits and needs to know upfront. Surface ONLY warnings array (each has a user_facing_message safe to surface verbatim). Do NOT mention _internal_warning_signals; those are debug-only and you must obey USER-FACING LANGUAGE LOCK when speaking to the user. Ask for explicit approval ('lo ejecuto?' / 'cambio algo?'). When the user confirms, call execute_content_plan(plan_id, confirm: true). If the user wants to change a specific item, call update_content_plan(plan_id, changes) internally without naming the tool to the user. DO NOT propose your own prose version of the plan; summary_for_user is the canonical view.`,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // update_content_plan
  // ────────────────────────────────────────────────────────────────────────

  const ChangeReplaceItem = z.object({
    action: z.literal("replace_item"),
    slug: z.string().min(1),
    new_item: PlanItemSchema,
  });
  const ChangeUpdateField = z.object({
    action: z.literal("update_field"),
    slug: z.string().min(1),
    field: z.enum([
      "date",
      "publish_at_time_local",
      "timezone",
      "concept_shared",
      "rationale",
    ]),
    value: z.string().min(1),
  });
  const ChangeAddItem = z.object({
    action: z.literal("add_item"),
    new_item: PlanItemSchema,
  });
  const ChangeRemoveItem = z.object({
    action: z.literal("remove_item"),
    slug: z.string().min(1),
  });
  const ChangeShiftDates = z.object({
    action: z.literal("shift_dates"),
    days_offset: z.number().int(),
  });
  const ChangeSetGlobal = z.object({
    action: z.literal("set_global"),
    field: z.enum(["use_brand_voice", "auto_publish_schedule"]),
    value: z.union([
      z.boolean(),
      z.object({
        timezone: z.string().min(1),
        time_per_day: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    ]),
  });
  const ChangeReplaceSubPost = z.object({
    action: z.literal("replace_sub_post"),
    slug: z.string().min(1),
    sub_post_index: z.number().int().nonnegative(),
    new_sub_post: SubPostSchema,
  });
  const ChangeAddSubPost = z.object({
    action: z.literal("add_sub_post"),
    slug: z.string().min(1),
    new_sub_post: SubPostSchema,
  });
  const ChangeRemoveSubPost = z.object({
    action: z.literal("remove_sub_post"),
    slug: z.string().min(1),
    sub_post_index: z.number().int().nonnegative(),
  });
  const ChangeSplitByNetwork = z.object({
    action: z.literal("split_subposts_by_network"),
    slug: z.string().min(1),
    new_items: z
      .array(
        z.object({
          slug: z
            .string()
            .min(1)
            .max(80)
            .regex(/^[a-z0-9\-_]+$/i),
          publish_at_time_local: z.string().regex(/^\d{2}:\d{2}$/),
          networks: z.array(SocialNetworkEnum).min(1),
        }),
      )
      .min(2)
      .max(8)
      .describe(
        "Each entry takes a subset of the original item's sub_posts (matched by social_network), turns it into a new plan_item with its own publish_at_time_local. Used to separate a heterogeneous plan_item into per-network siblings with different publish times.",
      ),
  });
  const ChangeConvertToCarousel = z.object({
    action: z.literal("convert_to_carousel"),
    slug: z.string().min(1),
    sub_post_index: z.number().int().nonnegative(),
    new_carousel_sources: z
      .array(z.union([AssetSourceUrlSchema, AssetSourceAssetIdSchema, AssetSourceAiImageSchema]))
      .min(2)
      .max(20),
  });

  const ChangeSchema = z.discriminatedUnion("action", [
    ChangeReplaceItem,
    ChangeUpdateField,
    ChangeAddItem,
    ChangeRemoveItem,
    ChangeShiftDates,
    ChangeSetGlobal,
    ChangeReplaceSubPost,
    ChangeAddSubPost,
    ChangeRemoveSubPost,
    ChangeSplitByNetwork,
    ChangeConvertToCarousel,
  ]);

  server.registerTool(
    "update_content_plan",
    {
      annotations: MUTATION_IDEMPOTENT,
      title: "Apply mutations to a draft content plan and re-validate the result",
      description: `Mutate a draft plan held in session memory. Takes an ordered array of changes that target individual plan_items (by slug) or the whole plan, applies them, and re-runs the full validation pipeline against the new state.

PRECONDITION: plan_id must exist (created by draft_content_plan and not yet executed/expired).

AVAILABLE CHANGES:
- replace_item: replace one full plan_item by slug.
- update_field: change date / publish_at_time_local / timezone / concept_shared / rationale on a plan_item.
- add_item: append a new plan_item.
- remove_item: delete a plan_item by slug.
- shift_dates: shift all dates by N days (positive = later, negative = earlier).
- set_global: change use_brand_voice or auto_publish_schedule.
- replace_sub_post / add_sub_post / remove_sub_post: surgical edits inside one plan_item.
- split_subposts_by_network: separate a heterogeneous plan_item into multiple plan_items by network grouping with different publish_at_time_local. Use this when the user wants the photo and the reel on different times instead of the default single PostGroup.
- convert_to_carousel: change a single_image sub_post into carousel_images by providing new_carousel_sources.

OUTPUT: same shape as draft_content_plan (plan_id stays the same; status reflects post-change validation; full blocker / warning lists; refreshed budget snapshot).

NO MUTATIONS TO FOLLOWR: this tool only edits in-memory plan state. Executes nothing in Followr until execute_content_plan is called.

AFTER THIS: same flow as draft. Show the updated table, await explicit approval, then execute.`,
      inputSchema: {
        plan_id: z.string().min(1),
        changes: z.array(ChangeSchema).min(1).max(40),
      },
    },
    async ({ plan_id, changes }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolError({
          reason: "plan_id_not_found",
          user_message:
            "No encuentro ese plan. Puede haber expirado (2 hs en memoria) o nunca fue creado. Llamá draft_content_plan para crear uno nuevo.",
          blocking: true,
        });
      }
      const ctx = getContext(plan.context_id);
      if (!ctx) {
        return toolError({
          reason: "context_id_invalid_or_expired",
          user_message:
            "El context del plan expiró. Llamá prepare_content_plan_context de nuevo, después draft_content_plan con el plan corregido.",
          blocking: true,
        });
      }

      // Apply changes IN ORDER, mutating a working copy.
      const working = {
        plan_items: plan.plan_items.map((it) => ({ ...it, sub_posts: it.sub_posts.map((sp) => ({ ...sp })) })),
        use_brand_voice: plan.use_brand_voice,
        auto_publish_schedule: plan.auto_publish_schedule ?? undefined,
      };

      const changeErrors: Array<{ change_index: number; reason: string }> = [];

      for (let idx = 0; idx < changes.length; idx++) {
        const change = changes[idx]!;
        try {
          applyChange(working, change);
        } catch (e) {
          changeErrors.push({
            change_index: idx,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Update the persisted plan with the working state.
      const updatedPlan: ContentPlan = {
        ...plan,
        plan_items: working.plan_items as PlanItem[],
        use_brand_voice: working.use_brand_voice,
        ...(working.auto_publish_schedule
          ? { auto_publish_schedule: working.auto_publish_schedule }
          : {}),
      };
      // Auto-resolve any near-duplicate AI image prompts the user may have
      // re-introduced via this update_content_plan call. Same silent
      // dedupe behaviour as the draft_content_plan path: collapse pairs to
      // a single generation via shared_concept_key without surfacing the
      // mechanic to the user.
      autoApplyImageDedupHints(updatedPlan.plan_items as PlanItem[]);

      // Persist by mutating the entry in the state map. We can do this safely
      // because createPlan / getPlan operate on the same map and we own the
      // session lifecycle.
      updatePlanInState(plan_id, updatedPlan);

      // Re-validate.
      const v = await runValidation({
        plan_items: updatedPlan.plan_items,
        time_window: updatedPlan.time_window,
        ctx,
        client,
        use_brand_voice: updatedPlan.use_brand_voice,
      });

      const summaryRows = buildSummaryTable(updatedPlan);
      const manualMaterialization = collectManualMaterializationSteps(
        updatedPlan.plan_items,
      );
      const response = {
        plan_id,
        status: v.blockers.length > 0 ? "needs_revision" : "ready_for_execution",
        applied_changes: changes.length - changeErrors.length,
        change_errors: changeErrors,
        summary_for_user: summaryRows,
        totals: {
          plan_items_count: updatedPlan.plan_items.length,
          sub_posts_count: updatedPlan.plan_items.reduce((a, it) => a + it.sub_posts.length, 0),
          estimated_ai_image_generations: v.totals.image_ai_count,
          estimated_ai_video_generations: v.totals.video_ai_count,
          estimated_asset_uploads: v.totals.upload_count,
          estimated_existing_asset_reuse: v.totals.reuse_count,
          estimated_total_credits_cost: v.totals.total_ai_cost,
          budget_remaining_before_execution: v.budget_remaining,
          budget_remaining_after_execution:
            v.budget_remaining !== null ? v.budget_remaining - v.totals.total_ai_cost : null,
          text_dependent_pieces_count: v.text_dependent_count,
          ai_text_budget_total: v.text_budget_total,
          ai_text_budget_remaining: v.text_budget_remaining,
        },
        upfront_decisions_required: extractUpfrontDecisions(v.warnings),
        manual_materialization_required: manualMaterialization,
        warnings: filterUserFacingWarnings(v.warnings),
        _internal_warning_signals: extractInternalOnlyWarnings(v.warnings),
        blockers: v.blockers,
        next_step_instructions:
          v.blockers.length > 0
            ? "Plan still has blockers. Surface to the user, then iterate. Obey USER-FACING LANGUAGE LOCK: do not name tools or internal fields when explaining changes."
            : `FIRST handle upfront_decisions_required if non-empty (same rule as draft_content_plan: surface BEFORE the plan summary, never as a trailing PD).${manualMaterialization ? " SECOND, if manual_materialization_required is non-null, follow its instructions_for_agent: surface the user_message BEFORE the cost summary, then handle the avatar materialization dance (generate -> replace_sub_post -> execute_content_plan with plan_item_slugs) when the user approves." : ""} Plan is valid. Surface summary_for_user verbatim AND mention the updated cost in natural language using totals.estimated_total_credits_cost and totals.budget_remaining_after_execution. Ask the user for explicit approval before executing. Surface ONLY warnings array (already filtered to user-safe); never mention _internal_warning_signals to the user. DO NOT replace summary_for_user with your own prose table.`,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // get_content_plan (read-only inspector)
  // ────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "get_content_plan",
    {
      annotations: READ_ONLY,
      title: "Read a previously drafted content plan back from session memory",
      description: `Return a content plan currently held in MCP server memory by plan_id. Useful for re-displaying the plan after iteration, debugging, or surfacing it to the user mid-flow.

OUTPUT: same shape as draft_content_plan (plan_id, status, summary_for_user, totals, plan_items, time_window, etc.). Returns 404-style error if the plan_id has expired (session-only) or never existed.`,
      inputSchema: {
        plan_id: z.string().min(1),
      },
    },
    async ({ plan_id }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolError({
          reason: "plan_id_not_found",
          user_message:
            "No encuentro ese plan. Puede haber expirado (los planes viven 2hs en memoria del MCP server) o nunca fue creado. Llamá draft_content_plan para crear uno nuevo.",
          blocking: true,
        });
      }
      const summary = buildSummaryTable(plan);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                plan_id: plan.plan_id,
                status: plan.status,
                company_id: plan.company_id,
                time_window: plan.time_window,
                use_brand_voice: plan.use_brand_voice,
                auto_publish_schedule: plan.auto_publish_schedule ?? null,
                summary_for_user: summary,
                plan_items: plan.plan_items,
                created_at_iso: new Date(plan.created_at_ms).toISOString(),
                expires_at_iso: new Date(plan.expires_at_ms).toISOString(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // preview_plan_item (natural-language detail for one plan_item)
  // ────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "preview_plan_item",
    {
      annotations: READ_ONLY,
      title: "Render a detailed natural-language preview of one plan_item for user confirmation",
      description: `Return a human-readable preview of a single plan_item, designed to be surfaced to the user BEFORE asking for execute confirmation. The summary table returned by draft_content_plan / update_content_plan is intentionally compact (one row per network). This tool fills the other side: full caption text per network, plain-language description of each asset (what each image will show, what the video will look like), credit estimate, and any flags worth raising (model blocked_by_plan, brand voice missing, etc.).

USE THIS when the user asks to advance item by item ("arranca con el primero", "andá pidiendo confirmación", "uno por uno") or when they explicitly ask for more detail about a specific post before approving. Call it once per plan_item right BEFORE you call execute_content_plan(plan_id, plan_item_slugs: [slug], confirm: true).

OUTPUT: { plan_id, slug, concept, publish_at_local, networks: [{ network_display, format, caption_final, assets: [{ kind, description, model?, cost_credits }] }], totals: { credits, estimated_generation_minutes }, flags: [...], rendered_markdown }. The agent can either surface rendered_markdown verbatim or quote individual fields.

NO MUTATION. Pure read of in-memory plan state.`,
      inputSchema: {
        plan_id: z.string().min(1),
        slug: z
          .string()
          .min(1)
          .describe("The slug of the plan_item to preview (see plan.plan_items[].slug from get_content_plan or draft_content_plan)."),
      },
    },
    async ({ plan_id, slug }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolError({
          reason: "plan_id_not_found",
          user_message:
            "No encuentro ese plan. Puede haber expirado (los planes viven 2hs en memoria) o nunca fue creado.",
          blocking: true,
        });
      }
      const item = plan.plan_items.find((it) => it.slug === slug);
      if (!item) {
        return toolError({
          reason: "plan_item_slug_not_found",
          user_message: `No encontré el item con slug "${slug}" en el plan. Slugs disponibles: ${plan.plan_items.map((it) => it.slug).join(", ")}.`,
          blocking: true,
        });
      }
      // Load plus status so we only flag premium-blocked models when the
      // account actually can't use them. Without this the preview would emit
      // a "requires Followr Plus" warning for every premium model regardless
      // of whether the user already has Plus, which is noise (Plus users see
      // those models work fine). Best-effort: on a failed budget load, we
      // skip the gating flag rather than misfire.
      let followrPlusEnabled: boolean | null = null;
      try {
        const b = await loadBudgets(client);
        followrPlusEnabled = b?.followr_plus_enabled ?? null;
      } catch {
        followrPlusEnabled = null;
      }
      const preview = buildItemPreview(plan, item, followrPlusEnabled);
      // Surface manual materialization for THIS single item (subset of full
      // plan's block). Lets the agent know upfront when going item-by-item
      // whether to do the avatar dance for this slug.
      const manualMaterialization = collectManualMaterializationSteps([item]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ...preview, manual_materialization_required: manualMaterialization },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // preview_content_plan (batch preview of all plan_items, optionally filtered)
  // ────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "preview_content_plan",
    {
      annotations: READ_ONLY,
      title: "Render detailed previews for ALL plan_items (or a subset) in one call",
      description: `Batch version of preview_plan_item. Returns the same per-item preview structure for EVERY plan_item in the plan (or only the slugs in 'slugs' when provided). Avoids the round-trip cost of calling preview_plan_item N times when the user asks to see "todo el detalle" up front.

USE WHEN: the user asked to see the full week / multi-item breakdown at once ("mostrame el detalle completo de los 5 días", "preview de todo el plan"), or when running an autonomous flow where you want every preview cached client-side before deciding which to surface.

PRECONDITION: plan_id exists in session memory. Plan must not have expired.

OUTPUT: { plan_id, previews: [<ItemPreview>...], summary: { item_count, total_credits, total_image_ai, total_video_ai } }. Each preview is identical in shape to preview_plan_item output (same rendered_markdown, same asset_reuse_matrix, same flags).

PRESENTING TO THE USER: do NOT dump all 5 rendered_markdown blocks one after another, that is unusable. Pick the right strategy per PLANNING_STRATEGY.per_item_preview_strategy: for 1-3 items show all; for 4-7 show a representative spot-check; for 8+ group by week or by concept type.`,
      inputSchema: {
        plan_id: z.string().min(1),
        slugs: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Optional subset filter. When provided, only the matching plan_item slugs are previewed. When omitted, every plan_item in the plan is previewed.",
          ),
      },
    },
    async ({ plan_id, slugs }) => {
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolError({
          reason: "plan_id_not_found",
          user_message:
            "No encuentro ese plan. Puede haber expirado (los planes viven 2hs en memoria) o nunca fue creado.",
          blocking: true,
        });
      }
      const slugSet = slugs && slugs.length > 0 ? new Set(slugs) : null;
      const items = slugSet
        ? plan.plan_items.filter((it) => slugSet.has(it.slug))
        : plan.plan_items;
      if (items.length === 0) {
        return toolError({
          reason: "no_matching_items",
          user_message: `Ninguno de los slugs solicitados existe en el plan. Slugs disponibles: ${plan.plan_items.map((it) => it.slug).join(", ")}.`,
          blocking: true,
        });
      }
      let followrPlusEnabled: boolean | null = null;
      try {
        const b = await loadBudgets(client);
        followrPlusEnabled = b?.followr_plus_enabled ?? null;
      } catch {
        followrPlusEnabled = null;
      }
      const previews = items.map((it) => buildItemPreview(plan, it, followrPlusEnabled));
      const summary = {
        item_count: previews.length,
        total_credits: previews.reduce((acc, p) => acc + p.totals.credits, 0),
        total_image_ai: previews.reduce((acc, p) => acc + p.totals.image_ai_count, 0),
        total_video_ai: previews.reduce((acc, p) => acc + p.totals.video_ai_count, 0),
        total_uploads: previews.reduce((acc, p) => acc + p.totals.upload_count, 0),
        total_reuses: previews.reduce((acc, p) => acc + p.totals.reuse_count, 0),
      };
      // Surface manual materialization steps only for the items requested
      // here (when slugs is provided we already filtered items above).
      const manualMaterialization = collectManualMaterializationSteps(items);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                plan_id: plan.plan_id,
                previews,
                summary,
                manual_materialization_required: manualMaterialization,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // execute_content_plan
  // ────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "execute_content_plan",
    {
      annotations: MUTATION_IDEMPOTENT,
      title: "Execute a previously drafted content plan against Followr (uploads, AI generations, PostGroup creation, in parallel)",
      description: `Take a draft content plan (created via draft_content_plan, optionally iterated via update_content_plan), validate that it is still consistent with current state, and execute it against Followr: upload assets from URLs, generate AI images and videos, create one PostGroup per plan_item with all its per-network sub_posts, and report granular per-item results.

COPY RESOLUTION: each per-network Post's description is resolved as follows. Path A (preferred): use sp.copy_draft verbatim. Path B (fallback when copy_draft is empty): call Followr generate_chat with sp.caption_concept + brand context (company description, tones, audience) + per-network length and hashtag policy + the plan's language; persist the response as the description. Costs ai_text_budget words (very large budget by default). Path C (last resort when generation fails): persist sp.caption_concept verbatim. The chosen path is surfaced per sub_post in the response as copy_resolution_path: "copy_draft" | "generated" | "directive_fallback" so the agent can tell the user whether the copy was their own draft, server-generated, or the directive fallback.

ASSET RESOLUTION: AssetSourceAiImage refs with the same shared_concept_key collapse to ONE generation inside a plan_item, regardless of prompt drift. Without shared_concept_key, dedupe falls back to exact (model, aspect_ratio, prompt) equality. Aspect_ratio is honored from the ref when set, otherwise from the company's ai_preferences.image_aspect_ratio.

PRECONDITION: plan_id must exist in session memory (created by draft_content_plan, not yet executed, not expired). The agent MUST have surfaced the plan summary to the user and received EXPLICIT approval ("dale", "ejecutalo", "OK", etc) BEFORE calling this. The MCP requires confirm: true literal to proceed.

NOT ATOMIC: this is on purpose. If 6 of 7 plan_items succeed and 1 fails, the 6 successful PostGroups are kept (already-consumed credits cannot be refunded). The response surfaces granular results per plan_item with the raw backend error message for each failure plus a recovery_suggestion. The agent surfaces this to the user; they can call execute_content_plan again with a fixed plan or call update_content_plan to fix the specific failing item.

PARALLELISM: plan_items are executed in parallel. Inside each plan_item, sub_posts are processed in parallel (uploads + AI generations + PostGroup + Posts creation pipeline). This compresses a typical 7-day plan from N sequential round-trips into one efficient burst.

ASSET STRATEGIES SUPPORTED IN v1:
- url: download + upload to asset library (image or video).
- asset_id: pass through.
- ai_generate image: POST /api/aiResults/image, poll until completed, re-upload to asset library, attach asset id.
- ai_generate video: POST /api/aiResults/video (text-to-video), poll until completed (~10-15 min for Veo), re-upload, attach.
- ai_avatar_lipsync, ai_avatar_video: NOT supported in v1. The executor throws "Asset strategy ai_avatar_* is not supported" when it encounters one. draft_content_plan / update_content_plan / preview_content_plan all surface a manual_materialization_required block listing the affected slugs upfront with the exact dance: (1) call generate_avatar_video or generate_avatar_lipsync_clip for each fingerprint, (2) update_content_plan with replace_sub_post swapping video_source to { type: "asset_id", id: <resulting_asset_id> } for every consumer, (3) execute_content_plan with plan_item_slugs covering the now-materialized items. Read manual_materialization_required BEFORE calling execute on any avatar plan_item.

OUTPUT: { plan_id, status (succeeded / completed_with_partial_failures / failed_all), results (per plan_item: status, post_group_id when created, asset_ids per sub_post, credits_consumed, error and recovery_suggestion when failed), totals (count succeeded / failed, total credits consumed, budget remaining after). next_actions guides what the user can do next.

DO NOT CALL this without explicit user confirmation in chat. The MCP rejects calls without confirm: true.

PARTIAL EXECUTION: pass plan_item_slugs to execute only a subset of items (e.g. ["lun-drop-campera"] to execute just Monday). Items not in the list are left intact in the plan and can be executed later by calling execute_content_plan again with a different slug list. The plan's status only flips to 'executed' once every item has been attempted; partial executions keep the plan in 'draft' so it can be resumed. Use this when the user asks to ship "the first one only" or "Monday and Tuesday but wait on the rest" - this is the supported flow, NOT update_content_plan + remove_item as a workaround.

ITEM-BY-ITEM CONFIRMATION FLOW: when the user asks to advance one item at a time, the right sequence is: (1) call preview_plan_item(plan_id, slug) for the next item; (2) surface the preview to the user (caption verbatim, plain-language asset descriptions, cost); (3) wait for explicit approval; (4) call execute_content_plan(plan_id, plan_item_slugs: [slug], confirm: true); (5) on success, repeat for the next slug listed in the response's remaining_slugs. Do NOT skip step 1 - the compact summary table is too thin for per-item approval.`,
      inputSchema: {
        plan_id: z.string().min(1),
        confirm: z
          .literal(true)
          .describe(
            "Must be the literal boolean true. Any other value or omission causes the tool to refuse. This is the chat-side confirmation gate: the agent must have asked the user out loud, received explicit approval, and only then passes confirm: true.",
          ),
        plan_item_slugs: z
          .array(z.string().min(1).max(80))
          .min(1)
          .max(60)
          .optional()
          .describe(
            "Optional subset of plan_item slugs to execute. When set, only matching items run; the rest stay in the plan untouched and can be executed in a later call. When omitted, every item in the plan runs. Use this for confirm-each-item flows ('arranca con el primero', 'andá pidiendo confirmación') - it is the supported alternative to removing items via update_content_plan and re-adding them later.",
          ),
      },
    },
    async ({ plan_id, confirm, plan_item_slugs }) => {
      if (confirm !== true) {
        return toolError({
          reason: "confirmation_required",
          user_message:
            "execute_content_plan requiere confirmación explícita. Llamá esta tool solo después que el usuario haya dicho explícitamente que quiere ejecutar el plan.",
          blocking: true,
        });
      }
      const plan = getPlan(plan_id);
      if (!plan) {
        return toolError({
          reason: "plan_id_not_found",
          user_message:
            "No encuentro ese plan. Puede haber expirado (los planes viven 2hs en memoria) o nunca fue creado.",
          blocking: true,
        });
      }
      if (plan.status === "executed") {
        return toolError({
          reason: "plan_already_executed",
          user_message:
            "Este plan ya fue ejecutado. Si querés crear los mismos posts de nuevo, generá un plan nuevo con draft_content_plan.",
          blocking: true,
        });
      }
      const ctx = getContext(plan.context_id);
      if (!ctx) {
        return toolError({
          reason: "context_id_invalid_or_expired",
          user_message:
            "El context expiró. Llamá prepare_content_plan_context y rearmá el plan antes de ejecutar.",
          blocking: true,
        });
      }

      // Resolve which plan_items to execute this call. When plan_item_slugs is
      // present we honor it; missing slugs are reported up front so the agent
      // does not silently skip work. The plan stays intact either way; we
      // only mutate the in-memory copy on items we actually executed.
      let itemsToRun: PlanItem[];
      const unknownSlugs: string[] = [];
      if (plan_item_slugs && plan_item_slugs.length > 0) {
        const slugSet = new Set(plan_item_slugs);
        itemsToRun = plan.plan_items.filter((it) => slugSet.has(it.slug));
        for (const s of plan_item_slugs) {
          if (!plan.plan_items.some((it) => it.slug === s)) unknownSlugs.push(s);
        }
        if (itemsToRun.length === 0) {
          return toolError({
            reason: "plan_item_slugs_no_match",
            user_message:
              "Ninguno de los plan_item_slugs solicitados existe en el plan. Llamá get_content_plan para ver los slugs disponibles.",
            blocking: true,
            details: { requested_slugs: plan_item_slugs, available_slugs: plan.plan_items.map((it) => it.slug) },
          });
        }
      } else {
        itemsToRun = plan.plan_items;
      }
      const isPartialExecution = itemsToRun.length < plan.plan_items.length;

      // Re-validate before execute to catch any quota / state drift since draft.
      const v = await runValidation({
        plan_items: plan.plan_items,
        time_window: plan.time_window,
        ctx,
        client,
        use_brand_voice: plan.use_brand_voice,
      });
      if (v.blockers.length > 0) {
        return toolError({
          reason: "plan_no_longer_valid",
          user_message:
            "El plan dejó de ser válido entre el draft y este execute (cambió tu cuota, una red se desconectó, etc.). Llamá update_content_plan para resolver los blockers listados y reintentá.",
          blocking: true,
          details: { blockers: v.blockers },
        });
      }

      updatePlanInState(plan_id, { status: "executing", execution_started_at_ms: Date.now() });

      // Load company AI preferences ONCE for the whole execution. We propagate
      // them down to executePlanItem and resolveSubPostAssets so each call
      // can pick the right driver per modality without repeating the
      // getCompany roundtrip per sub_post.
      // Load the Company too: we need its language + tones + audience to
      // synthesize copy_draft fallbacks when a sub_post lacks one.
      // Also load the BrandContext (parsed BrandVisualIdentity block +
      // asset_id->url lookup) so the AI image resolver can auto-inject
      // brand grounding (F3).
      // Also list connected social networks: if the company has any network
      // connected AND the plan items carry a publish time, we schedule the
      // PostGroup (draft:false + publish_at + auto_publish:true) so it lands
      // on the user's calendar. Without networks we keep the legacy draft
      // behavior. Fetched in parallel to keep latency flat.
      // Tolerant: failures degrade gracefully (no brand grounding when the
      // company has no identity block; no copy_draft fallback when getCompany
      // fails; no scheduling when listSocialNetworks fails).
      const [prefs, companyForCopy, brandContext, socialNetworksR] = await Promise.all([
        getAiPreferences(client, plan.company_id),
        client.getCompany(plan.company_id).catch(() => null),
        loadBrandContext(client, plan.company_id),
        client.listSocialNetworks(plan.company_id).catch(() => [] as unknown[]),
      ]);
      const hasConnectedNetworks =
        Array.isArray(socialNetworksR) && socialNetworksR.length > 0;
      // Timezone fallback chain: explicit plan-level auto_publish_schedule >
      // company timezone > UTC. Each PlanItem carries publish_at_time_local
      // as "HH:MM"; we combine with item.date + this timezone to compute UTC.
      const scheduleTimezone = resolveTimezone(
        plan.auto_publish_schedule?.timezone,
        (companyForCopy as (Company & { timezone?: string | null }) | null)?.timezone,
        "UTC",
      );
      const copyCtx: CopyResolutionContext = {
        companyName: companyForCopy?.name ?? "the company",
        companyDescription: companyForCopy?.description ?? null,
        companyLanguage:
          (companyForCopy as (Company & { language?: string | null }) | null)?.language ??
          (companyForCopy as (Company & { language_iso_code?: string | null }) | null)?.language_iso_code ??
          null,
        tones: (companyForCopy as (Company & { tones?: string[] | null }) | null)?.tones ?? null,
        audience:
          (companyForCopy as (Company & { audience_types?: string[] | null }) | null)?.audience_types ?? null,
        planLanguage: plan.user_answers.language ?? null,
        hashtagsPolicy: plan.user_answers.hashtags_policy ?? "auto",
      };

      const itemResults: Array<Record<string, unknown>> = [];
      const executions = itemsToRun.map(async (item) => {
        try {
          const result = await executePlanItem(
            client,
            plan.company_id,
            item,
            prefs,
            copyCtx,
            brandContext,
            { hasConnectedNetworks, scheduleTimezone },
          );
          itemResults.push(result);
          return result;
        } catch (e) {
          const result = {
            slug: item.slug,
            date: item.date,
            status: "failed_unexpected" as const,
            error_message: e instanceof Error ? e.message : String(e),
            credits_consumed_estimate: 0,
            recovery_suggestion:
              "Unexpected failure outside the per-sub_post pipeline. Inspect details. If transient (network blip, 5xx), retry execute_content_plan.",
          };
          itemResults.push(result);
          return result;
        }
      });
      await Promise.all(executions);

      // Totals.
      const succeeded = itemResults.filter((r) => r["status"] === "created").length;
      const failed = itemResults.length - succeeded;
      const overallStatus =
        succeeded === itemResults.length
          ? "succeeded"
          : succeeded === 0
            ? "failed_all"
            : "completed_with_partial_failures";

      // Refresh budget for the report.
      let budgetAfter: number | null = null;
      try {
        const b = await loadBudgets(client);
        budgetAfter = b?.ai_image_and_video_budget.remaining ?? null;
      } catch {
        budgetAfter = null;
      }

      // Compute remaining slugs (items that were not part of this run). On a
      // partial run the plan stays in 'draft' so the caller can keep going
      // item by item; on a full run we transition to 'executed' (or 'failed'
      // when nothing succeeded).
      const ranSlugs = new Set(itemsToRun.map((it) => it.slug));
      const remainingSlugs = plan.plan_items.filter((it) => !ranSlugs.has(it.slug)).map((it) => it.slug);

      let nextStatus: ContentPlan["status"];
      if (isPartialExecution) {
        nextStatus = "draft";
      } else if (overallStatus === "failed_all") {
        nextStatus = "failed";
      } else {
        nextStatus = "executed";
      }
      updatePlanInState(plan_id, {
        status: nextStatus,
        execution_finished_at_ms: Date.now(),
      });

      const consumedEstimate = itemResults.reduce(
        (a, r) => a + (typeof r["credits_consumed_estimate"] === "number" ? (r["credits_consumed_estimate"] as number) : 0),
        0,
      );

      // Branch next-actions by whether items were scheduled or left as drafts.
      // Mixed runs (some scheduled, some draft) describe both states. The
      // helper checks each result for the `scheduled` flag set by
      // executePlanItem.
      const scheduledCount = itemResults.filter((r) => r["scheduled"] === true).length;
      const draftCount = itemResults.filter(
        (r) => r["status"] === "created" && r["scheduled"] !== true,
      ).length;
      const calendarLine =
        scheduledCount > 0
          ? `Revisar los posteos que quedaron calendarizados (${scheduledCount}) en el calendario de Followr; se publican automáticamente en la fecha y hora indicadas.`
          : null;
      const draftLine =
        draftCount > 0
          ? `Revisar los borradores (${draftCount}) en la vista de drafts de Followr; podés programarlos a mano desde la app o publicarlos directo.`
          : null;
      const successLines = [calendarLine, draftLine].filter((l): l is string => l !== null);
      const nextActions =
        overallStatus === "succeeded"
          ? isPartialExecution
            ? [
                `Quedan ${remainingSlugs.length} items pendientes en el plan: ${remainingSlugs.join(", ")}. Pasalos a execute_content_plan con plan_item_slugs cuando el usuario apruebe avanzar.`,
                ...successLines,
              ]
            : successLines
          : overallStatus === "completed_with_partial_failures"
            ? [
                ...successLines,
                "Mirar el campo error_message de los items que fallaron para entender la causa.",
                "Para reintentar solo los fallidos: usar update_content_plan para ajustar ese sub_post y volver a llamar execute_content_plan con plan_item_slugs apuntando solo a los slugs fallidos.",
                ...(remainingSlugs.length > 0
                  ? [`Quedan ${remainingSlugs.length} items que ni siquiera se intentaron en este call (${remainingSlugs.join(", ")}). Pasalos en una llamada posterior con plan_item_slugs.`]
                  : []),
              ]
            : [
                "Ningún item se creó. Revisar el error_message de cada fila para entender la causa raíz.",
                "Si fue por modelo bloqueado por plan (followr_plus_enabled=false): cambiá el video a wan_2.2 (único video regular) con update_content_plan y reintentá. En cuentas con Plus, el ID equivocado es la causa más común: confirmá que el model_id viene verbatim del catálogo (veo_3.1_fast con punto, no veo_3_1_fast con underscore).",
                "Si fue por quota: cambiar modelos a alternativas más baratas con update_content_plan y reintentar.",
                "Si fue por un asset URL que ya no existe: corregir la URL con update_content_plan y reintentar.",
              ];

      const responseBody: Record<string, unknown> = {
        plan_id,
        status: overallStatus,
        partial_execution: isPartialExecution,
        executed_slugs: itemsToRun.map((it) => it.slug),
        remaining_slugs: remainingSlugs,
        results: itemResults,
        totals: {
          plan_items_attempted: itemResults.length,
          succeeded,
          failed,
          estimated_credits_consumed: consumedEstimate,
          ai_image_and_video_budget_remaining: budgetAfter,
        },
        next_actions: nextActions,
      };
      if (unknownSlugs.length > 0) {
        responseBody["unknown_slugs_skipped"] = unknownSlugs;
        responseBody["unknown_slugs_note"] =
          "Algunos plan_item_slugs solicitados no existen en el plan y fueron ignorados. Llamá get_content_plan para ver los slugs reales.";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(responseBody, null, 2),
          },
        ],
      };
    },
  );
}

// ── execute helpers ─────────────────────────────────────────────────────────

type ImageSrc = NonNullable<AssetsStrategy["image_source"]>;
type VideoSrc = NonNullable<AssetsStrategy["video_source"]>;

interface ResolvedAsset {
  asset_id: number;
  /**
   * Followr CDN URL of the resolved asset, when we have it. Populated by
   * URL uploads and AI generations (via uploadFromUrl's return). NULL for
   * asset_id reuse (no extra GET) and for paths that don't track it.
   * Used by the carousel chaining pass to feed slide N-1's URL as a
   * reference into slide N's generation.
   */
  asset_url: string | null;
  credits_consumed: number;
  ai_result_id: number | null;
}

interface AssetSourceRef {
  src: ImageSrc | VideoSrc;
  mode: "image" | "video";
  // For video sources, the aspect ratio is derived from network/product_type.
  // Two sub_posts requesting the same prompt at different aspect ratios are
  // genuinely different generations, so the aspect is part of the dedupe key.
  aspect_ratio?: "9:16" | "16:9";
}

/**
 * Per-network video aspect-ratio priority used to maximize cross-network
 * asset reuse within a single plan_item. The lowest numeric priority wins
 * when multiple sub_posts in the same plan_item request AI video.
 *
 *   P1 (9:16 vertical, mandatory): TikTok, IG (all surfaces), FB (all
 *       surfaces), YouTube Short. These networks privilege or require
 *       vertical content, so when ANY of them are in the plan_item with
 *       a video, every other ai_generate video in that plan_item is
 *       generated at 9:16 to share the same fingerprint and avoid
 *       duplicate billing.
 *   P2 (16:9 horizontal): LinkedIn. If the plan_item has no P1 video,
 *       LinkedIn dictates 16:9; if it does, LinkedIn accepts the 9:16
 *       reel asset (LinkedIn renders it correctly on mobile).
 *   P3 (flexible): X / Twitter, Threads, Pinterest, Bluesky. These follow
 *       whichever priority the plan_item already settled on. When alone
 *       they default to 9:16 because 9:16 reels render reasonably well
 *       on every P3 platform and the asset is more reusable later.
 *
 * Special case: YouTube long_video is excluded from this coupling. Long
 * form is a different production pipeline and a 9:16 long_video would
 * look broken in the YT feed. It always uses 16:9, independent of what
 * else is in the plan_item.
 */
const VIDEO_NETWORK_PRIORITY: Record<string, 1 | 2 | 3> = {
  "tiktok:feed": 1,
  "instagram:feed": 1,
  "instagram:reel": 1,
  "instagram:story": 1,
  "facebook:feed": 1,
  "facebook:reel": 1,
  "facebook:story": 1,
  "youtube:short": 1,
  "linkedin:feed": 2,
  "x:feed": 3,
  "threads:feed": 3,
  "pinterest:feed": 3,
  "bluesky:feed": 3,
};

const PRIORITY_PREFERRED_ASPECT: Record<1 | 2 | 3, "9:16" | "16:9"> = {
  1: "9:16",
  2: "16:9",
  3: "9:16",
};

function isYouTubeLongVideo(sp: SubPost): boolean {
  return sp.social_network === "youtube" && sp.product_type === "long_video";
}

/**
 * Resolve the plan_item's shared video aspect ratio so every AI video
 * generation inside the item can dedupe to a single fingerprint when
 * appropriate. YouTube long_video sub_posts opt out of this coupling and
 * stay 16:9.
 */
function videoAspectRatioForPlanItem(item: PlanItem): "9:16" | "16:9" {
  let bestPriority: number = Infinity;
  let aspect: "9:16" | "16:9" = "9:16";
  for (const sp of item.sub_posts) {
    if (!sp.assets_strategy.video_source) continue;
    if (isYouTubeLongVideo(sp)) continue;
    const key = `${sp.social_network}:${sp.product_type}`;
    const prio = VIDEO_NETWORK_PRIORITY[key];
    if (prio !== undefined && prio < bestPriority) {
      bestPriority = prio;
      aspect = PRIORITY_PREFERRED_ASPECT[prio];
    }
  }
  return aspect;
}

/**
 * Aspect ratio the AI video generator should target for ONE sub_post.
 * YouTube long_video opts out of the plan_item coupling and stays 16:9.
 * Everything else inherits the plan_item's resolved aspect, which is what
 * lets a 9:16 reel asset be shared across IG Reel + FB Reel + TikTok +
 * LinkedIn (coupled down from 16:9) when they all appear together.
 */
function videoAspectRatioForSubPostInItem(sp: SubPost, item: PlanItem): "9:16" | "16:9" {
  if (isYouTubeLongVideo(sp)) return "16:9";
  return videoAspectRatioForPlanItem(item);
}

/**
 * Stable fingerprint of an asset source. Sources with the same fingerprint
 * resolve to a single backend call and their result is reused by every
 * sub_post that requested it. This is what stops execute_content_plan
 * from billing 3x the same Veo clip when a 9:16 video is cross-posted to
 * IG Reel + FB Reel + TikTok.
 *
 * IMPORTANT: any field that genuinely changes the generator output must
 * be part of the fingerprint. For video that means model + aspect_ratio
 * + duration + reference_image_url + prompt.
 */
function fingerprintAssetSource(ref: AssetSourceRef): string {
  const { src, mode, aspect_ratio } = ref;
  if (src.type === "url") return `url:${src.url}`;
  if (src.type === "asset_id") return `id:${src.id}`;
  if (src.type === "ai_generate") {
    // Combine reference_image_url + reference_image_urls into one canonical
    // list for fingerprinting. Refs that differ produce distinct generations
    // even when the prompt is identical (this is what makes carousel
    // chaining safe: slide N has slide N-1's URL injected, fingerprint
    // changes, no accidental cache hit).
    const collectedRefs = (() => {
      if (mode !== "image") return [] as string[];
      const imgSrc = src as Extract<ImageSrc, { type: "ai_generate" }>;
      const list: string[] = [];
      if (imgSrc.reference_image_url) list.push(imgSrc.reference_image_url);
      if (imgSrc.reference_image_urls) list.push(...imgSrc.reference_image_urls);
      return list;
    })();
    void collectedRefs; // referenced below per-branch
    if (mode === "image") {
      const imgSrc = src as Extract<ImageSrc, { type: "ai_generate" }>;
      // shared_concept_key short-circuits: any two AssetSourceAiImage refs
      // declaring the same key collapse into ONE generation, regardless of
      // prompt-level adjective drift. This is the canonical way to express
      // "the cover for LinkedIn and the cover for Instagram are the same
      // concept" without having to keep the two prompts byte-identical.
      if (imgSrc.shared_concept_key) {
        return `ai_image:shared:${imgSrc.shared_concept_key}`;
      }
      const model = imgSrc.model ?? "default";
      const ratio = imgSrc.aspect_ratio ?? "default";
      const refsKey = collectedRefs.length > 0 ? collectedRefs.join(",") : "";
      const useBrandFlag = (imgSrc.use_brand_visual_identity ?? true) ? "B1" : "B0";
      return `ai_image:${model}|${ratio}|${useBrandFlag}|${refsKey}|${imgSrc.prompt}`;
    }
    const vidSrc = src as Extract<VideoSrc, { type: "ai_generate" }>;
    return `ai_video:${vidSrc.model}|${aspect_ratio ?? "9:16"}|${vidSrc.duration_seconds ?? 8}|${vidSrc.reference_image_url ?? ""}|${vidSrc.prompt}`;
  }
  if (src.type === "ai_avatar_lipsync") return `lipsync:${src.avatar_id}|${src.script}`;
  if (src.type === "ai_avatar_video") return `avatar:${src.avatar_id}|${src.generate_backgrounds ?? false}|${src.scripts.join("||")}`;
  return JSON.stringify(src);
}

/**
 * Normalized Levenshtein similarity for two prompts. Returns 1.0 for
 * identical strings (after lowercase + whitespace normalization), 0.0 for
 * complete mismatch. Used by the validator to detect near-duplicate AI
 * image prompts inside the same plan_item (the case where covers for
 * LinkedIn and Instagram only differ by a stylistic adjective and produce
 * indistinguishable outputs, burning a generation per network for zero
 * differentiation. Empirical threshold from the 2026-05-21 audit: at
 * similarity >=0.85 the model renders near-identical images.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1) as number[];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = new Array(n + 1) as number[];
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const ca = a[i - 1];
      const cb = b[j - 1];
      const cost = ca === cb ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

function normalizedPromptSimilarity(a: string, b: string): number {
  const A = a.toLowerCase().trim().replace(/\s+/g, " ");
  const B = b.toLowerCase().trim().replace(/\s+/g, " ");
  if (A === B) return 1;
  const maxLen = Math.max(A.length, B.length);
  if (maxLen === 0) return 1;
  const d = levenshteinDistance(A, B);
  return 1 - d / maxLen;
}

/**
 * Threshold over which two AI image prompts inside the same plan_item are
 * considered near-duplicates worth flagging. 0.85 is empirical from the
 * 2026-05-21 audit where 96-97% similar prompts produced visually
 * indistinguishable covers.
 */
const PROMPT_DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Pre-validation pass: detect AI-image prompt pairs that are >=85% similar
 * within the same plan_item AND share the same aspect_ratio, and unify them
 * by assigning the SAME shared_concept_key on both refs. The resolver then
 * collapses them into one generation, the user gets one image (reused across
 * networks), and the agent never has to mention the mechanic.
 *
 * Mutates the plan_items array in place. Returns the count of pairs unified
 * so callers can log it internally (never surfaced to the user).
 *
 * This is the auto-resolution counterpart to the silent near_duplicate
 * warning. Together they cover the 2026-05-23 PostApprove share complaint
 * that the user should not have had to read about "shared_concept_key" at
 * all: the planner detects the duplication, fixes it silently, and the
 * preview just shows one shared asset across networks.
 */
function autoApplyImageDedupHints(plan_items: PlanItem[]): number {
  let unifiedPairs = 0;
  let autoKeyCounter = 0;
  for (const item of plan_items) {
    interface DedupRef {
      sp_index: number;
      slot: number;
      src: AssetSourceAiImage;
    }
    const refs: DedupRef[] = [];
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const collectFromImage = (src: NonNullable<AssetsStrategy["image_source"]>, slot: number) => {
        if (src.type !== "ai_generate") return;
        refs.push({ sp_index: i, slot, src: src as AssetSourceAiImage });
      };
      if (sp.assets_strategy.image_source) collectFromImage(sp.assets_strategy.image_source, 0);
      if (sp.assets_strategy.carousel_sources) {
        sp.assets_strategy.carousel_sources.forEach((s, idx) => collectFromImage(s, idx));
      }
    }
    for (let a = 0; a < refs.length; a++) {
      for (let b = a + 1; b < refs.length; b++) {
        const A = refs[a]!;
        const B = refs[b]!;
        // Skip if one or both already declare a shared_concept_key. The
        // explicit caller intent wins; auto-apply never overrides it.
        if (A.src.shared_concept_key || B.src.shared_concept_key) continue;
        // Require matching aspect_ratio. Different aspects produce different
        // outputs even from identical prompts; unifying them would lose the
        // intentional structural differentiation.
        const aspA = A.src.aspect_ratio ?? null;
        const aspB = B.src.aspect_ratio ?? null;
        if (aspA !== aspB) continue;
        const sim = normalizedPromptSimilarity(A.src.prompt, B.src.prompt);
        if (sim < PROMPT_DUPLICATE_SIMILARITY_THRESHOLD) continue;
        // Assign the same auto key to both refs. The slug-derived prefix
        // keeps multiple unrelated unifications inside the same plan_item
        // distinguishable in debug logs (never surfaced to the user).
        autoKeyCounter += 1;
        const autoKey = `auto-${item.slug}-${autoKeyCounter}`;
        A.src.shared_concept_key = autoKey;
        B.src.shared_concept_key = autoKey;
        unifiedPairs += 1;
      }
    }
  }
  return unifiedPairs;
}

/**
 * Anti-placeholder hardening for AI image prompts. Models like nano_banana_2,
 * gpt_image_2, ideogram_v3, etc. occasionally leak prompt scaffolding into
 * the rendered image as visible text (Lorem ipsum, "Title preview", "your
 * text here", broken image placeholders). The Followr UI verified this
 * empirically on 2026-05-21: a "Slack message" mockup slide ended up
 * shipping with "Lorem ipsum dolor sit amet, consectetur adipiscing elit"
 * inside the chat-bubble preview. Appending a clear negative-list suffix
 * to every AI image prompt collapses the false positive rate well below 1%.
 */
const PLACEHOLDER_PROHIBITION_SUFFIX =
  "\n\nIMPORTANT: do NOT include any placeholder text on the image. Specifically, NO 'lorem ipsum', NO 'placeholder', NO 'title preview', NO 'your text here', NO 'sample text', NO broken-image icons, NO dummy chat bubbles, NO grey image placeholders. If a mockup needs a label, use the real labels from the prompt itself; otherwise leave the area blank.";

function hardenAiImagePrompt(prompt: string): string {
  // Idempotent: don't double-append if the caller already injected the suffix.
  if (prompt.includes("do NOT include any placeholder text")) return prompt;
  return `${prompt}${PLACEHOLDER_PROHIBITION_SUFFIX}`;
}

/**
 * Context needed to fall back to Followr's text AI when a sub_post lacks
 * copy_draft. Loaded once per execute call and passed down so we don't
 * round-trip getCompany per sub_post.
 */
interface CopyResolutionContext {
  companyName: string;
  companyDescription: string | null;
  companyLanguage: string | null;
  tones: string[] | null;
  audience: string[] | null;
  /** From user_answers.language; overrides companyLanguage when present. */
  planLanguage: string | null;
  /** From user_answers.hashtags_policy; defaults to "auto" when absent. */
  hashtagsPolicy: "auto" | "off";
}

function lengthGuidanceForNetwork(network: SocialNetwork, productType: ProductType): string {
  if (network === "linkedin") return productType === "long_video" ? "200-400 words" : "100-200 words";
  if (network === "instagram") return productType === "reel" || productType === "story" ? "60-120 words" : "100-150 words";
  if (network === "x") return "<=280 characters";
  if (network === "tiktok") return "50-150 characters";
  if (network === "threads") return "<=500 characters";
  if (network === "pinterest") return "20-80 characters for the title; description optional";
  if (network === "facebook") return "80-180 words";
  if (network === "youtube") return productType === "long_video" ? "150-400 words description with timestamps if applicable" : "60-120 words";
  if (network === "bluesky") return "<=300 characters";
  return "100-150 words";
}

function hashtagGuidanceForNetwork(network: SocialNetwork, policy: "auto" | "off"): string {
  if (policy === "off") return "Do NOT include hashtags.";
  if (network === "instagram") return "Include 5-8 relevant hashtags at the end, on the last line.";
  if (network === "linkedin") return "Include 3-5 relevant hashtags at the end.";
  if (network === "x") return "Include at most 1-3 hashtags integrated in the body.";
  if (network === "tiktok") return "Include 3-5 hashtags at the end.";
  if (network === "threads") return "Include 0-3 hashtags, optional.";
  if (network === "pinterest") return "Hashtags are NOT useful on Pinterest; rely on keywords in the title.";
  if (network === "facebook") return "Include 1-3 hashtags at the end, optional.";
  if (network === "youtube") return "Include 3-5 hashtags at the end of the description.";
  if (network === "bluesky") return "Include 1-3 hashtags optionally.";
  return "Include 3-5 relevant hashtags at the end.";
}

function buildCopyFallbackPrompt(sp: SubPost, ctx: CopyResolutionContext): string {
  const language = ctx.planLanguage ?? ctx.companyLanguage ?? "the company's default language";
  const lengthHint = lengthGuidanceForNetwork(sp.social_network, sp.product_type);
  const hashtagHint = hashtagGuidanceForNetwork(sp.social_network, ctx.hashtagsPolicy);
  const tonesLine = ctx.tones && ctx.tones.length > 0 ? `\n- Tone: ${ctx.tones.join(", ")}` : "";
  const audienceLine = ctx.audience && ctx.audience.length > 0 ? `\n- Audience: ${ctx.audience.join(", ")}` : "";
  const descriptionLine = ctx.companyDescription ? `\n- Company description: ${ctx.companyDescription.slice(0, 600)}` : "";

  return [
    `You are writing the publication-ready copy for a ${displayNetworkName(sp.social_network)} ${sp.product_type} post.`,
    `Brand: ${ctx.companyName}.${descriptionLine}${tonesLine}${audienceLine}`,
    `Language: write the copy in ${language}. If the directive below contains text in another language, translate it to ${language}.`,
    `Length target: ${lengthHint}.`,
    `Hashtags: ${hashtagHint}`,
    "",
    `Directive for this specific post (your editorial brief, NOT the final copy):`,
    sp.caption_concept,
    "",
    "OUTPUT INSTRUCTIONS:",
    "- Output ONLY the publication-ready copy, nothing else.",
    "- Do NOT include meta-commentary, preface, or headers like 'Copy:' or 'Here is the post:'.",
    "- Do NOT include the directive text or any meta-instructions.",
    "- The first line should be the hook.",
    "- Match the brand tone, audience expectations, and network conventions.",
  ].join("\n");
}

/**
 * Resolve the description that will be persisted on the per-network Post.
 *
 * Path A (preferred): the agent provided `copy_draft` during draft_content_plan,
 * with full conversational + brand context. Use it verbatim. No extra call,
 * no extra latency, no extra text-budget consumption.
 *
 * Path B (fallback): no copy_draft. Synthesize a prompt that injects brand
 * context + per-network length / hashtag policy + the caption_concept as the
 * editorial brief, then call Followr's generate_chat. Cost is paid out of
 * ai_text_budget (very large by default, see get_ai_budget).
 *
 * Path C (last resort): the fallback generation fails (timeout, 5xx, plan
 * limits). Persist the caption_concept verbatim so the post is at least
 * created instead of crashing the whole plan. The agent can rewrite via
 * update_post in a follow-up call.
 */
async function resolvePostDescription(
  client: FollowrClient,
  companyId: number,
  sp: SubPost,
  ctx: CopyResolutionContext,
): Promise<{ description: string; path: "copy_draft" | "generated" | "directive_fallback"; ai_result_id: number | null }> {
  if (sp.copy_draft && sp.copy_draft.trim().length > 0) {
    return { description: sp.copy_draft, path: "copy_draft", ai_result_id: null };
  }
  try {
    const prompt = buildCopyFallbackPrompt(sp, ctx);
    const initial = await client.generateChat({ q: prompt, company_id: companyId });
    let final = initial;
    if (final.status !== "completed" && final.status !== "failed") {
      final = await client.waitForAiResult(initial.id, { timeoutMs: 120 * 1000 });
    }
    if (final.status === "completed" && typeof final.response === "string" && final.response.trim().length > 0) {
      return { description: final.response.trim(), path: "generated", ai_result_id: final.id };
    }
  } catch {
    // Swallow and fall through to the directive last-resort branch below.
  }
  return { description: sp.caption_concept, path: "directive_fallback", ai_result_id: null };
}

// ── Brand visual identity injection (F3) ──────────────────────────────────

/**
 * Snapshot of a company's Brand Visual Identity + asset URL lookup table.
 * Loaded ONCE per execute_content_plan call and propagated down to every
 * AI image generation so the resolver can auto-inject brand grounding
 * (brief in the prompt, tagged template/element URLs as image_urls).
 *
 * If the company has no BrandVisualIdentity block in description,
 * `identity` is null and the resolver behaves exactly as before F3.
 */
interface BrandContext {
  identity: BrandVisualIdentity | null;
  /** asset_id -> Followr CDN url, for refs lookup. */
  assetIdToUrl: Map<number, string>;
  /**
   * Company.palettes hex codes, even when a full BrandVisualIdentity block is
   * NOT configured. Used as a soft fallback: when identity is null but the
   * company has palettes saved, the resolver injects a short palette suffix
   * into the image prompt so generations at least respect the brand colors.
   * Reduces the "generic AI output" problem on companies that have only
   * partial brand setup. Empty array when the company has no palettes.
   */
  fallbackPalettes: string[];
  /** FollowrClient passed through so the picker can do live folder reads. */
  client: FollowrClient;
  /** Company id, passed through so the picker can scope listAssets. */
  companyId: number;
}

async function loadBrandContext(
  client: FollowrClient,
  companyId: number,
): Promise<BrandContext> {
  let identity: BrandVisualIdentity | null = null;
  let fallbackPalettes: string[] = [];
  try {
    const company = await client.getCompany(companyId);
    const parsed = parseBrandIdentityFromDescription(company.description ?? null);
    if (parsed.status === "ok") identity = parsed.identity;
    // Always record the company-level palettes; we use them only when the
    // full identity block is missing.
    const rawPalettes = (company as Company & { palettes?: unknown }).palettes;
    if (Array.isArray(rawPalettes)) {
      fallbackPalettes = rawPalettes
        .filter((p): p is string => typeof p === "string" && /^#?[0-9a-f]{3,8}$/i.test(p))
        .map((p) => (p.startsWith("#") ? p : `#${p}`));
    }
  } catch {
    // Best-effort: if Company fetch fails, brand context is empty and
    // the resolver falls back to non-branded generation.
  }
  const assetIdToUrl = new Map<number, string>();
  if (identity) {
    try {
      const assets = await client.listAssets(companyId, {
        pageSize: 100,
        include: "image.thumbnail",
      });
      for (const a of assets) {
        const url =
          (a as Asset & { image?: { url?: string } }).image?.url ??
          (a as Asset & { url?: string }).url ??
          null;
        if (url) assetIdToUrl.set(a.id, url);
      }
    } catch {
      // Same fallback: if listAssets fails, the auto-injection just has
      // no URLs to inject. Generations still happen with caller-provided
      // refs (if any).
    }
  }
  return { identity, assetIdToUrl, fallbackPalettes, client, companyId };
}

/**
 * Lightweight palette-only suffix used when the company has palettes but no
 * full BrandVisualIdentity block. Mirrors the palette section of
 * buildBrandPromptSuffix without the brief / typography / anti-patterns,
 * since those don't exist outside an identity block. Empty string when the
 * palette list is empty (caller can concatenate unconditionally).
 */
function buildSoftPalettePromptSuffix(palettes: string[]): string {
  if (palettes.length === 0) return "";
  const list = palettes.slice(0, 6).join(", ");
  return `\n\n--- BRAND PALETTE GUIDANCE ---\nUse this brand color palette as the dominant chromatic anchor of the image (apply to accents, backgrounds, surfaces, or focal subjects as visually appropriate): ${list}. Avoid colors that clash with this palette.`;
}

/**
 * Suffix appended to AI image prompts when the company has a Brand Visual
 * Identity configured. Includes the brief + palette + typography +
 * anti-patterns. Designed to read as natural prose continuation of the
 * caller's prompt so the model treats the whole input coherently.
 */
function buildBrandPromptSuffix(identity: BrandVisualIdentity): string {
  const palette = identity.palette_primary
    .concat(identity.palette_extended)
    .slice(0, 6)
    .join(", ");
  const lines: string[] = ["", "--- BRAND VISUAL IDENTITY GUIDANCE ---"];
  lines.push(`Brief: ${identity.brief_text}`);
  if (palette) lines.push(`Palette: ${palette}.`);
  if (identity.typography_style_text.length > 0) {
    lines.push(`Typography character: ${identity.typography_style_text}.`);
  }
  if (identity.anti_patterns_text.length > 0) {
    lines.push(`AVOID (anti-patterns): ${identity.anti_patterns_text.join("; ")}.`);
  }
  lines.push(
    "Use these as creative guidance, blended with the specific generation request above. The attached reference images carry the visual style; the brief carries the strategic intent.",
  );
  return lines.join("\n");
}

/**
 * Output of pickBrandReferenceUrls. Returns not just the URLs but also a
 * flag indicating whether any typography reference is included, so the
 * caller can append the negative-literal-copy prompt suffix when it is
 * (F6).
 */
interface PickedBrandRefs {
  urls: string[];
  has_typography_ref: boolean;
}

/**
 * Pick up to maxRefs reference image URLs from the brand asset library
 * for a given prompt. Strategy:
 *   1. Always include the logo (max 1).
 *   2. Add concept-matched tags via suggestedTagsForConcept.
 *   3. Reserve 1 slot for a TYPOGRAPHY_REFERENCE asset if available
 *      (F6: this lets the model use the brand's typographic style
 *      without copying literal text; the caller appends a special
 *      prompt suffix when has_typography_ref is true).
 *   4. Pad with HERO if still under 3 refs.
 *   5. Pad with ASPIRATIONAL for cold-start brands with <2 refs.
 *
 * Returns absolute Followr CDN URLs. Duplicates are filtered. The cap
 * is the practical max for nano_banana_2 (~5); see TODO_V2.md item for
 * revisiting per-model.
 */
async function pickBrandReferenceUrls(
  ctx: BrandContext,
  promptText: string,
  maxRefs: number,
): Promise<PickedBrandRefs> {
  if (!ctx.identity) return { urls: [], has_typography_ref: false };
  const out: string[] = [];
  const seen = new Set<string>();
  let typographyAdded = false;
  // Live-read picker: pickBrandReferenceAssetIds hits listAssets per tag,
  // so manual uploads / deletions made via the Followr UI between
  // loadBrandContext and now are picked up immediately. The JSON map is
  // metadata only; the folder is the source of truth.
  const addByTag = async (tag: BrandTag, limit: number): Promise<number> => {
    let added = 0;
    const ids = await pickBrandReferenceAssetIds(
      ctx.client,
      ctx.companyId,
      ctx.identity!,
      tag,
    );
    for (const id of ids) {
      if (added >= limit) break;
      const url = ctx.assetIdToUrl.get(id);
      if (!url || seen.has(url)) continue;
      out.push(url);
      seen.add(url);
      added += 1;
      if (tag === BRAND_TAGS.TYPOGRAPHY_REFERENCE) typographyAdded = true;
      if (out.length >= maxRefs) return added;
    }
    return added;
  };
  // 1. Always logo first.
  await addByTag(BRAND_TAGS.LOGO, 1);

  // 2. Concept-matched tags. Compute remaining budget BEFORE reserving
  // 1 slot for the typography ref (so the typography slot doesn't eat
  // into a concept-relevant slot when both apply). Live-check typography
  // ref availability once instead of inside the loop.
  const suggestedTags = suggestedTagsForConcept(promptText);
  const typographyAssets = await pickBrandReferenceAssetIds(
    ctx.client,
    ctx.companyId,
    ctx.identity,
    BRAND_TAGS.TYPOGRAPHY_REFERENCE,
  );
  const typoBudget = typographyAssets.length > 0 ? 1 : 0;
  const conceptBudget = Math.max(0, maxRefs - out.length - typoBudget);
  let conceptSpent = 0;
  for (const tag of suggestedTags) {
    if (conceptSpent >= conceptBudget) break;
    conceptSpent += await addByTag(tag, conceptBudget - conceptSpent);
  }

  // 3. Typography ref (F6) at the end, leaving its slot reserved.
  if (typoBudget > 0 && out.length < maxRefs) {
    await addByTag(BRAND_TAGS.TYPOGRAPHY_REFERENCE, 1);
  }

  // 4. Pad with HERO if still under 3 refs.
  if (out.length < 3) await addByTag(BRAND_TAGS.HERO, maxRefs - out.length);
  // 5. Final pad with ASPIRATIONAL for cold-start brands.
  if (out.length < 2) await addByTag(BRAND_TAGS.ASPIRATIONAL, maxRefs - out.length);

  return {
    urls: out.slice(0, maxRefs),
    has_typography_ref: typographyAdded,
  };
}

/**
 * Suffix appended to AI image prompts when at least one of the
 * reference_image_urls is a TYPOGRAPHY_REFERENCE asset (F6). Instructs the
 * model to use the typographic STYLE (font weight, letter shapes, kerning,
 * alignment) without copying the literal text content of the reference.
 *
 * This is essential because vision models otherwise tend to lift the
 * actual text from the reference into the generated image, producing
 * outputs that say something different than the user intended.
 */
function buildTypographyRefSuffix(): string {
  return [
    "",
    "--- TYPOGRAPHY REFERENCE NOTICE ---",
    "One or more of the reference images is provided strictly as a TYPOGRAPHY STYLE reference. Use it to inform the typographic character of any text in the generated image: font weight, letter shapes, kerning, alignment style, decorative treatment. DO NOT copy the literal text content from the typography reference. The text in the generated image should follow the prompt above, NOT the words in the reference.",
  ].join("\n");
}

/**
 * Merge caller-provided reference URLs with brand auto-injected URLs,
 * de-duplicated, capped at 5 (the practical limit for nano_banana_2 and
 * similar models; more refs beyond 5 yield diminishing returns).
 */
function mergeReferenceUrls(
  callerSingle: string | undefined,
  callerList: string[] | undefined,
  brandAuto: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string | undefined) => {
    if (!u || seen.has(u) || out.length >= 5) return;
    out.push(u);
    seen.add(u);
  };
  push(callerSingle);
  for (const u of callerList ?? []) push(u);
  for (const u of brandAuto) push(u);
  return out;
}

/**
 * HEAD-probe a list of reference image URLs in parallel. Returns the
 * subset that responded 2xx and looked like images. Used as a guard
 * before passing brand identity references to /api/aiResults/image:
 * stale signed URLs, deleted assets, or non-image content-types are
 * the suspected cause of the "Missing required parameter: 'images'"
 * error class seen with nano_banana_2 in execute_content_plan v0.4.4
 * (the SPA web does NOT pre-inject brand refs, so it never hits the
 * same failure mode).
 *
 * Never blocks: a refusing remote (HEAD not supported, network blip)
 * leaves the URL on the OK list rather than dropping it. Worst case we
 * pass through to the backend with a slightly stale URL, which is what
 * the v0.4.3 behavior did anyway. Best case we drop the actually-broken
 * URL before it poisons the request.
 */
async function filterReachableImageUrls(
  urls: string[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ valid: string[]; dropped: Array<{ url: string; reason: string }> }> {
  if (urls.length === 0) return { valid: [], dropped: [] };
  const probes = await Promise.all(
    urls.map(async (url): Promise<{ url: string; ok: boolean; reason?: string }> => {
      try {
        const resp = await fetchImpl(url, { method: "HEAD" });
        if (!resp.ok) {
          return { url, ok: false, reason: `HTTP ${resp.status}` };
        }
        const contentType = resp.headers.get("content-type") ?? "";
        // Be liberal: many CDNs return image/* and some return
        // application/octet-stream with a correct extension. Only drop
        // explicit non-image content types.
        if (contentType && !contentType.startsWith("image/") && !contentType.startsWith("application/octet-stream")) {
          return { url, ok: false, reason: `non-image content-type "${contentType}"` };
        }
        return { url, ok: true };
      } catch (err) {
        // Network blip / HEAD blocked: assume usable rather than drop.
        return { url, ok: true, reason: `head_probe_failed:${err instanceof Error ? err.message : String(err)}` };
      }
    }),
  );
  const valid: string[] = [];
  const dropped: Array<{ url: string; reason: string }> = [];
  for (const p of probes) {
    if (p.ok) {
      valid.push(p.url);
    } else {
      dropped.push({ url: p.url, reason: p.reason ?? "unknown" });
    }
  }
  return { valid, dropped };
}

/**
 * Detects the class of backend error that we want to recover from by
 * retrying without reference images. Pattern observed: nano_banana_2
 * occasionally rejects a call with "Missing required parameter:
 * 'images'" or a generic 4xx when reference URLs included in the
 * request are unreachable or in a format the provider rejects. The SPA
 * web of Followr does NOT pre-inject brand refs and never hits this
 * failure mode (verified empirically 2026-05-24 with the same prompt +
 * model + count).
 */
function isImageRefRejectionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("missing required parameter") ||
    m.includes("'images'") ||
    m.includes("invalid image") ||
    m.includes("image_urls") ||
    m.includes("reference image")
  );
}

async function resolveAssetSourceFresh(
  client: FollowrClient,
  companyId: number,
  ref: AssetSourceRef,
  prefs: AiPreferences,
  brandContext: BrandContext,
): Promise<ResolvedAsset> {
  const { src, mode, aspect_ratio } = ref;
  if (src.type === "asset_id") {
    // For asset_id reuse we can still surface the URL when we have it
    // (via brandContext.assetIdToUrl loaded at execute time). This unlocks
    // carousel chaining when a mid-slide is a reused asset.
    return {
      asset_id: src.id,
      asset_url: brandContext.assetIdToUrl.get(src.id) ?? null,
      credits_consumed: 0,
      ai_result_id: null,
    };
  }
  if (src.type === "url") {
    const a = await uploadFromUrl(client, {
      companyId,
      url: src.url,
      type: mode === "image" ? "image" : "video",
    });
    return {
      asset_id: a.id,
      asset_url: (a as Asset & { url?: string }).url ?? null,
      credits_consumed: 0,
      ai_result_id: null,
    };
  }
  if (src.type === "ai_generate" && mode === "image") {
    const imgSrc = src as Extract<ImageSrc, { type: "ai_generate" }>;

    // ── ROUTE: Creative Studio vs legacy ─────────────────────────────────────
    // Default to Creative Studio for nano_banana_* models (or unspecified
    // model). Fallback to legacy generate_image for any other model
    // (recraftv3, flux_pro, ideogram_v3, gpt-image-2, etc.) or when the
    // caller opts out via use_creative_studio: false.
    //
    // Agregado 2026-05-25 como Phase A del refactor BVI → Creative Studio.
    const csCompatibleModels = new Set(["nano_banana_2", "nano_banana_pro"]);
    const modelIsCsCompat =
      imgSrc.model === undefined || csCompatibleModels.has(imgSrc.model);
    const wantsCreativeStudio =
      (imgSrc.use_creative_studio ?? true) && modelIsCsCompat;

    if (wantsCreativeStudio) {
      // Read cached visual_style marker for default style_key
      const company = await client.getCompany(companyId);
      const cachedMarker = parseVisualStyleMarker(company.description ?? null);
      const styleKey =
        cachedMarker && isValidStyleSlug(cachedMarker.slug)
          ? cachedMarker.slug
          : AI_DECIDES_SLUG;
      const standardRatio = (imgSrc.aspect_ratio ?? prefs.image_aspect_ratio ?? "1:1") as StandardAspectRatio;
      const csAspectRatio = toCreativeStudioAspectRatio(standardRatio);
      const csModel = imgSrc.model ?? "nano_banana_2";

      try {
        const creative = await client.createCreative(companyId, {
          content_type: "single",
          style_key: styleKey,
          prompt: imgSrc.prompt,
          aspect_ratio: csAspectRatio,
          slide_count: 1,
          model: csModel,
          brand_context: company.description ?? "",
          include_brand_logo: true,
          use_brand_colors: true,
          image_urls:
            imgSrc.reference_image_url
              ? [imgSrc.reference_image_url]
              : imgSrc.reference_image_urls && imgSrc.reference_image_urls.length > 0
                ? imgSrc.reference_image_urls.slice(0, 4)
                : null,
          carousel_format: null,
        });

        const final = await client.waitForCreative(creative.id, {
          expectedSlides: 1,
          intervalMs: 3000,
          timeoutMs: 3 * 60_000,
        });

        const firstResult = final.ai_results?.[0];
        const firstImage = firstResult?.images?.[0];
        if (!firstImage?.url) {
          throw new Error(
            `Creative ${creative.id} completed but ai_results[0].images[0] is missing or has no url. ai_results status: ${firstResult?.status ?? "missing"}`,
          );
        }

        // Re-upload to asset library so the post can reference asset_id
        const asset = await uploadFromUrl(client, {
          companyId,
          url: firstImage.url,
          type: "image",
          name: `creative-${creative.id}-slide-1.jpg`,
        });

        // Map credits: nano_banana_2 = 25 cr/slide, pro = 45 cr/slide
        const creditsConsumed = csModel === "nano_banana_pro" ? 45 : 25;

        return {
          asset_id: asset.id,
          asset_url: (asset as Asset & { url?: string }).url ?? firstImage.url,
          credits_consumed: creditsConsumed,
          ai_result_id: firstResult?.id ?? null,
        };
      } catch (err) {
        // Si Creative Studio falla, NO caemos al legacy automáticamente
        // porque el error podría ser por content_policy del prompt y reintentar
        // con otro endpoint no resolvería. Surface el error claro al caller.
        throw new Error(
          `Creative Studio generation failed: ${err instanceof Error ? err.message : String(err)}. Si querés fallback al legacy /api/aiResults/image, retry con use_creative_studio: false en el plan_item.`,
        );
      }
    }

    // ── LEGACY PATH: generate_image directo (fall-through) ───────────────────
    const aiDriver = resolveDriver({ prefs, modality: "image", model: imgSrc.model });
    const resolvedAspectRatio = imgSrc.aspect_ratio ?? prefs.image_aspect_ratio;

    // Decide whether brand-aware grounding applies. Defaults to true; the
    // agent can opt out per-source by setting use_brand_visual_identity:false.
    // Skips silently when the company has no brand identity configured.
    const useBrand = (imgSrc.use_brand_visual_identity ?? true) && brandContext.identity !== null;
    // Three suffix tiers for brand grounding, in priority order:
    //   1. Full identity suffix (brief + palette + typography + anti-patterns) when BVI is configured.
    //   2. Soft palette-only suffix when BVI is missing but the company has palettes saved on its profile.
    //   3. None when nothing is available.
    // The agent's per-source use_brand_visual_identity:false opt-out skips
    // tier 1 only; the palette fallback still applies because palettes are a
    // weaker, purely chromatic anchor that doesn't constrain composition.
    const brandSuffix = useBrand && brandContext.identity
      ? buildBrandPromptSuffix(brandContext.identity)
      : brandContext.identity === null && brandContext.fallbackPalettes.length > 0
        ? buildSoftPalettePromptSuffix(brandContext.fallbackPalettes)
        : "";
    const brandRefsPicked = useBrand
      ? await pickBrandReferenceUrls(brandContext, imgSrc.prompt, 4)
      : { urls: [] as string[], has_typography_ref: false };

    // Merge caller-provided refs (legacy single + new plural) with brand
    // auto-refs. Cap at 5 total.
    const mergedRefs = mergeReferenceUrls(
      imgSrc.reference_image_url,
      imgSrc.reference_image_urls,
      brandRefsPicked.urls,
    );

    // Pre-flight reachability check on the merged ref list. Stale signed
    // URLs / deleted brand assets / wrong content-types are the suspected
    // cause of "Missing required parameter: 'images'" failures from
    // nano_banana_2 (verified empirically that the SPA web has no such
    // pre-injection and never fails). This step is best-effort: if HEAD
    // probing is itself blocked, the URL stays on the list. See
    // filterReachableImageUrls for the policy.
    const probe = await filterReachableImageUrls(mergedRefs);
    const finalRefs = probe.valid;
    if (probe.dropped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[execute_content_plan] Dropped ${probe.dropped.length} unreachable reference image(s) before generation: ${probe.dropped.map((d) => `${d.url} (${d.reason})`).join("; ")}`,
      );
    }

    // F6: when at least one reference is a TYPOGRAPHY_REFERENCE asset,
    // append the negative-literal-copy suffix so the model uses the
    // typographic style WITHOUT copying the literal text content.
    const typoSuffix = brandRefsPicked.has_typography_ref ? buildTypographyRefSuffix() : "";

    // Final prompt: caller prompt + anti-placeholder suffix + brand suffix
    // + (optional) typography reference notice. Order matters: placeholder
    // prohibition first (most important), then brand guidance (style),
    // then typography notice (specific to text rendering). All sit AFTER
    // the user prompt so they don't dilute its primary intent.
    const finalPrompt = `${hardenAiImagePrompt(imgSrc.prompt)}${brandSuffix}${typoSuffix}`;

    const buildPayload = (refs: string[]) => ({
      q: finalPrompt,
      company_id: companyId,
      ...(resolvedAspectRatio ? { aspect_ratio: resolvedAspectRatio } : {}),
      ...(imgSrc.model ? { model: imgSrc.model } : {}),
      ...(aiDriver ? { driver: aiDriver } : {}),
      // Prefer the new plural field when we have more than one ref; fall back
      // to the legacy singular when only one is present (which is what the
      // pre-F3 behavior used, so semantics are preserved).
      ...(refs.length > 1
        ? { image_urls: refs }
        : refs.length === 1
          ? { image_url: refs[0] }
          : {}),
    });

    let aiResult;
    let usedRefs = finalRefs;
    let retriedWithoutRefs = false;
    try {
      aiResult = await client.generateImage(buildPayload(finalRefs));
    } catch (err) {
      // First-attempt failure with refs in the payload: retry once
      // without refs if the error class matches the known ref-rejection
      // pattern. Recovery is "best effort"; if the second attempt also
      // fails we surface the original error context to the caller.
      const message = err instanceof Error ? err.message : String(err);
      if (finalRefs.length > 0 && isImageRefRejectionError(message)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[execute_content_plan] generateImage failed with ref-related error ("${message.slice(0, 200)}"); retrying without ${finalRefs.length} reference image(s).`,
        );
        usedRefs = [];
        retriedWithoutRefs = true;
        aiResult = await client.generateImage(buildPayload([]));
      } else {
        throw err;
      }
    }
    const final = await client.waitForAiResult(aiResult.id, { timeoutMs: 5 * 60 * 1000 });
    if (final.status !== "completed") {
      const retryNote = retriedWithoutRefs
        ? " (retry without refs after initial ref-related failure also did not complete)"
        : finalRefs.length > 0
          ? ` (payload included ${finalRefs.length} reference image(s); model=${imgSrc.model ?? "default"})`
          : "";
      throw new Error(
        `AI image generation failed (id=${final.id}, status=${final.status}, message=${final.status_message ?? "no message"})${retryNote}. Backend response: ${JSON.stringify(final).slice(0, 500)}`,
      );
    }
    // Use usedRefs.length to silence the unused-variable lint when no
    // retry happened. The variable carries useful debug info above.
    void usedRefs;
    const imageUrl =
      (final as unknown as { image_url?: string; response?: string }).image_url ??
      (final as unknown as { response?: string }).response;
    if (!imageUrl || typeof imageUrl !== "string") {
      throw new Error(`AI image generation completed but no image URL was returned (id=${final.id}).`);
    }
    const m = IMAGE_MODELS.find((x) => x.model_id === (imgSrc.model ?? "nano_banana_2"));
    const credits = m ? m.cost_per_image : 25;
    const a = await uploadFromUrl(client, { companyId, url: imageUrl, type: "image" });
    return {
      asset_id: a.id,
      asset_url: (a as Asset & { url?: string }).url ?? null,
      credits_consumed: credits,
      ai_result_id: final.id,
    };
  }
  if (src.type === "ai_generate" && mode === "video") {
    const vidSrc = src as Extract<VideoSrc, { type: "ai_generate" }>;
    const aiDriver = resolveDriver({ prefs, modality: "video", model: vidSrc.model });
    const aiResult = await client.generateAiVideoClip({
      type: "video",
      q: vidSrc.prompt,
      aspect_ratio: aspect_ratio ?? "9:16",
      model: vidSrc.model,
      company_id: companyId,
      ...(aiDriver ? { driver: aiDriver } : {}),
      ...(vidSrc.reference_image_url ? { image_url: vidSrc.reference_image_url } : {}),
    });
    const final = await client.waitForAiResult(aiResult.id, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000 });
    if (final.status !== "completed") {
      throw new Error(
        `AI video generation failed (model=${vidSrc.model}, id=${final.id}, status=${final.status}, message=${final.status_message ?? "no message"}). Backend response: ${JSON.stringify(final).slice(0, 500)}`,
      );
    }
    const m = VIDEO_MODELS.find((x) => x.model_id === vidSrc.model);
    const duration = vidSrc.duration_seconds ?? m?.default_duration_seconds ?? 8;
    const credits = (m?.cost_per_second ?? 400) * duration;
    const videoUrl =
      (final as unknown as { video_url?: string; response?: string }).video_url ??
      (final as unknown as { response?: string }).response;
    if (!videoUrl || typeof videoUrl !== "string") {
      throw new Error(`AI video generation completed but no video URL was returned (id=${final.id}).`);
    }
    const a = await uploadFromUrl(client, { companyId, url: videoUrl, type: "video" });
    return {
      asset_id: a.id,
      asset_url: (a as Asset & { url?: string }).url ?? null,
      credits_consumed: credits,
      ai_result_id: final.id,
    };
  }
  if (src.type === "ai_avatar_lipsync" || src.type === "ai_avatar_video") {
    // execute_content_plan v1 does not run avatar tools end-to-end. The
    // agent has to materialize the avatar asset manually and then point
    // the plan at the resulting asset id. The original draft already
    // committed to a SHAPE (single-scene lipsync vs multi-scene with
    // subtitles); the recovery suggestion must preserve that shape and
    // not silently degrade to lipsync to save credits.
    const targetTool =
      src.type === "ai_avatar_video"
        ? "generate_avatar_video"
        : "generate_avatar_lipsync_clip";
    const shapeNote =
      src.type === "ai_avatar_video"
        ? "Multi-scene reel with burned-in subtitles, transitions, and per-scene backgrounds. Do NOT substitute generate_avatar_lipsync_clip even if it looks cheaper: that tool produces a single bare talking head without subtitles, which is a different output shape than what the plan committed to."
        : "Single-scene bare talking head, no subtitles, no concat. This shape was chosen explicitly at draft time; do not upgrade to generate_avatar_video unless the user re-confirms.";
    throw new Error(
      `Asset strategy ${src.type} is not supported by execute_content_plan in v1. Generate the avatar video first by calling ${targetTool} (the tool that matches the plan's avatar shape), then pass the resulting asset id via assets_strategy.video_source = { type: "asset_id", id: <n> } and re-run execute_content_plan. ${shapeNote}`,
    );
  }
  throw new Error(`Unknown asset source type: ${(src as { type?: string }).type ?? "unknown"}`);
}

interface SubPostAssetResolution {
  sub_post_index: number;
  asset_ids: number[];
  error?: string;
}

/**
 * Returns true when a sub_post should resolve its carousel sources
 * sequentially (so previous slide's output URL can be passed as a
 * reference to the next slide's generation). Criterion: 2+ ai_generate
 * image slides in the carousel. Mixed carousels with asset_id / url
 * slides still chain because those slides have stable URLs we can pass
 * forward.
 */
function shouldChainCarousel(sp: SubPost, refs: AssetSourceRef[]): boolean {
  if (sp.asset_layout !== "carousel_images") return false;
  let aiImageCount = 0;
  for (const r of refs) {
    if (r.mode !== "image") continue;
    if (r.src.type === "ai_generate") aiImageCount += 1;
  }
  return aiImageCount >= 2;
}

/**
 * Resolve a sequence of carousel sources one after the other, feeding
 * slide N-1's resolved URL into slide N's reference_image_urls. This is
 * F4: image-to-image chaining for visual continuity across slides.
 *
 * The resolver uses the original resolveOnce closure (which caches by
 * fingerprint), so chained slides get unique fingerprints (because the
 * injected ref changes the fingerprint) and resolve to distinct
 * generations. Non-chained refs (asset_id, url) pass through unchanged.
 */
async function resolveCarouselSourcesSequential(
  refs: AssetSourceRef[],
  resolveOnce: (ref: AssetSourceRef) => Promise<ResolvedAsset>,
): Promise<ResolvedAsset[]> {
  const results: ResolvedAsset[] = [];
  let previousUrl: string | null = null;
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i]!;
    // Only AI-generated image slides receive the chain reference. Other
    // types (asset_id, url) pass through with their original ref.
    if (i > 0 && ref.src.type === "ai_generate" && ref.mode === "image" && previousUrl) {
      const imgSrc = ref.src as Extract<ImageSrc, { type: "ai_generate" }>;
      // Append previousUrl as an additional reference_image_urls entry.
      // mergeReferenceUrls in resolveAssetSourceFresh will cap to 5 total.
      const chainedImgSrc: typeof imgSrc = {
        ...imgSrc,
        reference_image_urls: [
          ...(imgSrc.reference_image_urls ?? []),
          previousUrl,
        ],
      };
      const chainedRef: AssetSourceRef = { ...ref, src: chainedImgSrc };
      const resolved = await resolveOnce(chainedRef);
      results.push(resolved);
      previousUrl = resolved.asset_url ?? previousUrl;
    } else {
      const resolved = await resolveOnce(ref);
      results.push(resolved);
      // Even non-AI slides contribute their URL to the chain so a mid-
      // carousel asset_id or url slide doesn't break continuity for the
      // AI slides that come after it.
      if (resolved.asset_url) previousUrl = resolved.asset_url;
    }
  }
  return results;
}

function subPostAssetRefs(sp: SubPost, item: PlanItem): AssetSourceRef[] {
  const refs: AssetSourceRef[] = [];
  const aspect = videoAspectRatioForSubPostInItem(sp, item);
  if (sp.assets_strategy.image_source) {
    refs.push({ src: sp.assets_strategy.image_source, mode: "image" });
  }
  if (sp.assets_strategy.carousel_sources) {
    for (const s of sp.assets_strategy.carousel_sources) {
      refs.push({ src: s, mode: "image" });
    }
  }
  if (sp.assets_strategy.video_source) {
    refs.push({ src: sp.assets_strategy.video_source, mode: "video", aspect_ratio: aspect });
  }
  return refs;
}

async function executePlanItem(
  client: FollowrClient,
  companyId: number,
  item: PlanItem,
  prefs: AiPreferences,
  copyCtx: CopyResolutionContext,
  brandContext: BrandContext,
  schedulingCtx: {
    /**
     * True when listSocialNetworks returned at least one connection for this
     * company. We only schedule (publish_at + auto_publish) when the company
     * can actually publish; otherwise the PostGroup stays as a pure draft so
     * the user can connect networks later and approve from the UI.
     */
    hasConnectedNetworks: boolean;
    /**
     * IANA timezone used to interpret item.publish_at_time_local. Resolved by
     * the caller from plan.auto_publish_schedule.timezone, the Company's own
     * timezone, or "UTC" as final fallback.
     */
    scheduleTimezone: string;
  },
): Promise<Record<string, unknown>> {
  // 1. Build a fingerprint-keyed promise cache so any AI generation
  // (or URL upload) requested by multiple sub_posts is performed exactly
  // once. The cached Promise is reused across consumers, which means a
  // 9:16 reel cross-posted to IG Reel + FB Reel + TikTok now costs ONE
  // generation instead of three. Pre-refactor each sub_post resolved its
  // strategy independently, billing every duplicate generation. Verified
  // against the VCP 2026-05-21 session where the lunes reel was billed
  // 3×400 cr instead of 1×400.
  const resolveCache = new Map<string, Promise<ResolvedAsset>>();
  const resolveOnce = (ref: AssetSourceRef): Promise<ResolvedAsset> => {
    const fp = fingerprintAssetSource(ref);
    let p = resolveCache.get(fp);
    if (!p) {
      p = resolveAssetSourceFresh(client, companyId, ref, prefs, brandContext);
      resolveCache.set(fp, p);
    }
    return p;
  };

  let assetResolutions: SubPostAssetResolution[];
  try {
    assetResolutions = await Promise.all(
      item.sub_posts.map(async (sp, idx): Promise<SubPostAssetResolution> => {
        const refs = subPostAssetRefs(sp, item);
        try {
          // F4: carousel image-to-image chaining. When a sub_post is a
          // carousel with 2+ AI image generations, we resolve them
          // SEQUENTIALLY and feed slide N-1's output URL as an extra
          // reference into slide N. This gives the model strong visual
          // continuity (typography, lighting, framing) across siblings,
          // at the cost of N×generation_time latency instead of max().
          //
          // Auto-detect criterion: assets_strategy.carousel_sources with
          // 2+ ai_generate slides. Non-AI slides (asset_id or url) pass
          // through their resolved URL too, so a mixed carousel still
          // chains through every slide.
          //
          // Single-image / single-video sub_posts and non-AI carousels
          // continue to resolve in parallel as before.
          const needsCarouselChaining = shouldChainCarousel(sp, refs);
          let resolved: ResolvedAsset[];
          if (needsCarouselChaining) {
            resolved = await resolveCarouselSourcesSequential(refs, resolveOnce);
          } else {
            resolved = await Promise.all(refs.map(resolveOnce));
          }
          return { sub_post_index: idx, asset_ids: resolved.map((r) => r.asset_id) };
        } catch (e) {
          return {
            sub_post_index: idx,
            asset_ids: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
  } catch (e) {
    return {
      slug: item.slug,
      date: item.date,
      status: "failed_resolving_assets",
      error_message: e instanceof Error ? e.message : String(e),
      credits_consumed_estimate: 0,
      recovery_suggestion: "Asset resolution failed unexpectedly. Check connectivity to Followr and retry.",
    };
  }

  // Total credits consumed: sum each UNIQUE cache entry exactly once. The
  // pre-refactor totals double-counted shared generations because each
  // sub_post tracked its own consumption.
  const settledCache = await Promise.allSettled(Array.from(resolveCache.values()));
  const creditsConsumed = settledCache.reduce(
    (acc, r) => acc + (r.status === "fulfilled" ? r.value.credits_consumed : 0),
    0,
  );

  const anyFail = assetResolutions.find((r) => r.error);
  if (anyFail) {
    // List the sub_posts that completed asset resolution successfully along
    // with the asset ids they ended up with. The agent can swap those into
    // the plan via update_content_plan + replace_sub_post with assets_strategy
    // pointing at { type: "asset_id", id } so a retry does not re-bill the
    // credits already spent on this attempt.
    const succeededSubPostAssets = assetResolutions
      .filter((r) => !r.error && r.asset_ids.length > 0)
      .map((r) => ({
        sub_post_index: r.sub_post_index,
        asset_ids: r.asset_ids,
      }));
    const failedSubPost = item.sub_posts[anyFail.sub_post_index];
    return {
      slug: item.slug,
      date: item.date,
      status: "failed_resolving_assets",
      error_message: anyFail.error,
      failed_sub_post_index: anyFail.sub_post_index,
      failed_sub_post_network: failedSubPost?.social_network ?? null,
      failed_sub_post_strategy: failedSubPost?.assets_strategy ?? null,
      succeeded_sub_post_assets: succeededSubPostAssets,
      credits_consumed_estimate: creditsConsumed,
      recovery_suggestion:
        succeededSubPostAssets.length > 0
          ? `Sub_post #${anyFail.sub_post_index} failed but ${succeededSubPostAssets.length} other sub_post(s) generated assets successfully (${creditsConsumed} cr already spent). To retry WITHOUT double-billing: (1) call update_content_plan with one replace_sub_post per entry in succeeded_sub_post_assets, swapping assets_strategy to { type: "asset_id", id: <asset_id> } for each completed asset. (2) Separately fix the failing sub_post (e.g. swap to a non-premium video model when blocked_by_plan, change prompt, point at an asset_id). (3) Call execute_content_plan(plan_id, plan_item_slugs: ["${item.slug}"], confirm: true) to retry just this item.`
          : `One sub_post failed to resolve its assets and no other sub_post had completed yet. Fix the failing sub_post with update_content_plan (e.g. change the video model when blocked_by_plan is true on the chosen model) and retry execute_content_plan with plan_item_slugs: ["${item.slug}"] to retry just this item.`,
    };
  }

  // Defense in depth: if any sub_post resolved without an error but ended
  // up with an empty asset_ids list, refuse to create the post. Empty
  // strategies should be caught by validateLayoutShape upstream, but a
  // back-compat plan (assets_strategy hand-built around asset_plan only)
  // or a deleted referenced asset can sneak through. Creating a post
  // without media on a network that requires media leaves a broken draft
  // and looks exactly like the FB/IG "copy attached, image missing" bug
  // reported on 2026-05-21.
  const emptyAssetsFail = assetResolutions.find((r) => r.asset_ids.length === 0);
  if (emptyAssetsFail) {
    const sp = item.sub_posts[emptyAssetsFail.sub_post_index]!;
    return {
      slug: item.slug,
      date: item.date,
      status: "failed_resolving_assets",
      error_message: `sub_post[${emptyAssetsFail.sub_post_index}] (${sp.social_network} ${sp.product_type} ${sp.asset_layout}) resolved to zero asset_ids. The assets_strategy is empty or every source resolved to a deleted asset. Refusing to create a post with no media.`,
      failed_sub_post_index: emptyAssetsFail.sub_post_index,
      failed_sub_post_network: sp.social_network,
      failed_sub_post_strategy: sp.assets_strategy,
      credits_consumed_estimate: creditsConsumed,
      recovery_suggestion:
        "Re-check the sub_post's assets_strategy with update_content_plan: confirm image_source / carousel_sources / video_source matches the asset_layout. Re-run execute_content_plan after fixing.",
    };
  }

  // 2. Decide whether to schedule the PostGroup or leave it as a draft.
  // Rule: only schedule (publish_at + auto_publish) when BOTH the plan item
  // carries a concrete publish_at_time_local AND the company actually has
  // at least one social network connected. Without networks the user cannot
  // publish anyway, so the legacy draft-only behavior is preserved so they
  // can connect networks later and approve from the Followr UI.
  const wantSchedule =
    schedulingCtx.hasConnectedNetworks &&
    typeof item.publish_at_time_local === "string" &&
    item.publish_at_time_local.length > 0;
  const publishAtUtc = wantSchedule
    ? localDateTimeToUtcIso(item.date, item.publish_at_time_local, schedulingCtx.scheduleTimezone)
    : null;
  const scheduled = wantSchedule && publishAtUtc !== null;
  let group;
  try {
    group = await client.createPostGroup(companyId, {
      // Scheduling path: PostGroup is published automatically at publish_at.
      // Draft path (no scheduling): traditional behavior; the user must
      // schedule manually from the UI.
      draft: !scheduled,
      ...(scheduled ? { publish_at: publishAtUtc, auto_publish: true } : {}),
      title: item.concept_shared.slice(0, 120),
      description: item.concept_shared,
      topic: item.concept_shared.slice(0, 60),
    });
  } catch (e) {
    return {
      slug: item.slug,
      date: item.date,
      status: "failed_creating_post_group",
      error_message: e instanceof Error ? e.message : String(e),
      credits_consumed_estimate: creditsConsumed,
      recovery_suggestion:
        "Asset library uploads / AI generations succeeded but the PostGroup creation failed (likely a Followr API issue). The assets are persisted in your library; you can reuse them via asset_id by updating the plan and retrying.",
    };
  }

  // 3. Create per-network Posts inside that PostGroup. Sequential to keep
  // backend load reasonable; per-post the backend is fast.
  const postResults: Array<{
    sub_post_index: number;
    social_network: SocialNetwork;
    status: "created" | "failed";
    error_message?: string;
    /** Which path resolved the post description. Surfaces in the result so the
     * agent can tell the user "the copy was generated server-side" vs "the
     * copy you wrote was used verbatim". */
    copy_resolution_path?: "copy_draft" | "generated" | "directive_fallback";
    /** AI result id for the fallback generation. null when copy_draft was used. */
    copy_ai_result_id?: number | null;
  }> = [];

  for (let i = 0; i < item.sub_posts.length; i++) {
    const sp = item.sub_posts[i] as SubPost;
    const resolution = assetResolutions.find((r) => r.sub_post_index === i)!;
    const internalNetworkId =
      NETWORK_FORMAT_COMPATIBILITY[`${sp.social_network}:${sp.product_type}`]?.internal_id ??
      sp.social_network;
    try {
      // Auto-inject media_product_type for the networks that require it
      // (IG, FB, YouTube). Followr accepts UPPERCASE singular only. Same
      // logic as posts.ts/create_post and post-groups.ts/bulk; the
      // pre-existing branch that omitted media_product_type for
      // product_type=feed was the root cause of the lunes VCP bug where
      // IG/FB Reels were rejected with "media product type is invalid"
      // (lowercase) and also the secondary FB/IG feed bug where the
      // missing field could leave assets unattached when defaults drifted.
      const initialPreferences: Record<string, unknown> = NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE.has(
        sp.social_network,
      )
        ? { media_product_type: productTypeToFollowr(sp.product_type) }
        : {};
      // Pass through the normalizer for defense in depth: covers the case
      // where future code paths inject preferences with wrong case (e.g.
      // YouTube privacy_level uppercase) and would silently 422. Map
      // SocialNetwork "x" -> NetworkType "twitter" for the lookup.
      const normalizerNetwork = (sp.social_network === "x" ? "twitter" : sp.social_network) as
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
      const { normalized: preferences } = normalizePreferences(initialPreferences, normalizerNetwork);
      // Resolve the description BEFORE createPost. Path A uses copy_draft
      // verbatim (preferred when the agent wrote it during draft). Path B
      // calls Followr's generate_chat using the caption_concept as the
      // editorial brief + brand context. Path C falls back to the
      // directive itself if generation fails. Whatever path is chosen,
      // the persisted description is publication-ready, not a directive.
      const copyResolution = await resolvePostDescription(client, companyId, sp, copyCtx);
      await client.createPost(group.id, {
        social_network_type: internalNetworkId,
        description: copyResolution.description,
        assets_ids: resolution.asset_ids,
        preferences,
      });
      postResults.push({
        sub_post_index: i,
        social_network: sp.social_network,
        status: "created",
        copy_resolution_path: copyResolution.path,
        copy_ai_result_id: copyResolution.ai_result_id,
      });
    } catch (e) {
      postResults.push({
        sub_post_index: i,
        social_network: sp.social_network,
        status: "failed",
        error_message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const subPostsCreated = postResults.filter((p) => p.status === "created").length;
  const subPostsFailed = postResults.length - subPostsCreated;

  if (subPostsCreated === 0) {
    // Roll back the empty PostGroup to avoid orphans.
    try {
      await client.deletePostGroup(group.id);
    } catch {
      // Non-fatal: surface in details.
    }
    return {
      slug: item.slug,
      date: item.date,
      status: "failed_creating_posts",
      error_message:
        postResults.find((p) => p.status === "failed")?.error_message ?? "All sub_posts failed.",
      credits_consumed_estimate: creditsConsumed,
      sub_post_results: postResults,
      recovery_suggestion:
        "PostGroup was deleted to avoid leaving an orphan. The assets remain in your library. Fix the per-sub_post issues with update_content_plan and retry.",
    };
  }

  // Count unique vs requested asset references so the agent can surface
  // the savings ("3 sub_posts cross-posted 1 video instead of 3").
  const totalRequestedSources = item.sub_posts.reduce(
    (acc, sp) => acc + subPostAssetRefs(sp, item).length,
    0,
  );
  const uniqueAssetGenerations = resolveCache.size;

  // Pre-built user-facing message in plain Spanish without IDs. The
  // agent should reproduce/adapt this text verbatim to the user; raw IDs
  // belong inside _internal_* fields below and must NEVER be surfaced.
  // Discipline reminder: PLANNING_STRATEGY.never_show_internal_ids.
  const networksCreated = postResults
    .filter((p) => p.status === "created")
    .map((p) => displayNetworkName(p.social_network));
  const networksFailed = postResults
    .filter((p) => p.status === "failed")
    .map((p) => displayNetworkName(p.social_network));
  const reuseLine =
    uniqueAssetGenerations < totalRequestedSources
      ? ` Se generaron ${uniqueAssetGenerations} asset${uniqueAssetGenerations === 1 ? "" : "s"} reutilizando entre ${totalRequestedSources - uniqueAssetGenerations} redes adicionales (ahorro de ${totalRequestedSources - uniqueAssetGenerations} generación${totalRequestedSources - uniqueAssetGenerations === 1 ? "" : "es"}).`
      : "";
  // Wording note: we used to say "créditos", but the deprecated `credits`
  // counter on User mixes legacy AppSumo lifetime credits with topups and
  // doesn't reflect the actual gating bucket. The real bucket is
  // ai_image_and_video_budget. Surfacing "generaciones de imagen/video" is
  // both more accurate (it IS the unit of the budget) and less likely to
  // confuse the user into checking the wrong counter. Cf. MEMORY note
  // 'credits != budget'.
  const generationsLabel = creditsConsumed === 1 ? "generación de imagen/video" : "generaciones de imagen/video";
  // State label adapts to whether the PostGroup was scheduled (it appears on
  // the user's Followr calendar and auto-publishes at publish_at) or stayed
  // as a draft (no schedule, sits in the drafts view until the user acts).
  const stateLabel = scheduled
    ? `calendarizado para el ${item.date} a las ${item.publish_at_time_local}`
    : `listo como borrador del ${item.date} ${item.publish_at_time_local}`;
  const userFacingSummary =
    subPostsFailed === 0
      ? `Posteo "${item.concept_shared}" ${stateLabel} en ${networksCreated.join(", ")}. Costo: ${creditsConsumed} ${generationsLabel}.${reuseLine}`
      : `Posteo "${item.concept_shared}" ${stateLabel}: creado para ${networksCreated.join(", ") || "ninguna red"}, falló en ${networksFailed.join(", ")}. Costo: ${creditsConsumed} ${generationsLabel}.${reuseLine}`;

  return {
    slug: item.slug,
    date: item.date,
    publish_at_time_local: item.publish_at_time_local,
    status: subPostsFailed === 0 ? "created" : "partially_created",
    // Scheduling outcome. When scheduled is true the PostGroup is on the
    // user's Followr calendar and will auto-publish at publish_at. When
    // false it is a pure draft sitting in the drafts view; the user must
    // schedule manually from the UI. Surface this to the user in plain
    // language (never the field names) so they know what to expect next.
    scheduled,
    publish_at: scheduled ? publishAtUtc : null,
    user_facing_summary: userFacingSummary,
    sub_posts_created: subPostsCreated,
    sub_posts_failed: subPostsFailed,
    sub_post_results: postResults,
    credits_consumed_estimate: creditsConsumed,
    asset_reuse_summary: {
      total_requested_sources: totalRequestedSources,
      unique_resolutions: uniqueAssetGenerations,
      duplicates_avoided: Math.max(0, totalRequestedSources - uniqueAssetGenerations),
    },
    // Internal-only fields. The agent uses these to feed follow-up tool
    // calls (e.g. update_post_group, list_comments). NEVER mention them
    // to the user verbatim; refer to the post by concept_shared and date.
    _internal_post_group_id: group.id,
    _internal_asset_ids_per_sub_post: assetResolutions.map((r) => ({
      sub_post_index: r.sub_post_index,
      asset_ids: r.asset_ids,
    })),
  };
}

// Networks where Followr's API requires preferences.media_product_type to be
// set. Mirrors NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE in posts.ts and post-groups.ts;
// kept in this module so execute_content_plan does not depend on the standalone
// tool internals.
const NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE: ReadonlySet<SocialNetwork> = new Set([
  "instagram",
  "facebook",
  "youtube",
]);

// Followr's API accepts UPPERCASE singular: FEED | REEL | STORY | SHORT.
// Lowercase ("reel", "feed") and plurals ("REELS", "SHORTS") return HTTP 422
// "media product type is invalid". Verified empirically and documented in
// docs/followr-api/posts.md.
function productTypeToFollowr(pt: ProductType): string {
  switch (pt) {
    case "feed":
      return "FEED";
    case "reel":
      return "REEL";
    case "story":
      return "STORY";
    case "short":
      return "SHORT";
    case "long_video":
      return "FEED";
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────

function networkResolutionOptions(network: SocialNetwork, requestedType: ProductType) {
  // Map each network to the product_types it actually accepts.
  const accepted = Object.entries(NETWORK_FORMAT_COMPATIBILITY)
    .filter(([key]) => key.startsWith(`${network}:`))
    .flatMap(([, spec]) => spec.accepts.map((a) => a.product_type));
  return [
    {
      id: "change_product_type",
      description: `Change product_type to one accepted by ${network}: ${[...new Set(accepted)].join(", ") || "(none configured)"}.`,
    },
    {
      id: "change_network",
      description: `Drop ${network} from networks of this sub_post and target only networks that accept ${requestedType}.`,
    },
  ];
}

function layoutResolutionOptions(network: SocialNetwork, productType: ProductType, layout: AssetLayout) {
  const slotSpec = NETWORK_FORMAT_COMPATIBILITY[`${network}:${productType}`];
  const allowed = slotSpec ? slotSpec.accepts.find((a) => a.product_type === productType)?.asset_layouts ?? [] : [];
  return [
    {
      id: "switch_layout",
      description: `Switch asset_layout to one accepted on ${network} ${productType}: ${allowed.join(", ") || "(none)"}.`,
    },
    {
      id: "split_subpost",
      description: `If the same concept needs ${layout} on another network, split this sub_post into two: keep ${layout} for the network that accepts it, generate a video sub_post for ${network}.`,
    },
  ];
}

function validateLayoutShape(
  layout: AssetLayout,
  strategy: AssetsStrategy,
  maxImagesInCarousel: number,
): string | null {
  if (layout === "single_image") {
    if (!strategy.image_source) return "asset_layout=single_image requires assets_strategy.image_source.";
  } else if (layout === "carousel_images") {
    if (!strategy.carousel_sources || strategy.carousel_sources.length < 2) {
      return "asset_layout=carousel_images requires assets_strategy.carousel_sources with at least 2 items.";
    }
    if (strategy.carousel_sources.length > maxImagesInCarousel) {
      return `asset_layout=carousel_images: this network accepts at most ${maxImagesInCarousel} images, received ${strategy.carousel_sources.length}.`;
    }
  } else if (layout === "single_video" || layout === "single_gif") {
    if (!strategy.video_source) return `asset_layout=${layout} requires assets_strategy.video_source.`;
  } else if (layout === "carousel_mixed") {
    // Only Threads supports mixed. carousel_sources may include video/gif items;
    // we don't enforce strict types here because the API tolerates the variation.
    if (!strategy.carousel_sources || strategy.carousel_sources.length < 2) {
      return "asset_layout=carousel_mixed requires assets_strategy.carousel_sources with at least 2 items.";
    }
  }
  return null;
}

interface SubPostCost {
  image_ai_cost: number;
  image_ai_count: number;
  video_ai_cost: number;
  video_ai_count: number;
  upload_count: number;
  reuse_count: number;
}

/**
 * Plan-level cost estimate that mirrors execute_content_plan's dedupe
 * behavior: a fingerprint that appears N times across sub_posts is charged
 * exactly once. The pre-refactor totals double-counted shared AI
 * generations, so the user saw "1.200 cr" in the draft for a single video
 * cross-posted to 3 networks even though execute_content_plan also billed
 * 1.200 cr (3 separate generations); now both draft AND execute report the
 * deduped cost ("400 cr"), which is what actually gets charged.
 */
function estimatePlanItemCostDeduped(item: PlanItem): SubPostCost {
  const out: SubPostCost = {
    image_ai_cost: 0,
    image_ai_count: 0,
    video_ai_cost: 0,
    video_ai_count: 0,
    upload_count: 0,
    reuse_count: 0,
  };
  const seenFingerprints = new Set<string>();
  for (const sp of item.sub_posts) {
    for (const ref of subPostAssetRefs(sp, item)) {
      const fp = fingerprintAssetSource(ref);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);

      const { src, mode } = ref;
      if (src.type === "url") {
        out.upload_count += 1;
      } else if (src.type === "asset_id") {
        out.reuse_count += 1;
      } else if (src.type === "ai_generate" && mode === "image") {
        const imgSrc = src as Extract<ImageSrc, { type: "ai_generate" }>;
        const m = IMAGE_MODELS.find((x) => x.model_id === (imgSrc.model ?? "nano_banana_2")) ?? IMAGE_MODELS[0];
        out.image_ai_count += 1;
        out.image_ai_cost += m?.cost_per_image ?? 25;
      } else if (src.type === "ai_generate" && mode === "video") {
        const vidSrc = src as Extract<VideoSrc, { type: "ai_generate" }>;
        const m = VIDEO_MODELS.find((x) => x.model_id === vidSrc.model);
        if (m) {
          out.video_ai_count += 1;
          const duration = vidSrc.duration_seconds ?? m.default_duration_seconds;
          out.video_ai_cost += m.cost_per_second * duration;
        } else {
          // Unknown model: charge a conservative high estimate so the budget
          // check catches the upper bound (equivalent to Veo 3 Fast 8s).
          out.video_ai_count += 1;
          out.video_ai_cost += 400 * 8;
        }
      } else if (src.type === "ai_avatar_lipsync") {
        out.video_ai_count += 1;
        out.video_ai_cost += 25 * 12;
      } else if (src.type === "ai_avatar_video") {
        const sceneCount = src.scripts.length;
        const lipsyncCost = 25 * 10 * sceneCount;
        const backgroundCost = src.generate_backgrounds ? 60 * sceneCount : 0;
        out.video_ai_count += 1;
        out.video_ai_cost += lipsyncCost + backgroundCost;
      }
    }
  }
  return out;
}

/**
 * Map every (item.slug, sub_post_index) to whether its assets are SHARED
 * with another sub_post in the same plan_item via fingerprint dedupe.
 * Used by the summary table and preview so the user sees "1 video x 3
 * networks" instead of three identical rows that look like independent
 * costs.
 */
function computeAssetSharing(plan: ContentPlan): Map<string, { fingerprint: string; share_group: string[] }[]> {
  const out = new Map<string, { fingerprint: string; share_group: string[] }[]>();
  for (const item of plan.plan_items) {
    // Build fingerprint -> list of `{network}#{kind}` consumers within this item.
    const fpConsumers = new Map<string, string[]>();
    for (const sp of item.sub_posts) {
      for (const ref of subPostAssetRefs(sp, item)) {
        const fp = fingerprintAssetSource(ref);
        const label = `${displayNetworkName(sp.social_network)} (${ref.mode})`;
        const list = fpConsumers.get(fp) ?? [];
        list.push(label);
        fpConsumers.set(fp, list);
      }
    }
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const perSubPost: { fingerprint: string; share_group: string[] }[] = [];
      for (const ref of subPostAssetRefs(sp, item)) {
        const fp = fingerprintAssetSource(ref);
        perSubPost.push({ fingerprint: fp, share_group: fpConsumers.get(fp) ?? [] });
      }
      out.set(`${item.slug}#${i}`, perSubPost);
    }
  }
  return out;
}

function buildSummaryTable(plan: ContentPlan): string[] {
  const lines: string[] = [];
  lines.push("| Día | Hora | Concepto | Red | Formato | Asset | Compartido | Costo estimado |");
  lines.push("|-----|------|----------|-----|---------|-------|------------|----------------|");
  const sharing = computeAssetSharing(plan);
  for (const item of plan.plan_items) {
    // Cost is allocated to the FIRST consumer of a fingerprint within the
    // plan_item; subsequent consumers display 0 cr and a "↳ comparte con
    // X" hint. Mirrors execute_content_plan's actual billing.
    const seenInItem = new Set<string>();
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const refs = subPostAssetRefs(sp, item);
      let rowCost = 0;
      for (const ref of refs) {
        const fp = fingerprintAssetSource(ref);
        if (seenInItem.has(fp)) continue;
        seenInItem.add(fp);
        if (ref.src.type === "ai_generate" && ref.mode === "image") {
          const imgSrc = ref.src as Extract<ImageSrc, { type: "ai_generate" }>;
          const m = IMAGE_MODELS.find((x) => x.model_id === (imgSrc.model ?? "nano_banana_2")) ?? IMAGE_MODELS[0];
          rowCost += m?.cost_per_image ?? 25;
        } else if (ref.src.type === "ai_generate" && ref.mode === "video") {
          const vidSrc = ref.src as Extract<VideoSrc, { type: "ai_generate" }>;
          const m = VIDEO_MODELS.find((x) => x.model_id === vidSrc.model);
          rowCost += m ? m.cost_per_second * (vidSrc.duration_seconds ?? m.default_duration_seconds) : 400 * 8;
        }
      }
      const sharingForSubPost = sharing.get(`${item.slug}#${i}`) ?? [];
      const sharedLabels = sharingForSubPost
        .filter((s) => s.share_group.length > 1)
        .map((s) => `con ${s.share_group.length - 1} más`);
      const sharedCell = sharedLabels.length > 0 ? sharedLabels.join("; ") : "-";
      lines.push(
        `| ${item.date} | ${item.publish_at_time_local} | ${i === 0 ? item.concept_shared : "↳ (mismo concepto)"} | ${displayNetworkName(sp.social_network)} | ${displayLayout(sp.asset_layout, sp.product_type)} | ${displayAssetStrategy(sp.assets_strategy, sp.asset_layout)} | ${sharedCell} | ${rowCost > 0 ? `${rowCost} cr` : "0 cr"} |`,
      );
    }
  }
  return lines;
}

function displayNetworkName(network: SocialNetwork): string {
  const map: Record<SocialNetwork, string> = {
    instagram: "Instagram",
    tiktok: "TikTok",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    x: "X / Twitter",
    pinterest: "Pinterest",
    threads: "Threads",
    youtube: "YouTube",
    bluesky: "Bluesky",
  };
  return map[network];
}

function displayLayout(layout: AssetLayout, product: ProductType): string {
  if (product === "reel") return "Reel";
  if (product === "story") return "Story";
  if (product === "short") return "Short";
  if (product === "long_video") return "Video largo";
  // feed
  if (layout === "single_image") return "Foto";
  if (layout === "carousel_images") return "Carrusel";
  if (layout === "single_video") return "Video";
  if (layout === "carousel_mixed") return "Carrusel mixto";
  if (layout === "single_gif") return "GIF";
  return product;
}

// ── Natural-language preview (for preview_plan_item) ──────────────────────

interface AssetPreview {
  kind: "ai_image" | "url_image" | "library_image" | "ai_video" | "url_video" | "library_video" | "avatar_lipsync" | "avatar_video";
  description: string;
  model?: string;
  duration_seconds?: number;
  cost_credits: number;
  reference_image_url?: string;
  /**
   * Human-readable label of what kind of video the user is actually getting.
   * Distinct from `kind`, which is the internal storage discriminator.
   *
   * - "ai_clip_with_audio": AI-generated cinematic clip with native audio
   *   from the model itself (Google Veo 3 family). No human in frame.
   * - "ai_clip_silent": AI-generated cinematic clip with no audio at all
   *   (Wan, Seedance, Hailuo). The user has to add music or sound design
   *   in a video editor afterwards.
   * - "avatar_lipsync": single-scene talking head with a virtual person
   *   speaking the user's script, synthetic voice.
   * - "avatar_multi_scene_video": multi-scene avatar reel with burned-in
   *   subtitles, synthetic voice, one or more scenes concatenated.
   *
   * Set only on video-kind assets. Other kinds leave it undefined.
   */
  video_kind_user_facing?:
    | "ai_clip_with_audio"
    | "ai_clip_silent"
    | "avatar_lipsync"
    | "avatar_multi_scene_video";
  /**
   * Plain-language audio status for video assets, surfaced in the preview
   * so the user is not surprised by a silent Reel. Mirrors the model's
   * audio_capability in user-friendly prose. Undefined on non-video assets.
   */
  audio_status?:
    | "with_native_audio"
    | "silent_video"
    | "synthetic_voice";
}

interface NetworkPreview {
  network: SocialNetwork;
  network_display: string;
  format: string;
  caption_final: string;
  assets: AssetPreview[];
  asset_fingerprints: string[];
  flags: string[];
}

/**
 * Unique asset for a plan_item, with the list of networks that consume it.
 * Surfaced upfront in the preview so the user sees the asset PLAN before
 * the per-network breakdown ("1 video 9:16 que se cross-postea a IG, FB y
 * TikTok" instead of three identical-looking entries).
 */
interface SharedAssetPreview {
  fingerprint: string;
  preview: AssetPreview;
  consumed_by: Array<{ network_display: string; format: string }>;
  // Aspect ratio for videos and orientation hint for images, so the user
  // sees "9:16 vertical" or "2:3 vertical" right next to the asset
  // description. This is what the user asked for: explicit asset spec
  // (kind, aspect, model, cost) in the plan and preview, not buried in
  // per-network rows.
  aspect_or_orientation?: string;
}

/**
 * Compact view of which asset lands in which carousel slot, per network.
 * Rendered as a table by the agent to surface reuse explicitly:
 *
 *   slot | LinkedIn         | Instagram
 *   -----|------------------|------------------
 *   1    | cover-li         | cover-ig
 *   2    | step01-li        | step01-ig
 *   3    | shared:step02 ✦  | shared:step02 ✦
 *   4    | shared:step03 ✦  | shared:step03 ✦
 *   5    | shared:cta ✦     | shared:cta ✦
 *
 * Cells flagged with "shared" indicate the asset is reused across networks
 * (one generation, multiple consumers). Cells WITHOUT the shared marker
 * are network-unique generations, so the agent can ask "do you really need
 * two distinct covers?" when it sees two non-shared near-duplicate rows.
 */
interface AssetReuseMatrixCell {
  /**
   * Stable token identifying the asset for THIS slot+network pair. For
   * shared assets this matches across networks; for unique assets it
   * differs.
   */
  token: string;
  /** True when the same asset is consumed by 2+ networks. */
  is_shared: boolean;
  /** Networks that consume this exact asset (display names). */
  consumed_by: string[];
}

interface AssetReuseMatrixRow {
  slot_index: number;
  slot_label: string;
  /** Map from network display name (e.g. "LinkedIn") to the cell. */
  cells: Record<string, AssetReuseMatrixCell | null>;
}

interface AssetReuseMatrix {
  /** Ordered list of network display names in the preview, for column order. */
  networks: string[];
  rows: AssetReuseMatrixRow[];
  /**
   * "3 of 7 slides are shared between LinkedIn and Instagram. 2 covers and 2
   * step01 are network-unique." Pre-rendered prose for the agent.
   */
  human_summary: string;
}

interface ItemPreview {
  plan_id: string;
  slug: string;
  date: string;
  publish_at_local: string;
  timezone: string;
  concept: string;
  rationale: string;
  paired_with: string[];
  networks: NetworkPreview[];
  asset_plan: SharedAssetPreview[];
  asset_reuse_matrix: AssetReuseMatrix;
  totals: {
    asset_count: number;
    image_ai_count: number;
    video_ai_count: number;
    upload_count: number;
    reuse_count: number;
    credits: number;
    estimated_generation_minutes: { min: number; max: number };
  };
  flags: string[];
  rendered_markdown: string;
}

function describeAiImage(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  return clean.length > 320 ? clean.slice(0, 317) + "..." : clean;
}

// Avatar video cost model. Sources:
//   - Lipsync / multi-scene lipsync billing: veed_fabric_1.0 @ 25 cr/sec
//     (documented in ai-results.ts:222 and ai-results.ts:385).
//   - TTS speech rate: ~14 chars/sec measured across recent ElevenLabs
//     runs at default speed for ES + EN; close enough as a planning
//     estimate. Floor at 8 sec because Followr enforces a payload floor.
//   - Background generation (multi-scene with generate_backgrounds=true):
//     ~60 cr per scene median, measured on recent multi-scene runs. The
//     actual cost is dominated by an image-to-image generation per scene.
//
// The prior estimator used a flat 12 sec for lipsync (300 cr fixed) and
// 10 sec/scene for multi-scene (250 cr/scene), which silently
// underbilled long scripts. Real example from a recent session: 3 scripts
// of ~30 chars each => prior estimate 750 cr, actual ~750 cr. Same
// scripts of ~150 chars each => prior estimate 750 cr, actual ~1500 cr.
// The new estimator scales with script length.
const AVATAR_TTS_COST_PER_SECOND = 25;
const AVATAR_BACKGROUND_COST_PER_SCENE = 60;
const AVATAR_TTS_CHARS_PER_SECOND = 14;
const AVATAR_TTS_FLOOR_SECONDS = 8;

function estimateTtsSeconds(script: string): number {
  const chars = script.trim().length;
  if (chars === 0) return AVATAR_TTS_FLOOR_SECONDS;
  return Math.max(AVATAR_TTS_FLOOR_SECONDS, Math.round(chars / AVATAR_TTS_CHARS_PER_SECOND));
}

// ── Manual materialization detector (P4 fix, 2026-05-26) ──────────────────
//
// execute_content_plan v1 does NOT run avatar tools (generate_avatar_video,
// generate_avatar_lipsync_clip) end-to-end. When a plan_item.sub_post has
// video_source.type === "ai_avatar_video" or "ai_avatar_lipsync", the
// executor throws "Asset strategy ai_avatar_* is not supported" at item
// resolution time.
//
// Pre 2026-05-26 the agent discovered this at execute time and improvised
// (PipeLime session: agent had to back out, generate the avatar manually,
// then re-route). This helper surfaces the same information UPFRONT at
// draft / update / preview time so the agent can plan the dance.

interface ManualMaterializationStep {
  fingerprint: string;
  source_type: "ai_avatar_lipsync" | "ai_avatar_video";
  suggested_tool: "generate_avatar_lipsync_clip" | "generate_avatar_video";
  avatar_id: number;
  scripts_count: number;
  generate_backgrounds: boolean;
  estimated_total_seconds: number;
  estimated_credits: number;
  shape_note: string;
  consumed_by: Array<{
    slug: string;
    sub_post_index: number;
    network_display: string;
  }>;
  next_action_for_agent: string;
}

interface ManualMaterializationBlock {
  count: number;
  total_estimated_credits: number;
  affected_plan_item_slugs: string[];
  steps: ManualMaterializationStep[];
  user_message: string;
  instructions_for_agent: string;
}

function collectManualMaterializationSteps(
  plan_items: PlanItem[],
): ManualMaterializationBlock | null {
  const byFingerprint = new Map<string, ManualMaterializationStep>();

  for (const item of plan_items) {
    for (let idx = 0; idx < item.sub_posts.length; idx++) {
      const sp = item.sub_posts[idx]!;
      const vs = sp.assets_strategy.video_source;
      if (!vs) continue;
      if (vs.type !== "ai_avatar_lipsync" && vs.type !== "ai_avatar_video") continue;
      const fp = fingerprintAssetSource({ src: vs, mode: "video" });
      const consumer = {
        slug: item.slug,
        sub_post_index: idx,
        network_display: displayNetworkName(sp.social_network),
      };
      const existing = byFingerprint.get(fp);
      if (existing) {
        existing.consumed_by.push(consumer);
        continue;
      }
      const isMulti = vs.type === "ai_avatar_video";
      const scripts = isMulti ? vs.scripts : [vs.script];
      const totalSeconds = scripts
        .map((s) => estimateTtsSeconds(s))
        .reduce((a, b) => a + b, 0);
      const generateBackgrounds = isMulti ? vs.generate_backgrounds ?? false : false;
      const speechCost = AVATAR_TTS_COST_PER_SECOND * totalSeconds;
      const bgCost = generateBackgrounds
        ? AVATAR_BACKGROUND_COST_PER_SCENE * scripts.length
        : 0;
      const totalCost = speechCost + bgCost;
      const suggestedTool: ManualMaterializationStep["suggested_tool"] = isMulti
        ? "generate_avatar_video"
        : "generate_avatar_lipsync_clip";
      const shapeNote = isMulti
        ? "Multi-scene reel con burned-in subtitles, transitions y per-scene backgrounds. NO substituir por generate_avatar_lipsync_clip aunque parezca más barato: es un output distinto."
        : "Single-scene talking head, sin subtitles, sin concat. Es la SHAPE elegida en draft; no upgradear a generate_avatar_video sin re-confirmar con el user.";
      const callHint = isMulti
        ? `scripts=[${scripts.length} item(s)]${generateBackgrounds ? ", generate_backgrounds=true" : ""}`
        : "script=<el único script del plan>";
      byFingerprint.set(fp, {
        fingerprint: fp,
        source_type: vs.type,
        suggested_tool: suggestedTool,
        avatar_id: vs.avatar_id,
        scripts_count: scripts.length,
        generate_backgrounds: generateBackgrounds,
        estimated_total_seconds: totalSeconds,
        estimated_credits: totalCost,
        shape_note: shapeNote,
        consumed_by: [consumer],
        next_action_for_agent: `Llamá ${suggestedTool}(company_id, avatar_id=${vs.avatar_id}, ${callHint}), esperá el video resultante, después llamá update_content_plan con un replace_sub_post por cada entry de consumed_by (swap video_source a { type: "asset_id", id: <asset_id_resultante> }), y finalmente execute_content_plan(plan_id, plan_item_slugs=[<los slugs cubiertos>], confirm=true).`,
      });
    }
  }

  if (byFingerprint.size === 0) return null;

  const steps = Array.from(byFingerprint.values());
  const totalCredits = steps.reduce((a, s) => a + s.estimated_credits, 0);
  const affectedSlugs = Array.from(
    new Set(steps.flatMap((s) => s.consumed_by.map((c) => c.slug))),
  );

  return {
    count: steps.length,
    total_estimated_credits: totalCredits,
    affected_plan_item_slugs: affectedSlugs,
    steps,
    user_message: `Aviso importante: este plan tiene ${steps.length} pieza(s) con avatar (${affectedSlugs.length} día(s) afectado(s)) que requieren un paso extra de mi parte antes de publicar, aprox ${totalCredits} créditos en total para esos videos. Las voy a generar una por una, las agrego al plan y recién ahí se publica el día completo. Los días sin avatar se publican directo, sin esa pausa.`,
    instructions_for_agent: `ANTES del cost summary y de pedir aprobación final, surface manual_materialization_required.user_message al usuario. Después, cuando el user apruebe el plan, el flujo correcto es: (1) para cada step, llamar suggested_tool y esperar el asset, (2) llamar update_content_plan con replace_sub_post para cada entry de consumed_by swappeando video_source a { type: "asset_id", id: <asset_id> }, (3) execute_content_plan con plan_item_slugs cubriendo los slugs afectados. Los plan_items NO afectados (sin avatar) se ejecutan con execute_content_plan normalmente sin esa danza. NUNCA llamar execute_content_plan sobre los slugs en affected_plan_item_slugs sin antes completar (1) y (2): el executor tira "Asset strategy ai_avatar_* is not supported by execute_content_plan in v1" y aborta el item. Cuando el user pide "arrancá con los primeros 2 posteos" y uno de esos 2 está en affected_plan_item_slugs, hacer la danza para ese antes de publicar.`,
  };
}

function describeAssetSource(
  src: NonNullable<AssetsStrategy["image_source"] | AssetsStrategy["video_source"]> | NonNullable<AssetsStrategy["carousel_sources"]>[number],
  mode: "image" | "video",
): AssetPreview {
  if (src.type === "url") {
    return {
      kind: mode === "image" ? "url_image" : "url_video",
      description: `Asset desde URL: ${src.url}`,
      cost_credits: 0,
    };
  }
  if (src.type === "asset_id") {
    return {
      kind: mode === "image" ? "library_image" : "library_video",
      description: `Reusa el asset #${src.id} de la biblioteca de Followr`,
      cost_credits: 0,
    };
  }
  if (src.type === "ai_generate" && mode === "image") {
    const modelId = ("model" in src && src.model) || "nano_banana_2";
    const m = IMAGE_MODELS.find((x) => x.model_id === modelId);
    const desc: AssetPreview = {
      kind: "ai_image",
      description: describeAiImage(src.prompt),
      model: modelId,
      cost_credits: m?.cost_per_image ?? 25,
    };
    if ("reference_image_url" in src && src.reference_image_url) {
      desc.reference_image_url = src.reference_image_url;
    }
    return desc;
  }
  if (src.type === "ai_generate" && mode === "video") {
    const modelId = "model" in src ? src.model : undefined;
    const m = modelId ? VIDEO_MODELS.find((x) => x.model_id === modelId) : undefined;
    const dur = "duration_seconds" in src ? (src.duration_seconds ?? m?.default_duration_seconds ?? 8) : 8;
    const audioCap = m?.audio_capability ?? "silent_only";
    const desc: AssetPreview = {
      kind: "ai_video",
      description: describeAiImage(src.prompt),
      model: modelId,
      duration_seconds: dur,
      cost_credits: m ? m.cost_per_second * dur : 400 * dur,
      video_kind_user_facing:
        audioCap === "with_native_audio" ? "ai_clip_with_audio" : "ai_clip_silent",
      audio_status:
        audioCap === "with_native_audio" ? "with_native_audio" : "silent_video",
    };
    if ("reference_image_url" in src && src.reference_image_url) {
      desc.reference_image_url = src.reference_image_url;
    }
    return desc;
  }
  if (src.type === "ai_avatar_lipsync") {
    // Estimate speech duration from script length. ElevenLabs TTS at
    // default speed reads at roughly ~14 chars/sec for Spanish and
    // English (verified empirically across recent avatar lipsync runs).
    // Minimum 8 seconds because Followr enforces a floor on TTS payload.
    // Billing model: 25 cr/sec on veed_fabric_1.0 (the only lipsync
    // model wired in for avatars).
    const seconds = estimateTtsSeconds(src.script);
    return {
      kind: "avatar_lipsync",
      description: `Avatar lipsync (avatar #${src.avatar_id}, ~${seconds}s). Script: "${describeAiImage(src.script)}"`,
      cost_credits: AVATAR_TTS_COST_PER_SECOND * seconds,
      duration_seconds: seconds,
      video_kind_user_facing: "avatar_lipsync",
      audio_status: "synthetic_voice",
    };
  }
  if (src.type === "ai_avatar_video") {
    // Sum the per-scene speech duration, then bill the total at 25 cr/sec.
    // Backgrounds (when enabled) add an image-to-image generation per
    // scene; empirically 60 cr/scene is the median observed (verified
    // across recent multi-scene runs with generate_backgrounds=true).
    const perSceneSeconds = src.scripts.map((s) => estimateTtsSeconds(s));
    const totalSeconds = perSceneSeconds.reduce((a, b) => a + b, 0);
    const speechCost = AVATAR_TTS_COST_PER_SECOND * totalSeconds;
    const bgCost = src.generate_backgrounds
      ? AVATAR_BACKGROUND_COST_PER_SCENE * src.scripts.length
      : 0;
    return {
      kind: "avatar_video",
      description: `Avatar video con ${src.scripts.length} escena(s) (avatar #${src.avatar_id}, ~${totalSeconds}s totales)${src.generate_backgrounds ? ", con backgrounds generados" : ""}.`,
      cost_credits: speechCost + bgCost,
      duration_seconds: totalSeconds,
      video_kind_user_facing: "avatar_multi_scene_video",
      audio_status: "synthetic_voice",
    };
  }
  return { kind: "ai_image", description: "(asset desconocido)", cost_credits: 0 };
}

function buildItemPreview(
  plan: ContentPlan,
  item: PlanItem,
  followrPlusEnabled: boolean | null,
): ItemPreview {
  const networks: NetworkPreview[] = [];
  const flags: string[] = [];
  let maxVideoSeconds = 0;

  // Only flag premium-bucket models as plan-blocked when the account actually
  // lacks Followr Plus. For Plus users premium models are simply premium-tier
  // (informational, not actionable), so the warning would be noise. When plus
  // status could not be determined (null), skip the flag to avoid misfiring.
  const flagBlockedByPlan = followrPlusEnabled === false;

  // Pre-compute fingerprints and the unique asset plan.
  const sharedAssetPlan: SharedAssetPreview[] = [];
  const fpIndex = new Map<string, SharedAssetPreview>();

  for (const sp of item.sub_posts) {
    const assets: AssetPreview[] = [];
    const subPostFingerprints: string[] = [];
    const networkFlags: string[] = [];
    const refs = subPostAssetRefs(sp, item);

    const checkPlanBlock = (a: AssetPreview) => {
      if (!flagBlockedByPlan) return;
      if (a.kind === "ai_image" && a.model) {
        const im = IMAGE_MODELS.find((m) => m.model_id === a.model);
        if (im && im.bucket === "premium") {
          networkFlags.push(
            `La imagen usa ${im.display_name} (premium). Esta cuenta no tiene Followr Plus activado y el backend va a rechazar el modelo con "selected model is invalid". Cambiá a nano_banana_2 o z_image_turbo con update_content_plan antes de ejecutar.`,
          );
        }
      } else if (a.kind === "ai_video" && a.model) {
        const vm = VIDEO_MODELS.find((m) => m.model_id === a.model);
        if (vm && vm.bucket === "premium") {
          networkFlags.push(
            `El video usa ${vm.display_name} (premium). Esta cuenta no tiene Followr Plus activado y el backend va a rechazar el modelo con "selected model is invalid". Cambiá a wan_2.2 (único video regular) con update_content_plan antes de ejecutar.`,
          );
        }
      }
    };

    for (const ref of refs) {
      const a = describeAssetSource(ref.src, ref.mode);
      assets.push(a);
      const fp = fingerprintAssetSource(ref);
      subPostFingerprints.push(fp);
      checkPlanBlock(a);
      if (a.duration_seconds && a.duration_seconds > maxVideoSeconds) {
        maxVideoSeconds = a.duration_seconds;
      }

      const consumer = { network_display: displayNetworkName(sp.social_network), format: displayLayout(sp.asset_layout, sp.product_type) };
      const existing = fpIndex.get(fp);
      if (existing) {
        existing.consumed_by.push(consumer);
      } else {
        // Aspect/orientation hint. For video we use the resolved aspect
        // ratio (9:16 for reels/tiktok, 16:9 otherwise). For images we
        // leave it undefined; the LLM passes orientation via prompt.
        let aspect: string | undefined;
        if (ref.mode === "video" && ref.aspect_ratio) aspect = ref.aspect_ratio;
        const entry: SharedAssetPreview = {
          fingerprint: fp,
          preview: a,
          consumed_by: [consumer],
        };
        if (aspect !== undefined) entry.aspect_or_orientation = aspect;
        fpIndex.set(fp, entry);
        sharedAssetPlan.push(entry);
      }
    }

    networks.push({
      network: sp.social_network,
      network_display: displayNetworkName(sp.social_network),
      format: displayLayout(sp.asset_layout, sp.product_type),
      caption_final: sp.copy_draft && sp.copy_draft.trim().length > 0 ? sp.copy_draft : sp.caption_concept,
      assets,
      asset_fingerprints: subPostFingerprints,
      flags: networkFlags,
    });
  }

  // Totals are dedupe-aware (each unique asset counted once). Mirrors
  // execute_content_plan billing.
  let imageAiCount = 0;
  let videoAiCount = 0;
  let uploadCount = 0;
  let reuseCount = 0;
  let creditsTotal = 0;
  for (const e of sharedAssetPlan) {
    creditsTotal += e.preview.cost_credits;
    switch (e.preview.kind) {
      case "ai_image":
        imageAiCount += 1;
        break;
      case "url_image":
      case "url_video":
        uploadCount += 1;
        break;
      case "library_image":
      case "library_video":
        reuseCount += 1;
        break;
      case "ai_video":
      case "avatar_lipsync":
      case "avatar_video":
        videoAiCount += 1;
        break;
    }
  }

  if (!plan.use_brand_voice) {
    flags.push("use_brand_voice está en false: los copys finales no van a usar el brand voice prompt aunque esté cargado.");
  }

  // Quality-upgrade heuristic deliberately removed (2026-05-24): the prior
  // code detected "hero/launch/cinematic" keywords in the rationale and
  // suggested swapping the cheap model for veo_3_fast (~3200 cr/8s) or
  // nano_banana_pro (~45 cr) on those items. The detection produced
  // confusing "tu pieza hero podría ser mejor" warnings and silently
  // upsold parts of the plan to 8x more expensive video. The product
  // direction is now: every piece in a plan is treated equally, the user
  // picks the model tier explicitly at draft time (or upgrades a specific
  // item via update_content_plan), and the agent never auto-flags some
  // items as "more important" than others.

  const minGen = imageAiCount > 0 ? 1 : 0;
  const maxGen = imageAiCount * 0.5 + (videoAiCount > 0 ? 10 : 0);
  const reuseMatrix = buildAssetReuseMatrix(item, networks);
  const rendered = renderMarkdown({
    plan,
    item,
    networks,
    asset_plan: sharedAssetPlan,
    reuse_matrix: reuseMatrix,
    totals: { imageAiCount, videoAiCount, uploadCount, reuseCount, creditsTotal },
    estimatedGenerationMinutes: { min: Math.max(1, Math.round(minGen)), max: Math.max(2, Math.round(maxGen)) },
    flags,
  });

  return {
    plan_id: plan.plan_id,
    slug: item.slug,
    date: item.date,
    publish_at_local: item.publish_at_time_local,
    timezone: item.timezone,
    concept: item.concept_shared,
    rationale: item.rationale,
    paired_with: item.paired_with ?? [],
    networks,
    asset_plan: sharedAssetPlan,
    asset_reuse_matrix: reuseMatrix,
    totals: {
      asset_count: imageAiCount + videoAiCount + uploadCount + reuseCount,
      image_ai_count: imageAiCount,
      video_ai_count: videoAiCount,
      upload_count: uploadCount,
      reuse_count: reuseCount,
      credits: creditsTotal,
      estimated_generation_minutes: { min: Math.max(1, Math.round(minGen)), max: Math.max(2, Math.round(maxGen)) },
    },
    flags,
    rendered_markdown: rendered,
  };
}

/**
 * Compute the per-slot, per-network reuse matrix for a plan_item. The matrix
 * has one row per carousel slot (or one row for single-asset layouts) and
 * one column per network. Each cell carries a stable token derived from the
 * asset fingerprint so the agent can spot shared assets at a glance: cells
 * with the same token across multiple columns are reused, cells with a
 * unique token are network-specific generations.
 *
 * The human_summary line at the bottom is pre-rendered so the agent can
 * paste it verbatim ("3 of 7 slides are shared across LinkedIn and
 * Instagram; 2 cover slides and 2 step-01 slides are network-unique").
 */
function buildAssetReuseMatrix(item: PlanItem, networks: NetworkPreview[]): AssetReuseMatrix {
  const networkNames = networks.map((n) => n.network_display);
  const maxSlots = networks.reduce((acc, n) => Math.max(acc, n.asset_fingerprints.length), 0);
  // Pre-compute consumer index from fingerprint to networks. Two cells with
  // the same fingerprint => same asset, reused. The token is a short stable
  // hash-ish derived from the fingerprint; we use a counter to keep it
  // readable ("a1", "a2", "shared-a3"...).
  const fpToToken = new Map<string, string>();
  const fpToConsumers = new Map<string, Set<string>>();
  for (const n of networks) {
    for (const fp of n.asset_fingerprints) {
      const set = fpToConsumers.get(fp) ?? new Set<string>();
      set.add(n.network_display);
      fpToConsumers.set(fp, set);
    }
  }
  let counter = 1;
  for (const n of networks) {
    for (const fp of n.asset_fingerprints) {
      if (!fpToToken.has(fp)) {
        const isShared = (fpToConsumers.get(fp)?.size ?? 0) > 1;
        const token = isShared ? `shared-a${counter}` : `a${counter}`;
        fpToToken.set(fp, token);
        counter += 1;
      }
    }
  }

  const rows: AssetReuseMatrixRow[] = [];
  // Slot labels: cover (1), step n, ..., last is CTA when the layout looks
  // like a step-flow carousel. Otherwise generic "slot N". Best-effort
  // heuristic. The rendered_markdown still surfaces the actual asset
  // description from sharedAssetPlan, so a wrong label here doesn't break
  // anything; it's just a readability hint.
  const slotLabelFor = (idx: number, total: number): string => {
    if (total <= 1) return "asset";
    if (idx === 0) return "cover / slot 1";
    if (idx === total - 1) return `slot ${idx + 1} (CTA o cierre)`;
    return `slot ${idx + 1}`;
  };

  for (let slot = 0; slot < Math.max(1, maxSlots); slot += 1) {
    const cells: Record<string, AssetReuseMatrixCell | null> = {};
    for (const n of networks) {
      const fp = n.asset_fingerprints[slot];
      if (!fp) {
        cells[n.network_display] = null;
        continue;
      }
      const token = fpToToken.get(fp) ?? `a${slot}`;
      const consumers = Array.from(fpToConsumers.get(fp) ?? new Set<string>());
      cells[n.network_display] = {
        token,
        is_shared: consumers.length > 1,
        consumed_by: consumers,
      };
    }
    rows.push({ slot_index: slot, slot_label: slotLabelFor(slot, Math.max(1, maxSlots)), cells });
  }

  // Compute human-readable summary.
  const totalCells = rows.reduce(
    (acc, r) => acc + Object.values(r.cells).filter((c) => c !== null).length,
    0,
  );
  const sharedCells = rows.reduce(
    (acc, r) => acc + Object.values(r.cells).filter((c) => c?.is_shared === true).length,
    0,
  );
  const uniqueAssets = new Set(Array.from(fpToToken.values()));
  const reusedAssets = Array.from(fpToToken.values()).filter((t) => t.startsWith("shared-")).length;
  const summary =
    networks.length <= 1
      ? `Una sola red, ${uniqueAssets.size} pieza${uniqueAssets.size === 1 ? "" : "s"} en total.`
      : `${uniqueAssets.size} pieza${uniqueAssets.size === 1 ? "" : "s"} única${uniqueAssets.size === 1 ? "" : "s"} para ${networks.length} redes. ${reusedAssets} se reusa${reusedAssets === 1 ? "" : "n"} entre redes (una sola generación, varios destinos), cubriendo ${sharedCells} de ${totalCells} apariciones.`;
  void item; // referenced for future per-item label hints
  return { networks: networkNames, rows, human_summary: summary };
}

function renderMarkdown(args: {
  plan: ContentPlan;
  item: PlanItem;
  networks: NetworkPreview[];
  asset_plan: SharedAssetPreview[];
  reuse_matrix: AssetReuseMatrix;
  totals: { imageAiCount: number; videoAiCount: number; uploadCount: number; reuseCount: number; creditsTotal: number };
  estimatedGenerationMinutes: { min: number; max: number };
  flags: string[];
}): string {
  const { item, networks, asset_plan, reuse_matrix, totals, estimatedGenerationMinutes, flags } = args;
  const lines: string[] = [];
  lines.push(`### ${item.date} a las ${item.publish_at_time_local} (${item.timezone})`);
  lines.push("");
  lines.push(`**Concepto:** ${item.concept_shared}`);
  lines.push("");
  if (item.rationale) {
    lines.push(`**Por qué este post:** ${item.rationale}`);
    lines.push("");
  }

  // Plan de assets: SoT of what gets generated. Listed upfront so the
  // user sees "1 video 9:16 cross-posteado a IG/FB/TikTok" instead of
  // three identical-looking entries one per network. This is also what
  // tells the user "estás pagando POR asset único, no por sub_post":
  // crucial after the 2026-05-21 incident where 3 identical videos were
  // billed instead of 1.
  lines.push(`**Plan de assets (${asset_plan.length} ${asset_plan.length === 1 ? "asset único" : "assets únicos"}):**`);
  lines.push("");
  asset_plan.forEach((e, i) => {
    const aspect = e.aspect_or_orientation ? ` ${e.aspect_or_orientation}` : "";
    const where = e.consumed_by.map((c) => `${c.network_display} (${c.format})`).join(", ");
    const reuseTag = e.consumed_by.length > 1 ? ` · reusado en ${e.consumed_by.length} redes` : "";
    lines.push(`${i + 1}. **${describeAssetKind(e.preview)}${aspect}**${reuseTag}`);
    lines.push(`   - Va a: ${where}`);
    if (e.preview.description) {
      lines.push(`   - Detalle: ${e.preview.description}`);
    }
    if (e.preview.reference_image_url) {
      lines.push(`   - Imagen de referencia: ${e.preview.reference_image_url}`);
    }
  });
  lines.push("");

  for (const n of networks) {
    lines.push(`#### ${n.network_display} (${n.format})`);
    lines.push("");
    lines.push(`**Copy:**`);
    lines.push("");
    lines.push(`> ${n.caption_final.replace(/\n/g, "\n> ")}`);
    lines.push("");
    // Reference assets by their position in the plan. The per-network
    // section no longer repeats the asset description (that lives in
    // the Plan de assets block above), it just points to which assets
    // this sub_post consumes.
    if (n.asset_fingerprints.length > 0) {
      const positions = n.asset_fingerprints.map((fp) => asset_plan.findIndex((e) => e.fingerprint === fp) + 1);
      const positionsLabel = positions.length === 1 ? `el asset #${positions[0]}` : `los assets #${positions.join(", #")}`;
      lines.push(`**Usa ${positionsLabel} del Plan de assets.**`);
      lines.push("");
    }
    if (n.flags.length > 0) {
      for (const f of n.flags) {
        lines.push(`> ⚠️ ${f}`);
      }
      lines.push("");
    }
  }
  // Asset reuse matrix block. Lists each carousel slot as a row and each
  // network as a column. Shared assets carry the "shared-" prefix on the
  // token, so the table makes reuse impossible to miss without forcing the
  // agent to re-explain it in prose. Cells reused across networks are
  // flagged with the cross-reference marker (✦).
  if (reuse_matrix.rows.length > 0 && reuse_matrix.networks.length > 1) {
    lines.push("**Matriz de reuso de assets por slot y red:**");
    lines.push("");
    lines.push(`| Slot | ${reuse_matrix.networks.join(" | ")} |`);
    lines.push(`|------|${reuse_matrix.networks.map(() => "------").join("|")}|`);
    for (const row of reuse_matrix.rows) {
      const cells = reuse_matrix.networks.map((n) => {
        const cell = row.cells[n];
        if (!cell) return "-";
        const mark = cell.is_shared ? " ✦" : "";
        return `${cell.token}${mark}`;
      });
      lines.push(`| ${row.slot_label} | ${cells.join(" | ")} |`);
    }
    lines.push("");
    lines.push(`> ${reuse_matrix.human_summary}`);
    lines.push("");
  }
  lines.push(`**Totales:** ${totals.imageAiCount} imágenes AI + ${totals.videoAiCount} videos AI${totals.uploadCount ? ` + ${totals.uploadCount} subidas` : ""}${totals.reuseCount ? ` + ${totals.reuseCount} assets reusados` : ""}. Costo estimado: ${totals.creditsTotal} ${totals.creditsTotal === 1 ? "generación de imagen/video" : "generaciones de imagen/video"} (ai_image_and_video_budget). Tiempo de generación: ${estimatedGenerationMinutes.min}-${estimatedGenerationMinutes.max} min.`);
  if (flags.length > 0) {
    lines.push("");
    lines.push("**Alertas:**");
    for (const f of flags) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}

function describeAssetKind(a: AssetPreview): string {
  switch (a.kind) {
    case "ai_image": {
      const model = IMAGE_MODELS.find((m) => m.model_id === a.model);
      const name = model?.display_name ?? "imagen con IA";
      return `Imagen generada con IA (${name}, ${a.cost_credits} cr)`;
    }
    case "url_image":
      return "Foto del sitio (sin generar nada)";
    case "library_image":
      return "Foto que ya está cargada en la biblioteca";
    case "ai_video": {
      const model = a.model ? VIDEO_MODELS.find((m) => m.model_id === a.model) : undefined;
      const name = model?.display_name ?? "video con IA";
      const dur = a.duration_seconds ?? 8;
      // The audio status changes how the user will perceive the asset, so
      // it deserves to be in the label itself (not buried in a sub-field).
      // Stays in plain language, no model_ids, no internal flags.
      const audioLabel =
        a.audio_status === "with_native_audio"
          ? "con audio nativo"
          : "sin sonido, lo agregás vos después en un editor";
      return `Video generado con IA (${name}, ${dur}s, ${audioLabel}, ${a.cost_credits} cr)`;
    }
    case "url_video":
      return "Video del sitio (sin generar nada)";
    case "library_video":
      return "Video que ya está cargado en la biblioteca";
    case "avatar_lipsync":
      return `Avatar virtual hablando a cámara (voz sintética del script, ${a.cost_credits} cr)`;
    case "avatar_video":
      return `Avatar virtual narrando varias escenas (voz sintética + subtítulos quemados, ${a.cost_credits} cr)`;
  }
}

function displayAssetStrategy(strategy: AssetsStrategy, layout: AssetLayout): string {
  if (layout === "single_image" && strategy.image_source) {
    if (strategy.image_source.type === "url") return "Foto del sitio";
    if (strategy.image_source.type === "asset_id") return "Foto ya subida";
    if (strategy.image_source.type === "ai_generate") return "Imagen con IA";
  }
  if (layout === "carousel_images" && strategy.carousel_sources) {
    return `${strategy.carousel_sources.length} imágenes (carrusel)`;
  }
  if ((layout === "single_video" || layout === "single_gif") && strategy.video_source) {
    const vs = strategy.video_source;
    if (vs.type === "url") return "Video del sitio";
    if (vs.type === "asset_id") return "Video ya subido";
    if (vs.type === "ai_generate") {
      const model = VIDEO_MODELS.find((m) => m.model_id === vs.model);
      const audioBit = model?.audio_capability === "with_native_audio" ? " con audio" : " sin audio";
      return model ? `Video con IA (${model.display_name}${audioBit})` : "Video con IA";
    }
    if (vs.type === "ai_avatar_lipsync") return "Avatar habla a cámara";
    if (vs.type === "ai_avatar_video") return `Avatar narra ${vs.scripts.length} escena${vs.scripts.length === 1 ? "" : "s"}`;
  }
  return "-";
}

// ── Shared validation pipeline ──────────────────────────────────────────────

interface ValidationCtx {
  company_id: number;
  networks_connected: SocialNetwork[];
  // Initial snapshot captured at prepare_content_plan_context time. Used only
  // as a fallback when the live re-fetch fails. The validation logic
  // re-queries listPrompts on every run so creating a brand voice mid-session
  // and then calling update_content_plan clears the brand_voice_missing
  // warning right away.
  brand_has_voice_prompt: boolean;
  // Visual style marker presence at snapshot time. Same fallback role as
  // brand_has_voice_prompt: the validator re-checks via getCompany on every
  // run so a mid-session confirm_visual_style clears the visual_style_missing
  // warning on the next update_content_plan. See visual-style-marker.ts for
  // the marker format.
  has_visual_style_marker: boolean;
}

interface ValidationTotals {
  image_ai_count: number;
  image_ai_cost: number;
  video_ai_count: number;
  video_ai_cost: number;
  upload_count: number;
  reuse_count: number;
  total_ai_cost: number;
}

interface ValidationResult {
  blockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  totals: ValidationTotals;
  /** ai_image_and_video_budget.remaining before plan execution. null if budget fetch failed. */
  budget_remaining: number | null;
  /** ai_text_budget.remaining before plan execution. null if budget fetch failed. */
  text_budget_remaining: number | null;
  /** ai_text_budget.total. 0 means the plan does not include text/TTS modality. */
  text_budget_total: number | null;
  /** Count of sub_posts that consume words (avatar TTS or missing copy_draft path B). */
  text_dependent_count: number;
}

/**
 * Split the validation warnings into two arrays based on the
 * user_facing_message field set when the warning was emitted:
 *
 * - A warning with a NON-null user_facing_message is safe to surface to the
 *   user. The message is written in natural language, obeys the
 *   USER-FACING LANGUAGE LOCK (no internal MCP terms, no tool names, no
 *   field names), and the agent MAY parrot it verbatim.
 *
 * - A warning with user_facing_message: null (or missing) is internal only.
 *   The planner emits it as a signal for the agent to silently react to
 *   (e.g. apply a dedup hint on a subsequent update_content_plan call),
 *   but the agent NEVER mentions it in conversation. These end up in
 *   _internal_warning_signals on the response, gated by the catalog rule
 *   user_facing_language_lock.
 *
 * This split fixes the leak pattern from the 2026-05-23 PostApprove share
 * where the agent parroted "voy a aplicar el fix automático con
 * shared_concept_key" because the warning's detail field was the only
 * available text and it mentioned internal terms verbatim.
 */
function filterUserFacingWarnings(
  warnings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return warnings.filter((w) => {
    const msg = w["user_facing_message"];
    if (typeof msg !== "string" || msg.length === 0) return false;
    // upfront decisions live in their own array (extractUpfrontDecisions
    // below); they MUST NOT also appear in warnings, otherwise the LLM
    // tends to surface them twice (once up front, once at the bottom)
    // and the user gets confused.
    if (w["is_upfront_decision"] === true) return false;
    return true;
  });
}

function extractInternalOnlyWarnings(
  warnings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return warnings.filter((w) => {
    const msg = w["user_facing_message"];
    return msg === null || msg === undefined;
  });
}

/**
 * Warnings flagged is_upfront_decision are routed to a dedicated array
 * that the LLM is instructed to surface BEFORE the plan summary (so the
 * user decides on these before mentally approving the plan). Example:
 * brand_voice_missing. Without this, the same warning ends up at the end
 * of the warnings array and the LLM presents it as a "PD/aviso" after
 * the user has already approved the plan, which is too late.
 */
function extractUpfrontDecisions(
  warnings: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return warnings.filter((w) => {
    if (w["is_upfront_decision"] !== true) return false;
    const msg = w["user_facing_message"];
    return typeof msg === "string" && msg.length > 0;
  });
}

/**
 * Auto-corrige video_sources de plan_items cuando el video_kind elegido
 * contradice el `default_video_kind` recomendado por la industria de la
 * empresa, y el concepto del plan_item NO matchea ningún `flip_concept`
 * del profile (lo cual significaría que el agente legitimamente quiso
 * flipear el default).
 *
 * Side effect: MUTA los plan_items in-place. Devuelve la lista de
 * correcciones aplicadas para que el caller pueda incluirla en
 * `_internal_corrections_applied` (debugging) y para que el `_assistant_guidance`
 * pueda instruir al agente que NO mencione las correcciones al user
 * (correcciones silenciosas).
 *
 * Conversiones soportadas:
 *   ai_clip → ai_avatar_video: requiere que la company tenga al menos 1
 *     avatar cargado. Si no, NO se corrige (el avatar_setup_proposal
 *     upstream debió pedir al user que cree uno antes). Scripts se derivan
 *     del caption_concept del sub_post o del concept_shared del item.
 *   ai_avatar_lipsync → ai_avatar_video: SHAPE upgrade dentro de la familia
 *     avatar. La industry policy default avatar_video define "reel multi-
 *     escena con subtítulos quemados" como shape canónica; lipsync (single-
 *     scene sin subtítulos) es la versión degradada. El upgrade es
 *     non-breaking: misma cost-per-second de TTS, generate_backgrounds queda
 *     en false así que cost total no se mueve, output gana subtítulos.
 *     Agregado 2026-05-26 tras la sesión PipeLime (saas) donde se filtró
 *     lipsync en 5 piezas.
 *   ai_avatar_video → ai_clip: convierte scripts a un prompt visual
 *     concatenado, defaults a veo_3.1_fast 8s sin reference image.
 *   ai_avatar_lipsync → ai_clip: idem, prompt del script.
 *
 * Si la industry no está cacheada, si el profile no se encuentra, o si la
 * estrategia es `is_ambiguous`, no se hace ninguna corrección.
 *
 * Agregado 2026-05-25 tras la sesión-test PipeLime donde el agente armó 6
 * ai_clips + 1 avatar para una industry (local_business) cuyo default es
 * avatar.
 */
async function autoCorrectInvertedVideoSources(
  client: FollowrClient,
  companyId: number,
  cachedIndustryId: string | null,
  planItems: PlanItem[],
): Promise<
  Array<{
    slug: string;
    sub_post_index: number;
    from_kind: string;
    to_kind: string;
    reason: string;
  }>
> {
  if (!cachedIndustryId) return [];
  const KNOWN: ReadonlySet<string> = new Set<string>([
    "ecommerce_fashion", "ecommerce_general", "saas", "restaurant",
    "service_b2b", "education", "real_estate", "healthcare",
    "creative_agency", "local_business", "personal_brand", "news_media",
    "hotel_hospitality", "fitness_wellness", "events_organizer",
    "ngo_nonprofit", "generic_business",
  ]);
  if (!KNOWN.has(cachedIndustryId)) return [];
  const profile = getProfile(cachedIndustryId as IndustryId);
  const strategy = profile.video_strategy;
  if (strategy.is_ambiguous === true) return [];

  const defaultKind = strategy.default_video_kind;
  const flipConcepts = strategy.flip_concepts.map((c) => c.toLowerCase());

  // Solo fetch avatares si vamos a necesitarlos (default avatar + hay items
  // de ai_clip para flipear).
  let avatarsCache: { id: number; default?: boolean }[] | null = null;
  const loadAvatars = async (): Promise<{ id: number; default?: boolean }[]> => {
    if (avatarsCache !== null) return avatarsCache;
    try {
      const list = await client.listAvatars(companyId, { pageSize: 30 });
      avatarsCache = list.map((a) => ({ id: a.id, default: (a as { default?: boolean }).default }));
    } catch {
      avatarsCache = [];
    }
    return avatarsCache;
  };

  const pickAvatarId = async (): Promise<number | null> => {
    const avatars = await loadAvatars();
    if (avatars.length === 0) return null;
    const def = avatars.find((a) => a.default === true);
    return def ? def.id : (avatars[0]?.id ?? null);
  };

  const corrections: Array<{
    slug: string;
    sub_post_index: number;
    from_kind: string;
    to_kind: string;
    reason: string;
  }> = [];

  const conceptMatchesFlip = (text: string): boolean => {
    const lower = text.toLowerCase();
    return flipConcepts.some((kw) => lower.includes(kw));
  };

  for (const item of planItems) {
    const itemConcept = item.concept_shared ?? "";
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const vs = sp.assets_strategy.video_source;
      if (!vs) continue;

      const subConcept = sp.caption_concept ?? itemConcept;
      const concept = `${itemConcept} ${subConcept}`.trim();
      if (conceptMatchesFlip(concept)) continue; // legítimamente flipped

      // ai_avatar_lipsync → ai_avatar_video (industry default avatar; lipsync
      // es la SHAPE degradada dentro de la familia avatar). Agregado 2026-05-26
      // tras la sesión PipeLime (saas) donde el agente eligió ai_avatar_lipsync
      // para 5 piezas en lugar de ai_avatar_video. El enum VideoKind del
      // industry profile solo distingue ai_clip vs ai_avatar_video; lipsync
      // pasaba el filtro silencioso porque "no es ai_clip", pero pierde la
      // shape multi-escena con subtítulos que la policy define como default.
      //
      // El upgrade es non-breaking porque:
      //   - El TTS cost por segundo es idéntico (25 cr/seg de speech) tanto
      //     en avatar_video como en lipsync, sin backgrounds.
      //   - generate_backgrounds queda en false por default, así que el costo
      //     total no cambia vs la versión lipsync (mismo costo, MEJOR output:
      //     ahora con subtítulos quemados).
      //   - El user nunca pidió lipsync explícitamente (Rule 21 del system
      //     prompt: si fuera un downgrade por presupuesto deliberado, el
      //     agente tenía que avisar primero; si llegó hasta acá sin avisar,
      //     es un slip y lo corregimos).
      //
      // Si el user en futuras iteraciones PIDE explícitamente lipsync
      // ("solo una toma corta sin subtítulos"), la flip_concepts del profile
      // o un update_content_plan con replace_sub_post explícito quedan como
      // escape hatches; ESTA corrección solo se dispara cuando el concept NO
      // matchea ningún flip_concept (chequeado arriba).
      if (
        defaultKind === "ai_avatar_video" &&
        vs.type === "ai_avatar_lipsync"
      ) {
        if (vs.script.length < 8) continue;
        sp.assets_strategy.video_source = {
          type: "ai_avatar_video",
          scripts: [vs.script],
          avatar_id: vs.avatar_id,
        };
        corrections.push({
          slug: item.slug,
          sub_post_index: i,
          from_kind: "ai_avatar_lipsync",
          to_kind: "ai_avatar_video",
          reason: `Industry ${cachedIndustryId} default is ai_avatar_video (multi-scene reel with subtitles); lipsync is the degraded single-scene shape and concept "${concept.slice(0, 80)}" does not match any flip_concept that would justify the simpler shape`,
        });
        continue;
      }

      // ai_clip → ai_avatar_video (industry default avatar)
      if (
        defaultKind === "ai_avatar_video" &&
        vs.type === "ai_generate"
      ) {
        const avatarId = await pickAvatarId();
        if (avatarId === null) continue; // sin inventory, no podemos corregir
        const script = (subConcept || itemConcept).slice(0, 800);
        if (script.length < 8) continue; // sin texto razonable para script
        sp.assets_strategy.video_source = {
          type: "ai_avatar_video",
          scripts: [script],
          avatar_id: avatarId,
        };
        corrections.push({
          slug: item.slug,
          sub_post_index: i,
          from_kind: "ai_clip",
          to_kind: "ai_avatar_video",
          reason: `Industry ${cachedIndustryId} default is ai_avatar_video; concept "${concept.slice(0, 80)}" does not match any flip_concept`,
        });
        continue;
      }

      // ai_avatar_video / ai_avatar_lipsync → ai_clip (industry default clip)
      if (
        defaultKind === "ai_clip" &&
        (vs.type === "ai_avatar_video" || vs.type === "ai_avatar_lipsync")
      ) {
        const prompt =
          vs.type === "ai_avatar_video"
            ? vs.scripts.join(". ").slice(0, 600)
            : vs.script.slice(0, 600);
        if (prompt.length < 8) continue;
        sp.assets_strategy.video_source = {
          type: "ai_generate",
          model: "veo_3.1_fast",
          prompt,
          duration_seconds: 8,
        };
        corrections.push({
          slug: item.slug,
          sub_post_index: i,
          from_kind: vs.type === "ai_avatar_video" ? "ai_avatar_video" : "ai_avatar_lipsync",
          to_kind: "ai_clip",
          reason: `Industry ${cachedIndustryId} default is ai_clip; concept "${concept.slice(0, 80)}" does not match any flip_concept`,
        });
        continue;
      }
    }
  }

  return corrections;
}

async function runValidation(args: {
  plan_items: PlanItem[];
  time_window: { start: string; end: string };
  ctx: ValidationCtx;
  client: FollowrClient;
  use_brand_voice: boolean;
}): Promise<ValidationResult> {
  const { plan_items, time_window, ctx, client, use_brand_voice } = args;
  const blockers: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const slugSeen = new Set<string>();
  const slotMap = new Map<string, Array<{ slug: string; network: SocialNetwork }>>();

  const totals: ValidationTotals = {
    image_ai_count: 0,
    image_ai_cost: 0,
    video_ai_count: 0,
    video_ai_cost: 0,
    upload_count: 0,
    reuse_count: 0,
    total_ai_cost: 0,
  };

  for (const item of plan_items) {
    if (slugSeen.has(item.slug)) {
      blockers.push({
        issue: "duplicate_slug",
        slug: item.slug,
        detail: `Slug "${item.slug}" appears more than once. Each plan_item needs a unique slug.`,
      });
    }
    slugSeen.add(item.slug);

    if (item.date < time_window.start || item.date > time_window.end) {
      warnings.push({
        issue: "date_out_of_window",
        item: item.slug,
        user_facing_message: `El posteo está agendado para el ${item.date}, fuera de la ventana ${time_window.start} a ${time_window.end} que pediste. Verificá si querías esa fecha o muevo el posteo.`,
      });
    }

    // CHECK 2026-05-25: publish_at debe estar en el futuro (con buffer de 30
    // min para que el user tenga tiempo de revisar el plan antes de la
    // publicación automática). Cuando el agente arma plans con dates
    // tipo "esta semana" pero corre el flow tarde, los primeros slots
    // pueden caer en el pasado y la publicación falla o se ejecuta
    // inmediatamente (no deseado).
    //
    // Solo aplica cuando el plan_item tiene publish_at_time_local (los
    // plan_items sin tiempo se quedan como draft sin schedule, no aplica
    // gate).
    if (
      typeof item.publish_at_time_local === "string" &&
      item.publish_at_time_local.length > 0
    ) {
      try {
        const itemPublishAtIso = localDateTimeToUtcIso(
          item.date,
          item.publish_at_time_local,
          item.timezone,
        );
        // Timezone inválido o date/time mal formado: skip past check,
        // otros validators ya se quejan del shape.
        if (itemPublishAtIso !== null) {
        const itemPublishAtMs = new Date(itemPublishAtIso).getTime();
        const nowMs = Date.now();
        const bufferMs = 30 * 60 * 1000;
        if (itemPublishAtMs < nowMs + bufferMs) {
          blockers.push({
            issue: "publish_at_in_past",
            item: item.slug,
            publish_at_local: `${item.date} ${item.publish_at_time_local}`,
            publish_at_utc: itemPublishAtIso,
            timezone: item.timezone,
            user_facing_message: `El posteo "${item.concept_shared.slice(0, 60)}" está agendado para ${item.date} ${item.publish_at_time_local} (${item.timezone}) que ya pasó o está dentro de los próximos 30 min. Necesito moverlo a un slot futuro antes de ejecutar.`,
            resolution_options: [
              {
                id: "move_to_next_future_slot",
                description:
                  "Mover este plan_item a la primera fecha+hora futura disponible dentro del time_window. Usar update_content_plan con changes=[{target: 'plan_item', slug, operation: 'update_field', field: 'date'/'publish_at_time_local', value: <slot futuro>}].",
              },
              {
                id: "remove_from_plan",
                description:
                  "Sacar este plan_item del plan. Usar update_content_plan con changes=[{target: 'plan_item', slug, operation: 'delete'}].",
              },
              {
                id: "extend_time_window",
                description:
                  "Si la ventana original cae mayormente en el pasado (ej: user pidió 'esta semana' un viernes a las 9pm), proponer al user extender la ventana a próxima semana via un draft nuevo. Esta no es una resolution del plan actual sino un rebuild.",
              },
            ],
          });
        }
        }
      } catch {
        // localDateTimeToUtcIso puede tirar si timezone es inválido. En ese
        // caso saltamos el check (otro validator se va a quejar del timezone).
      }
    }

    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const slotKey = `${item.date}T${item.publish_at_time_local}`;
      const slotEntries = slotMap.get(slotKey) ?? [];
      slotEntries.push({ slug: item.slug, network: sp.social_network });
      slotMap.set(slotKey, slotEntries);

      if (!ctx.networks_connected.includes(sp.social_network)) {
        warnings.push({
          issue: "network_not_connected",
          item: item.slug,
          sub_post_index: i,
          network: sp.social_network,
          user_facing_message: `${displayNetworkName(sp.social_network)} no está conectada a esta marca. Hasta que la conectes en Followr, el posteo va a quedar como draft y no se publica solo.`,
        });
      }

      const slotSpec = NETWORK_FORMAT_COMPATIBILITY[`${sp.social_network}:${sp.product_type}`];
      if (!slotSpec) {
        blockers.push({
          issue: "incompatible_product_type_for_network",
          item: item.slug,
          sub_post_index: i,
          network: sp.social_network,
          product_type: sp.product_type,
          detail: `${sp.social_network} does not accept product_type ${sp.product_type}. See network_format_compatibility_matrix from prepare_content_plan_context.`,
          resolution_options: networkResolutionOptions(sp.social_network, sp.product_type),
        });
        continue;
      }
      const slotAcceptsLayout = slotSpec.accepts.some(
        (a) => a.product_type === sp.product_type && a.asset_layouts.includes(sp.asset_layout),
      );
      if (!slotAcceptsLayout) {
        blockers.push({
          issue: "incompatible_asset_layout_for_network",
          item: item.slug,
          sub_post_index: i,
          network: sp.social_network,
          product_type: sp.product_type,
          asset_layout: sp.asset_layout,
          detail: `${slotSpec.display_name} (${sp.product_type}) does not accept asset_layout=${sp.asset_layout}. Allowed: ${slotSpec.accepts
            .filter((a) => a.product_type === sp.product_type)
            .flatMap((a) => a.asset_layouts)
            .join(", ")}.`,
          resolution_options: layoutResolutionOptions(sp.social_network, sp.product_type, sp.asset_layout),
        });
        continue;
      }

      const shapeBlocker = validateLayoutShape(sp.asset_layout, sp.assets_strategy, slotSpec.max_images_in_carousel);
      if (shapeBlocker) {
        blockers.push({
          issue: "asset_strategy_mismatch_for_layout",
          item: item.slug,
          sub_post_index: i,
          network: sp.social_network,
          asset_layout: sp.asset_layout,
          detail: shapeBlocker,
        });
        continue;
      }

      if (
        sp.asset_layout === "single_image" &&
        /(carrusel|carousel|comparativa|comparison|múltiples?|multiples?|step.?by.?step|antes\s*\/\s*despu[eé]s|before\s*\/\s*after|\b\d+\s+looks?\b|\b\d+\s+formas?\b|\b\d+\s+tips?\b)/i.test(
          item.rationale + " " + sp.caption_concept,
        )
      ) {
        // Suppress the warning when the image prompt itself describes a
        // composition that legitimately conveys multiple items in ONE frame
        // (split-screen, diptych, side-by-side, "mitad ... mitad ..."). The
        // share session at PostApprove had Claude ignoring this warning by
        // hand because the before/after lived inside a split-screen image.
        // Catch those cases here so the warning only fires for genuinely
        // mismatched layouts.
        const imgSrc = sp.assets_strategy.image_source;
        const promptForSplit =
          imgSrc && imgSrc.type === "ai_generate" ? imgSrc.prompt : "";
        const splitInFramePattern =
          /(split[- ]?screen|side[- ]?by[- ]?side|diptych|two halves|two\s+halves|mitad\s+.+\s+mitad|split\s+composition|half\s*\/\s*half|left half.*right half|izquierda.*derecha)/i;
        if (!splitInFramePattern.test(promptForSplit)) {
          warnings.push({
            issue: "rationale_suggests_carousel_but_layout_is_single",
            item: item.slug,
            sub_post_index: i,
            user_facing_message:
              "El concepto del post sugiere varios items o un antes/después, pero está planeado como una sola foto. Si la idea es mostrar más de una cosa, conviene un carrusel.",
          });
        }
      }

      // Detect AI video sources whose prompt or sub_post concept implies
      // multiple distinct items composed into one clip. generate_ai_video_clip
      // takes a SINGLE reference_image_url; promising "video con los 4
      // colores" forces the model to hallucinate the colors it cannot
      // see. The fix is either a carousel of images or a multi-scene
      // avatar_video. Documented in PLANNING_STRATEGY.video_reference_constraint.
      const vs = sp.assets_strategy.video_source;
      if (vs && vs.type === "ai_generate") {
        const combinedText = (vs.prompt + " " + sp.caption_concept + " " + item.concept_shared + " " + item.rationale).toLowerCase();
        const multiItemPattern =
          /(varios?\s+(colores?|productos?|prendas?|modelos?|sabores?|variantes?|opciones?)|m[uú]ltiples?\s+(colores?|productos?|prendas?|items?)|\b[2-9]\s+(colores?|productos?|prendas?|modelos?|sabores?|variantes?)\b|los?\s+\d+\s+(colores?|productos?|prendas?)|combinando\s+(varios?|m[uú]ltiples?|diferentes?))/;
        if (multiItemPattern.test(combinedText)) {
          warnings.push({
            issue: "ai_video_implies_multiple_references",
            item: item.slug,
            sub_post_index: i,
            network: sp.social_network,
            user_facing_message:
              "El video con IA promete mostrar varios productos o variantes en un solo clip, pero la IA solo puede usar una imagen de referencia. Si lo ejecutamos así, el modelo se inventa los productos que no ve y el video sale distinto al catálogo. Conviene cambiarlo a un carrusel con una imagen por producto, o a un avatar con una escena por variante.",
            resolution_options: [
              {
                id: "convert_to_carousel",
                description: "Switch this sub_post to product_type=feed + asset_layout=carousel_images with one ai_generate image per variant. Does NOT apply on TikTok/Reels which only accept video.",
                user_facing_description:
                  "Cambio el formato a un carrusel con una imagen por producto. No funciona en TikTok ni Reels (que solo aceptan video).",
              },
              {
                id: "switch_to_avatar_video",
                description: "Switch video_source to ai_avatar_video with one scene per variant; each scene carries its own reference_image_url via scene_reference_images.",
                user_facing_description:
                  "Cambio el video a un avatar con una escena por variante. Cada escena puede mostrar fielmente su producto.",
              },
              {
                id: "narrow_video_concept",
                description: "Rewrite the video prompt to show ONE single product / variant with a specific reference_image_url, and tighten caption_concept so it does not promise what the video does not show.",
                user_facing_description:
                  "Reduzco el video a mostrar un solo producto en cámara (close-up o transición sobre el mismo) y ajusto el copy para que no prometa más de lo que se ve.",
              },
            ],
          });
        }
      }
    }

    // Cross-sub_post similarity check within THIS plan_item. Walk every
    // pair of AssetSourceAiImage references and surface a non-blocking
    // warning when their prompts are >=85% similar after normalization.
    // The 2026-05-21 audit found two pairs (cover LinkedIn vs cover IG;
    // step01 LinkedIn vs step01 IG) where the only diff was a single
    // adjective at the tail ("generous negative space", "professional SaaS
    // aesthetic"); the model rendered indistinguishable outputs and burned
    // 2 credits per pair for zero differentiation. With shared_concept_key
    // in the schema we now have a first-class way to express the dedupe
    // intent; this validator nudges the planner toward it.
    interface AiImageRef {
      sub_post_index: number;
      slot_within_sub_post: number;
      network: SocialNetwork;
      prompt: string;
      aspect_ratio: string | undefined;
      shared_concept_key: string | undefined;
    }
    const aiImageRefs: AiImageRef[] = [];
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const collectFromImage = (src: NonNullable<AssetsStrategy["image_source"]>, slot: number) => {
        if (src.type !== "ai_generate") return;
        aiImageRefs.push({
          sub_post_index: i,
          slot_within_sub_post: slot,
          network: sp.social_network,
          prompt: src.prompt,
          aspect_ratio: (src as AssetSourceAiImage).aspect_ratio,
          shared_concept_key: (src as AssetSourceAiImage).shared_concept_key,
        });
      };
      if (sp.assets_strategy.image_source) collectFromImage(sp.assets_strategy.image_source, 0);
      if (sp.assets_strategy.carousel_sources) {
        sp.assets_strategy.carousel_sources.forEach((s, idx) => collectFromImage(s, idx));
      }
    }
    for (let a = 0; a < aiImageRefs.length; a++) {
      for (let b = a + 1; b < aiImageRefs.length; b++) {
        const A = aiImageRefs[a]!;
        const B = aiImageRefs[b]!;
        // If both refs declare the SAME shared_concept_key, the resolver
        // already collapses them to one generation, no warning needed.
        if (
          A.shared_concept_key &&
          B.shared_concept_key &&
          A.shared_concept_key === B.shared_concept_key
        ) {
          continue;
        }
        const sim = normalizedPromptSimilarity(A.prompt, B.prompt);
        if (sim < PROMPT_DUPLICATE_SIMILARITY_THRESHOLD) continue;
        // Same prompt + same aspect_ratio + same model = the fingerprint
        // path already dedupes. We surface only when the planner intends
        // them as DISTINCT generations (e.g. different network, no
        // shared_concept_key) and would burn extra credits.
        const aspectDiffers = (A.aspect_ratio ?? null) !== (B.aspect_ratio ?? null);
        if (aspectDiffers && sim < 0.95) continue;
        const percent = Math.round(sim * 100);
        warnings.push({
          issue: "near_duplicate_ai_image_prompts",
          item: item.slug,
          sub_post_index_a: A.sub_post_index,
          sub_post_index_b: B.sub_post_index,
          network_a: A.network,
          network_b: B.network,
          similarity: sim,
          // SILENT TO USER. The agent uses this internally to decide whether
          // to apply a dedup hint when calling update_content_plan, but
          // never mentions it in conversation. The leak from the
          // 2026-05-23 PostApprove share ("voy a aplicar el fix automático
          // con shared_concept_key") came from this warning's prose detail
          // being parroted by the agent. user_facing_message: null tells
          // the agent that this signal is for planning only, not for
          // user-visible explanation.
          user_facing_message: null,
          internal_only_detail: `Dos imágenes AI en este plan_item tienen prompts ${percent}% idénticos (${displayNetworkName(A.network)} slot #${A.slot_within_sub_post + 1} vs ${displayNetworkName(B.network)} slot #${B.slot_within_sub_post + 1}). Internal: agent should unify them silently (dedup hint on both refs) without surfacing the mechanic to the user.`,
        });
      }
    }
  }

  // Aggregate plan-level totals using dedupe-aware cost estimate. Each
  // unique AI generation across a plan_item's sub_posts is counted once,
  // matching execute_content_plan's actual billing.
  for (const item of plan_items) {
    const dedupedCost = estimatePlanItemCostDeduped(item);
    totals.image_ai_cost += dedupedCost.image_ai_cost;
    totals.image_ai_count += dedupedCost.image_ai_count;
    totals.video_ai_cost += dedupedCost.video_ai_cost;
    totals.video_ai_count += dedupedCost.video_ai_count;
    totals.upload_count += dedupedCost.upload_count;
    totals.reuse_count += dedupedCost.reuse_count;
  }

  // Cross-network: warn when youtube:long_video is in the plan. By policy
  // we don't propose long_video unless the user explicitly asked or has
  // pre-recorded video assets. If we DID end up planning long_video,
  // surface it so the user can confirm intent. Also blocks the obvious
  // anti-pattern of long_video with ai_generate (AI clips top out at ~8s).
  for (const item of plan_items) {
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      if (sp.social_network !== "youtube" || sp.product_type !== "long_video") continue;
      const vs = sp.assets_strategy.video_source;
      if (vs && vs.type === "ai_generate") {
        blockers.push({
          issue: "youtube_long_video_with_ai_generate",
          item: item.slug,
          sub_post_index: i,
          detail:
            "YouTube long_video con assets_strategy.video_source de tipo ai_generate. Los clips AI duran ~8s; no sirven como YouTube long_video. Followr lo va a publicar pero el resultado es un long_video de 8s, no usable.",
          resolution_options: [
            {
              id: "drop_youtube",
              description:
                "Eliminar el sub_post de youtube:long_video. No proponer long_video sin que el usuario lo pida explícitamente con video propio (assets_strategy.video_source = { type: 'asset_id' } o 'url').",
            },
            {
              id: "swap_to_youtube_short",
              description:
                "Cambiar product_type=short para crear un YouTube Short. Shorts comparten 9:16 con Reels/TikTok y permiten dedupear el video.",
            },
            {
              id: "upload_existing_video",
              description:
                "Si el usuario tiene un video largo propio, cargarlo primero con upload_video_from_url y pasar assets_strategy.video_source = { type: 'asset_id', id: <n> }.",
            },
          ],
        });
      } else {
        warnings.push({
          issue: "youtube_long_video_proposed",
          item: item.slug,
          sub_post_index: i,
          user_facing_message:
            "El plan incluye un video largo de YouTube. Por defecto no proponemos ese formato porque suele requerir contenido pre-grabado. Confirmame que pediste contenido long-form para esta semana antes de avanzar.",
        });
      }
    }
  }

  // Cross-items: format-mix policy for instagram and facebook.
  // A week of 5+ posts on IG or FB with zero reels misses the largest organic
  // surface on those networks since 2024. Warning is non-blocking: the user
  // can dismiss it, but the planner should not silently default to feed-only.
  // See PLANNING_STRATEGY.format_mix_per_network for the underlying policy.
  for (const network of ["instagram", "facebook"] as const) {
    if (!ctx.networks_connected.includes(network)) continue;
    const itemsWithNetwork: Array<{ slug: string; sub_post_index: number; product_type: ProductType }> = [];
    for (const item of plan_items) {
      for (let i = 0; i < item.sub_posts.length; i++) {
        const sp = item.sub_posts[i] as SubPost;
        if (sp.social_network === network) {
          itemsWithNetwork.push({ slug: item.slug, sub_post_index: i, product_type: sp.product_type });
        }
      }
    }
    if (itemsWithNetwork.length >= 5) {
      const reelCount = itemsWithNetwork.filter((e) => e.product_type === "reel").length;
      if (reelCount === 0) {
        // Identify reel-friendly candidates: items whose rationale or
        // caption_concept hints at movement, transition, try-on, before/after,
        // BTS. The agent can use these to convert one sub_post to a reel.
        const reelKeywords =
          /(reel|video|movimiento|movement|try[- ]?on|fit check|transición|transition|antes\s*\/\s*despu[eé]s|before\s*\/\s*after|bts|behind.?the.?scenes|tutorial|how[- ]?to|process|plating|reveal|hook|c[aá]mara r[aá]pida|time.?lapse|day in the life)/i;
        const candidateSlugs: string[] = [];
        for (const item of plan_items) {
          const hasNetwork = item.sub_posts.some((sp) => sp.social_network === network);
          if (!hasNetwork) continue;
          if (reelKeywords.test(item.rationale + " " + item.concept_shared)) {
            candidateSlugs.push(item.slug);
          }
        }
        warnings.push({
          issue: "no_reel_in_weekly_plan",
          network,
          posts_count: itemsWithNetwork.length,
          reel_count: 0,
          reel_friendly_candidates: candidateSlugs,
          user_facing_message: `El plan tiene ${itemsWithNetwork.length} posts para ${displayNetworkName(network)} y ningún Reel. Los Reels llevan la mayor parte del alcance orgánico ahí desde 2024; conviene tener al menos uno por semana.`,
          internal_only_suggestion:
            candidateSlugs.length > 0
              ? `Convert one of these reel-friendly items to a reel: ${candidateSlugs.join(", ")}. If TikTok is already in the plan_item, reuse its 9:16 asset (cross-post, no extra generation).`
              : "No reel-friendly concepts detected. Either reframe an existing item with movement or add a new reel-friendly concept (try-on, transition, BTS, before/after, time-lapse).",
          resolution_options: [
            {
              id: "convert_to_reel",
              description: `Swap one of the ${network} sub_posts to product_type=reel + asset_layout=single_video + video_source. If TikTok is in the same plan_item, reuse its 9:16 asset (cross-post, free).`,
              user_facing_description: `Cambio uno de los posts de ${displayNetworkName(network)} a Reel. Si TikTok ya está en ese día, reuso el mismo video (no se duplica el costo).`,
            },
            {
              id: "add_new_reel_item",
              description: "Add a fresh plan_item with a reel sub_post seeded from a reel-friendly concept (try-on, transition, BTS, before/after, time-lapse).",
              user_facing_description:
                "Agrego un Reel nuevo a la semana, con un concepto pensado para video (transición, antes/después, behind-the-scenes, etc.).",
            },
            {
              id: "keep_as_is",
              description: "Dismiss this warning when the user explicitly wants a static-only week.",
              user_facing_description:
                "Dejo la semana sin Reels, si esa es la decisión.",
            },
          ],
        });
      }
    }
  }

  // Cross-items: duplicate network per slot.
  for (const [slotKey, entries] of slotMap) {
    const counts = new Map<SocialNetwork, string[]>();
    for (const e of entries) {
      const list = counts.get(e.network) ?? [];
      list.push(e.slug);
      counts.set(e.network, list);
    }
    for (const [network, slugs] of counts) {
      if (slugs.length > 1) {
        blockers.push({
          issue: "duplicate_network_same_slot",
          slot: slotKey,
          network,
          involved_items: slugs,
          detail: `Slot ${slotKey} has ${slugs.length} sub_posts targeting ${network}. Posting twice to the same network at the same time is invalid.`,
          resolution_options: [
            {
              id: "consolidate",
              description:
                "Merge the duplicate sub_posts into ONE plan_item with heterogeneous sub_posts (a single PostGroup with multiple per-network children).",
            },
            {
              id: "drop_duplicate",
              description: `Remove ${network} from one of the duplicate items, leaving only the remaining sub_posts in that item.`,
            },
            {
              id: "different_time",
              description: `Change the publish_at_time_local of one of the duplicate items so the two posts to ${network} land at different moments.`,
            },
          ],
        });
      }
    }
  }

  // Budget.
  totals.total_ai_cost = totals.image_ai_cost + totals.video_ai_cost;
  let budgetRemaining: number | null = null;
  let textBudgetRemaining: number | null = null;
  let textBudgetTotal: number | null = null;
  try {
    const budget = await loadBudgets(client);
    budgetRemaining = budget?.ai_image_and_video_budget.remaining ?? null;
    textBudgetRemaining = budget?.ai_text_budget.remaining ?? null;
    textBudgetTotal = budget?.ai_text_budget.total ?? null;
  } catch {
    budgetRemaining = null;
  }
  if (budgetRemaining !== null && totals.total_ai_cost > budgetRemaining) {
    blockers.push({
      issue: "budget_exceeded",
      requested: totals.total_ai_cost,
      available: budgetRemaining,
      shortage: totals.total_ai_cost - budgetRemaining,
      detail: `This plan needs ${totals.total_ai_cost} credits of ai_image_and_video_budget but the company has ${budgetRemaining}. Shortage: ${totals.total_ai_cost - budgetRemaining}.`,
      resolution_options: [
        {
          id: "switch_to_cheaper_models",
          description:
            "Switch ai_generate video models to cheaper alternatives (SeeDance 1.1 Light at 20 cr/s instead of Veo 3.1 Fast at 50, or Hailuo Standard at 20). Check available_video_models from prepare_content_plan_context for affordable: true models.",
        },
        {
          id: "reduce_ai_generations",
          description:
            "Replace some ai_generate sub_posts with use_existing_urls or upload_from_website strategies. Photos from the company's site cost 0 credits.",
        },
        {
          id: "shrink_time_window",
          description: "Reduce the number of plan_items, the time_window or the posts_per_day.",
        },
      ],
    });
  }

  // Text/TTS budget check. Avatar pieces (ai_avatar_lipsync, ai_avatar_video)
  // require words budget for the TTS step; detect_brand_visual_style and the
  // copy-draft fallback also consume words. The ai_image_and_video_budget
  // check above is silent about this even when total_ai_cost looks fine,
  // because words are billed against a separate bucket.
  //
  // PipeLime 2026-05-26 session: ai_text_budget.total was 0 (plan did not
  // include AI text + TTS). The plan validated fine on image/video budget,
  // got approved by the user for day 1, and then 402'd at TTS time with
  // entity="words". Surfacing the gate at validation time avoids the wasted
  // approval cycle.
  let textDependentCount = 0;
  for (const item of plan_items) {
    for (const sp of item.sub_posts) {
      const vs = sp.assets_strategy.video_source;
      if (vs && (vs.type === "ai_avatar_lipsync" || vs.type === "ai_avatar_video")) {
        textDependentCount += 1;
      }
      // copy_draft missing implies path B (server-side generate_text); that
      // also consumes words. Count those too.
      if (!sp.copy_draft || sp.copy_draft.trim().length === 0) {
        textDependentCount += 1;
      }
    }
  }
  if (textDependentCount > 0 && textBudgetTotal === 0) {
    blockers.push({
      issue: "plan_requires_text_or_tts_but_not_in_plan",
      text_dependent_count: textDependentCount,
      detail: `This plan has ${textDependentCount} piece(s) that depend on AI text generation or TTS audio (avatar pieces with scripted speech, or sub_posts without copy_draft that would trigger server-side copy generation). The current Followr plan does not include this modality (ai_text_budget.total === 0), so the plan will 402 with entity="words" at execution time.`,
      user_facing_message: `Tu plan actual de Followr no incluye generación de texto AI ni audio narrado. Eso bloquea las ${textDependentCount} pieza(s) del plan que dependen de voz de avatar o copies auto-redactados. Hay tres caminos: activar ese módulo en Followr (página de Subscription), reemplazar los avatares por AI clips sin voz (animación sin persona ni audio) y escribir vos los copies, o pausar acá. ¿Cómo seguimos?`,
      is_upfront_decision: true,
      resolution_options: [
        {
          id: "activate_text_feature_in_followr",
          description:
            "Direct the user to app.followr.ai > Subscription to add the text/TTS module to their current plan. The MCP cannot mutate subscriptions; the user has to complete this on the web. After they confirm, re-run prepare_content_plan_context to refresh the capability state.",
          user_facing_description:
            "Activá generación de texto y audio en Followr (página de Subscription) y volvemos.",
        },
        {
          id: "swap_avatars_for_ai_clips",
          description:
            "Replace ai_avatar_lipsync / ai_avatar_video sub_posts with ai_generate video (AI clips, no voice, no persona). Use update_content_plan with replace_sub_post for each affected piece. Cost stays in the image/video bucket; words are no longer consumed.",
          user_facing_description:
            "Cambio los videos con avatar por clips AI cinematográficos sin voz ni persona. Mantengo el mensaje en texto del posteo.",
        },
        {
          id: "manual_copy_only_plan",
          description:
            "Drop avatar pieces entirely; the remaining sub_posts need copy_draft filled in by the agent (no server-side fallback) since words are still unavailable for path B. The user gets copies you write inline.",
          user_facing_description:
            "Armo el plan sin avatares; los copies los redacto yo en el chat para que no haya generación AI de texto.",
        },
      ],
    });
  } else if (textDependentCount > 0 && textBudgetRemaining !== null && textBudgetRemaining <= 0) {
    blockers.push({
      issue: "text_budget_exhausted_in_cycle",
      text_dependent_count: textDependentCount,
      detail: `This plan has ${textDependentCount} text/TTS-dependent piece(s) but ai_text_budget.remaining is ${textBudgetRemaining}. The plan will 402 with entity="words" at execution time until the cycle renews.`,
      user_facing_message: `El bucket de texto AI y audio narrado se agotó en el ciclo actual de Followr. Tu plan TIENE incluido el módulo, pero las palabras del mes están consumidas. Las ${textDependentCount} pieza(s) que dependen de voz de avatar o copies auto-generados van a fallar hasta el renewal. Podés esperar al renewal, activar más créditos en Followr (página de Subscription), o ajusto el plan ahora para que no use texto AI. ¿Cómo seguimos?`,
      is_upfront_decision: true,
      resolution_options: [
        {
          id: "wait_for_renewal",
          description:
            "Schedule the plan AFTER ai_text_budget.renews_at. The agent should ask the user when they want to schedule (post-renewal) and adjust publish_at_time_local accordingly.",
          user_facing_description:
            "Esperamos al renewal del plan y arrancamos después.",
        },
        {
          id: "topup_text_credits",
          description:
            "Direct the user to add more text credits via app.followr.ai > Subscription. Same MCP limitation: cannot mutate subscriptions from here.",
          user_facing_description:
            "Activá un add-on de palabras adicionales en Followr y volvemos.",
        },
        {
          id: "swap_avatars_for_ai_clips",
          description:
            "Same as the not-in-plan case: replace avatars with ai_generate video and fill copies manually.",
          user_facing_description:
            "Cambio los videos con avatar por clips AI sin voz, y los copies los escribo yo en el chat.",
        },
      ],
    });
  }

  if (use_brand_voice) {
    // Re-check brand voice presence against the LIVE prompt list, not the
    // (potentially stale) ctx snapshot captured at prepare_content_plan_context
    // time. Without this, an agent that creates brand voice prompts mid-session
    // and then calls update_content_plan still sees the brand_voice_missing
    // warning because the snapshot remembers the pre-creation state.
    let hasVoicePromptLive = ctx.brand_has_voice_prompt;
    try {
      const prompts = await client.listPrompts({ companyId: ctx.company_id, pageSize: 1 });
      hasVoicePromptLive = prompts.length > 0;
    } catch {
      // If the live check fails, fall back to the ctx snapshot so we don't
      // accidentally drop the warning when prompts actually are missing.
    }
    if (!hasVoicePromptLive) {
      // upfront_decision marker: the validator emits this with a special
      // issue prefix so the response builder can re-route it from the
      // generic "warnings" array (which the LLM tends to present at the
      // BOTTOM, after the plan summary) into an upfront_decisions_required
      // array (which the LLM is instructed to present BEFORE the summary).
      // Without this routing, brand-voice-missing typically shipped as a
      // "PD/aviso al pie" trailing the plan, which is the wrong moment
      // for the user to decide: they have already mentally approved the
      // plan and won't pause to add the voice.
      warnings.push({
        issue: "brand_voice_missing",
        is_upfront_decision: true,
        user_facing_message:
          "Esta marca no tiene voz de marca configurada todavía. Los copies van a salir con el tono default, más genéricos. Antes de mostrarte el plan armado, ¿la armamos en una llamada (recomendado) o avanzamos con el tono default?",
      });
    }
  }

  // Re-check visual_style marker presence against LIVE company.description,
  // not the (potentially stale) ctx snapshot. Same reasoning as the brand
  // voice live re-check above: if the agent calls confirm_visual_style
  // mid-session and then update_content_plan, the ctx snapshot still says
  // false and the warning would surface incorrectly.
  let hasVisualStyleMarkerLive = ctx.has_visual_style_marker;
  try {
    const live = await client.getCompany(ctx.company_id);
    hasVisualStyleMarkerLive =
      parseVisualStyleMarker(live.description ?? null) !== null;
  } catch {
    // Live check failure: fall back to ctx snapshot.
  }
  if (!hasVisualStyleMarkerLive) {
    // Same upfront_decision routing as brand_voice_missing above.
    // Anti-pattern PipeLime 2026-05-25: this was surfaced as a "PD" at the
    // bottom of the draft (because visual_style_setup_proposal lived only
    // in prepare_content_plan_context and not in the draft warnings).
    // Result: the agent showed the full plan first, then mentioned the
    // visual style at the end. By then the user had already approved the
    // plan mentally; correcting course meant rebuilding instead of just
    // setting the style before drafting.
    warnings.push({
      issue: "visual_style_missing",
      is_upfront_decision: true,
      user_facing_message:
        "Esta marca todavía no tiene un visual style fijado (Bold Typography, Minimalist Clean, etc.). Sin esto, cada imagen del plan puede salir en un estilo distinto y el feed se ve menos coherente. Antes de mostrarte el plan armado: ¿detectamos tu estilo (recomendado, ~10-30 cr una sola vez), elegimos uno del catálogo (gratis), o avanzamos sin fijar?",
    });
  } else {
    // Marker IS present, but the draft may have selected models that bypass
    // Creative Studio. In that case the template the user fixed via
    // confirm_visual_style will not be applied to those plan_items: the
    // legacy /api/aiResults/image path runs instead, without style_key,
    // logo auto-inject, or brand_context enrichment.
    //
    // The set CS_COMPATIBLE_IMAGE_MODELS mirrors the check in
    // resolveImageSourceForExecution (search csCompatibleModels). When
    // model is undefined we treat it as nano_banana_2 (the default) so
    // unspecified models do NOT trip this warning.
    //
    // Soft warning, NOT upfront_decision: this is informational. The user
    // may legitimately want ideogram_v3 for legible baked text or recraftv3
    // for flat illustration, even at the cost of the fixed template.
    // Anti-pattern PipeLime 2026-05-25: the agent had chosen ideogram_v3
    // for the carousel slides (legible text) at draft time, then the user
    // fixed Gradient/Vibrant. The agent invented a "pre-generate everything
    // with generate_brand_creative" workflow instead of suggesting the
    // single update_content_plan to switch model to nano_banana_2.
    const CS_COMPATIBLE_IMAGE_MODELS = new Set([
      "nano_banana_2",
      "nano_banana_pro",
    ]);
    const itemsBypassingTemplate: Array<{
      slug: string;
      model: string;
    }> = [];
    for (const item of plan_items) {
      let alreadyFlagged = false;
      for (const sp of item.sub_posts) {
        if (alreadyFlagged) break;
        const srcs = [
          sp.assets_strategy?.image_source,
          ...(sp.assets_strategy?.carousel_sources ?? []),
        ];
        for (const src of srcs) {
          if (!src || src.type !== "ai_generate") continue;
          const aiImg = src as AssetSourceAiImage;
          // Default (undefined model) → nano_banana_2 → CS-compatible, skip.
          if (aiImg.model === undefined) continue;
          // Explicit opt-out via use_creative_studio: false → user knows
          // they are bypassing, skip noise.
          if (aiImg.use_creative_studio === false) continue;
          if (!CS_COMPATIBLE_IMAGE_MODELS.has(aiImg.model)) {
            itemsBypassingTemplate.push({
              slug: item.slug,
              model: aiImg.model,
            });
            alreadyFlagged = true; // one entry per item is enough
            break;
          }
        }
      }
    }
    if (itemsBypassingTemplate.length > 0) {
      const distinctModels = Array.from(
        new Set(itemsBypassingTemplate.map((i) => i.model)),
      );
      warnings.push({
        issue: "visual_style_bypassed_by_model",
        is_upfront_decision: false,
        affected_items: itemsBypassingTemplate,
        user_facing_message: `Tenés un visual style fijado, pero ${itemsBypassingTemplate.length} ${itemsBypassingTemplate.length === 1 ? "pieza" : "piezas"} del plan usa${itemsBypassingTemplate.length === 1 ? "" : "n"} un modelo (${distinctModels.join(", ")}) que NO pasa por tu template. Trade-off: ese modelo tiene mejor control sobre el texto que aparece renderizado en la imagen, pero el feed pierde coherencia visual con tus otros posts. Opciones: (a) dejar así si necesitás copy exacto en esas piezas, (b) cambiar el modelo a nano_banana_2 en esas piezas para que usen tu template (perdés control fino sobre el copy renderizado, lo inventa el AI).`,
        resolution_options: [
          {
            id: "keep_specialty_model",
            description:
              "Dejar el plan como está. Las piezas con modelo especializado mantienen control fino sobre el copy literal pero quedan visualmente desalineadas del resto del feed.",
          },
          {
            id: "switch_to_template_compatible_model",
            description: `Llamar update_content_plan con changes[] que cambien el image_source.model de las piezas afectadas a "nano_banana_2". Esto rutea esas generaciones a Creative Studio y aplica el template fijado. Slugs afectados: ${itemsBypassingTemplate.map((i) => i.slug).join(", ")}.`,
          },
        ],
      });
    }
  }

  return {
    blockers,
    warnings,
    totals,
    budget_remaining: budgetRemaining,
    text_budget_remaining: textBudgetRemaining,
    text_budget_total: textBudgetTotal,
    text_dependent_count: textDependentCount,
  };
}

// ── update_content_plan: apply individual changes to a working plan state ──

type WorkingState = {
  plan_items: Array<PlanItem & { sub_posts: SubPost[] }>;
  use_brand_voice: boolean;
  auto_publish_schedule?: { timezone: string; time_per_day: string };
};

type Change =
  | { action: "replace_item"; slug: string; new_item: PlanItem }
  | {
      action: "update_field";
      slug: string;
      field: "date" | "publish_at_time_local" | "timezone" | "concept_shared" | "rationale";
      value: string;
    }
  | { action: "add_item"; new_item: PlanItem }
  | { action: "remove_item"; slug: string }
  | { action: "shift_dates"; days_offset: number }
  | { action: "set_global"; field: "use_brand_voice" | "auto_publish_schedule"; value: unknown }
  | { action: "replace_sub_post"; slug: string; sub_post_index: number; new_sub_post: SubPost }
  | { action: "add_sub_post"; slug: string; new_sub_post: SubPost }
  | { action: "remove_sub_post"; slug: string; sub_post_index: number }
  | {
      action: "split_subposts_by_network";
      slug: string;
      new_items: Array<{ slug: string; publish_at_time_local: string; networks: SocialNetwork[] }>;
    }
  | {
      action: "convert_to_carousel";
      slug: string;
      sub_post_index: number;
      new_carousel_sources: NonNullable<AssetsStrategy["carousel_sources"]>;
    };

function applyChange(state: WorkingState, change: Change): void {
  switch (change.action) {
    case "replace_item": {
      const idx = state.plan_items.findIndex((it) => it.slug === change.slug);
      if (idx < 0) throw new Error(`replace_item: slug ${change.slug} not found.`);
      state.plan_items[idx] = { ...change.new_item, sub_posts: [...change.new_item.sub_posts] };
      return;
    }
    case "update_field": {
      const it = state.plan_items.find((x) => x.slug === change.slug);
      if (!it) throw new Error(`update_field: slug ${change.slug} not found.`);
      (it as unknown as Record<string, unknown>)[change.field] = change.value;
      return;
    }
    case "add_item": {
      if (state.plan_items.some((x) => x.slug === change.new_item.slug)) {
        throw new Error(`add_item: slug ${change.new_item.slug} already exists.`);
      }
      state.plan_items.push({ ...change.new_item, sub_posts: [...change.new_item.sub_posts] });
      return;
    }
    case "remove_item": {
      const idx = state.plan_items.findIndex((it) => it.slug === change.slug);
      if (idx < 0) throw new Error(`remove_item: slug ${change.slug} not found.`);
      state.plan_items.splice(idx, 1);
      return;
    }
    case "shift_dates": {
      const offsetMs = change.days_offset * 24 * 60 * 60 * 1000;
      for (const it of state.plan_items) {
        const d = new Date(`${it.date}T00:00:00Z`);
        d.setTime(d.getTime() + offsetMs);
        it.date = d.toISOString().slice(0, 10);
      }
      return;
    }
    case "set_global": {
      if (change.field === "use_brand_voice") {
        if (typeof change.value !== "boolean") throw new Error("set_global use_brand_voice expects boolean.");
        state.use_brand_voice = change.value;
      } else if (change.field === "auto_publish_schedule") {
        const v = change.value as { timezone?: string; time_per_day?: string } | null;
        if (!v || typeof v.timezone !== "string" || typeof v.time_per_day !== "string") {
          throw new Error("set_global auto_publish_schedule expects {timezone, time_per_day}.");
        }
        state.auto_publish_schedule = { timezone: v.timezone, time_per_day: v.time_per_day };
      }
      return;
    }
    case "replace_sub_post": {
      const it = state.plan_items.find((x) => x.slug === change.slug);
      if (!it) throw new Error(`replace_sub_post: slug ${change.slug} not found.`);
      if (change.sub_post_index < 0 || change.sub_post_index >= it.sub_posts.length) {
        throw new Error(`replace_sub_post: index ${change.sub_post_index} out of range.`);
      }
      it.sub_posts[change.sub_post_index] = { ...change.new_sub_post };
      return;
    }
    case "add_sub_post": {
      const it = state.plan_items.find((x) => x.slug === change.slug);
      if (!it) throw new Error(`add_sub_post: slug ${change.slug} not found.`);
      it.sub_posts.push({ ...change.new_sub_post });
      return;
    }
    case "remove_sub_post": {
      const it = state.plan_items.find((x) => x.slug === change.slug);
      if (!it) throw new Error(`remove_sub_post: slug ${change.slug} not found.`);
      if (change.sub_post_index < 0 || change.sub_post_index >= it.sub_posts.length) {
        throw new Error(`remove_sub_post: index ${change.sub_post_index} out of range.`);
      }
      it.sub_posts.splice(change.sub_post_index, 1);
      if (it.sub_posts.length === 0) {
        // Empty plan_item is invalid; remove it.
        state.plan_items = state.plan_items.filter((x) => x.slug !== change.slug);
      }
      return;
    }
    case "split_subposts_by_network": {
      const idx = state.plan_items.findIndex((x) => x.slug === change.slug);
      if (idx < 0) throw new Error(`split_subposts_by_network: slug ${change.slug} not found.`);
      const original = state.plan_items[idx]!;
      const partition = new Map<SocialNetwork, SubPost[]>();
      for (const sp of original.sub_posts) partition.set(sp.social_network, [
        ...(partition.get(sp.social_network) ?? []),
        sp,
      ]);
      const newItems: PlanItem[] = [];
      const pairedSlugs = change.new_items.map((n) => n.slug);
      for (const ni of change.new_items) {
        const collectedSubPosts: SubPost[] = [];
        for (const net of ni.networks) {
          const sps = partition.get(net) ?? [];
          collectedSubPosts.push(...sps);
        }
        if (collectedSubPosts.length === 0) {
          throw new Error(
            `split_subposts_by_network: no sub_posts found in original "${change.slug}" matching networks ${ni.networks.join(", ")}.`,
          );
        }
        newItems.push({
          slug: ni.slug,
          date: original.date,
          publish_at_time_local: ni.publish_at_time_local,
          timezone: original.timezone,
          concept_shared: original.concept_shared,
          rationale: original.rationale,
          paired_with: pairedSlugs.filter((s) => s !== ni.slug),
          sub_posts: collectedSubPosts,
        });
      }
      state.plan_items.splice(idx, 1, ...newItems);
      return;
    }
    case "convert_to_carousel": {
      const it = state.plan_items.find((x) => x.slug === change.slug);
      if (!it) throw new Error(`convert_to_carousel: slug ${change.slug} not found.`);
      const sp = it.sub_posts[change.sub_post_index];
      if (!sp) throw new Error(`convert_to_carousel: sub_post_index out of range.`);
      sp.asset_layout = "carousel_images";
      sp.assets_strategy = {
        carousel_sources: [...change.new_carousel_sources],
      };
      return;
    }
  }
}
