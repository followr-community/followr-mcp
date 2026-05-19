import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION } from "../lib/annotations.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";
import { gatherRuntimeContext } from "../specs/runtime-context.js";
import type { NetworkType, ProductType, SpecWarning } from "../specs/types.js";
import { validateAgainstSpec } from "../specs/validate.js";

/**
 * Validator warning rules that mean the network will reject the post at
 * publish time (asset count / type / size, etc.). When create_post detects
 * any of these in the validator output it aborts BEFORE calling the API,
 * so the user does not end up with a permanent broken draft. The caller
 * can override by passing acknowledge_validation_errors=true.
 */
const BLOCKING_VALIDATION_RULES: ReadonlySet<string> = new Set([
  "required",
  "video_required_for_product_type",
  "no_mixed_media",
  "max_total_exceeded",
  "max_count_exceeded",
  "max_size_exceeded",
  "video_too_long",
  "video_too_short",
  "video_max_width_exceeded",
  "video_min_width_below",
  "aspect_ratio_out_of_range",
  "not_supported",
]);

function pickBlockingWarnings(warnings: SpecWarning[]): SpecWarning[] {
  return warnings.filter(
    (w) => w.severity === "hard_fail" && BLOCKING_VALIDATION_RULES.has(w.rule),
  );
}

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
      annotations: MUTATION,
      title: "Create a social media post inside a PostGroup (per-network publication with captions, assets, scheduling)",
      description: `Create a Post (per-network publication, content piece, draft entry) targeting one social network channel (Instagram feed / reel / story, TikTok, Facebook, Twitter/X, LinkedIn, YouTube, Pinterest, Threads, Bluesky, Medium) inside an existing PostGroup. This is the second step of the manual PostGroup -> Post -> Schedule workflow: after create_post_group, call create_post once per target social network, then update_post_group to set publish_at.

PRECONDITION: The parent PostGroup must already exist in the user's chosen company. company_id is required to resolve account-specific limits (Twitter verified status, TikTok tier) for validation.

VALIDATION: Pre-validates the payload against per-network specs (caption length, asset count/type/size/aspect ratio, etc.) and returns advisory warnings alongside the created post. The post is ALWAYS created; warnings don't block.

WARNINGS HANDLING: Inspect each warning's severity. severity="error" indicates the post will likely fail at publish time (e.g. Instagram without an image, video too long for TikTok). Surface those to the user BEFORE proceeding to update_post_group / scheduling. severity="warning" or "info" can be presented as advisory; the user decides whether to fix or proceed.

EARLIER VALIDATION: For tighter UX, call validate_against_specs at intent time (as soon as the user describes the post idea, networks, and assets) instead of waiting to validate after the post is built. That way blocking issues surface immediately, not after multiple steps.

WHEN THE USER HAS NO VIDEO FOR product_type=reel|short: do NOT create the post yet. Followr's video generation tools are the right answer; propose one before calling create_post:
- Multi-scene avatar reel with subtitles -> generate_avatar_video (flexible duration; recommended for promo/product/lifestyle).
- Single talking head avatar -> generate_avatar_lipsync_clip.
- 8-second AI video clip without avatar (product motion, lifestyle moment) -> generate_ai_video_clip.
- The user already has footage -> upload_video_from_url.
Once a video asset id is available, then call create_post with assets=[{id, type:"video", ...}].`,
      inputSchema: {
        post_group_id: z.number().int().positive().describe("Parent PostGroup id from create_post_group."),
        company_id: z
          .number()
          .int()
          .positive()
          .describe("Followr company id. Required to resolve account-specific limits (Twitter verified, TikTok tier) for validation."),
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
        acknowledge_validation_errors: z
          .boolean()
          .optional()
          .describe(
            "Default false. When false, create_post ABORTS before hitting the API if pre-validation surfaces a blocking warning (missing required asset, wrong asset type for product_type, asset over size limit, video duration out of range, aspect ratio out of range, mixed media not allowed, exceeded count caps, caption sent to a network that doesn't accept it). This prevents creating drafts the network will reject at publish time. Set to true ONLY to force-create against the user's explicit instruction after they were told about the blockers; warnings are returned alongside the created post just like before.",
          ),
      },
    },
    async (input) => {
      try {
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

      // 3b. Hard-block on validation rules that the network will reject at
      // publish time. The user gets a clear error with the offending rules
      // and suggested fixes BEFORE the API call, so no broken draft is
      // created. Override via acknowledge_validation_errors=true.
      const blockingWarnings = pickBlockingWarnings(warnings);
      if (blockingWarnings.length > 0 && input.acknowledge_validation_errors !== true) {
        const summary = blockingWarnings
          .map((w) => `- ${w.field}: ${w.suggestion ?? w.rule}`)
          .join("\n");
        return toolError({
          reason: "validation_blockers",
          user_message: `Cannot create this post for ${input.social_network_type} ${input.product_type}: the payload violates network rules that would cause the post to be rejected at publish time. Fix these before retrying:\n${summary}`,
          suggested_actions: [
            {
              tool: "generate_avatar_video",
              rationale:
                "If a video asset is missing for a reel/short, generate one with the avatar video tool (multi-scene with subtitles).",
            },
            {
              tool: "generate_ai_video_clip",
              rationale:
                "Or generate a single 8-second AI video clip (no avatar) for product motion / lifestyle moments.",
            },
            {
              tool: "upload_video_from_url",
              rationale: "If the user already has footage, upload it and pass its asset id.",
            },
            {
              tool: "validate_against_specs",
              rationale:
                "Re-run validate_against_specs after fixing the payload to confirm no blockers remain.",
            },
          ],
          details: {
            network: input.social_network_type,
            product_type: input.product_type,
            blocking_warnings: blockingWarnings,
            all_warnings: warnings,
            runtime_context: context,
            override_hint:
              "Pass acknowledge_validation_errors=true to create the post anyway (not recommended — the network will reject it).",
          },
        });
      }

      // 4. Execute the API call.
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
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
