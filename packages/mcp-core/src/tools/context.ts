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

OWNED VS ACCESSIBLE COMPANIES: the response field "companies" lists the companies the current user owns (where Company.user_id === user.id), matching how the Followr web UI presents them. Each company carries a relationship: "owner" marker. If the token has admin/superuser scope (cofounders, staff, platform admins), the response also includes "accessible_companies" with companies owned by OTHER users that the token can read, each marked relationship: "guest". Those guest companies are NOT presented by default in user_facing_options. Only consult accessible_companies when the user explicitly mentions a company by exact name or id that is not in the owned list. _assistant_guidance.has_admin_scope is true when this distinction applies.

NAME COLLISIONS: there are two kinds of collisions, and the response surfaces both.

(1) OWNED VS ACCESSIBLE: when an accessible (guest) company shares the SAME name as an owned company, the response merges that guest company into user_facing_options with a "(invitada)" suffix and sets _assistant_guidance.has_name_collision = true. In that case, when you ask the user which company to use, ALWAYS surface both options together in the SAME first turn (e.g. 'Tenés acceso a 2 PipeLime: una es tuya y otra es donde sos invitado. ¿Cuál usamos?'). Do NOT pose a generic "which X do you mean?" without showing the owner/guest disambiguation up front. The id_lookup map already contains both name -> id mappings (the guest entry is keyed with the "(invitada)" suffix).

(2) OWNED VS OWNED (added 2026-05-26): when TWO companies the user owns share the same name (real case: two "PipeLime" companies the user created, both with the same website), user_facing_options shows each duplicated entry with a built-in disambiguator "(creada YYYY-MM-DD)". Same-day collisions automatically extend to "(creada YYYY-MM-DD HH:MM)"; pathological same-minute collisions get a trailing "opción 1 / opción 2". The numeric id is DELIBERATELY EXCLUDED from these labels and from any user-facing surface. _assistant_guidance.has_owned_name_collision is true and owned_name_collisions[].companies[] carries the id (for internal id_lookup resolution) PLUS additional non-id distinguishers: website, language, country_iso_code, description_excerpt (first ~140 chars with internal markers stripped) and disabled_at. CRITICAL: do NOT silently pick one of the duplicates and just mention it in passing ("estoy trabajando sobre la que tiene IG conectado"). That's exactly what the prior implementation did and the user could not even tell which was used. EQUALLY CRITICAL: do NOT surface the numeric id to the user, ever, in any form — not in tables ("PipeLime A (17889) vs PipeLime B (42129)"), not in inline references, not as a "tiebreaker", not as headers, not as parenthetical hints. Use the date, the description excerpt, the website or any combination of non-id fields. Surface ALL duplicated entries in user_facing_options together in the SAME AskUserQuestion call this turn, ENRICH the question with whichever extra distinguishers from owned_name_collisions[].companies[] differ between the dupes (e.g. "una con sitio pipelime.ai y descripción de freelancers, otra sin sitio y descripción enterprise"), and wait for the user's explicit pick before calling any tool with a company_id. id_lookup keys are the EXACT disambiguated labels, so the user's pick resolves cleanly to a company_id internally.

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

      // Name collision detection (2026-05-26: extended to cover OWNED dupes).
      //
      // Three collision flavours:
      //   1. Owned vs accessible: same name on a company the user owns AND on a
      //      company they were invited to. Existing behavior: promote the
      //      accessible into user_facing_options with the "(invitada)" suffix.
      //   2. Owned vs owned: TWO companies the user owns share the same name
      //      (real case 2026-05-26: the user had two "PipeLime" both owned,
      //      both with website pipelime.ai; the agent silently picked one and
      //      the user could not even tell). New behavior: append an id-free
      //      disambiguator "(creada YYYY-MM-DD)" (date-only is enough in the
      //      common case). Same-day collisions extend to a HH:MM timestamp.
      //      Pathological same-minute collisions fall back to a stable
      //      "opción 1 / opción 2" ordinal. The numeric id is intentionally
      //      excluded from the label (a prior version did "· #ID" as a
      //      tiebreaker and the LLM surfaced the id verbatim to the user).
      //   3. Accessible vs accessible: same name on two accessible (guest)
      //      companies. Rare but possible on admin tokens. Suffix the same way.
      const ownedNames = new Set(ownedCompanies.map((c) => c.name));
      const collidingAccessibles = accessibleCompanies.filter((c) => ownedNames.has(c.name));
      const hasNameCollision = collidingAccessibles.length > 0;

      // Owned duplicate detection: any name that appears more than once across
      // the owned list. Names that only collide with an accessible (existing
      // hasNameCollision case) are NOT counted as owned dupes; that path
      // already disambiguates via "(invitada)".
      const ownedNameCounts = new Map<string, number>();
      for (const c of ownedCompanies) {
        ownedNameCounts.set(c.name, (ownedNameCounts.get(c.name) ?? 0) + 1);
      }
      const ownedDuplicateNames = new Set<string>();
      for (const [name, count] of ownedNameCounts) {
        if (count > 1) ownedDuplicateNames.add(name);
      }
      const hasOwnedNameCollision = ownedDuplicateNames.size > 0;
      // Build per-company collision details with EVERY non-id field that
      // could help the agent enrich its disambiguation question to the
      // user (website, language, country, a short description excerpt).
      // The agent should compose a question like "una creada en septiembre
      // 2024 con sitio pipelime.ai en español, otra creada en mayo 2025
      // con sitio pipelime-enterprise.ai" instead of ever surfacing #ID.
      const descriptionExcerpt = (desc: string | null | undefined): string | null => {
        if (!desc) return null;
        // Drop internal markers ([industry:...], [visual_style:...]) and
        // trim to ~140 chars for a useful preview.
        const clean = desc
          .replace(/\[[^\]]+\]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!clean) return null;
        return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
      };
      const ownedCollisionDetails = hasOwnedNameCollision
        ? Array.from(ownedDuplicateNames).map((name) => ({
            name,
            companies: ownedCompanies
              .filter((c) => c.name === name)
              .map((c) => ({
                id: c.id,
                created_at: c.created_at,
                website: c.website ?? null,
                language: c.language ?? null,
                country_iso_code: c.country_iso_code ?? null,
                description_excerpt: descriptionExcerpt(c.description ?? null),
                disabled_at: c.disabled_at ?? null,
              })),
          }))
        : [];

      // Accessible duplicates among the colliding accessibles only (rare).
      const collidingAccessibleNameCounts = new Map<string, number>();
      for (const c of collidingAccessibles) {
        collidingAccessibleNameCounts.set(c.name, (collidingAccessibleNameCounts.get(c.name) ?? 0) + 1);
      }
      const accessibleDuplicateNames = new Set<string>();
      for (const [name, count] of collidingAccessibleNameCounts) {
        if (count > 1) accessibleDuplicateNames.add(name);
      }

      // Stable label for the user. For dupes we append "(creada YYYY-MM-DD)"
      // so the user can pick by date (the most natural cue) WITHOUT ever
      // exposing the numeric id. If two same-name dupes share the exact
      // same day, fall back to a HH:MM timestamp; if they ALSO share the
      // minute (essentially impossible for real users, only via API abuse),
      // fall back to a short "(opción 1)" / "(opción 2)" deterministic
      // ordinal. The numeric id NEVER appears in the user-facing label.
      // The id stays available to the agent through id_lookup (which maps
      // label -> id internally) so tool calls continue to work.
      //
      // Rationale (2026-05-26 PipeLime regression): the previous label
      // included "· #${c.id}" "as a tiebreaker" and the LLM surfaced the
      // ID verbatim to the user in a comparison table ("PipeLime A (17889)
      // vs PipeLime B (42129)"). Rule 5 / Rule 6 say "never expose IDs to
      // the user" but if the label CONTAINS the id, the LLM treats it as
      // part of the displayable name. Fix: make the label intrinsically
      // id-free.
      const dateOnly = (iso: string): string => iso.slice(0, 10);
      const timeHHMM = (iso: string): string => {
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return "";
        const hh = String(dt.getUTCHours()).padStart(2, "0");
        const mm = String(dt.getUTCMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
      };
      const buildDupeLabel = <T extends { name: string; created_at: string; id: number }>(
        list: T[],
        c: T,
        prefix: string,
      ): string => {
        const siblings = list.filter((s) => s.name === c.name);
        const myDate = dateOnly(c.created_at);
        const sameDay = siblings.filter((s) => dateOnly(s.created_at) === myDate);
        if (sameDay.length === 1) {
          return `${c.name} (${prefix}creada ${myDate})`;
        }
        const myTime = timeHHMM(c.created_at);
        const sameMinute = sameDay.filter((s) => timeHHMM(s.created_at) === myTime);
        if (sameMinute.length === 1) {
          return `${c.name} (${prefix}creada ${myDate} ${myTime})`;
        }
        // Pathological case: same name, same created_at down to the
        // minute. Use a stable ordinal derived from the id ORDER (not the
        // id value): the lowest id becomes "opción 1", the next "opción 2",
        // etc. The numeric id itself is never shown.
        const sorted = [...sameMinute].sort((a, b) => a.id - b.id);
        const idx = sorted.findIndex((s) => s.id === c.id);
        const ordinal = idx >= 0 ? idx + 1 : "?";
        return `${c.name} (${prefix}creada ${myDate} ${myTime}, opción ${ordinal})`;
      };
      const ownedLabel = (c: typeof ownedCompanies[number]): string =>
        ownedDuplicateNames.has(c.name) ? buildDupeLabel(ownedCompanies, c, "") : c.name;
      const accessibleLabel = (c: typeof accessibleCompanies[number]): string =>
        accessibleDuplicateNames.has(c.name)
          ? buildDupeLabel(collidingAccessibles, c, "invitada · ")
          : `${c.name} (invitada)`;

      // user_facing_options is the array the agent presents to the user.
      // - Always includes all owned companies, with disambiguation when names
      //   collide among them.
      // - Adds accessible companies ONLY when their name collides with an
      //   owned one, with the "(invitada)" suffix (and an extra date+id
      //   tiebreaker when accessibles themselves collide).
      const user_facing_options: string[] = [
        ...ownedCompanies.map(ownedLabel),
        ...collidingAccessibles.map(accessibleLabel),
      ];
      // id_lookup maps the label EXACTLY as it appears in user_facing_options
      // to its company_id. Because labels are disambiguated, no key is ever
      // overwritten.
      const id_lookup: Record<string, number> = {};
      for (const c of ownedCompanies) {
        id_lookup[ownedLabel(c)] = c.id;
      }
      for (const c of collidingAccessibles) {
        id_lookup[accessibleLabel(c)] = c.id;
      }
      const multipleOwned = ownedCompanies.length > 1;
      const singleOwned = ownedCompanies.length === 1 ? ownedCompanies[0] : undefined;
      // When there is ANY name collision (owned-vs-accessible OR owned-vs-owned)
      // the user MUST pick; single-owned shortcut does not apply because we
      // cannot guess which "PipeLime" they mean.
      const next_step =
        ownedCompanies.length === 0
          ? hasAdminScope
            ? "ask_user_to_pick_company"
            : "no_companies_available"
          : hasNameCollision || hasOwnedNameCollision
            ? "ask_user_to_pick_company"
            : singleOwned
              ? "proceed_with_single_company"
              : "ask_user_to_pick_company";
      const adminScopeNote = hasAdminScope
        ? ` Note: this token has admin/superuser scope and can also access ${accessibleCompanies.length} companies owned by other users; these are listed in accessible_companies. Use them only when the user explicitly references one (by exact name or id), with the exception of name collisions which are already merged into user_facing_options.`
        : "";
      const collisionNote = hasNameCollision
        ? ` There ${collidingAccessibles.length === 1 ? "is" : "are"} ${collidingAccessibles.length} accessible compan${collidingAccessibles.length === 1 ? "y" : "ies"} with the SAME name as a company the user owns (${collidingAccessibles.map((c) => `"${c.name}"`).join(", ")}). They appear in user_facing_options with the suffix "(invitada)" so you can distinguish them in the first message. Tell the user up front which "${collidingAccessibles[0]?.name ?? "company"}" is their own and which is the one they were invited to; do NOT ask "which X do you mean?" without showing this disambiguation.`
        : "";
      const ownedCollisionNote = hasOwnedNameCollision
        ? ` The user owns ${ownedDuplicateNames.size > 1 ? "MULTIPLE pairs of" : ""} companies with the SAME name (${Array.from(ownedDuplicateNames).map((n) => `"${n}"`).join(", ")}). user_facing_options shows each duplicated entry with a built-in disambiguator "(creada YYYY-MM-DD)" so the user can pick the right one by creation date. Same-day collisions automatically extend to "(creada YYYY-MM-DD HH:MM)". The numeric id is DELIBERATELY NOT in the label and you MUST NOT add it; rely on id_lookup to resolve the user's pick to a company_id internally. NEVER pick one silently and just mention it in passing ("estoy trabajando sobre la que tiene IG conectado"): always surface ALL of them in the SAME AskUserQuestion call this turn, showing the creation dates AND enriching with the extra distinguishers from owned_name_collisions[].companies[] (website, language, country_iso_code, description_excerpt, disabled_at if any) so the user can tell them apart by content, not by date alone. CRITICAL: do NOT show numeric ids or "#${'NUMBER'}" patterns to the user in your AskUserQuestion call, in tables, or anywhere else. Rule 5 / Rule 6 of the MCP instructions are absolute on this point; this collision branch is the most common temptation to break them. Wait for the user's pick BEFORE any tool call that takes company_id.`
        : "";
      const instruction =
        ownedCompanies.length === 0
          ? hasAdminScope
            ? `This token has admin/superuser scope but no companies are owned by the current user. Ask the user which of the ${accessibleCompanies.length} accessible companies they want to operate on, by exact name or id. Use accessible_companies for context.`
            : `No companies accessible to this API token. The token may be invalid or the account unprovisioned. Surface this to the user and stop further Followr work.`
          : hasOwnedNameCollision
            ? `The user owns ${ownedCompanies.length} companies AND ${ownedDuplicateNames.size === 1 ? "two or more share the same name" : "multiple share names"}. Ask the user which one by the disambiguated label in user_facing_options.${ownedCollisionNote}${hasNameCollision ? collisionNote : ""}${adminScopeNote}`
            : hasNameCollision
              ? `The user owns ${ownedCompanies.length} compan${ownedCompanies.length === 1 ? "y" : "ies"} AND has access to ${collidingAccessibles.length} additional compan${collidingAccessibles.length === 1 ? "y" : "ies"} with a colliding name. Ask the user which one by name, surfacing the "(invitada)" label so they can tell which is which.${collisionNote}`
              : multipleOwned
                ? `The user owns ${ownedCompanies.length} companies. Before any write or scoped-read operation, ask the user which company by name (use user_facing_options). Once chosen, reuse the same company_id for the rest of the conversation. Never default silently to the first listed.${adminScopeNote}`
                : singleOwned
                  ? `Single company owned by the user ("${singleOwned.name}"). Safe to use its id for subsequent operations without re-asking, unless the user explicitly mentions a different company.${adminScopeNote}`
                  : "";
      // Per-modality AI budgets. Mirrors get_ai_budget output shape (the
      // simpler 4-bucket model) so any agent that sees only get_session_context
      // already has the correct mental model. The legacy 'credits' field from
      // Followr's API is intentionally NOT surfaced here: it's a deprecated
      // counter (AppSumo lifetime + topups) that previously misled agents into
      // false "you don't have enough credits" conclusions.
      const subscription =
        balanceResult && typeof balanceResult === "object" && !("_error" in balanceResult)
          ? {
              ai_text_budget: {
                remaining: balanceResult.words_allowed - balanceResult.words_spent,
                used: balanceResult.words_spent,
                total: balanceResult.words_allowed,
              },
              ai_image_and_video_budget: {
                remaining: balanceResult.images_allowed - balanceResult.images_spent,
                used: balanceResult.images_spent,
                total: balanceResult.images_allowed,
                note: "video and image generation share this bucket; there is no separate video quota",
              },
              plus_chat_enabled: balanceResult.plus_chat_enabled,
              white_label_enabled: balanceResult.white_label_enabled,
              _what_to_use_for_decisions:
                "For any video or image generation cost decision, read ai_image_and_video_budget.remaining (not the deprecated 'credits' field that the underlying API still exposes).",
            }
          : null;
      const response: Record<string, unknown> = {
        user: {
          id: me.id,
          name: me.name,
          email: me.email,
          timezone: me.timezone ?? null,
          language: me.language ?? null,
        },
        companies: ownedCompanies.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          relationship: "owner" as const,
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
          has_name_collision: hasNameCollision,
          name_collisions: hasNameCollision
            ? collidingAccessibles.map((c) => ({
                name: c.name,
                owned_id: ownedCompanies.find((o) => o.name === c.name)?.id ?? null,
                accessible_id: c.id,
              }))
            : [],
          has_owned_name_collision: hasOwnedNameCollision,
          owned_name_collisions: ownedCollisionDetails,
        },
      };
      if (hasAdminScope) {
        response["accessible_companies"] = accessibleCompanies.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          owner_user_id: c.user_id,
          relationship: "guest" as const,
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
