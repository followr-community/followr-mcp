import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

// Note: `update_brand_voice` was removed after discovery 2026-05-14 that the
// `Company.social_network_prompts` field is a read-only denormalized cache.
// Brand-voice prompts are now mutated via the dedicated /api/prompts resource,
// exposed in this MCP through the `prompts.ts` tools (list_prompts,
// get_prompt, create_prompt, update_prompt, delete_prompt).

export function registerCompanySettingsTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "update_webhook_url",
    {
      annotations: MUTATION,
      title: "Update the company webhook URL and secret",
      description: `Set or rotate the company's outbound webhook (used when a Post is published or fails to publish). Affects external integrations bound to this company.

CRITICAL: This changes integration-level config and can BREAK existing automations that depend on the previous URL or secret. Before calling:
1. Confirm the user is intentionally changing webhook configuration (not asking about it). "Show me the webhook" or "what's the webhook" do NOT authorize this tool; use get_company instead.
2. State the new URL (and that the secret will be rotated, if applicable) in user-readable form. Get explicit confirmation by company name (not id).
3. If rotating the secret, warn the user that the previous secret cannot be recovered; any consumer using the old secret will start failing signature verification.

PRECONDITION: company_id required. If multiple companies, confirm company by name before calling.

SEMANTICS:
- webhook_posts_url: accepts a URL string, empty string (""), or null. Empty string and null both mean "no webhook URL set" (the backend stores empty string when you pass either; functionally equivalent).
- The first time a webhook_posts_url is set on a company, the BACKEND AUTO-GENERATES a webhook_secret server-side if none was explicitly provided. That secret PERSISTS even if you later clear webhook_posts_url; there is no documented endpoint to delete the secret independently. webhook_secret_present: true in the response indicates a secret exists.
- webhook_secret: the actual secret value IS returned in plain text by the underlying GET /api/companies/{id} endpoint for the company owner. This tool redacts it in its response (only surfaces webhook_secret_present). To avoid leaking the secret into chat transcripts, always use this tool (or get_company, which also redacts) rather than raw curl.`,
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
      try {
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
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "set_menu_visibility",
    {
      annotations: MUTATION,
      title: "Set the company's left-menu visibility flags",
      description: `Update which menu sections are visible in the Followr SPA for a company. Affects the navigation experience for ALL users with access to this company, not just the caller.

CRITICAL: This change is company-wide and visible to teammates. Before calling, confirm with the user (by company name, not id) that they intend to change visibility for the whole team. Don't apply this from generic intents like "clean up the menu" without explicit per-section confirmation.

PRECONDITION: company_id required. If multiple companies, confirm company by name first.

REPLACE SEMANTICS: menu_visibility is a full map (section_name -> boolean). The map passed becomes the new value entirely. To toggle a single section without affecting others, first call get_company to read the current menu_visibility, modify the one key, and pass the full map back. Forgetting this hides sections the user didn't intend to hide.

RESET: pass {} (empty object) to reset to "everything visible". The backend stores this as an empty array ([]) and the GET response returns [] for menu_visibility after a reset. Both [] and null mean "no overrides, everything visible".

KEYS: section names match the Followr UI sidebar (e.g. "automation", "social_hub", "analytics", "media_library", "calendar"). To discover the exact keys for this company, call get_company first and inspect menu_visibility. Pass false to HIDE a section.

USE CASE: whitelabel installs hiding sections that aren't relevant to a tenant. Example: {"automation": false, "viral_shorts": false} hides those two from the sidebar for everyone in the company.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        menu_visibility: z
          .record(z.boolean())
          .describe("Full map of section_name -> visible. REPLACE, not merge. Pass {} to reset all overrides."),
      },
    },
    async ({ company_id, menu_visibility }) => {
      try {
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
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
