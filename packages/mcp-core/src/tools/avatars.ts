import { FollowrClient } from "@followr-mcp/shared";
import type { Avatar } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION, MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import { getAiPreferences } from "../lib/preferences.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

// Strip BYOK/secret fields if the API embedded `company` via include chain.
function sanitizeAvatar(avatar: Avatar): Avatar {
  // Cast: API may add `company` when ?include=company is used; not in static Avatar type.
  const av = avatar as Avatar & {
    company?: { ai_keys?: unknown; webhook_secret?: unknown; [k: string]: unknown };
  };
  if (av.company) {
    const { ai_keys: _ak, webhook_secret: _ws, ...safeCompany } = av.company;
    av.company = safeCompany;
  }
  return av;
}

const DEFAULT_INCLUDE = "image,image.thumbnail,voice,voice.audio,scenes,scenes.thumbnail";

export function registerAvatarTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_avatars",
    {
      annotations: READ_ONLY,
      title: "List avatars in a company",
      description: `List avatars belonging to a Followr company, each hydrated with its image (with thumbnail), voice (with audio sample), and scenes.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE BEFORE: generate_avatar_video (requires picking an avatar) or create_avatar_full_flow (to avoid creating a duplicate of an existing avatar).

PRESENTING: refer to avatars by name; include the thumbnail URL if showing options to the user.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, page_size }) => {
      const avatars = await client.listAvatars(company_id, {
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(avatars.map(sanitizeAvatar), null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_avatar",
    {
      annotations: READ_ONLY,
      title: "Get a single avatar with image, voice, and scenes",
      description: `Fetch one avatar by id, hydrated by default with image, voice (with audio sample), and scenes.

USE FOR: confirming a freshly created avatar has its image and voice attached; inspecting available scenes before generate_avatar_video; retrieving the thumbnail URL to show the user.`,
      inputSchema: {
        avatar_id: z.number().int().positive(),
        include: z.string().optional().describe("Override the include chain. Default hydrates image, voice, and scenes."),
      },
    },
    async ({ avatar_id, include }) => {
      const avatar = await client.getAvatar(avatar_id, {
        include: include ?? DEFAULT_INCLUDE,
      });
      return { content: [{ type: "text", text: JSON.stringify(sanitizeAvatar(avatar), null, 2) }] };
    },
  );

  server.registerTool(
    "create_avatar_full_flow",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Create an avatar end-to-end (image gen + resource + upload)",
      description: `Compound workflow that creates a custom avatar from a single prompt. Internally: 1) generates an image with Followr AI from the prompt, 2) creates the avatar resource linked to the given voice_id, 3) attaches the generated image to the avatar via the 3-step upload pattern.

CRITICAL: This consumes credits (~25+ for the image generation alone). Before calling:
1. Confirm with the user verbatim (avatar name, voice, visual prompt) since the result is not reversible via MCP.
2. Call get_credits_balance if the user is on a tight budget or if running this repeatedly. Surface remaining credits to the user proactively.
3. Confirm the voice_id by name; the wrong voice means future avatar videos sound wrong.

PRECONDITION: company_id required. If multiple companies, confirm company by name. voice_id required (use list_voices to find one, or list_elevenlabs_voices + create_voice_from_elevenlabs to create one).

LATENCY: image generation can take 30-300 seconds. The tool blocks until completion (or timeout_seconds expires). Set the user's expectation that this is a non-instant operation.

NOT UNDOABLE VIA MCP: there is no delete_avatar tool. The created avatar persists in the company. Use update_avatar with default=false to demote it, or delete manually in the Followr UI.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        prompt: z.string().min(1).describe("Visual prompt describing the avatar (e.g. 'professional female news anchor in studio')."),
        voice_id: z.number().int().positive().describe("Existing Voice.id from list_voices or a voice freshly created via create_voice_from_elevenlabs."),
        name: z.string().min(1).max(50).describe("Display name for the avatar."),
        description: z.string().optional().describe("Optional description. Defaults to a truncated form of the prompt."),
        aspect_ratio: z.enum(["1:1", "4:3", "16:9", "3:4", "9:16"]).optional().describe("Aspect ratio of the generated portrait. Matches Followr UI options for image generation. Default 1:1."),
        default: z.boolean().optional().describe("If true, marks this avatar as the company default. Default false."),
        image_driver: z.string().optional().describe("Optional image generation driver override. e.g. fal, recraft, openai."),
        image_model: z.string().optional().describe("Optional image model override. e.g. nano_banana_2."),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds for image generation to complete. Default 300."),
      },
    },
    async ({
      company_id,
      prompt,
      voice_id,
      name,
      description,
      aspect_ratio,
      default: isDefault,
      image_driver,
      image_model,
      timeout_seconds,
    }) => {
      try {
        // Apply the company's AI image preferences (driver/model/aspect_ratio)
        // when the caller does not override. The /api/aiResults/image endpoint
        // does NOT auto-apply ai_preferences when driver/model are omitted,
        // so we resolve them client-side here. We only force `fal` as driver
        // when we're also using the hardcoded fallback model.
        const prefs = await getAiPreferences(client, company_id);
        const resolvedModel = image_model ?? prefs.image_model ?? "nano_banana_2";
        const resolvedDriver =
          image_driver ?? prefs.image_driver ?? (resolvedModel === "nano_banana_2" ? "fal" : undefined);
        const initialImage = await client.generateImage({
          q: prompt,
          company_id,
          aspect_ratio: aspect_ratio ?? prefs.image_aspect_ratio ?? "1:1",
          n: 1,
          chargeable: 1,
          queue: true,
          ...(resolvedDriver ? { driver: resolvedDriver } : {}),
          model: resolvedModel,
        });
        const completedImage = await client.waitForAiResult(initialImage.id, {
          timeoutMs: (timeout_seconds ?? 300) * 1000,
        });
        // For aiResults with type=image, the CDN URL of the generated image is
        // returned in the `response` field (not in an `image_url` field).
        const generatedImageUrl = completedImage.response ?? "";
        if (completedImage.status !== "completed" || !generatedImageUrl) {
          return toolError({
            reason: "ai_image_generation_failed",
            user_message: `Avatar image generation failed (status=${completedImage.status})${completedImage.status_message ? `: ${completedImage.status_message}` : ""}.`,
            suggested_actions: [
              {
                tool: "get_credits_balance",
                rationale:
                  "Check if there are enough credits. Image jobs can fail silently when balance drops below the cost.",
              },
              {
                rationale:
                  "Retry create_avatar_full_flow with the same prompt. Image generation models occasionally fail transiently.",
              },
            ],
            details: {
              ai_result_id: completedImage.id,
              status: completedImage.status,
              status_message: completedImage.status_message ?? null,
            },
          });
        }
        const avatar = await client.createAvatar(company_id, {
          name,
          description: description ?? prompt.slice(0, 340),
          voice_id,
          default: isDefault ?? false,
        });
        const filename = `avatar-${avatar.id}-${Date.now()}.jpg`;
        const uploadInfo = await client.requestAvatarImageUpload(avatar.id, {
          filename,
          type: "image",
          visibility: "public",
        });
        const downloadResp = await fetch(generatedImageUrl);
        if (!downloadResp.ok) {
          return toolError({
            reason: "cdn_download_failed",
            user_message: `The avatar image was generated but could not be downloaded from the CDN (${downloadResp.status} ${downloadResp.statusText}). The avatar resource was created but has no image attached.`,
            suggested_actions: [
              {
                rationale:
                  "Retry the call; CDN issues are usually transient. The image generation step (which consumed credits) was already paid, so subsequent retries are cheaper.",
              },
              {
                tool: "update_avatar",
                rationale:
                  "Alternatively, manually attach an image through the Followr UI to the partially-created avatar.",
              },
            ],
            details: {
              cdn_status: downloadResp.status,
              cdn_url: generatedImageUrl,
              ai_result_id: completedImage.id,
              partial_avatar_id: avatar.id,
            },
          });
        }
        const buffer = await downloadResp.arrayBuffer();
        await client.uploadToBlob(uploadInfo.presigned_url, buffer, "image/jpeg");
        const finalAvatar = await client.getAvatar(avatar.id, { include: DEFAULT_INCLUDE });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  image_ai_result_id: completedImage.id,
                  source_image_url: generatedImageUrl,
                  avatar: sanitizeAvatar(finalAvatar),
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
    "update_avatar",
    {
      annotations: MUTATION,
      title: "Update an avatar's metadata",
      description: `Patch an avatar's name, description, default flag, or voice_id.

DEFAULT TOGGLE: setting default=true on one avatar implicitly demotes any previous default in the company. Future generate_avatar_video calls without an explicit avatar will use the default.

VOICE SWAP: changing voice_id affects future generate_avatar_video calls but does NOT retroactively change avatar videos that were already generated.

IMAGE: this does NOT change the avatar's image. Re-creating with a new image requires the full create_avatar_full_flow (consumes credits again) or manual upload via the Followr UI.`,
      inputSchema: {
        avatar_id: z.number().int().positive(),
        name: z.string().min(1).max(50).optional(),
        description: z.string().optional(),
        default: z.boolean().optional(),
        voice_id: z.number().int().positive().optional(),
      },
    },
    async ({ avatar_id, ...patch }) => {
      try {
        const updated = await client.updateAvatar(avatar_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(sanitizeAvatar(updated), null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "list_avatar_scenes",
    {
      annotations: READ_ONLY,
      title: "List scenes attached to an avatar",
      description: `Return the scenes (video clips) associated with an avatar. Internally fetches the avatar with the scenes include chain and returns just the scenes array.

USE BEFORE: generate_avatar_video, to inspect what motion clips are available for combining. If the avatar has no scenes, generate_avatar_video will fail or produce a static-image video; surface this to the user before consuming credits.`,
      inputSchema: {
        avatar_id: z.number().int().positive(),
      },
    },
    async ({ avatar_id }) => {
      const avatar = await client.getAvatar(avatar_id, { include: "scenes,scenes.thumbnail" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(avatar.scenes ?? [], null, 2),
          },
        ],
      };
    },
  );
}
