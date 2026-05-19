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
      title: "Create a brand-voice prompt for a company",
      description: `Create a custom brand-voice prompt attached to a company and a specific social network. Followr considers this prompt (alongside any built-in defaults and other company prompts) when generating content.

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
