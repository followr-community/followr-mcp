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

import type { Company, Prompt, RuleGroup, Asset, PostGroup, Avatar, Voice, Tag, Folder } from "@followr-mcp/shared";
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
} from "../lib/content-plan-catalog.js";
import {
  type AssetLayout,
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
} from "../lib/content-plan-state.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

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
  // Name path: search.
  const search = String(hint).toLowerCase().trim();
  const candidates: Company[] = [];
  // Page through companies (Followr enforces page_size=30 server-side).
  for (let page = 1; page <= 10; page++) {
    const batch = await client.listCompanies({ pageSize: 30, pageNumber: page });
    if (batch.length === 0) break;
    for (const c of batch) {
      if ((c.name ?? "").toLowerCase().includes(search)) {
        candidates.push(c);
      }
    }
    if (batch.length < 30) break;
  }
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
  ai_premium_image_models_budget: AiBudget;
  storage_budget: AiBudget & { remaining_gb: number; used_gb: number; total_gb: number };
}

async function loadBudgets(client: FollowrClient): Promise<AllBudgets | null> {
  try {
    const balance = await client.getSubscriptionBalance();
    const bytesSpent =
      typeof balance.bytes_spent === "string" ? Number(balance.bytes_spent) : Number(balance.bytes_spent ?? 0);

    const textRemaining = balance.words_allowed - balance.words_spent;
    const imagesRemaining = balance.images_allowed - balance.images_spent;
    const premiumRemaining = balance.premium_images_allowed - balance.premium_images_spent;
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
      ai_premium_image_models_budget: {
        remaining: premiumRemaining,
        used: balance.premium_images_spent,
        total: balance.premium_images_allowed,
        percent_used: pct(balance.premium_images_spent, balance.premium_images_allowed),
        note:
          premiumRemaining <= 0
            ? "exhausted: premium image models (gpt_image_2, imagen4, nano_banana_pro, etc.) will fail with HTTP 402 on this plan"
            : noteHigh(pct(balance.premium_images_spent, balance.premium_images_allowed)),
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
    };
  } catch {
    return null;
  }
}

// Mark video models with affordable: true/false given current budget.
function annotateVideoModels(imageVideoRemaining: number) {
  return VIDEO_MODELS.map((m) => ({
    ...m,
    affordable_at_default_duration: m.cost_for_default_duration <= imageVideoRemaining,
    cost_note: `${m.cost_per_second} credits per second of video (${m.default_duration_seconds}s default = ${m.cost_for_default_duration} cr total).`,
  }));
}

function annotateImageModels(imagesRemaining: number, premiumRemaining: number) {
  return IMAGE_MODELS.map((m) => ({
    ...m,
    affordable: m.bucket === "premium" ? premiumRemaining >= m.cost_per_image : imagesRemaining >= m.cost_per_image,
    cost_note: `${m.cost_per_image} credits per image (${m.bucket} bucket).`,
  }));
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

MUTATION: none. Read-only. Safe to call multiple times if the user changes company or window.

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
      },
    },
    async ({ company, include_website_summary }) => {
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
        client.listRuleGroups(company_id),
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

      const imageVideoRemaining = budgets?.ai_image_and_video_budget.remaining ?? Number.POSITIVE_INFINITY;
      const premiumRemaining = budgets?.ai_premium_image_models_budget.remaining ?? Number.POSITIVE_INFINITY;
      const videoModels = annotateVideoModels(imageVideoRemaining);
      const imageModels = annotateImageModels(imageVideoRemaining, premiumRemaining);

      // 6. Persist the context snapshot for later validation by
      // draft_content_plan.
      const ctx = createContext({
        company_id,
        networks_connected: connectedNetworks,
        brand_has_voice_prompt: hasBrandVoice,
      });

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
        publishing_rule_groups: ruleGroups.map((rg) => ({
          id: rg.id,
          name: (rg as RuleGroup & { name?: string }).name ?? null,
          random_minutes: (rg as RuleGroup & { random_minutes?: number }).random_minutes ?? null,
        })),
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
        followr_capabilities_summary: FOLLOWR_CAPABILITIES_SUMMARY,
        _assistant_guidance: {
          ultrathink_required: PLANNING_STRATEGY.ultrathink_required,
          planning_strategy: PLANNING_STRATEGY,
          next_step: "ask_user_clarifying_question_then_draft",
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
    reference_image_url: z.string().url().optional(),
    model: z.string().optional(),
  });
  const AssetSourceAiVideoSchema = z.object({
    type: z.literal("ai_generate"),
    model: z.string().min(1),
    prompt: z.string().min(1).max(2000),
    reference_image_url: z.string().url().optional(),
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
      .optional(),
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
    caption_concept: z.string().min(1).max(2000),
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

AFTER THIS RETURNS: show the summary table to the user verbatim, list any warnings, and ask for explicit approval. ONLY THEN call execute_content_plan(plan_id, confirm: true). If the user wants changes, call update_content_plan(plan_id, changes) instead.`,
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

      // 2. Per-item validation (intra) + collect cross-data.
      const blockers: Array<Record<string, unknown>> = [];
      const warnings: Array<Record<string, unknown>> = [];
      const slugSeen = new Set<string>();
      const slotMap = new Map<string, Array<{ slug: string; network: SocialNetwork }>>();

      let totalImagesAiCost = 0;
      let totalImagesAiCount = 0;
      let totalVideosAiCost = 0;
      let totalVideosAiCount = 0;
      let totalUploadsCount = 0;
      let totalExistingAssetReuse = 0;

      for (const item of input.plan_items) {
        // Unique slug across items.
        if (slugSeen.has(item.slug)) {
          blockers.push({
            issue: "duplicate_slug",
            slug: item.slug,
            detail: `Slug "${item.slug}" appears more than once. Each plan_item needs a unique slug.`,
          });
        }
        slugSeen.add(item.slug);

        // Date in window.
        if (item.date < input.time_window.start || item.date > input.time_window.end) {
          warnings.push({
            issue: "date_out_of_window",
            item: item.slug,
            detail: `Item date ${item.date} is outside the requested window ${input.time_window.start}..${input.time_window.end}.`,
          });
        }

        // Per-sub-post validation.
        for (let i = 0; i < item.sub_posts.length; i++) {
          const sp = item.sub_posts[i] as SubPost;
          const slotKey = `${item.date}T${item.publish_at_time_local}`;
          (slotMap.get(slotKey) ?? slotMap.set(slotKey, []).get(slotKey))!.push({
            slug: item.slug,
            network: sp.social_network,
          });

          // Network connected on this company?
          if (!ctx.networks_connected.includes(sp.social_network)) {
            warnings.push({
              issue: "network_not_connected",
              item: item.slug,
              sub_post_index: i,
              network: sp.social_network,
              detail: `${sp.social_network} is not connected to this company. Ask the user to connect it in Followr settings or remove it from the plan.`,
            });
          }

          // social_network + product_type + asset_layout compatibility.
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

          // asset_layout vs assets_strategy shape.
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

          // Cost estimation per sub_post.
          const cost = estimateSubPostCost(sp);
          totalImagesAiCost += cost.image_ai_cost;
          totalImagesAiCount += cost.image_ai_count;
          totalVideosAiCost += cost.video_ai_cost;
          totalVideosAiCount += cost.video_ai_count;
          totalUploadsCount += cost.upload_count;
          totalExistingAssetReuse += cost.reuse_count;

          // Rationale ↔ layout coherence soft warning.
          if (
            sp.asset_layout === "single_image" &&
            /(carrusel|carousel|comparativa|comparison|múltiples?|multiples?|step.?by.?step|antes\s*\/\s*despu[eé]s|before\s*\/\s*after|\b\d+\s+looks?\b|\b\d+\s+formas?\b|\b\d+\s+tips?\b)/i.test(item.rationale + " " + sp.caption_concept)
          ) {
            warnings.push({
              issue: "rationale_suggests_carousel_but_layout_is_single",
              item: item.slug,
              sub_post_index: i,
              detail:
                "El rationale o caption sugieren múltiples items pero el asset_layout es single_image. Considerá cambiar a carousel_images.",
            });
          }
        }
      }

      // 3. Cross-items: duplicate network per slot.
      for (const [slotKey, entries] of slotMap) {
        const counts = new Map<SocialNetwork, string[]>();
        for (const e of entries) {
          (counts.get(e.network) ?? counts.set(e.network, []).get(e.network))!.push(e.slug);
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
                  description:
                    "Change the publish_at_time_local of one of the duplicate items so the two posts to ${network} land at different moments.",
                },
              ],
            });
          }
        }
      }

      // 4. Budget check.
      const totalAiCost = totalImagesAiCost + totalVideosAiCost;
      // We can't introspect the live budget here without a fresh API call; use
      // the snapshot pattern: re-fetch a budget summary so the agent surfaces
      // an up-to-date number. If budget cannot be loaded, skip the hard check.
      let budgetRemaining: number | null = null;
      try {
        const budget = await loadBudgets(client);
        budgetRemaining = budget?.ai_image_and_video_budget.remaining ?? null;
      } catch {
        budgetRemaining = null;
      }
      if (budgetRemaining !== null && totalAiCost > budgetRemaining) {
        blockers.push({
          issue: "budget_exceeded",
          requested: totalAiCost,
          available: budgetRemaining,
          shortage: totalAiCost - budgetRemaining,
          detail: `This plan needs ${totalAiCost} credits of ai_image_and_video_budget but the company has ${budgetRemaining}. Shortage: ${totalAiCost - budgetRemaining}.`,
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

      // 5. Brand voice missing soft warning.
      if (!ctx.brand_has_voice_prompt && input.use_brand_voice) {
        warnings.push({
          issue: "brand_voice_missing",
          detail:
            "use_brand_voice is true but this company has no brand voice prompt loaded. Copies will fall back to Followr default voice. Offer the user to create one with create_prompt BEFORE executing.",
        });
      }

      // 6. Persist plan (even with blockers, so update_content_plan can fix fields).
      const plan = createPlan({
        context_id: input.context_id,
        company_id: ctx.company_id,
        time_window: input.time_window,
        user_answers: input.user_answers ?? {},
        plan_items: input.plan_items as PlanItem[],
        use_brand_voice: input.use_brand_voice ?? true,
        ...(input.auto_publish_schedule ? { auto_publish_schedule: input.auto_publish_schedule } : {}),
      });

      // 7. Build summary table for the user.
      const summaryRows = buildSummaryTable(plan);

      const response = {
        plan_id: plan.plan_id,
        status: blockers.length > 0 ? "needs_revision" : "ready_for_execution",
        summary_for_user: summaryRows,
        totals: {
          plan_items_count: input.plan_items.length,
          sub_posts_count: input.plan_items.reduce((a, it) => a + it.sub_posts.length, 0),
          estimated_ai_image_generations: totalImagesAiCount,
          estimated_ai_video_generations: totalVideosAiCount,
          estimated_asset_uploads: totalUploadsCount,
          estimated_existing_asset_reuse: totalExistingAssetReuse,
          estimated_total_credits_cost: totalAiCost,
          budget_remaining_before_execution: budgetRemaining,
          budget_remaining_after_execution:
            budgetRemaining !== null ? budgetRemaining - totalAiCost : null,
        },
        warnings,
        blockers,
        next_step_instructions:
          blockers.length > 0
            ? "There are blockers (listed above). Surface them to the user with the resolution_options for each, then call update_content_plan(plan_id, changes) with the chosen fixes. Do NOT call execute_content_plan until status is ready_for_execution."
            : "Show summary_for_user to the user (translate display_name fields, never expose ids). List any warnings. Ask for explicit approval ('lo ejecuto?' / 'cambio algo?'). When the user confirms, call execute_content_plan(plan_id, confirm: true). If the user wants to change a specific item, call update_content_plan(plan_id, changes) instead.",
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

function estimateSubPostCost(sp: SubPost): SubPostCost {
  const out: SubPostCost = {
    image_ai_cost: 0,
    image_ai_count: 0,
    video_ai_cost: 0,
    video_ai_count: 0,
    upload_count: 0,
    reuse_count: 0,
  };

  const accumulateImageSource = (src: AssetsStrategy["image_source"] | NonNullable<AssetsStrategy["carousel_sources"]>[number]) => {
    if (!src) return;
    if (src.type === "url") out.upload_count += 1;
    else if (src.type === "asset_id") out.reuse_count += 1;
    else if (src.type === "ai_generate") {
      const model = IMAGE_MODELS.find((m) => m.model_id === (src.model ?? "nano_banana_2")) ?? IMAGE_MODELS[0];
      out.image_ai_count += 1;
      out.image_ai_cost += model?.cost_per_image ?? 25;
    }
  };

  if (sp.assets_strategy.image_source) accumulateImageSource(sp.assets_strategy.image_source);
  if (sp.assets_strategy.carousel_sources) {
    for (const s of sp.assets_strategy.carousel_sources) accumulateImageSource(s);
  }
  if (sp.assets_strategy.video_source) {
    const vs = sp.assets_strategy.video_source;
    if (vs.type === "url") out.upload_count += 1;
    else if (vs.type === "asset_id") out.reuse_count += 1;
    else if (vs.type === "ai_generate") {
      const model = VIDEO_MODELS.find((m) => m.model_id === vs.model);
      if (model) {
        out.video_ai_count += 1;
        const duration = vs.duration_seconds ?? model.default_duration_seconds;
        out.video_ai_cost += model.cost_per_second * duration;
      } else {
        // Unknown model; charge conservative high estimate so the budget check
        // catches it. Equivalent to Veo 3 Fast (3200 cr).
        out.video_ai_count += 1;
        out.video_ai_cost += 400 * 8;
      }
    } else if (vs.type === "ai_avatar_lipsync") {
      // veed_fabric at ~25 cr/sec, average ~12 sec.
      out.video_ai_count += 1;
      out.video_ai_cost += 25 * 12;
    } else if (vs.type === "ai_avatar_video") {
      // Multi-scene: each scene ~10 sec at 25 cr/sec + backgrounds.
      const sceneCount = vs.scripts.length;
      const lipsyncCost = 25 * 10 * sceneCount;
      const backgroundCost = vs.generate_backgrounds ? 60 * sceneCount : 0;
      out.video_ai_count += 1;
      out.video_ai_cost += lipsyncCost + backgroundCost;
    }
  }
  return out;
}

function buildSummaryTable(plan: ContentPlan): string[] {
  const lines: string[] = [];
  lines.push("| Día | Hora | Concepto | Red | Formato | Asset | Costo estimado |");
  lines.push("|-----|------|----------|-----|---------|-------|----------------|");
  for (const item of plan.plan_items) {
    for (let i = 0; i < item.sub_posts.length; i++) {
      const sp = item.sub_posts[i] as SubPost;
      const cost = estimateSubPostCost(sp);
      const totalCost = cost.image_ai_cost + cost.video_ai_cost;
      lines.push(
        `| ${item.date} | ${item.publish_at_time_local} | ${i === 0 ? item.concept_shared : "↳ (mismo concepto)"} | ${displayNetworkName(sp.social_network)} | ${displayLayout(sp.asset_layout, sp.product_type)} | ${displayAssetStrategy(sp.assets_strategy, sp.asset_layout)} | ${totalCost > 0 ? `${totalCost} cr` : "0 cr"} |`,
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

function displayAssetStrategy(strategy: AssetsStrategy, layout: AssetLayout): string {
  if (layout === "single_image" && strategy.image_source) {
    if (strategy.image_source.type === "url") return "Foto del sitio";
    if (strategy.image_source.type === "asset_id") return "Foto ya subida";
    if (strategy.image_source.type === "ai_generate") return "Imagen AI";
  }
  if (layout === "carousel_images" && strategy.carousel_sources) {
    return `${strategy.carousel_sources.length} imágenes (carrusel)`;
  }
  if ((layout === "single_video" || layout === "single_gif") && strategy.video_source) {
    const vs = strategy.video_source;
    if (vs.type === "url") return "Video ya disponible";
    if (vs.type === "asset_id") return "Video ya subido";
    if (vs.type === "ai_generate") {
      const model = VIDEO_MODELS.find((m) => m.model_id === vs.model);
      return model ? `Video AI (${model.display_name})` : "Video AI";
    }
    if (vs.type === "ai_avatar_lipsync") return "Avatar lipsync";
    if (vs.type === "ai_avatar_video") return `Avatar video (${vs.scripts.length} escenas)`;
  }
  return "—";
}
