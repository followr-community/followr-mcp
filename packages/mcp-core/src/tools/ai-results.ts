import { FollowrClient } from "@followr-mcp/shared";
import type { AiResult, Avatar } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import { getAiPreferences } from "../lib/preferences.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

// Drop BYOK metadata before exposing AiResult to the AI client.
function sanitizeAiResult(result: AiResult): Omit<AiResult, "use_own_key"> {
  const { use_own_key: _omit, ...safe } = result;
  return safe;
}

export function registerAiResultsTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "generate_text",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate text with Followr AI (chat completion)",
      description: `Generate text using Followr's AI text endpoint. Use for prompt-based text tasks: brainstorm ideas, draft copy, rewrite in a different tone, translate, suggest hashtags, summarize an article.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name. Cost is charged to the company's plan.

BRAND VOICE: when generating content for posts in a specific company, consider calling get_company first to load brand voice fields (description, audience, tone) and reference them in the prompt. Generic prompts produce generic content.

DEFAULTS: openai gpt-4.1-mini. Override via driver/model. Company ai_preferences are NOT applied automatically when these are omitted; explicit defaults are used.

ASYNC: wait=true (default) blocks until completion. wait=false returns immediately with a pending id (use get_ai_result or wait_for_ai_result to poll later). Use wait=false only for genuinely long batch jobs the user is OK leaving running.`,
      inputSchema: {
        company_id: z.number().int().positive().describe("The Followr company id (company)."),
        prompt: z.string().min(1).describe("The full prompt to send to the model."),
        driver: z.string().optional().describe("Optional provider override. Visto: openai, anthropic, deepseek. Default uses the company's text_driver."),
        model: z.string().optional().describe("Optional model override. e.g. gpt-4.1-mini, claude-sonnet-4-5, deepseek-chat. Default uses the company's text_model."),
        queue: z.boolean().optional().describe("If true, run async via queue. Default true (matches SPA behavior)."),
        wait: z.boolean().optional().default(true).describe("If true (default), poll until the result is completed or failed and return the final result. If false, return the initial pending result."),
        timeout_seconds: z.number().int().positive().max(600).optional().describe("Max seconds to wait for completion when wait=true. Default 300."),
      },
    },
    async ({ company_id, prompt, driver, model, queue, wait, timeout_seconds }) => {
      try {
        const prefs = await getAiPreferences(client, company_id);
        const resolvedDriver = driver ?? prefs.text_driver;
        const resolvedModel = model ?? prefs.text_model;
        const initial = await client.generateChat({
          q: prompt,
          company_id,
          ...(resolvedDriver ? { driver: resolvedDriver } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(queue !== undefined ? { queue } : {}),
        });
        if (!wait || initial.status === "completed" || initial.status === "failed") {
          return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(initial), null, 2) }] };
        }
        const final = await client.waitForAiResult(initial.id, {
          timeoutMs: (timeout_seconds ?? 300) * 1000,
        });
        return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(final), null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "generate_image",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate an image with Followr AI",
      description: `Generate an image using Followr's AI image endpoint.

CRITICAL: consumes around 25 credits per image. Before batch generations (n>1 or repeated calls), call get_credits_balance and surface the cost to the user. Don't auto-generate multiple variants without explicit user consent.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

CONSISTENCY: pass image_url to keep a subject consistent across multiple generations (image-to-image). Useful for avatar scenes, product variations, character continuity.

ASPECT RATIO: optional. If omitted, the company's ai_preferences.image_aspect_ratio is used (this is the user's configured preference in Followr UI > Company Settings > AI Images). Only pass an explicit aspect_ratio when (a) the user requested a specific value, or (b) the target platform REQUIRES a different ratio than the company default and would reject or visibly crop the post otherwise (e.g. IG Story = 9:16 required). When you know the target network + product_type, call validate_against_specs first to discover required ratios. Do NOT override the company default for marketing best practices ("4:5 rinde mejor"); that is the user's call, not the agent's.

DEFAULTS: applies the company's ai_preferences (image_model and image_aspect_ratio) configured in Followr UI > Company Settings > AI Images. If the company has no preferences set, falls back to nano_banana_2 (driver fal). Note: ai_preferences only stores image_model, not image_driver. When using the company's model, the MCP lets the Followr backend resolve the driver automatically; passing driver explicitly is rarely necessary.

ASYNC: wait=true (default) blocks until completion (30-120s typical). wait=false returns immediately with a pending id.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        prompt: z.string().min(1).describe("Visual prompt describing the desired image."),
        aspect_ratio: z
          .enum(["1:1", "4:3", "16:9", "3:4", "9:16"])
          .optional()
          .describe("Output aspect ratio. Matches the options in Followr UI > Company Settings > AI Images. 1:1 square, 4:3 / 16:9 landscape, 3:4 / 9:16 portrait."),
        image_url: z.string().url().optional().describe("Reference image URL for image-to-image. Useful for keeping a subject consistent."),
        image_urls: z.array(z.string().url()).optional().describe("Multiple reference images (when applicable)."),
        n: z.number().int().positive().max(4).optional().describe("Number of images to generate. Default 1."),
        driver: z.string().optional().describe("Optional provider override. Visto: fal, openai, recraft."),
        model: z.string().optional().describe("Optional model override. Visto: nano_banana_2."),
        queue: z.boolean().optional(),
        wait: z.boolean().optional().default(true),
        timeout_seconds: z.number().int().positive().max(600).optional(),
      },
    },
    async ({ company_id, prompt, aspect_ratio, image_url, image_urls, n, driver, model, queue, wait, timeout_seconds }) => {
      try {
        const prefs = await getAiPreferences(client, company_id);
        // Resolution order: explicit tool param > company ai_preferences >
        // hardcoded fallback. The hardcoded fallback exists because the
        // /api/aiResults/image endpoint does not apply company preferences
        // when driver/model are omitted from the body (verified empirically).
        //
        // Important: Followr's ai_preferences only stores `_model` (no `_driver`),
        // so when the company has a model configured we let the backend infer the
        // driver instead of forcing `fal`, which would be wrong for non-fal
        // models like imagen4_preview_fast (Google) or gpt_image_2 (OpenAI).
        const resolvedModel = model ?? prefs.image_model ?? "nano_banana_2";
        const resolvedDriver =
          driver ?? prefs.image_driver ?? (resolvedModel === "nano_banana_2" ? "fal" : undefined);
        const resolvedAspectRatio = aspect_ratio ?? prefs.image_aspect_ratio;
        const initial = await client.generateImage({
          q: prompt,
          company_id,
          ...(resolvedAspectRatio ? { aspect_ratio: resolvedAspectRatio } : {}),
          ...(image_url ? { image_url } : {}),
          ...(image_urls?.length ? { image_urls } : {}),
          ...(n ? { n } : {}),
          ...(resolvedDriver ? { driver: resolvedDriver } : {}),
          model: resolvedModel,
          ...(queue !== undefined ? { queue } : {}),
        });
        if (!wait || initial.status === "completed" || initial.status === "failed") {
          return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(initial), null, 2) }] };
        }
        const final = await client.waitForAiResult(initial.id, {
          timeoutMs: (timeout_seconds ?? 300) * 1000,
        });
        return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(final), null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "generate_audio",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate TTS audio with Followr AI",
      description: `Generate text-to-speech audio.

PRECONDITION: company_id required (charges the company's credit plan). If multiple companies and the user hasn't named one, call list_companies first and ask by name.

VOICE: required. Pass either a Voice.platform_external_id from list_voices (company-scoped) or an ElevenLabs voice_id from list_elevenlabs_voices. Confirm the voice with the user verbatim (by name + language) before generating large batches; mistakes mean redoing work.

USE FOR: narrating scripts, podcast snippets, pre-generating audio for avatar videos (though generate_avatar_video bundles this step).

DEFAULTS: fal with elevenlabs_tts_3. Override via driver/model.

ASYNC: wait=true (default) blocks. wait=false returns pending id.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        text: z.string().min(1).describe("The text to speak."),
        voice: z.string().min(1).describe("Voice identifier. Either a Voice.platform_external_id from list_voices or an ElevenLabs voice_id from list_elevenlabs_voices."),
        speed: z.number().min(0.5).max(2.0).optional().describe("Speech speed multiplier. Default 1.0."),
        driver: z.string().optional().describe("TTS provider. Default fal. ElevenLabs also supported."),
        model: z.string().optional().describe("TTS model id (provider-specific)."),
        queue: z.boolean().optional(),
        wait: z.boolean().optional().default(true),
        timeout_seconds: z.number().int().positive().max(600).optional(),
      },
    },
    async ({ company_id, text, voice, speed, driver, model, queue, wait, timeout_seconds }) => {
      const initial = await client.generateAudio({
        q: text,
        company_id,
        type: "audio",
        voice,
        ...(speed !== undefined ? { speed } : {}),
        // Defaults verified empirically: fal + elevenlabs_tts_3.
        driver: driver ?? "fal",
        model: model ?? "elevenlabs_tts_3",
        ...(queue !== undefined ? { queue } : {}),
      });
      if (!wait || initial.status === "completed" || initial.status === "failed") {
        return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(initial), null, 2) }] };
      }
      const final = await client.waitForAiResult(initial.id, {
        timeoutMs: (timeout_seconds ?? 300) * 1000,
      });
      return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(final), null, 2) }] };
    },
  );

  server.registerTool(
    "generate_avatar_video",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate a lipsync video using an existing avatar",
      description: `Compound workflow that produces a single avatar lipsync video clip. Internally: 1) fetch the avatar's voice and image, 2) generate TTS audio with the avatar's voice, 3) wait for audio, 4) generate the lipsync video.

CRITICAL: VERY HEAVY OPERATION. ~775 credits per video (Regular driver), 930 with Fast. Before calling:
1. Confirm the script content verbatim with the user.
2. Call get_credits_balance and surface remaining credits + cost.
3. For multi-scene videos, multiply by scene count and confirm total cost.
4. Confirm avatar (by name, not id) and aspect_ratio.

PRECONDITION: company_id required. avatar_id required, and the avatar MUST have a voice and an image attached (list_avatars to verify, or create_avatar_full_flow if needed). The tool throws clearly if either is missing.

LATENCY: 60-600 seconds typical. Set the user's expectation; this is not interactive.

DEFAULTS: applies the company's ai_preferences (video_driver, video_model, video_aspect_ratio) configured in Followr UI > Company Settings > AI Videos. If the company has no preferences set, falls back to fal + veed_fabric_1.0 + 9:16. Passing driver/model/aspect_ratio in the call overrides both.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        avatar_id: z.number().int().positive().describe("The avatar to use (must have a voice and image already set)."),
        script: z.string().min(1).describe("Text the avatar will say in this scene. Typical 100-150 chars."),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional().describe("Followr's UI offers only 16:9 (landscape) and 9:16 (portrait, viral short) for video. Default 9:16 if neither tool call nor company prefs specify."),
        driver: z.string().optional().describe("Default fal."),
        model: z.string().optional().describe("Lipsync model id (provider-specific)."),
        audio_speed: z.number().min(0.5).max(2.0).optional().describe("TTS speed. Default 1.0."),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds for video to complete. Default 600."),
      },
    },
    async ({ company_id, avatar_id, script, aspect_ratio, driver, model, audio_speed, timeout_seconds }) => {
      try {
        const avatar: Avatar = await client.getAvatar(avatar_id, {
          include: "image,voice,voice.audio",
        });
        const voicePlatformId = avatar.voice?.platform_external_id;
        const imageUrl = avatar.image?.url;
        if (!voicePlatformId) {
          return toolError({
            reason: "avatar_missing_voice",
            user_message: `Avatar "${avatar.name}" has no voice configured. A voice is required to generate a lipsync video.`,
            suggested_actions: [
              {
                tool: "update_avatar",
                rationale:
                  "Assign a voice_id to this avatar. Use list_voices to find an existing one or create_voice_from_elevenlabs to pick a new one.",
              },
            ],
            details: { avatar_id, avatar_name: avatar.name },
          });
        }
        if (!imageUrl) {
          return toolError({
            reason: "avatar_missing_image",
            user_message: `Avatar "${avatar.name}" has no image attached. An image is required to generate a lipsync video.`,
            suggested_actions: [
              {
                tool: "create_avatar_full_flow",
                rationale:
                  "Re-create the avatar with an image, or attach one manually through the Followr UI.",
              },
            ],
            details: { avatar_id, avatar_name: avatar.name },
          });
        }
        // Generate TTS audio with avatar's voice.
        const audioInitial = await client.generateAudio({
          q: script,
          company_id,
          type: "audio",
          voice: voicePlatformId,
          ...(audio_speed !== undefined ? { speed: audio_speed } : {}),
          driver: "fal",
          model: "elevenlabs_tts_3",
        });
        const audioFinal = await client.waitForAiResult(audioInitial.id, {
          timeoutMs: (timeout_seconds ?? 600) * 1000,
        });
        const audioUrl = audioFinal.response ?? "";
        if (audioFinal.status !== "completed" || !audioUrl) {
          return toolError({
            reason: "audio_generation_failed",
            user_message: `TTS audio generation failed for avatar "${avatar.name}" (status=${audioFinal.status})${audioFinal.status_message ? `: ${audioFinal.status_message}` : ""}.`,
            suggested_actions: [
              {
                tool: "get_credits_balance",
                rationale:
                  "Check credit balance. Audio generation can fail silently when credits are insufficient.",
              },
              {
                rationale:
                  "Retry the call; audio jobs occasionally fail transiently.",
              },
            ],
            details: {
              avatar_id,
              ai_result_id: audioFinal.id,
              status: audioFinal.status,
              status_message: audioFinal.status_message ?? null,
            },
          });
        }
        // Generate lipsync video.
        // Resolution: explicit tool param > company ai_preferences > hardcoded.
        // Same nuance as generate_image: ai_preferences only stores `_model`,
        // no `_driver`. We only force `fal` when we're also using the hardcoded
        // model veed_fabric_1.0.
        const videoPrefs = await getAiPreferences(client, company_id);
        const resolvedVideoModel = model ?? videoPrefs.video_model ?? "veed_fabric_1.0";
        const resolvedVideoDriver =
          driver ?? videoPrefs.video_driver ?? (resolvedVideoModel === "veed_fabric_1.0" ? "fal" : undefined);
        const resolvedVideoAspectRatio = aspect_ratio ?? videoPrefs.video_aspect_ratio ?? "9:16";
        const videoInitial = await client.generateVideo({
          type: "video",
          q: script,
          audio_url: audioUrl,
          image_url: imageUrl,
          aspect_ratio: resolvedVideoAspectRatio,
          driver: resolvedVideoDriver ?? "fal",
          // Empirically verified default: veed_fabric_1.0 is what Followr uses
          // in production for avatar lipsync renders (company 8 historical
          // aiResults with type=video on 2026-05-13).
          model: resolvedVideoModel,
          company_id,
          chargeable: 1,
        });
        const videoFinal = await client.waitForAiResult(videoInitial.id, {
          timeoutMs: (timeout_seconds ?? 600) * 1000,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  avatar_id,
                  audio_ai_result_id: audioFinal.id,
                  audio_url: audioUrl,
                  image_url: imageUrl,
                  video: sanitizeAiResult(videoFinal),
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
    "list_ai_results",
    {
      annotations: READ_ONLY,
      title: "List past AI generations in a company",
      description: `List previously generated AI results in a company, filtered by type (chat, image, audio, video) and optionally by model.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

PRIMARY USE: recover prior generations and reference their URLs without paying credits to regenerate. Especially valuable for images/audio/video which are expensive.

INCLUDE: for images pass include="image,image.thumbnail"; for videos include="videos,videos.thumbnail". The base resource doesn't always hydrate file fields without an explicit include.

Sorted newest first by default.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        type: z
          .enum(["chat", "image", "audio", "video"])
          .optional()
          .describe("Filter by generation type. Omit for all types."),
        model: z.string().optional().describe("Filter by exact model id. Useful for Viral Shorts (creatomate_short)."),
        include: z.string().optional().describe("Comma-separated includes. e.g. 'image,image.thumbnail' for images, 'videos,videos.thumbnail' for videos."),
        page_size: z.number().int().positive().max(100).optional(),
        sort: z.string().optional().describe("Default -created_at."),
      },
    },
    async ({ company_id, type, model, include, page_size, sort }) => {
      const results = await client.listAiResults({
        companyId: company_id,
        ...(type ? { type } : {}),
        ...(model ? { model } : {}),
        ...(include ? { include } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
        ...(sort ? { sort } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results.map(sanitizeAiResult), null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_ai_result",
    {
      annotations: READ_ONLY,
      title: "Get a single AI result by id (no polling)",
      description: `Fetch a single aiResult by id without polling. Cheap status check.

USE FOR: one-shot status reads ("is this done yet?"); inspecting a known result by id.

ALTERNATIVE: wait_for_ai_result for automatic polling until terminal state (completed or failed). Use that when the agent needs the final result and is willing to wait.`,
      inputSchema: {
        ai_result_id: z.number().int().positive(),
      },
    },
    async ({ ai_result_id }) => {
      const result = await client.getAiResult(ai_result_id);
      return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(result), null, 2) }] };
    },
  );

  server.registerTool(
    "wait_for_ai_result",
    {
      annotations: READ_ONLY,
      title: "Wait for an AI result to complete (polling helper)",
      description: `Poll an aiResult by id until its status is terminal (completed or failed) or the timeout elapses.

USE WHEN: an id was returned from a previous generate_* call with wait=false, and now the agent (or user) wants the final result. Most generate_* tools already wait by default; this tool is for the explicit decoupled flow.

DEFAULTS: 300s timeout, 2.5s polling interval. For very long jobs (avatar video), bump timeout_seconds. Don't lower interval below 1s; the API rate-limits poll storms.`,
      inputSchema: {
        ai_result_id: z.number().int().positive(),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds to wait. Default 300."),
        interval_seconds: z.number().min(1).max(30).optional().describe("Polling interval in seconds. Default 2.5."),
      },
    },
    async ({ ai_result_id, timeout_seconds, interval_seconds }) => {
      const result = await client.waitForAiResult(ai_result_id, {
        timeoutMs: (timeout_seconds ?? 300) * 1000,
        intervalMs: (interval_seconds ?? 2.5) * 1000,
      });
      return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(result), null, 2) }] };
    },
  );
}
