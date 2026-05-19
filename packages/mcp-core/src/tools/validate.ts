import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";
import { getSpec, getSpecsMeta } from "../specs/loader.js";
import { gatherRuntimeContext } from "../specs/runtime-context.js";
import type { NetworkType, ProductType, SpecKey } from "../specs/types.js";
import { validateAgainstSpec } from "../specs/validate.js";

const NETWORK_ENUM = [
  "medium",
  "pinterest",
  "twitter",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "youtube",
  "threads",
  "bluesky",
] as const satisfies readonly NetworkType[];

const PRODUCT_TYPE_ENUM = ["feed", "reel", "story", "short"] as const satisfies readonly ProductType[];

const AssetSchema = z.object({
  id: z.number().int().positive().optional(),
  type: z.enum(["image", "video", "gif"]),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  size_bytes: z.number().nonnegative().optional(),
  duration_seconds: z.number().positive().optional(),
});

export function registerValidateTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "validate_against_specs",
    {
      annotations: READ_ONLY,
      title: "Validate a Post payload against social network specs (advisory)",
      description: `Check if a post (caption, assets, preferences) violates any social network rules before publishing. Returns advisory warnings with structured fields (field, rule, current_value, expected, severity, suggestion). Does NOT block; this tool never has side effects.

CALL EARLY: as soon as the user describes intent (network + format + assets, even before creating the PostGroup). Surfacing blocking issues at intent time (e.g. "Instagram requires at least one image, and the user mentioned no image") avoids creating a PostGroup that can't be scheduled. Don't wait until create_post runs validation post-hoc.

ALSO CALL BEFORE: expensive operations (generate_avatar_video at 775+ credits, generate_image, create_avatar_full_flow) to avoid spending credits on outputs the platform will reject anyway.

WARNINGS HANDLING: severity="error" warnings will likely cause publish to fail; raise these to the user immediately and resolve before proceeding. severity="warning" and "info" are advisory; present them and let the user decide.

ASSET METADATA: size_bytes, width, height, duration_seconds are optional. Provide what you have; the validator skips checks for missing fields. Provide as much as possible to catch issues early.`,
      inputSchema: {
        company_id: z
          .number()
          .int()
          .positive()
          .describe("Followr company id. Required to resolve account-specific limits (Twitter verified, TikTok tier)."),
        network: z.enum(NETWORK_ENUM).describe("Target social network."),
        product_type: z
          .enum(PRODUCT_TYPE_ENUM)
          .describe("Post format. e.g. 'feed' for IG Feed, 'reel' for IG Reels, 'story' for IG Stories, 'short' for YouTube Shorts."),
        description: z.string().optional().describe("Post caption / body text."),
        title: z.string().optional().describe("Title (medium, pinterest, youtube only)."),
        link: z.string().optional().describe("Optional outbound link."),
        assets: z
          .array(AssetSchema)
          .optional()
          .describe("Media to attach. Each asset's metadata is used for size/duration/dimensions/aspect ratio checks."),
        preferences: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Network-specific extras: board_id (Pinterest), privacy_level (TikTok), category_id (YouTube), media_product_type (FEED/REELS/STORY for IG), etc."),
      },
    },
    async (input) => {
      const context = await gatherRuntimeContext(input.company_id, input.network, client);
      const spec = getSpec(input.network, input.product_type);
      const specKey = `${input.network}_${input.product_type}` as SpecKey;
      const warnings = validateAgainstSpec(
        {
          network: input.network,
          product_type: input.product_type,
          description: input.description,
          title: input.title,
          link: input.link,
          assets: input.assets,
          preferences: input.preferences,
        },
        context,
      );

      const response = {
        spec_key: specKey,
        spec_exists: spec !== null,
        runtime_context: context,
        warning_count: warnings.length,
        warnings,
        specs_verified_at: getSpecsMeta()?.verified_at ?? null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
