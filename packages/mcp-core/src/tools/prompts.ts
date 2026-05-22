import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION, READ_ONLY } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

// `social_network_type` enum based on Followr's product surface (Post Generator
// supports these networks). Bluesky and Medium are accepted by the API even
// though the official enum drops them in places.
const SOCIAL_NETWORK_TYPE = z.enum([
  "facebook",
  "twitter",
  "instagram",
  "threads",
  "linkedin",
  "tiktok",
  "youtube",
  "pinterest",
  "bluesky",
  "medium",
]);

export function registerPromptTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_prompts",
    {
      annotations: READ_ONLY,
      title: "List brand-voice prompts for a company",
      description: `List the brand-voice prompts of a company. These are the per-network prompt templates that Followr picks among when generating content (Post Generator, etc.).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name. Pass company_id=0 to see Followr's built-in defaults (the API maps 0 -> null).

FILTERS: social_network_type narrows to one network; only_default=true returns only prompts eligible for automatic selection.

PRESENTING: refer to prompts by name, never by id.`,
      inputSchema: {
        company_id: z.number().int().nonnegative().describe("Company id. Pass 0 to query Followr's built-in defaults (the API maps 0 → null)."),
        social_network_type: SOCIAL_NETWORK_TYPE.optional().describe("Restrict to one network."),
        only_default: z.boolean().optional().describe("If true, only return prompts marked default."),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, social_network_type, only_default, page_size }) => {
      const prompts = await client.listPrompts({
        companyId: company_id === 0 ? null : company_id,
        ...(social_network_type ? { socialNetworkType: social_network_type } : {}),
        ...(only_default ? { onlyDefault: true } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              prompts.map((p) => ({
                id: p.id,
                company_id: p.company_id,
                social_network_type: p.social_network_type,
                default: p.default,
                name: p.name,
                prompt: p.prompt,
                created_at: p.created_at,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_prompt",
    {
      annotations: READ_ONLY,
      title: "Get a single brand-voice prompt by id",
      description: `Fetch one brand-voice prompt by id. Returns name, prompt text, social_network_type, default flag, company_id, created_at.

USE BEFORE: update_prompt (to compute a non-destructive patch), delete_prompt (to confirm what is being removed), or when generating content to inform the agent of the company's brand voice for that network.`,
      inputSchema: {
        prompt_id: z.number().int().positive(),
      },
    },
    async ({ prompt_id }) => {
      const prompt = await client.getPrompt(prompt_id);
      return { content: [{ type: "text", text: JSON.stringify(prompt, null, 2) }] };
    },
  );

  server.registerTool(
    "create_prompt",
    {
      annotations: MUTATION,
      title: "Crear instrucciones de estilo de comunicación (voz de marca) para una red",
      description: `Create a custom brand-voice prompt (the AI's system instructions for how to write copy) attached to a company and a specific social network. Followr considers this prompt (alongside any built-in defaults and other company prompts) when generating content.

WHEN TO USE THIS vs create_brand_voice_for_company. This single-network tool is the right choice when the user wants ONE specific network voice (e.g. "armame una voz para LinkedIn solo"), or when iterating an existing per-network voice. For the more common "create the brand voice for the whole company" case, prefer create_brand_voice_for_company; it loops every connected network and creates a prompt per network in one call.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

DEFAULT FLAG: default=true marks the prompt eligible for automatic selection at generate time. Multiple prompts with default=true per network are allowed; Followr picks one at random per generation. To force a single prompt, ensure it's the only default=true for that network (toggle others off via update_prompt).

PROMPT QUALITY: the prompt text is used as system instructions to the AI generator. Keep it imperative and specific (tone, audience, do/don't, examples). Generic prompts produce generic content.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        social_network_type: SOCIAL_NETWORK_TYPE,
        name: z.string().min(1).max(80).describe("Short human-readable name shown in the Followr UI."),
        prompt: z.string().min(1).describe("The actual prompt text used as system instructions when generating."),
        default: z.boolean().optional().describe("If true, marks this prompt as eligible for automatic selection. Default false."),
        type: z.string().optional().describe("Resource type. Default `text` (the only verified value). Reserved for future image/video prompt types."),
      },
    },
    async ({ company_id, social_network_type, name, prompt, default: isDefault, type }) => {
      try {
        const created = await client.createPrompt({
          company_id,
          social_network_type,
          name,
          prompt,
          ...(isDefault !== undefined ? { default: isDefault } : {}),
          ...(type ? { type } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // Convenience: loop every connected social network of a company and create
  // a brand-voice prompt per network from a single shared prompt text. This
  // is what the user usually means when they say "armá la voz de marca"; the
  // per-network create_prompt is for the rare case where they want one
  // specific network only.
  //
  // Followr's API requires social_network_type on every create_prompt call
  // (there is no concept of a "global" voice), so this tool encapsulates the
  // network loop and surfaces the result as a single operation. It explicitly
  // does NOT need the user to think in per-network terms.
  server.registerTool(
    "create_brand_voice_for_company",
    {
      annotations: MUTATION,
      title: "Armar la voz de marca (estilo de comunicación) para toda la empresa",
      description: `Create a brand-voice prompt (the AI's system instructions for writing copies) and install it across every connected social network of the company in a single call. This is the right entry point when the user asks to "create the brand voice" or accepts a brand_voice_setup_proposal returned by prepare_content_plan_context.

INPUTS
- company_id: required.
- prompt: the actual instructions text (imperative, specific; same content the user would author for a per-network voice).
- name: short human-readable name shown in the Followr UI for each created prompt. Defaults to "<Company> brand voice".
- default: when true, every created prompt is flagged default=true so Followr can pick it automatically at generate time. Defaults to true (this is what the user almost always wants).
- target_networks: optional filter. When omitted, the tool resolves every connected social network on the company and creates one prompt per. When provided, only those networks are targeted. Use this when extending an existing voice to newly connected networks (see brand_voice_coverage_gap in prepare_content_plan_context).

BEHAVIOR
1. Fetch the company's connected social networks via listSocialNetworks.
2. Map each to its prompt-compatible social_network_type.
3. Skip networks that are not promptable (e.g. unknown / unsupported types).
4. Call createPrompt N times in parallel with the SAME prompt body.
5. Return a per-network result list. Per-network failures do NOT abort the others; the partial result is surfaced with errors per network so the user can decide whether to retry just the failing ones.

USER-FACING LANGUAGE. When you tell the user what happened, say "te armé la voz de marca para tu empresa, quedó configurada en las redes conectadas (Instagram, Facebook, TikTok)". NEVER say "creé un prompt por red porque la red es obligatoria", "social_network_type es required", or any wording that exposes the schema constraint. The split into N prompts is an implementation detail; the user thinks "una voz de marca" and that is the right mental model.

PRECONDITION: the company has at least one social network connected. If the company has zero connected networks, the tool returns a partial result with skipped_reason="no_connected_networks" and the agent should tell the user to connect a network first and direct them to the Followr Settings page.

ALTERNATIVE: for a single specific network, use create_prompt directly.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        prompt: z.string().min(1).describe("The brand-voice text. Same content per network."),
        name: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe("Optional human-readable name shown in the UI. Defaults to '<Company> brand voice'."),
        default: z
          .boolean()
          .optional()
          .describe("If true, every created prompt is flagged default. Defaults to true."),
        target_networks: z
          .array(SOCIAL_NETWORK_TYPE)
          .optional()
          .describe(
            "Optional list of networks to target. When omitted, the tool loops every connected network on the company.",
          ),
      },
    },
    async ({ company_id, prompt, name, default: isDefault, target_networks }) => {
      try {
        const company = await client.getCompany(company_id).catch(() => null);
        const companyName = company?.name ?? "Company";
        const resolvedName = name ?? `${companyName} brand voice`;
        const useDefault = isDefault ?? true;
        const socialNetworks = await client.listSocialNetworks(company_id);
        // Each listSocialNetworks entry exposes a backend "type" string. The
        // values used for create_prompt are Followr's internal names (e.g.
        // "twitter" rather than "x"); we pass them through verbatim.
        const connectedTypes = new Set<string>();
        for (const n of socialNetworks as Array<{ type?: string | null }>) {
          if (typeof n.type === "string" && n.type.length > 0) {
            connectedTypes.add(n.type);
          }
        }
        if (connectedTypes.size === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    company_id,
                    status: "no_connected_networks",
                    skipped_reason:
                      "Esta empresa no tiene redes sociales conectadas todavía. Pedile al usuario que conecte al menos una red en Settings > Social Networks de Followr y volvé a llamar este flow.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const PROMPTABLE = new Set([
          "facebook",
          "twitter",
          "instagram",
          "threads",
          "linkedin",
          "tiktok",
          "youtube",
          "pinterest",
          "bluesky",
          "medium",
        ]);
        const targetSet: Set<string> | null = target_networks ? new Set(target_networks) : null;
        const networks = Array.from(connectedTypes).filter((t) => {
          if (!PROMPTABLE.has(t)) return false;
          if (targetSet && !targetSet.has(t)) return false;
          return true;
        });
        const results = await Promise.all(
          networks.map(async (network) => {
            try {
              const created = await client.createPrompt({
                company_id,
                social_network_type: network,
                name: resolvedName,
                prompt,
                default: useDefault,
              });
              return {
                social_network_type: network,
                status: "created" as const,
                prompt_id: created.id,
                name: created.name,
              };
            } catch (err) {
              return {
                social_network_type: network,
                status: "failed" as const,
                error_message: err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );
        const created = results.filter((r) => r.status === "created");
        const failed = results.filter((r) => r.status === "failed");
        const userFacingSummary =
          failed.length === 0
            ? `Voz de marca lista. Quedó configurada en ${created.length} red${created.length === 1 ? "" : "es"} conectada${created.length === 1 ? "" : "s"} de ${companyName}.`
            : `Voz de marca configurada en ${created.length} red${created.length === 1 ? "" : "es"} pero falló en ${failed.length}. Las redes que fallaron pueden reintentarse llamando esta misma tool con target_networks acotado.`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  company_id,
                  status: failed.length === 0 ? "succeeded" : "partial",
                  user_facing_summary: userFacingSummary,
                  created,
                  failed,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "update_prompt",
    {
      annotations: MUTATION,
      title: "Update a brand-voice prompt",
      description: `Patch an existing brand-voice prompt. Use to rename, edit the prompt text, change the network assignment, or toggle the default flag.

DEFAULT TOGGLE: toggling default has immediate effect on future content generation in this company. If the user is changing brand voice, confirm with them which prompts should be active before flipping flags.

BUILT-IN DEFAULTS: Followr's built-in prompts (where company_id is null) cannot be updated through this tool; only company-scoped prompts can.`,
      inputSchema: {
        prompt_id: z.number().int().positive(),
        name: z.string().min(1).max(80).optional(),
        prompt: z.string().min(1).optional(),
        social_network_type: SOCIAL_NETWORK_TYPE.optional(),
        default: z.boolean().optional(),
      },
    },
    async ({ prompt_id, ...patch }) => {
      try {
        const updated = await client.updatePrompt(prompt_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_prompt",
    {
      annotations: DESTRUCTIVE,
      title: "Delete a brand-voice prompt (destructive)",
      description: `Permanently delete a brand-voice prompt. Cannot be undone.

CRITICAL: Confirm with the user verbatim before calling. State the prompt name (not id) and the fact that this is permanent. Removing a prompt that's flagged default affects future content generation for that network in this company.

BUILT-IN DEFAULTS: Followr's built-in prompts (where company_id is null) cannot be deleted; only company-scoped prompts can. Attempts will fail.

ALTERNATIVE: if the user wants to stop using a prompt but might want it back later, consider update_prompt with default=false instead of delete. Deactivation is reversible; delete is not.`,
      inputSchema: {
        prompt_id: z.number().int().positive(),
      },
    },
    async ({ prompt_id }) => {
      try {
        await client.deletePrompt(prompt_id);
        return { content: [{ type: "text", text: `Deleted prompt ${prompt_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
