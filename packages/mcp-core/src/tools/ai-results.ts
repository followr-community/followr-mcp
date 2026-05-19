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

  // Tool: generate_avatar_lipsync_clip (renamed from generate_avatar_video in v0.3.2).
  // Produces ONE lipsync clip of ONE scene. For full multi-scene videos with
  // burned-in subtitles + concat, use generate_avatar_video.
  //
  // BUG FIX in v0.3.2: previous implementation merged
  // `model: model ?? ai_preferences.video_model ?? "veed_fabric_1.0"`. If a
  // company had `ai_preferences.video_model` set to a text-to-video model
  // (veo_3_1_fast, sora_2_pro, etc.) the endpoint silently switched modes and
  // ignored audio_url/image_url, producing a Veo/Sora text-to-video instead
  // of an avatar lipsync. Now we hardcode the lipsync model and driver.
  server.registerTool(
    "generate_avatar_lipsync_clip",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate one avatar lipsync clip (single scene, no subtitles or concat)",
      description: `Compound workflow that produces a single avatar lipsync video clip. Internally: 1) fetch the avatar's voice + image, 2) generate TTS audio with the avatar's voice, 3) wait for audio, 4) generate the lipsync video (avatar talking head).

USE THIS WHEN: the user wants a quick single-scene clip without subtitles or multi-scene concatenation. For the standard "AI Video Avatars" multi-scene flow with burned-in subtitles, use generate_avatar_video instead.

CRITICAL: heavy operation. Cost is dynamic in Followr; roughly 200-500 credits per clip depending on script length and aspect ratio. Call get_credits_balance before to confirm the user has budget.

PRECONDITION: company_id required. avatar_id required, and the avatar MUST have a voice and an image attached (list_avatars to verify, or create_avatar_full_flow if needed).

LATENCY: 60-180 seconds typical.

MODEL: hardcoded to fal + veed_fabric_1.0 (the only lipsync model verified to work for avatar videos in Followr). The company's ai_preferences.video_model is NOT applied here on purpose: that preference targets text-to-video generation (Veo, Sora, SeeDance), which is incompatible with lipsync and would produce a completely different output.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        avatar_id: z.number().int().positive().describe("The avatar to use (must have a voice and image already set)."),
        script: z.string().min(1).describe("Text the avatar will say in this scene. Typical 100-150 chars. May include ElevenLabs emotion tags like [excited] [confident] [whispers] [pause]."),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional().describe("9:16 (vertical, default, for Reels/Shorts/TikTok) or 16:9 (landscape). Default 9:16."),
        audio_speed: z.number().min(0.5).max(2.0).optional().describe("TTS speed. Default 1.0."),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds for video to complete. Default 600."),
      },
    },
    async ({ company_id, avatar_id, script, aspect_ratio, audio_speed, timeout_seconds }) => {
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
        // Lipsync render. HARDCODED to fal + veed_fabric_1.0. See description
        // for why we deliberately do NOT read ai_preferences here.
        const videoInitial = await client.generateVideo({
          type: "video",
          q: script,
          audio_url: audioUrl,
          image_url: imageUrl,
          aspect_ratio: aspect_ratio ?? "9:16",
          driver: "fal",
          model: "veed_fabric_1.0",
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

  // Tool: generate_avatar_video (NEW in v0.3.2).
  // Mirrors Followr's "AI Video Avatars" UI flow: N TTS audio jobs, then N
  // lipsync renders, then one Creatomate concat with burned-in subtitles.
  // Simplification vs UI: uses the avatar's portrait directly as the visual
  // for each scene instead of generating image-to-image backgrounds per scene
  // (that's a v0.4 feature).
  //
  // Render_script shape was verified empirically on 2026-05-19 via Chrome
  // capture of the production UI. See docs/followr-api/avatars.md.
  server.registerTool(
    "generate_avatar_video",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate a full multi-scene avatar video with burned-in subtitles",
      description: `Compound workflow that produces a complete multi-scene avatar video, mirroring Followr's "AI Video Avatars" UI flow. Internally:

1. For each scene script (in parallel): generate TTS audio with the avatar's voice.
2. Wait for audio jobs.
3. For each scene (in parallel): generate avatar lipsync video using audio + avatar portrait.
4. Wait for lipsync jobs.
5. Concat all lipsync clips into one MP4 with burned-in subtitles via Creatomate (driver=creatomate, model=creatomate_video).

USE THIS WHEN: the user wants a real avatar video like the one Followr UI produces from Avatar Video Creator (multi-scene, with subtitles, ready to publish to Reels/Shorts/TikTok).

USE generate_avatar_lipsync_clip INSTEAD: when the user only wants a single-scene clip without subtitles or concat.

CRITICAL: heavy operation. Cost is dynamic in Followr (depends on script length, aspect ratio, scene count); the UI typically shows 600-1100 credits for a 3-4 scene 9:16 video at Regular speed. Always confirm with the user before proceeding and surface get_credits_balance first.

PRECONDITION: company_id + avatar_id required. The avatar MUST have a voice and an image attached. Verify with get_avatar before calling.

SIMPLIFICATION vs Followr UI: this tool uses the avatar's portrait as the visual for every scene (talking head). The Followr UI generates a unique image-to-image background per scene; that level of visual variety is a future enhancement.

LATENCY: typically 3-5 minutes for a 3-4 scene video. Configurable via timeout_seconds.

SUBTITLES: burned in by default with Followr's default style (Montserrat 700, 9.29 vmin font size, white text + #0095a6 highlight color, dark stroke, highlight effect, 14 char max per line, positioned at 82% from top). Override via subtitle_* params.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        avatar_id: z.number().int().positive().describe("Avatar with voice + image attached."),
        scripts: z.array(z.string().min(1).max(500)).min(1).max(10).describe("One script per scene. 1 to 10 scenes. Typical 80-150 chars each. May include ElevenLabs emotion tags like [excited] [confident] [whispers] [pause]. Each script becomes one scene in the final video."),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional().describe("9:16 (vertical, default, for Reels/Shorts/TikTok) or 16:9 (landscape). Default 9:16."),
        audio_speed: z.number().min(0.5).max(2.0).optional().describe("TTS speed applied to every scene. Default 1.0."),
        subtitle_text_color: z.string().optional().describe("Hex color for subtitle text. Default #ffffff (white)."),
        subtitle_highlight_color: z.string().optional().describe("Hex color for the active highlighted word. Default #0095a6 (Followr brand teal)."),
        subtitle_max_chars: z.number().int().min(8).max(40).optional().describe("Max characters shown at once in subtitles. Default 14."),
        subtitle_font: z.string().optional().describe("Font family. Default Montserrat. Other supported (per Followr UI): Inter, Poppins, Roboto, Open Sans, Playfair Display, Bebas Neue."),
        timeout_seconds: z.number().int().positive().max(1200).optional().describe("Max seconds for the entire flow. Default 900 (15 min)."),
      },
    },
    async ({
      company_id,
      avatar_id,
      scripts,
      aspect_ratio,
      audio_speed,
      subtitle_text_color,
      subtitle_highlight_color,
      subtitle_max_chars,
      subtitle_font,
      timeout_seconds,
    }) => {
      try {
        const avatar: Avatar = await client.getAvatar(avatar_id, {
          include: "image,voice,voice.audio",
        });
        if (!avatar.voice?.platform_external_id) {
          return toolError({
            reason: "avatar_missing_voice",
            user_message: `Avatar "${avatar.name}" has no voice configured. A voice is required to generate avatar videos.`,
            suggested_actions: [
              {
                tool: "update_avatar",
                rationale: "Assign a voice_id to this avatar.",
              },
            ],
            details: { avatar_id, avatar_name: avatar.name },
          });
        }
        if (!avatar.image?.url) {
          return toolError({
            reason: "avatar_missing_image",
            user_message: `Avatar "${avatar.name}" has no image attached.`,
            suggested_actions: [
              {
                tool: "create_avatar_full_flow",
                rationale: "Re-create the avatar with an image, or attach one manually via the Followr UI.",
              },
            ],
            details: { avatar_id, avatar_name: avatar.name },
          });
        }
        const voicePlatformId = avatar.voice.platform_external_id;
        const avatarImageUrl = avatar.image.url;
        const totalTimeoutMs = (timeout_seconds ?? 900) * 1000;
        // Per-job timeout: a quarter of the total, with 60s floor. Audio is
        // fast (~10-15s) but lipsync renders can take 60-120s each in parallel.
        const perJobTimeoutMs = Math.max(60_000, Math.floor(totalTimeoutMs / 4));
        const finalAspectRatio = aspect_ratio ?? "9:16";

        // === Phase 1: TTS audio per scene (parallel submit + parallel wait). ===
        const audioInitials = await Promise.all(
          scripts.map((script) =>
            client.generateAudio({
              q: script,
              company_id,
              type: "audio",
              voice: voicePlatformId,
              ...(audio_speed !== undefined ? { speed: audio_speed } : {}),
              driver: "fal",
              model: "elevenlabs_tts_3",
            }),
          ),
        );
        const audioFinals = await Promise.all(
          audioInitials.map((init) =>
            client.waitForAiResult(init.id, { timeoutMs: perJobTimeoutMs }),
          ),
        );
        const failedAudioIdx = audioFinals.findIndex(
          (a) => a.status !== "completed" || !a.response,
        );
        if (failedAudioIdx >= 0) {
          const failed = audioFinals[failedAudioIdx]!;
          return toolError({
            reason: "audio_generation_failed",
            user_message: `Audio for scene ${failedAudioIdx + 1} of ${scripts.length} failed (status=${failed.status})${failed.status_message ? `: ${failed.status_message}` : ""}.`,
            suggested_actions: [
              {
                tool: "get_credits_balance",
                rationale: "Check credit balance.",
              },
            ],
            details: {
              failed_scene_index: failedAudioIdx,
              failed_script: scripts[failedAudioIdx] ?? null,
              ai_result_id: failed.id,
              status: failed.status,
              status_message: failed.status_message ?? null,
            },
          });
        }
        const audioUrls = audioFinals.map((a) => a.response!);

        // === Phase 2: Lipsync render per scene (parallel). HARDCODE model. ===
        const videoInitials = await Promise.all(
          scripts.map((script, i) =>
            client.generateVideo({
              type: "video",
              q: script,
              audio_url: audioUrls[i]!,
              image_url: avatarImageUrl,
              aspect_ratio: finalAspectRatio,
              driver: "fal",
              model: "veed_fabric_1.0",
              company_id,
              chargeable: 1,
            }),
          ),
        );
        const videoFinals = await Promise.all(
          videoInitials.map((init) =>
            client.waitForAiResult(init.id, { timeoutMs: perJobTimeoutMs }),
          ),
        );
        const failedVideoIdx = videoFinals.findIndex(
          (v) => v.status !== "completed" || !v.response,
        );
        if (failedVideoIdx >= 0) {
          const failed = videoFinals[failedVideoIdx]!;
          return toolError({
            reason: "lipsync_generation_failed",
            user_message: `Lipsync for scene ${failedVideoIdx + 1} of ${scripts.length} failed (status=${failed.status})${failed.status_message ? `: ${failed.status_message}` : ""}. Audio jobs already completed successfully; you can retry the lipsync step or fall back to generate_avatar_lipsync_clip per scene.`,
            suggested_actions: [
              {
                rationale: "Retry the call. Lipsync jobs occasionally fail transiently.",
              },
            ],
            details: {
              failed_scene_index: failedVideoIdx,
              ai_result_id: failed.id,
              status: failed.status,
              audio_urls: audioUrls,
            },
          });
        }
        const lipsyncUrls = videoFinals.map((v) => v.response!);

        // === Phase 3: Build Creatomate render_script and submit concat. ===
        // Shape verified empirically 2026-05-19 (sesión 7). For each scene
        // we emit two elements: a video (the lipsync clip) and a text overlay
        // (subtitles generated by Creatomate from the video's embedded
        // transcript via transcript_source linking by id). Tracks alternate
        // so elements don't overlap on the timeline: scene 0 = tracks 1+2,
        // scene 1 = tracks 3+4, ... Time and duration are intentionally
        // omitted; Creatomate infers them from the source video.
        const isPortrait = finalAspectRatio === "9:16";
        const renderWidth = isPortrait ? 768 : 1376;
        const renderHeight = isPortrait ? 1376 : 768;
        const elements: Array<Record<string, unknown>> = [];
        lipsyncUrls.forEach((url, i) => {
          const videoId = `video-scene-${i + 1}`;
          elements.push({
            type: "video",
            id: videoId,
            source: url,
            track: i * 2 + 1,
          });
          elements.push({
            type: "text",
            transcript_source: videoId,
            transcript_effect: "highlight",
            transcript_maximum_length: subtitle_max_chars ?? 14,
            y: "82%",
            width: "81%",
            height: "35%",
            x_alignment: "50%",
            y_alignment: "50%",
            fill_color: subtitle_text_color ?? "#ffffff",
            transcript_color: subtitle_highlight_color ?? "#0095a6",
            stroke_color: "rgba(0,0,0,1)",
            stroke_width: "1.6 vmin",
            font_family: subtitle_font ?? "Montserrat",
            font_weight: "700",
            font_size: "9.29 vmin",
            background_color: "rgba(216,216,216,0)",
            background_x_padding: "31%",
            background_y_padding: "10%",
            background_border_radius: "27%",
            track: i * 2 + 2,
          });
        });
        const concatInitial = await client.generateVideoConcat({
          type: "video",
          q: "creatomate",
          aspect_ratio: finalAspectRatio,
          driver: "creatomate",
          model: "creatomate_video",
          render_script: {
            output_format: "mp4",
            width: renderWidth,
            height: renderHeight,
            elements,
          },
          company_id,
          chargeable: 1,
        });
        const concatFinal = await client.waitForAiResult(concatInitial.id, {
          timeoutMs: perJobTimeoutMs,
        });
        if (concatFinal.status !== "completed" || !concatFinal.response) {
          return toolError({
            reason: "concat_failed",
            user_message: `Final video concat failed (status=${concatFinal.status})${concatFinal.status_message ? `: ${concatFinal.status_message}` : ""}. Individual lipsync clips were generated successfully (URLs in details). You can either retry the concat by calling this tool again with the same scripts (lipsyncs will regenerate, costing credits) or build a final video manually from the individual URLs.`,
            suggested_actions: [
              {
                tool: "list_ai_results",
                rationale: "Inspect the individual lipsync aiResults to confirm they're usable.",
              },
            ],
            details: {
              concat_ai_result_id: concatFinal.id,
              status: concatFinal.status,
              scene_count: scripts.length,
              individual_lipsync_urls: lipsyncUrls,
            },
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  avatar_id,
                  avatar_name: avatar.name,
                  scene_count: scripts.length,
                  aspect_ratio: finalAspectRatio,
                  audio_ai_result_ids: audioFinals.map((a) => a.id),
                  lipsync_ai_result_ids: videoFinals.map((v) => v.id),
                  individual_lipsync_urls: lipsyncUrls,
                  final_video: sanitizeAiResult(concatFinal),
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
