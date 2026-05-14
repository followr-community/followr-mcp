import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerWorkspaceSettingsTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "update_brand_voice",
    {
      title: "Update the per-network brand voice prompts of a workspace",
      description:
        "Update the workspace's `social_network_prompts` field with a fresh array of per-network voice / tone overrides. REPLACE semantics: the array passed becomes the full new value (the caller is responsible for merging entries for networks that should keep their prior prompt). Each entry typically has shape { social_network_type, prompt }.",
      inputSchema: {
        company_id: z.number().int().positive(),
        social_network_prompts: z
          .array(z.record(z.unknown()))
          .describe("Full list of per-network prompts (REPLACE, not append). Each item is an object; typical shape is { social_network_type, prompt }."),
      },
    },
    async ({ company_id, social_network_prompts }) => {
      const updated = await client.updateCompany(company_id, {
        social_network_prompts,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: updated.id, social_network_prompts: updated.social_network_prompts }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "update_webhook_url",
    {
      title: "Update the workspace webhook URL and secret",
      description:
        "Set or rotate the workspace's outbound webhook (used when a Post is published or fails). Both fields can be cleared with empty string. The secret never round-trips: stored and signed against, never echoed back; the response only confirms the URL.",
      inputSchema: {
        company_id: z.number().int().positive(),
        webhook_posts_url: z.string().describe("Destination URL for outbound events. Empty string clears."),
        webhook_secret: z
          .string()
          .optional()
          .describe("Shared secret used to sign payloads. Optional. Empty string clears."),
      },
    },
    async ({ company_id, webhook_posts_url, webhook_secret }) => {
      const updated = await client.updateCompany(company_id, {
        webhook_posts_url,
        ...(webhook_secret !== undefined ? { webhook_secret } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: updated.id,
                webhook_posts_url: updated.webhook_posts_url,
                webhook_secret_present: Boolean(updated.webhook_secret),
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
    "set_menu_visibility",
    {
      title: "Set the workspace's left-menu visibility flags",
      description:
        "Update which menu sections are visible in the Followr SPA for a workspace. The field `menu_visibility` is a map of section name to boolean. REPLACE semantics: the map passed becomes the new value. Useful for whitelabel installs that want to hide irrelevant sections.",
      inputSchema: {
        company_id: z.number().int().positive(),
        menu_visibility: z
          .record(z.boolean())
          .describe("Full map of section_name -> visible. REPLACE, not merge."),
      },
    },
    async ({ company_id, menu_visibility }) => {
      const updated = await client.updateCompany(company_id, {
        menu_visibility,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: updated.id, menu_visibility: updated.menu_visibility }, null, 2),
          },
        ],
      };
    },
  );
}
