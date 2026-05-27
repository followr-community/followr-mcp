import { FollowrClient } from "@followr-mcp/shared";
import type { Company } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";

/**
 * Strip internal markers ([industry:saas@...], [visual_style:...]) and
 * trim a company description down to a ~140-char preview suitable for
 * disambiguating duplicate-named companies. Mirrors the logic in
 * context.ts so list_companies and get_session_context return identical
 * description excerpts when duplicates collide.
 */
function descriptionExcerpt(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const clean = desc
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
}

export function registerCompanyTools(server: McpServer, client: FollowrClient, _options: RegisterOptions): void {
  server.registerTool(
    "list_companies",
    {
      annotations: READ_ONLY,
      title: "List Followr companies",
      description: `List the Followr companies (companies) accessible by the current API token.

RESPONSE SHAPE: always returns { companies: [...], _assistant_guidance?: {...} }. The companies array is the list of accessible companies, each entry minimally { id, name, type }. When duplicate names are detected in the result, each duplicate entry is enriched in place with extra disambiguators (relationship: "owner" | "guest" | "unknown", created_at_date, website, language, country_iso_code, description_excerpt, disabled_at) AND _assistant_guidance is populated with has_name_collisions: true plus an instruction for how to surface the duplicates to the user. Non-duplicate entries keep the minimal { id, name, type } shape.

PREFER get_session_context for session bootstrapping. It returns the same company list PLUS user info, credit balance, plan capability warnings, and a pre-formatted _assistant_guidance block with user_facing_options (already-disambiguated labels) and id_lookup. Use list_companies only when you specifically need just the company list (e.g. mid-session lookup, refresh after a company was added). If list_companies returns _assistant_guidance.has_name_collisions=true and you need full disambiguation (id_lookup, owned vs guest split for admin tokens, ready-to-use labels), call get_session_context instead.

PRESENTING TO THE USER: when more than one company is returned, present the options by NAME (not by id). Example: "Tenés acceso a 'PostApprove', 'Empresa B' y 'Empresa C'. ¿En cuál querés trabajar?". Use the id only inside subsequent tool calls, never in user-facing text. When duplicates are present, ENRICH the question with the extra disambiguators from the duplicate entries (relationship "owner" vs "guest" is usually the most useful, then created_at_date, then website). NEVER pick one silently: surface ALL duplicate options to the user in the SAME AskUserQuestion call and wait for their explicit pick (system prompt Rule 1 and Rule 5 are absolute on this). The id stays in the response for your internal use only.

STICKY CONTEXT: once the user picks a company, reuse that company_id for the rest of the conversation without re-asking, unless the user explicitly switches companies.`,
      inputSchema: {
        query: z.string().optional().describe("Optional name filter (substring match)."),
        page_size: z.number().int().positive().max(100).optional().describe("Items per page. Default 30."),
      },
    },
    async ({ query, page_size }) => {
      const companies = await client.listCompanies({ query, pageSize: page_size });

      // Detect duplicate names. Fast path returns the minimal shape when
      // there are no collisions so the response stays as small as
      // possible for the common single-company-per-name case.
      const nameCounts = new Map<string, number>();
      for (const c of companies) {
        nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
      }
      const duplicateNames = new Set(
        [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
      );

      // Always wrap the response in { companies, _assistant_guidance? } so
      // callers have a stable shape across the duplicate / non-duplicate
      // branches. Pre-2026-05-26 this tool returned a bare array; the new
      // wrapped shape carries strictly more information without losing the
      // company list. The agent reads JSON; the wrapping is transparent.
      if (duplicateNames.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  companies: companies.map((c) => ({ id: c.id, name: c.name, type: c.type })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Duplicate names detected. Enrich the duplicate entries inline with
      // every non-id field that could help the agent build a disambiguating
      // question (relationship, created_at_date, website, language,
      // country_iso_code, description_excerpt, disabled_at). Mirrors the
      // owned_name_collisions[].companies[] block exposed by
      // get_session_context._assistant_guidance.
      //
      // Calling getMe to resolve owner-vs-guest only happens when collisions
      // are detected, so the common case (no dupes) keeps the original
      // single-roundtrip latency.
      let meId: number | null = null;
      try {
        const me = await client.getMe();
        meId = me.id;
      } catch {
        // getMe failure is non-blocking; we still return the rest of the
        // disambiguators with relationship: "unknown" so the agent can
        // pick another distinguisher (created_at, website).
      }

      const enrichedCompanies = companies.map((c: Company) => {
        const basic = { id: c.id, name: c.name, type: c.type };
        if (!duplicateNames.has(c.name)) {
          return basic;
        }
        const relationship: "owner" | "guest" | "unknown" =
          meId !== null ? (c.user_id === meId ? "owner" : "guest") : "unknown";
        return {
          ...basic,
          relationship,
          created_at_date:
            typeof c.created_at === "string" ? c.created_at.slice(0, 10) : null,
          website: c.website ?? null,
          language: c.language ?? null,
          country_iso_code: c.country_iso_code ?? null,
          description_excerpt: descriptionExcerpt(c.description ?? null),
          disabled_at: c.disabled_at ?? null,
        };
      });

      const duplicateNamesArr = Array.from(duplicateNames);
      const dupesQuoted = duplicateNamesArr.map((n) => `"${n}"`).join(", ");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                companies: enrichedCompanies,
                _assistant_guidance: {
                  has_name_collisions: true,
                  duplicate_names: duplicateNamesArr,
                  instruction: `${duplicateNamesArr.length} name(s) appear more than once in the result: ${dupesQuoted}. Each duplicate entry has been enriched in place with extra fields (relationship "owner" | "guest" | "unknown", created_at_date, website, language, country_iso_code, description_excerpt, disabled_at) so you can disambiguate WITHOUT calling get_session_context. SURFACE ALL DUPLICATE ENTRIES TO THE USER IN A SINGLE AskUserQuestion CALL THIS TURN. Pick the most useful distinguishers between the duplicates: relationship is the strongest signal when one is "owner" and another is "guest"; otherwise use created_at_date, website, or description_excerpt. NEVER expose the numeric id to the user (Rule 5 of the system prompt is absolute). NEVER pick one silently (Rule 1). The id stays in the response for your internal use when the user resolves their pick. If you need the canonical id_lookup map plus the owned_vs_accessible split (admin-scope tokens), switch to get_session_context.`,
                  recommended_pivot:
                    "If the user's request was an orientation step (start of a content task), prefer get_session_context for the full pipeline instead of continuing with list_companies + manual disambiguation.",
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_company",
    {
      annotations: READ_ONLY,
      title: "Get a Followr company by id",
      description: `Get full details of a Followr company: name, description, audience targeting, AI preferences, brand voice fields, social_network_prompts, ai_keys configured providers, menu_visibility, webhook config.

USE WHEN: the user asks about company settings; OR the agent needs creative context (brand voice, audience, social_network_prompts) to redact content well. Call this before generating posts so the output matches the company's voice and audience.

PRECONDITION: company_id required. If the user has multiple companies and hasn't named one, call list_companies first and ask.

SENSITIVE FIELDS: webhook_secret and ai_keys are stripped from the response (only presence/providers are returned). Don't ask for them back; they cannot be read.`,
      inputSchema: {
        company_id: z.number().int().positive().describe("The Followr company id."),
      },
    },
    async ({ company_id }) => {
      const company = await client.getCompany(company_id);
      // Strip sensitive fields before returning to the AI client.
      const { webhook_secret, ai_keys, ...safeCompany } = company;
      const summary = {
        ...safeCompany,
        webhook_secret_present: Boolean(webhook_secret),
        ai_keys_configured_providers: (ai_keys ?? []).map((k) => k.provider),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  );
}
