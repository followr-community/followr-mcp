import { FollowrClient } from "@followr-mcp/shared";
import type { AiResult, Avatar } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import {
  estimateAvatarVideoSeconds,
  executeAvatarVideoPipeline,
  PipelineCancelledException,
  PipelineFailedException,
  type AvatarVideoPipelineParams,
} from "../lib/avatar-video-pipeline.js";
import { sanitizeImageModelPref } from "../lib/content-plan-catalog.js";
import { resolveDriver } from "../lib/driver-resolver.js";
import {
  createPipeline,
  getPipeline,
  isCancellationRequested,
  listPipelinesForCompany,
  markPipelineCancelled,
  markPipelineCompleted,
  markPipelineFailed,
  recordPipelineSubJobs,
  requestPipelineCancellation,
  updatePipelinePhase,
} from "../lib/pipeline-state.js";
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
      title: "Generate an AI image with Followr (text-to-image, image-to-image, product photo, social creative)",
      description: `Generate an image (creative, illustration, photo-style render, product visual, social post artwork, hero banner) using Followr's AI image endpoint. Supports text-to-image and image-to-image (pass image_url for subject consistency).

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
        // catalog-driven inference (resolveDriver) > backend infer.
        // The fallback model "nano_banana_2" exists because the
        // /api/aiResults/image endpoint does not apply company preferences
        // when model is omitted from the body (verified empirically).
        // sanitizeImageModelPref filters out stale ids (e.g. "dall-e-3" left
        // over from older versions of the Followr UI) so the fallback can
        // actually take over instead of being shadowed by an invalid prefs
        // value that the backend would reject with HTTP 422.
        const resolvedModel =
          model ?? sanitizeImageModelPref(prefs.image_model) ?? "nano_banana_2";
        const resolvedDriver = resolveDriver({
          explicitDriver: driver,
          prefs,
          modality: "image",
          model: resolvedModel,
        });
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
      title: "Generate one avatar lipsync clip (single talking-head scene, no subtitles, no concat, fast quote)",
      description: `Compound workflow that produces a single avatar lipsync video clip. Internally: 1) fetch the avatar's voice + image, 2) generate TTS audio with the avatar's voice, 3) wait for audio, 4) generate the lipsync video (avatar talking head).

THIS IS THE EXCEPTION, NOT THE DEFAULT. Generates a SINGLE talking head, NO subtitles, NO transitions, NO multi-scene. The polished "AI Video Avatars" output the Followr UI ships by default (multi-scene reel with burned-in subtitles + per-scene backgrounds) lives in generate_avatar_video. If the user did NOT explicitly ask for a single bare clip, OR if a content_plan PlanItem described the asset as "video avatar multi-escena" / "avatar narra N escenas" / "avatar_video", you MUST use generate_avatar_video. Using lipsync to "save credits" on a request that expected multi-scene is a regression: the user gets a stripped-down output without the subtitles they expected, AND the cost saving is usually small because both tools bill at 25 cr/seg.

USE THIS ONLY WHEN: the user explicitly requested a single bare talking-head clip with no subtitles and no scene changes (e.g. "just give me one quick 15-second clip of the avatar saying X, no extras"). Otherwise default to generate_avatar_video.

CRITICAL: heavy operation. Cost is per SECOND of generated video (model veed_fabric_1.0 = 25 cr/seg). A typical lipsync clip is ~10-15 seconds = roughly 250-400 credits. Call get_credits_balance before to confirm the user has budget.

REQUIRES TEXT BUDGET TOO. The lipsync flow internally calls Followr's TTS endpoint (ElevenLabs via Followr), which consumes ai_text_budget words on top of the video credits. If get_ai_budget shows ai_text_budget.total === 0 (plan does not include the text/audio module) or ai_text_budget.remaining <= 0 (cycle exhausted), this tool will fail with HTTP 402 entity="words" at the audio step BEFORE generating any video. get_session_context._assistant_guidance.plan_capability_warnings already surfaces this gate at orient time; honor that warning instead of attempting to call here.

PRECONDITION: company_id required. avatar_id required, and the avatar MUST have a voice and an image attached (list_avatars to verify, or create_avatar_full_flow if needed).

LATENCY: 60-180 seconds typical.

MODEL: hardcoded to fal + veed_fabric_1.0 (the only lipsync model verified to work for avatar videos in Followr). The company's ai_preferences.video_model is NOT applied here on purpose: that preference targets text-to-video generation (Veo, Sora, SeeDance), which is incompatible with lipsync and would produce a completely different output.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        avatar_id: z.number().int().positive().describe("The avatar to use (must have a voice and image already set)."),
        script: z.string().min(1).describe("Text the avatar will say in this scene. Typical 100-150 chars. May include ElevenLabs emotion tags like [excited] [confident] [whispers] [pause]."),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional().describe("9:16 (vertical, default, for Reels/Shorts/TikTok) or 16:9 (landscape). Default 9:16."),
        audio_speed: z.number().min(0.5).max(2.0).optional().describe("TTS speed. Default 1.0."),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds for video to complete. Default 600. Only relevant when wait=true."),
        wait: z
          .boolean()
          .optional()
          .describe(
            "If false (DEFAULT as of v0.6.0): returns immediately with a pipeline_id + ETA; the clip generates in the background. Use get_pipeline_status / wait_for_pipeline to track. If true: blocks until completion (legacy v0.5.x behavior). Use wait=true only for clients without transport timeouts.",
          ),
      },
    },
    async ({ company_id, avatar_id, script, aspect_ratio, audio_speed, timeout_seconds, wait }) => {
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
        // Closure: extract the pipeline body so both sync (wait:true) and
        // async (wait:false, default) paths run the same code. Throws
        // PipelineFailedException on backend failures; sync path catches
        // via toolErrorFromException, async path via the runner wrapper.
        const runLipsyncPipeline = async (
          hooks: {
            onPhase?: (info: { sub_phase: string; progress?: { completed: number; total: number } | null }) => void;
            checkCancelled?: (sub_phase: string) => void;
          } = {},
        ): Promise<{ audioFinal: AiResult; videoFinal: AiResult; audioUrl: string }> => {
          hooks.checkCancelled?.("tts");
          hooks.onPhase?.({ sub_phase: "tts (0/1)", progress: { completed: 0, total: 1 } });
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
            throw new PipelineFailedException(
              "tts",
              `TTS audio generation failed for avatar "${avatar.name}" (status=${audioFinal.status})${audioFinal.status_message ? `: ${audioFinal.status_message}` : ""}.`,
              {
                avatar_id,
                ai_result_id: audioFinal.id,
                status: audioFinal.status,
                status_message: audioFinal.status_message ?? null,
              },
            );
          }
          hooks.onPhase?.({ sub_phase: "tts (1/1)", progress: { completed: 1, total: 1 } });
          hooks.checkCancelled?.("lipsync");
          hooks.onPhase?.({ sub_phase: "lipsync (0/1)", progress: { completed: 0, total: 1 } });
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
          if (videoFinal.status !== "completed") {
            throw new PipelineFailedException(
              "lipsync",
              `Lipsync render failed for avatar "${avatar.name}" (status=${videoFinal.status})${videoFinal.status_message ? `: ${videoFinal.status_message}` : ""}.`,
              {
                avatar_id,
                ai_result_id: videoFinal.id,
                status: videoFinal.status,
                audio_url: audioUrl,
              },
            );
          }
          hooks.onPhase?.({ sub_phase: "lipsync (1/1)", progress: { completed: 1, total: 1 } });
          return { audioFinal, videoFinal, audioUrl };
        };

        // === Sync mode (legacy opt-in via wait: true) ====================
        if (wait === true) {
          const result = await runLipsyncPipeline();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    avatar_id,
                    audio_ai_result_id: result.audioFinal.id,
                    audio_url: result.audioUrl,
                    image_url: imageUrl,
                    video: sanitizeAiResult(result.videoFinal),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // === Async mode (DEFAULT as of v0.6.0) ===========================
        // Typical lipsync clip: ~60-180s. Async by default to avoid the
        // claude.ai 4-min transport timeout on slow networks.
        const estimate = 120;
        const pipeline = createPipeline({
          kind: "avatar_lipsync",
          company_id,
          params: { avatar_id, avatar_name: avatar.name, script, aspect_ratio: aspect_ratio ?? "9:16" },
          estimated_total_seconds: estimate,
          initial_sub_phase: "queued",
          initial_progress: { completed: 0, total: 2 },
        });
        const pipelineId = pipeline.pipeline_id;

        setImmediate(() => {
          void (async () => {
            try {
              updatePipelinePhase(pipelineId, {
                phase: "running",
                sub_phase: "starting",
              });
              const result = await runLipsyncPipeline({
                onPhase: (info) => {
                  updatePipelinePhase(pipelineId, {
                    sub_phase: info.sub_phase,
                    ...(info.progress !== undefined ? { progress: info.progress } : {}),
                  });
                },
                checkCancelled: (sub_phase) => {
                  if (isCancellationRequested(pipelineId)) {
                    throw new PipelineCancelledException(sub_phase);
                  }
                },
              });
              markPipelineCompleted(pipelineId, {
                ai_result_id: result.videoFinal.id,
                ...(result.videoFinal.response ? { asset_url: result.videoFinal.response } : {}),
                metadata: {
                  avatar_id,
                  avatar_name: avatar.name,
                  audio_ai_result_id: result.audioFinal.id,
                  audio_url: result.audioUrl,
                  image_url: imageUrl,
                  video: sanitizeAiResult(result.videoFinal),
                },
              });
            } catch (err) {
              if (err instanceof PipelineCancelledException) {
                markPipelineCancelled(pipelineId);
                return;
              }
              if (err instanceof PipelineFailedException) {
                markPipelineFailed(pipelineId, {
                  sub_phase: err.sub_phase,
                  reason: err.sub_phase,
                  user_message: err.user_message,
                  details: err.details,
                });
                return;
              }
              markPipelineFailed(pipelineId, {
                sub_phase: "unknown",
                reason: err instanceof Error ? err.name : "Error",
                user_message: `Pipeline failed with an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          })();
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pipeline_id: pipelineId,
                  kind: "avatar_lipsync",
                  company_id,
                  avatar_id,
                  avatar_name: avatar.name,
                  aspect_ratio: aspect_ratio ?? "9:16",
                  estimated_seconds: estimate,
                  user_facing_summary: `Empecé el clip lipsync del avatar "${avatar.name}". Va a tardar entre 1 y 3 minutos. Decime "fijate" cuando quieras chequear estado.`,
                  _assistant_guidance: {
                    next_step: "tell_user_eta_then_wait_for_status_request",
                    conversational_flow:
                      "Mismo flow que generate_avatar_video: traducí el user_facing_summary al user, usá get_pipeline_status (instant) cuando pregunte estado o wait_for_pipeline (hasta 3 min) cuando diga 'esperá'. NO mencionés pipeline_id ni prometas 'te aviso'.",
                  },
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
      title: "Generate a full multi-scene avatar video with burned-in subtitles (reel, short, TikTok video, talking-head explainer, promo, ad)",
      description: `Compound workflow that produces a complete multi-scene avatar video, mirroring Followr's "AI Video Avatars" UI flow. Internally:

1. (Optional, when generate_backgrounds=true) For each scene: generate a unique image-to-image background that depicts the avatar in a scene matching the script context. Backgrounds are derived from a chat call that turns the scripts into visual prompts.
2. For each scene script (in parallel): generate TTS audio with the avatar's voice.
3. For each scene (in parallel): generate avatar lipsync video using audio + per-scene background (or avatar portrait directly when backgrounds are disabled).
4. Wait for lipsync jobs.
5. Concat all lipsync clips into one MP4 with burned-in subtitles via Creatomate (driver=creatomate, model=creatomate_video).

DEFAULT FOR ALL AVATAR VIDEOS. Use this whenever the user (or a content_plan PlanItem) describes an asset as "avatar video", "video con avatar", "video avatar multi-escena", "avatar narra N escenas", or anything that implies more than a single bare clip. The single-scene generate_avatar_lipsync_clip is the exception, reserved for users who explicitly want a stripped-down talking head with no subtitles. If a planning step produced an ai_avatar_video source (multi-scene with subtitles, transitions, animations) and the executing agent has to materialize it manually because execute_content_plan v1 does not run avatar tools end-to-end, use THIS tool, not the lipsync one. Replacing multi-scene with lipsync "to save credits" is a regression: the user loses the subtitles and the cost saving is small (both bill at 25 cr/seg of speech).

USE THIS WHEN: the user wants a real avatar video like the one Followr UI produces from Avatar Video Creator (multi-scene, with subtitles, ready to publish to Reels/Shorts/TikTok). This is the flagship video tool of Followr.

FLEXIBLE DURATION: total length is the sum of TTS audio across scenes (1 to 10 scenes per call). Typical: 3 scenes of ~10s of speech each = ~30-60s total; a 5-scene LinkedIn piece can reach 1-2 min. There is NO fixed duration cap from the tool. Use this whenever the user needs content longer than 8 seconds or any narrative / scripted-speech video.

WHEN TO USE THE OTHER VIDEO TOOLS INSTEAD:
- Single talking head, one scene, no subtitles: use generate_avatar_lipsync_clip.
- Single 8-second visual clip WITHOUT a talking avatar (product motion, lifestyle moment, scenic loop): use generate_ai_video_clip.
- The user already has footage they want to publish: skip generation, use upload_video_from_url.

OUTFIT PRESERVATION: when the avatar portrait shows a specific outfit that must appear in EVERY scene (fashion brand reels, product showcase with the avatar wearing the brand, lifestyle reels for a recurring look), pass outfit_description with a precise text of the clothing (e.g. "gray bomber jacket with black collar, white tee, dark jeans"). Without this, the AI may interpret clothing differently per scene based on script context (e.g. a "beach" script may put the avatar in swimwear even if the portrait shows winter wear).

ASYNC BY DEFAULT (v0.5.0). This tool now returns immediately with a pipeline_id and an ETA; the video keeps generating in the background. The agent tracks progress via get_pipeline_status (instant) or wait_for_pipeline (bounded poll up to 3 min). This avoids the WebSocket transport timeout that breaks multi-min sync waits on claude.ai. Tell the user something like "Empecé tu reel, va a tardar X-Y min, decime 'fijate' cuando quieras chequear". NEVER promise "te aviso cuando termine" (no push notifications). To opt into legacy sync behavior (only on CLI / IDE clients without transport timeouts), pass wait:true.

CRITICAL: heavy operation. Cost is per SECOND of total video duration (each lipsync scene uses veed_fabric_1.0 at 25 cr/seg; backgrounds add more). For a 3-scene 9:16 video without backgrounds at ~30s total = roughly 750 credits; with backgrounds enabled add 30-100 cr per scene. A 60s multi-scene piece can reach 2000+ cr. Always confirm with the user before proceeding and surface get_credits_balance first.

REQUIRES TEXT BUDGET TOO. This flow internally calls Followr's TTS endpoint (ElevenLabs via Followr) for each scene's audio, which consumes ai_text_budget words on top of the image/video credits. When generate_backgrounds=true the per-scene visual prompt derivation also runs through Followr's chat AI (more words). If get_ai_budget shows ai_text_budget.total === 0 (plan does not include the text/audio module) or ai_text_budget.remaining <= 0 (cycle exhausted), this tool will fail with HTTP 402 entity="words" at the audio step BEFORE generating any video. get_session_context._assistant_guidance.plan_capability_warnings already surfaces this gate at orient time; honor that warning AND, per Rule 21 of the system prompt, NEVER silently downgrade to a no-voice alternative (generate_ai_video_clip) without surfacing the trade-off to the user first.

PRECONDITION: company_id + avatar_id required. The avatar MUST have a voice and an image attached. Verify with get_avatar before calling.

VISUAL OPTIONS:
- generate_backgrounds=true (recommended for polished output): each scene gets a unique image-to-image background that depicts the avatar in a context matching the script. This mirrors Followr's UI default and produces the "real" avatar video look. Adds ~30-100 credits per scene + 30-60s latency.
- generate_backgrounds=false (default, faster + cheaper): every scene uses the avatar's portrait directly as the lipsync image. Talking head with a static background. Faster + cheaper but less polished.

LATENCY: typically 3-5 minutes without backgrounds, 5-15 minutes with. Async by default (see above) so latency does not block the agent's transport. timeout_seconds only applies when wait:true is passed.

SUBTITLES: burned in by default with Followr's default style (Montserrat 700, 9.29 vmin font size, white text + #0095a6 highlight color, dark stroke, highlight effect, 14 char max per line, positioned at 82% from top). Override via subtitle_* params.

SCENE ANIMATIONS: optional camera animation per scene via scene_animation. 'zoom_in' adds a gradual 100%->110% scale across each scene (subtle parallax feel). Mirrors Followr UI Scene Animations toggle.

SCENE TRANSITIONS: optional transition between scenes via scene_transition. 'slide_left' makes each new scene slide in from the right (1 second). First scene never has a transition (no previous scene). Mirrors Followr UI Scene Transitions toggle.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        avatar_id: z.number().int().positive().describe("Avatar with voice + image attached."),
        scripts: z.array(z.string().min(1).max(500)).min(1).max(10).describe("One script per scene. 1 to 10 scenes. Typical 80-150 chars each. May include ElevenLabs emotion tags like [excited] [confident] [whispers] [pause]. Each script becomes one scene in the final video."),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional().describe("9:16 (vertical, default, for Reels/Shorts/TikTok) or 16:9 (landscape). Default 9:16."),
        audio_speed: z.number().min(0.5).max(2.0).optional().describe("TTS speed applied to every scene. Default 1.0."),
        generate_backgrounds: z.boolean().optional().describe("If true, generate a unique image-to-image background per scene (using the avatar as visual reference) instead of reusing the avatar portrait. Mirrors Followr UI default. Adds latency and credits. Default false."),
        background_style: z.string().optional().describe("Optional visual style hint for generated backgrounds, applied to every scene. Examples: 'modern content studio', 'outdoor adventurous', 'minimalist office', 'cinematic moody'. Ignored when generate_backgrounds is false."),
        outfit_description: z.string().optional().describe("Optional precise description of the clothing the avatar must wear in EVERY scene. Injected into the background-prompt chat so the AI does not reinterpret the outfit based on script context. Use for fashion brands, product showcases, or any reel where the avatar's look must stay consistent (e.g. 'gray bomber jacket with black collar, white tee, dark jeans'). Without this, the AI defers to the avatar's portrait and may drift between scenes. Ignored when generate_backgrounds is false."),
        reference_image_urls: z.array(z.string().url()).max(5).optional().describe("Optional URLs of additional reference images applied to EVERY scene's background generation. Use to show a product, logo, or wardrobe item the avatar should hold or wear. Combined with the avatar portrait as visual anchors in image-to-image mode (so the avatar stays visually consistent while incorporating the references). Examples: a product photo, a brand logo, a uniform. Up to 5 images. Ignored when generate_backgrounds is false."),
        scene_reference_images: z.record(z.string().regex(/^\d+$/), z.array(z.string().url()).max(5)).optional().describe("Optional per-scene override of reference_image_urls. Map keys are scene indices as strings ('0', '1', '2', ...); values are arrays of URLs. When a scene index is present here, those URLs REPLACE reference_image_urls for that scene. Use to show different products per scene (e.g. scene 0 holds a handbag, scene 1 holds a mug with logo). Ignored when generate_backgrounds is false."),
        scene_animation: z.enum([
          "none",
          "zoom_in",
          "zoom_out",
          "pan_left",
          "pan_right",
          "pan_up",
          "pan_down",
        ]).optional().describe(`Optional per-scene camera animation applied to every scene's video. Mirrors the 'Scene Animations' selector in Followr UI > Avatar Video Creator > Step 3. Pick the one that matches the scene's mood:

- 'none' (default): static camera, no movement. Use for talking-head clips, formal/educational content, or when subtitles need maximum readability.
- 'zoom_in': camera slowly pushes in toward the subject across the scene (100% -> 110%). Adds intimacy and intensity; great for emotional hooks, product reveals, dramatic statements.
- 'zoom_out': camera slowly pulls back (110% -> 100%). Adds context and openness; great for closing scenes, summary statements, "big picture" framing.
- 'pan_left' / 'pan_right': horizontal camera drift (subtle ~10% sweep). Adds cinematic motion; great for storytelling beats and keeping the eye moving on long talking-head scenes.
- 'pan_up' / 'pan_down': vertical camera drift. 'pan_up' often feels uplifting (good for inspiring conclusions); 'pan_down' feels grounding.

Shape detail: each animation is encoded as an element-scoped block inside the video's 'animations' array in the Creatomate render_script. 'zoom_*' uses type=scale with start_scale/end_scale; 'pan_*' uses type=pan with start_x/end_x/start_y/end_y coords. Shapes empirically verified for zoom_in and pan_left; directional siblings (zoom_out, pan_right/up/down) derived by coordinate swap of the verified pattern.`),
        scene_transition: z.enum([
          "none",
          "slide_left",
          "slide_right",
          "slide_up",
          "slide_down",
          "wipe_left",
          "wipe_right",
        ]).optional().describe(`Optional transition effect between consecutive scenes. Mirrors the 'Scene Transitions' selector in Followr UI > Avatar Video Creator > Step 3. Applied to scenes 2 onwards (first scene never has a transition since there's no previous scene). Duration is fixed 1 second.

- 'none' (default): hard cut between scenes. Clean and punchy; works for fast-paced content and when you want zero distraction.
- 'slide_left' / 'slide_right': new scene slides in from one side. Slide Left = enters from the right edge. Slide Right = enters from the left edge. Modern, social-feed feel; widely used for Reels/Shorts.
- 'slide_up' / 'slide_down': vertical slide. 'slide_up' (enters from below) feels like turning a page or revealing the next idea. 'slide_down' is less common.
- 'wipe_left' / 'wipe_right': a sweeping reveal that wipes over the previous scene (more graphic, less physical than slide). Use for clean topic changes or section breaks.

Shape detail: each transition is encoded as a video-element-scoped block inside the 'animations' array with transition=true. 'slide_*' uses type=slide with direction in degrees (180° = from right = Slide Left; 0°/90°/270° = right/up/down inferred). 'wipe_*' uses type=wipe with x_anchor percentage. Shapes empirically verified for slide_left and wipe_left; siblings derived by symmetric inference. Other Followr transitions (Scale, Flip, Rotate Slide, Spin, Circular Wipe, Color Wipe, Squash) have unique shapes per type and are NOT exposed yet. Each needs its own empirical pass before being safely wired up.`),
        subtitle_text_color: z.string().optional().describe("Hex color for subtitle text. Default #ffffff (white)."),
        subtitle_highlight_color: z.string().optional().describe("Hex color for the active highlighted word. Default #0095a6 (Followr brand teal)."),
        subtitle_max_chars: z.number().int().min(8).max(40).optional().describe("Max characters shown at once in subtitles. Default 14."),
        subtitle_font: z.string().optional().describe("Font family. Default Montserrat. Other supported (per Followr UI): Inter, Poppins, Roboto, Open Sans, Playfair Display, Bebas Neue."),
        timeout_seconds: z.number().int().positive().max(2400).optional().describe("Max seconds for the entire pipeline. Default 1500 (25 min). Bumped from 900 in v0.5.0 to cover the realistic worst case of 10 scenes with backgrounds. Only relevant when wait=true; in async mode the pipeline runs to completion regardless (the timeout is hit only inside per-job waits)."),
        wait: z
          .boolean()
          .optional()
          .describe(
            "If false (DEFAULT as of v0.5.0): returns immediately with a pipeline_id and an ETA; the video keeps generating in the background. Use get_avatar_video_pipeline_status / wait_for_avatar_video_pipeline to track. This is the safe default for clients with WebSocket transport timeouts (claude.ai cuts at ~4 min, avatar videos can take 5-15 min). If true: blocks until the pipeline completes (legacy v0.4.x behavior). Use wait=true only for clients that tolerate long-running tool calls (CLI / IDE plugins).",
          ),
      },
    },
    async ({
      company_id,
      avatar_id,
      scripts,
      aspect_ratio,
      audio_speed,
      generate_backgrounds,
      background_style,
      outfit_description,
      reference_image_urls,
      scene_reference_images,
      scene_animation,
      scene_transition,
      subtitle_text_color,
      subtitle_highlight_color,
      subtitle_max_chars,
      subtitle_font,
      timeout_seconds,
      wait,
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
        const pipelineParams: AvatarVideoPipelineParams = {
          company_id,
          avatar,
          scripts,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(audio_speed !== undefined ? { audio_speed } : {}),
          ...(generate_backgrounds !== undefined ? { generate_backgrounds } : {}),
          ...(background_style !== undefined ? { background_style } : {}),
          ...(outfit_description !== undefined ? { outfit_description } : {}),
          ...(reference_image_urls !== undefined ? { reference_image_urls } : {}),
          ...(scene_reference_images !== undefined ? { scene_reference_images } : {}),
          ...(scene_animation !== undefined ? { scene_animation } : {}),
          ...(scene_transition !== undefined ? { scene_transition } : {}),
          ...(subtitle_text_color !== undefined ? { subtitle_text_color } : {}),
          ...(subtitle_highlight_color !== undefined ? { subtitle_highlight_color } : {}),
          ...(subtitle_max_chars !== undefined ? { subtitle_max_chars } : {}),
          ...(subtitle_font !== undefined ? { subtitle_font } : {}),
          ...(timeout_seconds !== undefined ? { timeout_seconds } : {}),
        };

        // === Sync mode (legacy opt-in via wait: true) =====================
        // Same shape as the v0.4.x return. Use for clients without WebSocket
        // transport timeouts (CLI / IDE plugins). NOT recommended on
        // claude.ai because it cuts the transport at ~4 min and avatar
        // videos take 3-15 min.
        if (wait === true) {
          const result = await executeAvatarVideoPipeline(client, pipelineParams);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    avatar_id,
                    avatar_name: result.avatar.name,
                    scene_count: scripts.length,
                    aspect_ratio: result.aspect_ratio,
                    backgrounds_generated: result.backgroundsGenerated,
                    background_ai_result_ids: result.backgroundAiResultIds,
                    lipsync_image_urls: result.lipsyncImageUrls,
                    scene_animation: scene_animation ?? "none",
                    scene_transition: scene_transition ?? "none",
                    audio_ai_result_ids: result.audioFinals.map((a) => a.id),
                    lipsync_ai_result_ids: result.videoFinals.map((v) => v.id),
                    individual_lipsync_urls: result.lipsyncUrls,
                    final_video: sanitizeAiResult(result.finalVideo),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // === Async mode (DEFAULT as of v0.5.0) ============================
        // Create a PipelineState row, fire the executor as a background
        // task, and return the pipeline_id + ETA immediately. The agent
        // polls via get_avatar_video_pipeline_status (instant) or
        // wait_for_avatar_video_pipeline (bounded poll up to 180s).
        const estimate = estimateAvatarVideoSeconds(
          scripts.length,
          generate_backgrounds === true,
        );
        const pipeline = createPipeline({
          kind: "avatar_video",
          company_id,
          params: {
            avatar_id,
            avatar_name: avatar.name,
            scripts,
            aspect_ratio: aspect_ratio ?? "9:16",
            generate_backgrounds: generate_backgrounds === true,
          },
          estimated_total_seconds: estimate,
          initial_sub_phase: "queued",
          initial_progress: { completed: 0, total: scripts.length },
        });
        const pipelineId = pipeline.pipeline_id;

        // Fire-and-forget runner. Uses setImmediate to escape the current
        // tool-call event loop tick so the tool return is not blocked by
        // any synchronous overhead in the executor. Errors are captured
        // into the pipeline state; nothing is thrown out of the IIFE.
        setImmediate(() => {
          void (async () => {
            try {
              updatePipelinePhase(pipelineId, {
                phase: "running",
                sub_phase: "starting",
              });
              const result = await executeAvatarVideoPipeline(
                client,
                pipelineParams,
                {
                  onPhase: (info) => {
                    updatePipelinePhase(pipelineId, {
                      sub_phase: info.sub_phase,
                      ...(info.progress !== undefined ? { progress: info.progress } : {}),
                      ...(info.estimated_remaining_seconds !== undefined
                        ? { estimated_remaining_seconds: info.estimated_remaining_seconds }
                        : {}),
                    });
                  },
                  onSubJobs: (patch) => recordPipelineSubJobs(pipelineId, patch),
                  checkCancelled: (sub_phase) => {
                    if (isCancellationRequested(pipelineId)) {
                      throw new PipelineCancelledException(sub_phase);
                    }
                  },
                },
              );
              markPipelineCompleted(pipelineId, {
                ai_result_id: result.finalVideo.id,
                ...(result.finalVideo.response ? { asset_url: result.finalVideo.response } : {}),
                metadata: {
                  avatar_id,
                  avatar_name: result.avatar.name,
                  scene_count: scripts.length,
                  aspect_ratio: result.aspect_ratio,
                  backgrounds_generated: result.backgroundsGenerated,
                  background_ai_result_ids: result.backgroundAiResultIds,
                  lipsync_image_urls: result.lipsyncImageUrls,
                  audio_ai_result_ids: result.audioFinals.map((a) => a.id),
                  lipsync_ai_result_ids: result.videoFinals.map((v) => v.id),
                  individual_lipsync_urls: result.lipsyncUrls,
                },
              });
            } catch (err) {
              if (err instanceof PipelineCancelledException) {
                markPipelineCancelled(pipelineId);
                return;
              }
              if (err instanceof PipelineFailedException) {
                markPipelineFailed(pipelineId, {
                  sub_phase: err.sub_phase,
                  reason: err.sub_phase,
                  user_message: err.user_message,
                  details: err.details,
                });
                return;
              }
              markPipelineFailed(pipelineId, {
                sub_phase: "unknown",
                reason: err instanceof Error ? err.name : "Error",
                user_message: `Pipeline failed with an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          })();
        });

        const minMinutes = Math.max(1, Math.round(estimate / 60));
        const maxMinutes = Math.max(minMinutes + 1, Math.round((estimate * 1.5) / 60));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pipeline_id: pipelineId,
                  kind: "avatar_video",
                  company_id,
                  avatar_id,
                  avatar_name: avatar.name,
                  scene_count: scripts.length,
                  aspect_ratio: aspect_ratio ?? "9:16",
                  estimated_seconds: estimate,
                  user_facing_summary: `Empecé tu reel multi-escena (${scripts.length} scene${scripts.length === 1 ? "" : "s"}). Va a tardar entre ${minMinutes} y ${maxMinutes} minutos. Decime "fijate" cuando quieras chequear, o "esperá" si querés que pollée hasta 3 min sin freezar la conversación.`,
                  _assistant_guidance: {
                    next_step: "tell_user_eta_then_wait_for_status_request",
                    conversational_flow:
                      "1. Decile al user el user_facing_summary (tal cual o reformulado en castellano natural, lo mismo dará). 2. NO mencionés pipeline_id, ai_result_ids ni nada interno (son internos del MCP). 3. Cuando el user pregunte 'fijate' / 'ya está?' / 'cómo va', llamá get_avatar_video_pipeline_status(pipeline_id) (instantáneo) y traducí la phase a castellano humano (e.g. lipsync -> 'rendereando los videos del avatar', concat -> 'uniendo las escenas con subtítulos'). 4. Cuando el user diga 'esperá' / 'quédate ahí', llamá wait_for_avatar_video_pipeline(pipeline_id, max_wait_seconds=180) (hasta 3 min de polleo interno; suficiente bajo cualquier transport). 5. NUNCA prometas 'te aviso cuando termine'. claude.ai no soporta push notifications de MCP; el user siempre tiene que pedir el status. 6. Si el pipeline falla, surface el failure.user_message y preguntá si reintenta (sin auto-reintentar, evita gastar créditos).",
                  },
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

  // Tool: generate_ai_video_clip.
  // Text-to-video (and optionally image-to-video) single short clip via
  // Followr's AI Videos catalog: Veo 3 family, Wan 2, SeeDance, Hailuo.
  // Distinct from the avatar tools: NO avatar, NO lipsync, NO subtitles, NO
  // concat. One single 8-second clip per call (length is decided by the
  // model itself, not an input). For multi-scene / longer / talking-head
  // content, the agent should use generate_avatar_video instead.
  //
  // Catalog is hardcoded because the backend does not yet expose a models
  // listing endpoint (see docs/followr-api/_gaps.md). When that lands, swap
  // the enum for a free string and add a list_ai_video_models tool.
  // Model IDs match Followr's canonical format (verified empirically against
  // /api/aiResults responses 2026-05-20). Followr uses dots for major.minor
  // (veo_3.1_fast, wan_2.2, seedance_1.1_*, seedance_2.0_*) and no separator
  // for some (hailuo_02_*). Older underscore variants like veo_3_1_fast do
  // NOT exist in Followr and trigger HTTP 422 "selected model is invalid".
  const AI_VIDEO_MODEL_ENUM = [
    "veo_3.1_fast",
    "veo_3_fast",
    "veo_3.1",
    "veo_3",
    "wan_2.2",
    "seedance_1.1_light",
    "seedance_1.1_pro",
    "seedance_2.0_fast",
    "seedance_2.0",
    "hailuo_02_standard",
    "hailuo_02_premium",
  ] as const;

  server.registerTool(
    "generate_ai_video_clip",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate a single short AI video clip (no avatar, no lipsync)",
      description: `Generate a single short AI video clip via Followr's AI Videos catalog (Veo, Wan, SeeDance, Hailuo). Wraps POST /api/aiResults/video for text-to-video, and image-to-video on models that support image_url.

WHAT THIS IS: one single video clip, no avatar speaking, no subtitles, no scene concatenation. The model itself decides the clip length (around 8 seconds for the recommended Veo 3 family). Per-call output is one clip.

WHAT THIS IS NOT:
- NOT a multi-scene avatar reel. For that use generate_avatar_video (flexible duration, subtitles, concat handled internally).
- NOT a talking head with lipsync. For that use generate_avatar_lipsync_clip or generate_avatar_video.
- NOT a way to stitch multiple clips. There is no built-in concat for AI video clips today; do not promise the user a longer assembled video. If the user needs >8s, propose generate_avatar_video.

COST MODEL (verified 2026-05-20): Followr charges PER SECOND of generated video, not per clip. Since Veo models produce ~8-second clips, multiply the per-second rate by 8 to estimate the cost per clip. Do NOT quote the per-second number to the user as if it were the total cost.

RECOMMENDED MODELS (all produce ~8-second clips, all require followr_plus_enabled=true):
- veo_3.1_fast (50 cr/seg = ~400 cr per 8s clip): cheapest of the recommended set. Use only for genuinely disposable content, internal tests, or quick idea checks.
- veo_3_fast (400 cr/seg = ~3200 cr per 8s clip): safer default for real social-media content. Good quality / cost balance.
- veo_3.1 (600 cr/seg = ~4800 cr per 8s clip): hero piece, launch promo, key shot. Better subject consistency and motion fidelity than veo_3_fast.

PLAN GATING: on accounts WITHOUT followr_plus_enabled the ONLY accepted video model is wan_2.2. Every other model in this enum (veo_*, seedance_*, hailuo_*) requires Followr Plus and the backend rejects them with HTTP 422 "selected model is invalid" on non-Plus accounts. Read followr_plus_enabled from get_ai_budget BEFORE picking a model and respect company ai_preferences.video_model if set (the SPA ensures the company's stored default is compatible with the plan).

ALSO AVAILABLE (the agent should NOT auto-pick these: surface them only if the user explicitly asks for a non-Veo model or a different cost point): veo_3 (1000 cr/seg = ~8000 cr per 8s clip, never use without explicit user authorization), wan_2.2 (150 cr/seg = ~1200, the only model accessible without Followr Plus), seedance_1.1_light (20 cr/seg = ~160), seedance_1.1_pro (40 cr/seg = ~320), seedance_2.0_fast (100 cr/seg = ~800), seedance_2.0 (175 cr/seg = ~1400), hailuo_02_standard (20 cr/seg = ~160), hailuo_02_premium (30 cr/seg = ~240). Empirical quality / behavior of non-Veo models is not yet documented per-model.

CHOOSING A MODEL: do NOT auto-pick the cheapest model to "validate" the prompt. If the result fails, you cannot tell whether the prompt or the model is at fault, and regenerating with a higher-quality model means paying twice. Instead, ASK the user about the quality bar before picking. If the user has no preference, default to veo_3_fast and surface the cost via get_credits_balance before calling. Never call veo_3 (~8000 cr per 8s clip) without explicit user authorization of the cost.

PROMPT DESIGN FOR ~8 SECONDS: each recommended model produces ONE clip of roughly 8 seconds. Write the prompt as a SINGLE visual scene with one action, NOT a narrative sequence.
- Good: "Close-up of a person typing on a laptop in a warm café, steam rising from coffee, static camera, golden-hour light, shallow depth of field, cinematic 35mm look."
- Bad: "Person enters café, sits down, opens laptop, sips coffee, starts typing" (that is a 20s sequence; the model will cram it and the result feels rushed).
Describe: subject, action, setting, lighting, camera framing, mood. Avoid scene cuts, beats, or chronological steps.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name. Cost is charged to the company's plan.

LATENCY: 2-15 minutes depending on the model. Default timeout 1200s (20 min). Set the user's expectation.

IMAGE-TO-VIDEO: image_url is OPTIONAL and takes EXACTLY ONE URL. Pass it to seed the clip with a reference frame (image-to-video mode). Empirical per-model support is not yet verified; if a model rejects image_url the call will fail and the agent should retry without it. Do not promise the user a specific reference-fidelity outcome.

NEVER HALLUCINATE MULTI-REFERENCE COMPOSITES: there is no composite mode for AI video. If the user asks for "a clip with all 4 colors of the hoodie" or "a video combining 3 products", the single image_url cannot anchor the missing items; the model will invent them. Refuse to plan that as a single AI clip and propose: (a) a carousel of images, one per item, on networks that accept it, (b) generate_avatar_video with multi-scene where each scene takes its own reference, or (c) restrict the clip to ONE item with its own reference. Surface the constraint to the user before generating; do not silently produce hallucinated frames.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        prompt: z.string().min(1).describe("Visual prompt describing the single scene to generate. Keep it focused on ONE moment / action / shot; these models render ~8 seconds of video. See PROMPT DESIGN FOR ~8 SECONDS in the tool description."),
        model: z.enum(AI_VIDEO_MODEL_ENUM).describe("AI video model. Cost is per SECOND of video; Veo clips are ~8s. Recommended on Followr Plus accounts: veo_3.1_fast (~400 cr per 8s clip), veo_3_fast (~3200), veo_3.1 (~4800). On accounts WITHOUT Followr Plus, only wan_2.2 is accepted; every other model returns 'selected model is invalid'. Confirm cost with the user before calling, especially for veo_3 (~8000)."),
        aspect_ratio: z.enum(["9:16", "16:9"]).optional().describe("Default 9:16 (vertical, for Reels/Shorts/TikTok). Use 16:9 for landscape (LinkedIn, YouTube long-form thumbnails)."),
        image_url: z.string().url().optional().describe("Optional reference frame for image-to-video mode. Per-model support varies; the call may fail on models that do not accept it."),
        driver: z.string().optional().describe("Optional driver override. Most callers should omit; the backend resolves the driver from the model."),
        queue: z.boolean().optional().describe("If true, run async via queue. Default true (matches SPA behavior)."),
        wait: z.boolean().optional().default(true).describe("If true (default), block until the clip is completed or failed. If false, return the pending result id for later polling via get_ai_result / wait_for_ai_result."),
        timeout_seconds: z.number().int().positive().max(1800).optional().describe("Max seconds to wait when wait=true. Default 1200 (20 min). Veo 3 / Sora-class models can take 10-15 min."),
      },
    },
    async ({ company_id, prompt, model, aspect_ratio, image_url, driver, queue, wait, timeout_seconds }) => {
      try {
        const prefs = await getAiPreferences(client, company_id);
        const resolvedDriver = resolveDriver({
          explicitDriver: driver,
          prefs,
          modality: "video",
          model,
        });
        const initial = await client.generateAiVideoClip({
          type: "video",
          q: prompt,
          company_id,
          aspect_ratio: aspect_ratio ?? "9:16",
          model,
          ...(resolvedDriver ? { driver: resolvedDriver } : {}),
          ...(image_url ? { image_url } : {}),
          ...(queue !== undefined ? { queue } : { queue: true }),
          chargeable: 1,
        });
        if (!wait || initial.status === "completed" || initial.status === "failed") {
          return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(initial), null, 2) }] };
        }
        const final = await client.waitForAiResult(initial.id, {
          timeoutMs: (timeout_seconds ?? 1200) * 1000,
        });
        return { content: [{ type: "text", text: JSON.stringify(sanitizeAiResult(final), null, 2) }] };
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

RECOVERY AFTER A TIMEOUT: when a generate_* tool times out from the client side but the backend keeps producing the result, pass created_after with the ISO timestamp from RIGHT BEFORE the generate call. That narrows the list to only jobs your call kicked off, so you can recover the result_id without guessing which row is yours (avoids picking up unrelated concurrent jobs in shared workspaces).

INCLUDE: for images pass include="images,images.thumbnail" (PLURAL); for videos include="videos,videos.thumbnail". The base resource doesn't always hydrate file fields without an explicit include. NOTE: the API rejects the singular form "image,image.thumbnail" with HTTP 400; use plural even when filtering type=image.

Sorted newest first by default.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        type: z
          .enum(["chat", "image", "audio", "video"])
          .optional()
          .describe("Filter by generation type. Omit for all types."),
        model: z.string().optional().describe("Filter by exact model id. Useful for Viral Shorts (creatomate_short)."),
        include: z.string().optional().describe("Comma-separated includes. e.g. 'images,images.thumbnail' for images (plural even for type=image), 'videos,videos.thumbnail' for videos. Singular 'image,image.thumbnail' is REJECTED by the API."),
        page_size: z.number().int().positive().max(100).optional(),
        sort: z.string().optional().describe("Default -created_at."),
        created_after: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "ISO-8601 timestamp. Returns only results created at-or-after this moment. Use to scope recovery queries to a single call: capture `new Date().toISOString()` BEFORE invoking a generate_* tool, then filter with that timestamp if you need to recover after a timeout. The server-side filter is best-effort (filter[created_at_gte]); a client-side fallback enforces the cutoff in case the backend ignores it.",
          ),
      },
    },
    async ({ company_id, type, model, include, page_size, sort, created_after }) => {
      const results = await client.listAiResults({
        companyId: company_id,
        ...(type ? { type } : {}),
        ...(model ? { model } : {}),
        ...(include ? { include } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
        ...(sort ? { sort } : {}),
        ...(created_after ? { createdAfterIso: created_after } : {}),
      });
      // Client-side enforcement: if the backend silently ignored the
      // filter[created_at_gte] param (it's not in the published spec, we
      // discovered it empirically), drop rows older than the cutoff here.
      const filtered = created_after
        ? results.filter((r) => {
            if (!r.created_at) return true;
            return new Date(r.created_at).getTime() >= new Date(created_after).getTime();
          })
        : results;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filtered.map(sanitizeAiResult), null, 2),
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
