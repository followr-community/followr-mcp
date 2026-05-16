import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { gatherRuntimeContext } from "../specs/runtime-context.js";
import type { NetworkType, ProductType } from "../specs/types.js";
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

/**
 * Networks where Followr's API requires preferences.media_product_type to be
 * set (FEED/REEL/STORY/SHORT). For other networks (Twitter, LinkedIn,
 * Pinterest, Threads, Bluesky, Medium), media_product_type is not used and
 * we leave preferences untouched.
 */
const NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE: ReadonlySet<NetworkType> = new Set([
  "instagram",
  "facebook",
  "youtube",
]);

const PRODUCT_TYPE_TO_FOLLOWR: Record<ProductType, string> = {
  feed: "FEED",
  reel: "REEL",
  story: "STORY",
  short: "SHORT",
};

const AssetInputSchema = z.object({
  id: z.number().int().positive().describe("Followr asset id (returned by upload_image_from_url / upload_video_from_url / list_assets)."),
  type: z.enum(["image", "video", "gif"]).describe("Asset type. Required for spec validation."),
  width: z.number().positive().optional().describe("Optional. If provided, used for aspect ratio and width checks."),
  height: z.number().positive().optional(),
  size_bytes: z.number().nonnegative().optional().describe("Optional. If provided, used for file size checks."),
  duration_seconds: z.number().positive().optional().describe("Optional, video assets only. Used for duration checks."),
});

export function registerPostTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "create_post",
    {
      title: "Create a Post inside a PostGroup, attaching assets and copy",
      description:
        "Create a Post (per-network entry) within an existing PostGroup. This is the second step of the manual PostGroup → Post → Schedule workflow: after create_post_group, call create_post once per target social network, then update_post_group to set publish_at. Pre-validates the payload against per-network specs (caption length, asset count/type/size/aspect ratio, etc.) and returns advisory warnings alongside the created post. Warnings are informational — the post is always created. The caller (LLM or user) decides whether to act on warnings before scheduling.",
      inputSchema: {
        post_group_id: z.number().int().positive().describe("Parent PostGroup id from create_post_group."),
        company_id: z
          .number()
          .int()
          .positive()
          .describe("Followr workspace id. Required to resolve account-specific limits (Twitter verified, TikTok tier) for validation."),
        social_network_type: z.enum(NETWORK_ENUM).describe("Target social network."),
        product_type: z
          .enum(PRODUCT_TYPE_ENUM)
          .describe(
            "Post format. 'feed' = standard feed post. 'reel' = vertical short-form video (IG Reels, FB Reels). 'story' = ephemeral 9:16 (IG/FB Stories). 'short' = YouTube Shorts. For IG/FB/YouTube, this is auto-injected as preferences.media_product_type in the Followr API body.",
          ),
        description: z.string().optional().describe("Caption / body text."),
        title: z.string().optional().describe("Title (medium / pinterest / youtube only)."),
        link: z.string().optional().describe("Optional outbound link."),
        assets: z
          .array(AssetInputSchema)
          .optional()
          .describe("Media to attach. Asset ids are extracted into the API's assets_ids array. The full metadata (type, width, height, size, duration) is used for validation only — not sent to the API."),
        preferences: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Network-specific extras passed through to Followr. e.g. board_id (Pinterest), privacy_level + duet_disabled (TikTok), category_id (YouTube), notify_followers (IG). media_product_type is auto-injected from product_type for IG/FB/YouTube if not already set."),
        comments_to_create: z
          .array(z.unknown())
          .optional()
          .describe("First-comment payloads (e.g., for IG hashtag dumping in the first comment)."),
      },
    },
    async (input) => {
      // 1. Gather runtime context (Twitter verified, TikTok tier) with cache
      const context = await gatherRuntimeContext(input.company_id, input.social_network_type, client);

      // 2. Build merged preferences (auto-inject media_product_type where needed)
      const mergedPreferences: Record<string, unknown> = { ...(input.preferences ?? {}) };
      if (
        NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE.has(input.social_network_type) &&
        !("media_product_type" in mergedPreferences)
      ) {
        mergedPreferences["media_product_type"] = PRODUCT_TYPE_TO_FOLLOWR[input.product_type];
      }

      // 3. Run validation (uses merged preferences so the validator sees what Followr sees)
      const warnings = validateAgainstSpec(
        {
          network: input.social_network_type,
          product_type: input.product_type,
          description: input.description,
          title: input.title,
          link: input.link,
          assets: input.assets,
          preferences: mergedPreferences,
        },
        context,
      );

      // 4. Execute the API call (always — warnings don't block)
      const body: Parameters<FollowrClient["createPost"]>[1] = {
        social_network_type: input.social_network_type,
      };
      if (input.description !== undefined) body.description = input.description;
      if (input.title !== undefined) body.title = input.title;
      if (input.link !== undefined) body.link = input.link;
      if (input.assets && input.assets.length > 0) {
        body.assets_ids = input.assets.map((a) => a.id);
      }
      if (Object.keys(mergedPreferences).length > 0) body.preferences = mergedPreferences;
      if (input.comments_to_create !== undefined) body.comments_to_create = input.comments_to_create;

      const post = await client.createPost(input.post_group_id, body);

      // 5. Return post + warnings
      const response = {
        post,
        validation: {
          warning_count: warnings.length,
          warnings,
          runtime_context: context,
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    },
  );
}
