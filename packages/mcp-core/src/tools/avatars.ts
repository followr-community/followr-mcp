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
      title: "Create a new avatar end-to-end (text, image-to-image, or direct photo)",
      description: `Compound workflow that creates a NEW avatar in the company and attaches an image to it. Three input modes (mutually exclusive, EXACTLY ONE required):

INPUT MODES:
- prompt: text-only. Followr AI generates a portrait from scratch matching the prompt. Use when there is no real person to base the avatar on (generic spokesperson, fictional character, stylized look).
- reference_image_url: image-to-image generation. Followr AI uses the URL as visual reference and produces a "clean" avatar portrait (centered face, neutral framing) that resembles the reference person. Use when the brand has a model / owner / employee / recurring face the avatar should look like. The original photo is NOT reused as-is; a new portrait is generated based on it.
- use_image_directly_url: SKIP image generation entirely. The URL is uploaded as the avatar's image directly. Use only when the URL already points to a photo properly framed for avatar use (face centered and clear, neutral background, no overlaid logos or text). Saves ~25 credits and 30-90s of latency. If unsure whether the photo qualifies, fall back to reference_image_url.

CHECK FIRST (avatar discovery): BEFORE calling this tool, ALWAYS call list_avatars(company_id) and present the existing avatars to the user by NAME. If any existing avatar fits the use case, use that avatar's id directly in the video tool instead of creating a new one. Creating a new avatar consumes credits and clutters the library. Only call create_avatar_full_flow when no existing avatar matches OR the user explicitly asks for a new one.

CRITICAL: This consumes credits (~25-70 depending on image model and the chosen input mode; use_image_directly_url avoids the image-generation cost). Before calling:
1. Confirm with the user verbatim (avatar name, voice, input mode, prompt or reference URL).
2. Call get_credits_balance if the user is on a tight budget or if running this repeatedly.
3. Confirm the voice_id by name; the wrong voice means future avatar videos sound wrong.

PRECONDITION: company_id required. If multiple companies, confirm company by name. voice_id required (use list_voices to find one, or list_elevenlabs_voices + create_voice_from_elevenlabs to create one).

LATENCY: image generation can take 30-300 seconds when using prompt or reference_image_url. The tool blocks until completion (or timeout_seconds expires). use_image_directly_url is fast: ~5-15s for the download + upload only. Set the user's expectation accordingly.

NOT UNDOABLE VIA MCP: there is no delete_avatar tool exposed here. The created avatar persists in the company. Use update_avatar with default=false to demote it, or delete it from the Followr UI.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        voice_id: z.number().int().positive().describe("Existing Voice.id from list_voices or a voice freshly created via create_voice_from_elevenlabs."),
        name: z.string().min(1).max(50).describe("Display name for the avatar."),
        prompt: z.string().min(1).optional().describe("Text-to-image mode. Visual prompt describing the avatar (e.g. 'professional female news anchor in studio'). Mutually exclusive with reference_image_url and use_image_directly_url."),
        reference_image_url: z.string().url().optional().describe("Image-to-image mode. URL of a real photo the avatar should resemble (brand owner, model, employee). A clean avatar portrait is generated based on this reference. Mutually exclusive with prompt and use_image_directly_url."),
        use_image_directly_url: z.string().url().optional().describe("Skip-generation mode. URL of a photo already framed for avatar use (face centered, neutral background). Uploaded as the avatar's image as-is, no AI generation. Mutually exclusive with prompt and reference_image_url."),
        description: z.string().optional().describe("Optional description. Defaults to a truncated form of the prompt (or a brief auto-generated note for image modes)."),
        aspect_ratio: z.enum(["1:1", "4:3", "16:9", "3:4", "9:16"]).optional().describe("Aspect ratio of the generated portrait. Ignored when use_image_directly_url is set. Default 1:1."),
        default: z.boolean().optional().describe("If true, marks this avatar as the company default. Default false."),
        image_driver: z.string().optional().describe("Optional image generation driver override (e.g. fal, recraft, openai). Ignored when use_image_directly_url is set."),
        image_model: z.string().optional().describe("Optional image model override (e.g. nano_banana_2). Ignored when use_image_directly_url is set."),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds for image generation to complete. Default 300. Ignored when use_image_directly_url is set (that path is fast and bounded by the CDN download)."),
      },
    },
    async ({
      company_id,
      prompt,
      reference_image_url,
      use_image_directly_url,
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
        // Enforce exactly-one-of {prompt, reference_image_url, use_image_directly_url}.
        const modeFlags = [Boolean(prompt), Boolean(reference_image_url), Boolean(use_image_directly_url)];
        const modeCount = modeFlags.filter(Boolean).length;
        if (modeCount === 0) {
          return toolError({
            reason: "missing_input_mode",
            user_message:
              "create_avatar_full_flow requires exactly one of: prompt, reference_image_url, or use_image_directly_url. Pick the input mode based on what the user can provide (text description, photo of a real person to resemble, or a ready-to-use avatar portrait).",
            suggested_actions: [
              {
                rationale:
                  "If the brand has a real person whose face the avatar should resemble, ask for a photo URL and pass it as reference_image_url.",
              },
              {
                rationale: "If there is no real person to base on, write a visual prompt and pass it as prompt.",
              },
            ],
            details: {},
          });
        }
        if (modeCount > 1) {
          return toolError({
            reason: "ambiguous_input_mode",
            user_message:
              "create_avatar_full_flow accepts only ONE of prompt, reference_image_url, or use_image_directly_url. Choose the input mode that best matches the user's request and pass only that field.",
            suggested_actions: [],
            details: {
              prompt_set: Boolean(prompt),
              reference_image_url_set: Boolean(reference_image_url),
              use_image_directly_url_set: Boolean(use_image_directly_url),
            },
          });
        }

        // Resolve avatar.description default per mode.
        const resolvedDescription =
          description ??
          (prompt
            ? prompt.slice(0, 340)
            : reference_image_url
              ? `Avatar based on reference image: ${reference_image_url}`
              : `Avatar uploaded directly: ${use_image_directly_url}`);

        // === Mode: use_image_directly_url ===
        // Skip image generation. Create the avatar resource, download the image
        // from the provided URL, and upload it via the 3-step pattern.
        if (use_image_directly_url) {
          const downloadResp = await fetch(use_image_directly_url);
          if (!downloadResp.ok) {
            return toolError({
              reason: "url_download_failed",
              user_message: `Could not download the avatar image from "${use_image_directly_url}" (HTTP ${downloadResp.status} ${downloadResp.statusText}). Check that the URL is reachable and serves raw image bytes.`,
              suggested_actions: [
                {
                  rationale: "Verify the URL in a browser. For Google Drive / Dropbox shares, replace with a direct file URL.",
                },
                {
                  rationale: "Fall back to reference_image_url if the URL serves an image that just needs to be regenerated for avatar framing.",
                },
              ],
              details: {
                source_url: use_image_directly_url,
                http_status: downloadResp.status,
                http_status_text: downloadResp.statusText,
              },
            });
          }
          const contentType = downloadResp.headers.get("content-type") ?? "image/jpeg";
          const buffer = await downloadResp.arrayBuffer();
          const avatar = await client.createAvatar(company_id, {
            name,
            description: resolvedDescription,
            voice_id,
            default: isDefault ?? false,
          });
          const filename = `avatar-${avatar.id}-${Date.now()}.jpg`;
          const uploadInfo = await client.requestAvatarImageUpload(avatar.id, {
            filename,
            type: "image",
            visibility: "public",
          });
          await client.uploadToBlob(uploadInfo.presigned_url, buffer, contentType);
          const finalAvatar = await client.getAvatar(avatar.id, { include: DEFAULT_INCLUDE });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    input_mode: "use_image_directly_url",
                    source_image_url: use_image_directly_url,
                    avatar: sanitizeAvatar(finalAvatar),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // === Modes: prompt OR reference_image_url ===
        // Both go through generateImage. reference_image_url additionally passes
        // image_url + image_urls to enable image-to-image mode. Prompt text for
        // image-to-image is derived from the user-provided prompt if any, or
        // synthesized from a generic "avatar portrait" template otherwise.
        const prefs = await getAiPreferences(client, company_id);
        const resolvedModel = image_model ?? prefs.image_model ?? "nano_banana_2";
        const resolvedDriver =
          image_driver ?? prefs.image_driver ?? (resolvedModel === "nano_banana_2" ? "fal" : undefined);
        const generationPrompt =
          prompt ??
          "Clean professional portrait suitable as an avatar: subject centered, visible from waist up, neutral plain background, soft even lighting, sharp face, no overlaid text or logos. Match the reference image's identity (face, build, hair).";
        const imageBody: Parameters<FollowrClient["generateImage"]>[0] = {
          q: generationPrompt,
          company_id,
          aspect_ratio: aspect_ratio ?? prefs.image_aspect_ratio ?? "1:1",
          n: 1,
          chargeable: 1,
          queue: true,
          model: resolvedModel,
          ...(resolvedDriver ? { driver: resolvedDriver } : {}),
        };
        if (reference_image_url) {
          imageBody.image_url = reference_image_url;
          imageBody.image_urls = [reference_image_url];
        }
        const initialImage = await client.generateImage(imageBody);
        const completedImage = await client.waitForAiResult(initialImage.id, {
          timeoutMs: (timeout_seconds ?? 300) * 1000,
        });
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
                  "Retry create_avatar_full_flow with the same input. Image generation models occasionally fail transiently.",
              },
            ],
            details: {
              ai_result_id: completedImage.id,
              status: completedImage.status,
              status_message: completedImage.status_message ?? null,
              input_mode: reference_image_url ? "reference_image_url" : "prompt",
            },
          });
        }
        const avatar = await client.createAvatar(company_id, {
          name,
          description: resolvedDescription,
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
                  input_mode: reference_image_url ? "reference_image_url" : "prompt",
                  image_ai_result_id: completedImage.id,
                  source_image_url: generatedImageUrl,
                  ...(reference_image_url ? { reference_image_url } : {}),
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
      description: `Return the scenes (pre-recorded motion clips) associated with an avatar in Followr. These are an internal Followr concept (clips that some avatars come bundled with) and are NOT required by generate_avatar_video or generate_avatar_lipsync_clip. Those tools build new scenes from script + audio at call time.

USE FOR: introspection of bundled-clip avatars or diagnosing the avatar's setup. Most callers do not need this.`,
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
