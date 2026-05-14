import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

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
      title: "List brand-voice prompts for a workspace",
      description:
        "List the brand-voice prompts of a workspace. These are the per-network prompt templates that Followr picks among when generating content (Post Generator, etc.). Optional filter by social network type and by `default=true`. Pass company_id=0 to see Followr's built-in defaults (where company_id is null in the API).",
      inputSchema: {
        company_id: z.number().int().nonnegative().describe("Workspace id. Pass 0 to query Followr's built-in defaults (the API maps 0 → null)."),
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
      title: "Get a single brand-voice prompt by id",
      description:
        "Fetch one brand-voice prompt by id. Useful to inspect its current text, default flag, and network assignment.",
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
      title: "Create a brand-voice prompt for a workspace",
      description:
        "Create a custom brand-voice prompt attached to a workspace and a specific social network. Followr will consider this prompt (alongside any built-in defaults and other workspace prompts) when generating content. Mark `default=true` to make it eligible for automatic selection. Multiple prompts with default=true per network are allowed; Followr picks one at generate time.",
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
      const created = await client.createPrompt({
        company_id,
        social_network_type,
        name,
        prompt,
        ...(isDefault !== undefined ? { default: isDefault } : {}),
        ...(type ? { type } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
    },
  );

  server.registerTool(
    "update_prompt",
    {
      title: "Update a brand-voice prompt",
      description:
        "Patch an existing brand-voice prompt. Use to rename, edit the prompt text, change the network assignment, or toggle the `default` flag.",
      inputSchema: {
        prompt_id: z.number().int().positive(),
        name: z.string().min(1).max(80).optional(),
        prompt: z.string().min(1).optional(),
        social_network_type: SOCIAL_NETWORK_TYPE.optional(),
        default: z.boolean().optional(),
      },
    },
    async ({ prompt_id, ...patch }) => {
      const updated = await client.updatePrompt(prompt_id, patch);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    },
  );

  server.registerTool(
    "delete_prompt",
    {
      title: "Delete a brand-voice prompt (destructive)",
      description:
        "Permanently delete a brand-voice prompt. Cannot be undone. Followr's built-in defaults (where company_id is null) cannot be deleted; only workspace-scoped prompts can.",
      inputSchema: {
        prompt_id: z.number().int().positive(),
      },
    },
    async ({ prompt_id }) => {
      await client.deletePrompt(prompt_id);
      return { content: [{ type: "text", text: `Deleted prompt ${prompt_id}.` }] };
    },
  );
}
