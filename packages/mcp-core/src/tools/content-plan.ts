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
import { READ_ONLY } from "../lib/annotations.js";
import {
  FOLLOWR_CAPABILITIES_SUMMARY,
  IMAGE_MODELS,
  NETWORK_FORMAT_COMPATIBILITY,
  PLANNING_STRATEGY,
  VIDEO_MODELS,
  compatibilityFor,
} from "../lib/content-plan-catalog.js";
import { createContext } from "../lib/content-plan-state.js";
import type { SocialNetwork } from "../lib/content-plan-state.js";
import { toolErrorFromException } from "../lib/tool-error.js";

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
}
