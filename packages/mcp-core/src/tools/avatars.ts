import { FollowrClient } from "@followr-mcp/shared";
import type { Avatar } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

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
      title: "List avatars in a workspace",
      description:
        "List avatars belonging to a Followr workspace, each hydrated with its image (with thumbnail), voice (with audio sample), and scenes. Use this to discover available avatars before generating an avatar video.",
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
      title: "Get a single avatar with image, voice, and scenes",
      description:
        "Fetch one avatar by id, hydrated by default with image, voice (with audio sample), and scenes. Use this to inspect an avatar's resources or to confirm a freshly created avatar is ready.",
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
      title: "Create an avatar end-to-end (image gen + resource + upload)",
      description:
        "Workflow that creates a custom avatar from a single prompt. Steps internally: 1) generates an image with Followr AI from the prompt, 2) creates the avatar resource linked to the given voice_id, 3) attaches the generated image to the avatar via the 3-step upload pattern. Requires voice_id (use create_voice_from_elevenlabs first if no suitable voice exists). Costs around 25 credits for the image generation. Cannot be undone (the avatar resource persists; delete manually if needed).",
      inputSchema: {
        company_id: z.number().int().positive(),
        prompt: z.string().min(1).describe("Visual prompt describing the avatar (e.g. 'professional female news anchor in studio')."),
        voice_id: z.number().int().positive().describe("Existing Voice.id from list_voices or a voice freshly created via create_voice_from_elevenlabs."),
        name: z.string().min(1).max(50).describe("Display name for the avatar."),
        description: z.string().optional().describe("Optional description. Defaults to a truncated form of the prompt."),
        aspect_ratio: z.enum(["1:1", "9:16", "16:9", "4:5"]).optional().describe("Aspect ratio of the generated portrait. Default 1:1."),
        default: z.boolean().optional().describe("If true, marks this avatar as the workspace default. Default false."),
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
      const initialImage = await client.generateImage({
        q: prompt,
        company_id,
        aspect_ratio: aspect_ratio ?? "1:1",
        n: 1,
        chargeable: 1,
        queue: true,
        // Defaults verified empirically (workspace ai_preferences are NOT
        // automatically applied when driver/model are omitted from the body).
        driver: image_driver ?? "fal",
        model: image_model ?? "nano_banana_2",
      });
      const completedImage = await client.waitForAiResult(initialImage.id, {
        timeoutMs: (timeout_seconds ?? 300) * 1000,
      });
      // For aiResults with type=image, the CDN URL of the generated image is
      // returned in the `response` field (not in an `image_url` field).
      const generatedImageUrl = completedImage.response ?? "";
      if (completedImage.status !== "completed" || !generatedImageUrl) {
        throw new Error(
          `Avatar image generation failed: status=${completedImage.status} message=${completedImage.status_message ?? "(none)"}`,
        );
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
        throw new Error(
          `Failed to download generated image from CDN: ${downloadResp.status} ${downloadResp.statusText}`,
        );
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
    },
  );

  server.registerTool(
    "update_avatar",
    {
      title: "Update an avatar's metadata",
      description:
        "Patch an avatar's name, description, default flag, or voice_id. Useful for renaming, swapping the assigned voice, or marking another avatar as the workspace default. Does NOT change the avatar's image (re-upload via the create flow if image change is needed).",
      inputSchema: {
        avatar_id: z.number().int().positive(),
        name: z.string().min(1).max(50).optional(),
        description: z.string().optional(),
        default: z.boolean().optional(),
        voice_id: z.number().int().positive().optional(),
      },
    },
    async ({ avatar_id, ...patch }) => {
      const updated = await client.updateAvatar(avatar_id, patch);
      return { content: [{ type: "text", text: JSON.stringify(sanitizeAvatar(updated), null, 2) }] };
    },
  );

  server.registerTool(
    "list_avatar_scenes",
    {
      title: "List scenes attached to an avatar",
      description:
        "Return the scenes (video clips) associated with an avatar. Internally fetches the avatar with the scenes include chain and returns just the scenes array. Use this to inspect what motion clips are available for combining into an avatar video.",
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
