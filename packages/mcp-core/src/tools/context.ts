// Session context bootstrappers.
//
// Two read-only, idempotent tools that compose existing FollowrClient calls
// into the two "orient the session" packages the agent actually needs:
//
//   get_session_context           - light, called at start of any task that
//                                   needs company identity or credits
//   get_company_creative_brief    - heavier, called once a company is
//                                   chosen and the user wants to generate
//                                   or schedule content
//
// Both tools include an _assistant_guidance block in their response that
// tells the consuming agent how to act on the data: which company to ask
// about, when to reuse vs re-ask, how to refer to resources by name (never
// by id) in user-facing text.

import { FollowrClient } from "@followr-mcp/shared";
import type { Company } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

interface SocialNetworkLite {
  id: number;
  type?: string;
  status?: string | null;
}

function sanitizeCompany(company: Company) {
  const { webhook_secret, ai_keys, ...safe } = company;
  return {
    ...safe,
    webhook_secret_present: Boolean(webhook_secret),
    ai_keys_configured_providers: (ai_keys ?? []).map((k) => k.provider),
  };
}

/**
 * Fetch ALL companies the API token can see, paginating automatically.
 *
 * Followr's /api/companies endpoint enforces a server-side cap of 30 items
 * per page, regardless of what page[size] is passed. The response meta
 * always reports `per_page=30`. To paginate correctly we must:
 *   1. Pass pageSize that matches the actual server cap (30), NOT a higher
 *      "optimistic" value. Otherwise the "did we hit a partial page" check
 *      below becomes meaningless (a partial page == the end).
 *   2. Keep iterating until we receive a page with fewer than 30 items, OR
 *      hit the safety cap.
 *
 * Safety cap: 50 pages * 30/page = 1500 companies. Covers admin/superuser
 * scopes (cofounders, platform staff) that can see hundreds or thousands of
 * companies platform-wide, while still bounding the worst case.
 */
const COMPANIES_PAGE_SIZE = 30;
const COMPANIES_PAGE_LIMIT = 50;

async function fetchAllCompanies(client: FollowrClient): Promise<{
  companies: Company[];
  hit_cap: boolean;
}> {
  const all: Company[] = [];
  let hitCap = false;
  for (let page = 1; page <= COMPANIES_PAGE_LIMIT; page++) {
    const batch = await client.listCompanies({ pageSize: COMPANIES_PAGE_SIZE, pageNumber: page });
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < COMPANIES_PAGE_SIZE) break;
    if (page === COMPANIES_PAGE_LIMIT) {
      hitCap = true;
    }
  }
  return { companies: all, hit_cap: hitCap };
}

export function registerContextTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_session_context",
    {
      annotations: READ_ONLY,
      title: "Bootstrap session context (user + companies + credits)",
      description: `Light-weight bootstrapper for the agent at the start of any Followr conversation. Composes user info, available companies, and credit balance in one call.

USE FIRST: call this at the beginning of any task that requires company identity or credits. Replaces the chain of get_current_user + list_companies + get_credits_balance for the common "orient the session" case.

NO MUTATION: read-only, idempotent, safe to call repeatedly.

PRESENTING: when multiple companies are returned, present them to the user by NAME (the _assistant_guidance.user_facing_options array is already formatted for this). Use the _assistant_guidance.id_lookup map to resolve a chosen name back to company_id for subsequent tool calls. Never show numeric ids to the user.

NEXT STEPS based on _assistant_guidance.next_step:
- "proceed_with_single_company": exactly one owned company, use its id without asking.
- "ask_user_to_pick_company": multiple owned companies (or admin-scope token with no owned), present by name and wait for the user.
- "no_companies_available": token is invalid or unprovisioned; surface and stop.

OWNED VS ACCESSIBLE COMPANIES: the response field "companies" lists ONLY the companies the current user owns (where Company.user_id === user.id), matching how the Followr web UI presents them. If the token has admin/superuser scope (cofounders, staff, platform admins), the response also includes "accessible_companies" with companies owned by OTHER users that the token can read. Those are NOT presented by default in user_facing_options. Only consult accessible_companies when the user explicitly mentions a company by exact name or id that is not in the owned list. _assistant_guidance.has_admin_scope is true when this distinction applies.

If creative work follows (post generation, scheduling), consider calling get_company_creative_brief(company_id) once the company is chosen, to load brand voice / audience / existing tags / connected networks.`,
      inputSchema: {},
    },
    async () => {
      const [me, companiesResult, balanceResult] = await Promise.all([
        client.getMe(),
        fetchAllCompanies(client),
        client.getSubscriptionBalance().catch((err: unknown) => ({ _error: err instanceof Error ? err.message : String(err) })),
      ]);
      // Followr's GET /api/companies returns DIFFERENT scope depending on the
      // token's role:
      //   - Regular user token: only the companies that user owns
      //     (where `user_id == me.id`).
      //   - Admin / superuser token: ALL companies in the Followr platform
      //     (every customer's company), even though the UI of those tokens
      //     filters by ownership for display.
      //
      // Mirror the UI behavior: by default, only present the user's OWN
      // companies as selectable options. The non-owned companies stay
      // available as `accessible_companies` for the agent to use if the user
      // explicitly asks for one (by name or id). This avoids confusing the
      // typical user with a flood of companies that "look like the same
      // brand" because they belong to other accounts on the platform.
      const allCompanies = companiesResult.companies;
      const ownedCompanies = allCompanies.filter((c) => c.user_id === me.id);
      const accessibleCompanies = allCompanies.filter((c) => c.user_id !== me.id);
      const hasAdminScope = accessibleCompanies.length > 0;

      const user_facing_options = ownedCompanies.map((c) => c.name);
      const id_lookup: Record<string, number> = {};
      for (const c of ownedCompanies) {
        id_lookup[c.name] = c.id;
      }
      const multipleOwned = ownedCompanies.length > 1;
      const singleOwned = ownedCompanies.length === 1 ? ownedCompanies[0] : undefined;
      const next_step =
        ownedCompanies.length === 0
          ? hasAdminScope
            ? "ask_user_to_pick_company"
            : "no_companies_available"
          : singleOwned
            ? "proceed_with_single_company"
            : "ask_user_to_pick_company";
      const adminScopeNote = hasAdminScope
        ? ` Note: this token has admin/superuser scope and can also access ${accessibleCompanies.length} companies owned by other users; these are listed in accessible_companies and are not presented by default. Use them only when the user explicitly references one (by exact name or id).`
        : "";
      const instruction =
        ownedCompanies.length === 0
          ? hasAdminScope
            ? `This token has admin/superuser scope but no companies are owned by the current user. Ask the user which of the ${accessibleCompanies.length} accessible companies they want to operate on, by exact name or id. Use accessible_companies for context.`
            : `No companies accessible to this API token. The token may be invalid or the account unprovisioned. Surface this to the user and stop further Followr work.`
          : multipleOwned
            ? `The user owns ${ownedCompanies.length} companies. Before any write or scoped-read operation, ask the user which company by name (use user_facing_options). Once chosen, reuse the same company_id for the rest of the conversation. Never default silently to the first listed.${adminScopeNote}`
            : singleOwned
              ? `Single company owned by the user ("${singleOwned.name}"). Safe to use its id for subsequent operations without re-asking, unless the user explicitly mentions a different company.${adminScopeNote}`
              : "";
      const subscription =
        balanceResult && typeof balanceResult === "object" && !("_error" in balanceResult)
          ? {
              credits: balanceResult.credits,
              words_allowed: balanceResult.words_allowed,
              words_spent: balanceResult.words_spent,
              images_allowed: balanceResult.images_allowed,
              images_spent: balanceResult.images_spent,
              plus_chat_enabled: balanceResult.plus_chat_enabled,
              white_label_enabled: balanceResult.white_label_enabled,
            }
          : null;
      const response: Record<string, unknown> = {
        user: {
          id: me.id,
          name: me.name,
          email: me.email,
          timezone: me.timezone ?? null,
          language: me.language ?? null,
          credits: me.credits ?? null,
        },
        companies: ownedCompanies.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
        })),
        subscription,
        _assistant_guidance: {
          multiple_companies: multipleOwned,
          user_facing_options,
          id_lookup,
          next_step,
          instruction,
          companies_truncated: companiesResult.hit_cap,
          owned_companies_count: ownedCompanies.length,
          has_admin_scope: hasAdminScope,
          accessible_companies_count: accessibleCompanies.length,
        },
      };
      if (hasAdminScope) {
        response["accessible_companies"] = accessibleCompanies.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          owner_user_id: c.user_id,
        }));
      }
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    },
  );

  server.registerTool(
    "get_company_creative_brief",
    {
      annotations: READ_ONLY,
      title: "Get a company's creative context: brand voice, audience, tags, networks",
      description: `Heavier bootstrapper for any content generation or scheduling task. Composes the Company resource (brand voice fields, audience targeting, AI preferences), all configured brand-voice prompts, all existing tags, and the connected social networks for the company, in one call.

USE BEFORE: generate_text, generate_image, create_post_group + create_post, import_canva_design_as_post. Loading this once at the start of a content task lets the agent reference the company's voice, tone, audience, reuse existing tags (instead of creating duplicates), and verify which networks are actually connected.

PRECONDITION: company_id required. If company isn't yet chosen, call get_session_context first.

INCLUDED:
- company: name, description, website, language, country, audience_*, tones, syntaxes, palettes, ai_image_styles, ai_preferences (text_driver, image_driver, etc.), interests, characters, emotions, fonts. Secrets stripped (webhook_secret_present and ai_keys_configured_providers are returned as safe summaries).
- connected_networks: id + type + status for each social network wired to this company. Use this to verify a target network exists before creating Posts.
- brand_voice_prompts: company-scoped Prompt resources. Use the prompts marked default as system context for generate_text. Multiple defaults per network are normal; Followr picks one at generate time.
- existing_tags: every tag in the company. PREFER reusing these (by name match) over create_tag.

NOT INCLUDED (call separately if needed):
- analytics / top performers: get_best_performing_posts(company_id, ...).
- recent posts: list_drafts / list_scheduled.
- avatars or voices: list_avatars / list_voices.

PARTIAL FAILURES: each sub-call is tolerant. If listPrompts, listTags, or listSocialNetworks fails, that section comes back empty rather than blocking the whole brief. The company resource itself is mandatory; the tool throws if it can't load.

PRESENTING: refer to the company by name, tags by name, prompts by name. Never by id.`,
      inputSchema: {
        company_id: z.number().int().positive(),
      },
    },
    async ({ company_id }) => {
      const [companyResult, networksResult, promptsResult, tagsResult] = await Promise.allSettled([
        client.getCompany(company_id),
        client.listSocialNetworks(company_id),
        client.listPrompts({ companyId: company_id, pageSize: 100 }),
        client.listTags(company_id, { pageSize: 100 }),
      ]);
      if (companyResult.status === "rejected") {
        return toolErrorFromException(companyResult.reason);
      }
      const company = sanitizeCompany(companyResult.value);
      const networks =
        networksResult.status === "fulfilled" ? (networksResult.value as SocialNetworkLite[]) : [];
      const prompts = promptsResult.status === "fulfilled" ? promptsResult.value : [];
      const tags = tagsResult.status === "fulfilled" ? tagsResult.value : [];
      const has_brand_voice = prompts.length > 0;
      const default_prompts_by_network: Record<string, number> = {};
      for (const p of prompts) {
        if (p.default) {
          default_prompts_by_network[p.social_network_type] =
            (default_prompts_by_network[p.social_network_type] ?? 0) + 1;
        }
      }
      const response = {
        company,
        connected_networks: networks.map((n) => ({
          id: n.id,
          type: n.type ?? null,
          status: n.status ?? null,
        })),
        brand_voice_prompts: prompts.map((p) => ({
          id: p.id,
          name: p.name,
          social_network_type: p.social_network_type,
          default: p.default,
          prompt: p.prompt,
        })),
        existing_tags: tags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color ?? null,
          active: t.active ?? null,
        })),
        _assistant_guidance: {
          has_brand_voice,
          brand_voice_prompts_count: prompts.length,
          default_prompts_by_network,
          connected_networks_count: networks.length,
          existing_tags_count: tags.length,
          instruction: has_brand_voice
            ? `Use the company's description, audience fields, tones, and brand_voice_prompts (especially those with default=true for the target network) as system context when generating content. Reuse existing_tags by name match instead of creating duplicates. Verify connected_networks contains the target before creating Posts.`
            : `No company-scoped brand-voice prompts are configured. Generated content will fall back to Followr built-in defaults. Consider offering the user to create a brand-voice prompt for this company via create_prompt before generating a lot of content. Reuse existing_tags by name match instead of creating duplicates. Verify connected_networks contains the target before creating Posts.`,
          partial_failures: {
            networks: networksResult.status === "rejected",
            prompts: promptsResult.status === "rejected",
            tags: tagsResult.status === "rejected",
          },
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    },
  );
}
