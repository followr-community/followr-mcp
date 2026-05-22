import { FollowrClient } from "@followr-mcp/shared";
import type { AiResult, Avatar } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import { resolveDriver } from "../lib/driver-resolver.js";
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
        const resolvedModel = model ?? prefs.image_model ?? "nano_banana_2";
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

USE THIS WHEN: the user wants a quick single-scene clip without subtitles or multi-scene concatenation. For the standard "AI Video Avatars" multi-scene flow with burned-in subtitles, use generate_avatar_video instead.

CRITICAL: heavy operation. Cost is per SECOND of generated video (model veed_fabric_1.0 = 25 cr/seg). A typical lipsync clip is ~10-15 seconds = roughly 250-400 credits. Call get_credits_balance before to confirm the user has budget.

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
      title: "Generate a full multi-scene avatar video with burned-in subtitles (reel, short, TikTok video, talking-head explainer, promo, ad)",
      description: `Compound workflow that produces a complete multi-scene avatar video, mirroring Followr's "AI Video Avatars" UI flow. Internally:

1. (Optional, when generate_backgrounds=true) For each scene: generate a unique image-to-image background that depicts the avatar in a scene matching the script context. Backgrounds are derived from a chat call that turns the scripts into visual prompts.
2. For each scene script (in parallel): generate TTS audio with the avatar's voice.
3. For each scene (in parallel): generate avatar lipsync video using audio + per-scene background (or avatar portrait directly when backgrounds are disabled).
4. Wait for lipsync jobs.
5. Concat all lipsync clips into one MP4 with burned-in subtitles via Creatomate (driver=creatomate, model=creatomate_video).

USE THIS WHEN: the user wants a real avatar video like the one Followr UI produces from Avatar Video Creator (multi-scene, with subtitles, ready to publish to Reels/Shorts/TikTok). This is the flagship video tool of Followr.

FLEXIBLE DURATION: total length is the sum of TTS audio across scenes (1 to 10 scenes per call). Typical: 3 scenes of ~10s of speech each = ~30-60s total; a 5-scene LinkedIn piece can reach 1-2 min. There is NO fixed duration cap from the tool. Use this whenever the user needs content longer than 8 seconds or any narrative / scripted-speech video.

WHEN TO USE THE OTHER VIDEO TOOLS INSTEAD:
- Single talking head, one scene, no subtitles: use generate_avatar_lipsync_clip.
- Single 8-second visual clip WITHOUT a talking avatar (product motion, lifestyle moment, scenic loop): use generate_ai_video_clip.
- The user already has footage they want to publish: skip generation, use upload_video_from_url.

OUTFIT PRESERVATION: when the avatar portrait shows a specific outfit that must appear in EVERY scene (fashion brand reels, product showcase with the avatar wearing the brand, lifestyle reels for a recurring look), pass outfit_description with a precise text of the clothing (e.g. "gray bomber jacket with black collar, white tee, dark jeans"). Without this, the AI may interpret clothing differently per scene based on script context (e.g. a "beach" script may put the avatar in swimwear even if the portrait shows winter wear).

CRITICAL: heavy operation. Cost is per SECOND of total video duration (each lipsync scene uses veed_fabric_1.0 at 25 cr/seg; backgrounds add more). For a 3-scene 9:16 video without backgrounds at ~30s total = roughly 750 credits; with backgrounds enabled add 30-100 cr per scene. A 60s multi-scene piece can reach 2000+ cr. Always confirm with the user before proceeding and surface get_credits_balance first.

PRECONDITION: company_id + avatar_id required. The avatar MUST have a voice and an image attached. Verify with get_avatar before calling.

VISUAL OPTIONS:
- generate_backgrounds=true (recommended for polished output): each scene gets a unique image-to-image background that depicts the avatar in a context matching the script. This mirrors Followr's UI default and produces the "real" avatar video look. Adds ~30-100 credits per scene + 30-60s latency.
- generate_backgrounds=false (default, faster + cheaper): every scene uses the avatar's portrait directly as the lipsync image. Talking head with a static background. Faster + cheaper but less polished.

LATENCY: typically 3-5 minutes without backgrounds, 5-8 minutes with. Configurable via timeout_seconds.

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
        timeout_seconds: z.number().int().positive().max(1200).optional().describe("Max seconds for the entire flow. Default 900 (15 min)."),
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

        // === Phase 0 (optional): per-scene background generation. ===
        // When generate_backgrounds=true: ask Followr's chat to turn each script
        // into an image prompt, then image-to-image gen per scene using the
        // avatar's portrait as the visual reference (image_url + image_urls).
        // The resulting URLs replace avatar.image.url as the lipsync image,
        // giving each scene its own contextual background while keeping the
        // avatar visually consistent. When false (default): every scene
        // reuses the avatar portrait directly (talking head).
        let lipsyncImageUrls: string[] = scripts.map(() => avatarImageUrl);
        let backgroundAiResultIds: number[] = [];
        if (generate_backgrounds) {
          const styleHint = background_style ? ` Style hint: ${background_style}.` : "";
          // Character description: prefer explicit outfit_description (precise,
          // takes precedence) over the avatar's stored description (looser).
          // Either of them is injected as a hard constraint into the chat
          // prompt so every scene's background respects the avatar's identity
          // and clothing, instead of letting the script context drift the look.
          const characterParts: string[] = [];
          if (avatar.description) {
            characterParts.push(`Character description: ${avatar.description}`);
          }
          if (outfit_description) {
            characterParts.push(
              `OUTFIT CONSTRAINT (every scene MUST preserve this exactly, do not change clothes between scenes even if the script implies a different setting): ${outfit_description}`,
            );
          }
          const characterHint = characterParts.length > 0 ? `\n\n${characterParts.join("\n")}` : "";
          const chatPrompt =
            `For each of the ${scripts.length} short on-camera video scripts below, write ONE image generation prompt. Each prompt must describe a scene matching its script's tone and content, with the on-camera character (the avatar) visible from waist up in a portrait composition. Keep each prompt under 200 words. Return ONLY a JSON array of ${scripts.length} strings, no other text, no markdown code fences.${styleHint}${characterHint}\n\nScripts: ${JSON.stringify(scripts)}`;
          const chatInitial = await client.generateChat({
            q: chatPrompt,
            company_id,
            chargeable: 1,
          });
          const chatFinal = await client.waitForAiResult(chatInitial.id, {
            timeoutMs: Math.max(60_000, Math.floor(perJobTimeoutMs / 2)),
          });
          if (chatFinal.status !== "completed" || !chatFinal.response) {
            return toolError({
              reason: "background_prompts_failed",
              user_message: `Chat call to derive scene visual prompts failed (status=${chatFinal.status})${chatFinal.status_message ? `: ${chatFinal.status_message}` : ""}. You can retry with generate_backgrounds=false to skip this step and use the avatar's portrait as the background for every scene.`,
              suggested_actions: [
                {
                  tool: "get_credits_balance",
                  rationale: "Check credit balance.",
                },
              ],
              details: { ai_result_id: chatFinal.id, status: chatFinal.status },
            });
          }
          let imagePrompts: string[];
          try {
            const cleaned = chatFinal.response
              .replace(/^\s*```(?:json)?\s*/m, "")
              .replace(/\s*```\s*$/m, "")
              .trim();
            const parsed: unknown = JSON.parse(cleaned);
            if (!Array.isArray(parsed) || parsed.length !== scripts.length) {
              throw new Error(
                `expected JSON array of ${scripts.length} strings, got ${Array.isArray(parsed) ? `${parsed.length} items` : typeof parsed}`,
              );
            }
            imagePrompts = parsed.map((p) => String(p));
          } catch {
            // Fallback: build generic per-script prompts so the flow still works
            // even if the chat model returned malformed output. Quality is lower
            // but the user still gets a finished video.
            imagePrompts = scripts.map(
              (s) =>
                `Professional photograph of the on-camera character in a scene matching this script: "${s.slice(0, 200)}". Portrait orientation, visible from waist up, soft cinematic lighting.${styleHint}`,
            );
          }
          // Image-to-image gen per scene. Hardcoded fal + nano_banana_2 (the
          // model Followr's UI uses for this step; image-to-image mode is
          // activated by passing image_url + image_urls with references).
          // Reference logic per scene:
          //   1. avatar portrait is always included as visual anchor.
          //   2. if scene_reference_images has an entry for this scene index,
          //      those URLs are appended (per-scene override).
          //   3. else if reference_image_urls is set, those are appended (global).
          // This lets the caller put a product / logo / outfit in some or all
          // scenes (e.g. scene 0 with a handbag, scene 1 with a mug+logo).
          const imageInitials = await Promise.all(
            imagePrompts.map((prompt, i) => {
              const perSceneRefs = scene_reference_images?.[String(i)];
              const sceneRefs = perSceneRefs ?? reference_image_urls ?? [];
              const imageUrls = [avatarImageUrl, ...sceneRefs];
              return client.generateImage({
                q: prompt,
                company_id,
                n: 1,
                chargeable: 1,
                aspect_ratio: finalAspectRatio,
                driver: "fal",
                model: "nano_banana_2",
                image_url: avatarImageUrl,
                image_urls: imageUrls,
                queue: true,
              });
            }),
          );
          const imageFinals = await Promise.all(
            imageInitials.map((init) =>
              client.waitForAiResult(init.id, { timeoutMs: perJobTimeoutMs }),
            ),
          );
          const failedImageIdx = imageFinals.findIndex(
            (img) => img.status !== "completed" || !img.response,
          );
          if (failedImageIdx >= 0) {
            const failed = imageFinals[failedImageIdx]!;
            return toolError({
              reason: "background_generation_failed",
              user_message: `Background image for scene ${failedImageIdx + 1} of ${scripts.length} failed (status=${failed.status})${failed.status_message ? `: ${failed.status_message}` : ""}. Retry with generate_backgrounds=false to skip the per-scene background step and use the avatar's portrait for all scenes.`,
              suggested_actions: [
                {
                  tool: "get_credits_balance",
                  rationale: "Check credit balance.",
                },
              ],
              details: {
                failed_scene_index: failedImageIdx,
                ai_result_id: failed.id,
                status: failed.status,
                status_message: failed.status_message ?? null,
              },
            });
          }
          lipsyncImageUrls = imageFinals.map((img) => img.response!);
          backgroundAiResultIds = imageFinals.map((img) => img.id);
        }

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
        // image_url is either the avatar portrait (default) or a per-scene
        // image-to-image background (when generate_backgrounds=true).
        const videoInitials = await Promise.all(
          scripts.map((script, i) =>
            client.generateVideo({
              type: "video",
              q: script,
              audio_url: audioUrls[i]!,
              image_url: lipsyncImageUrls[i]!,
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
        // Estimate per-scene duration from script length. ElevenLabs tts_3 reads
        // roughly 0.06-0.07s per character; add a small buffer for natural
        // pauses. Used to set the `duration` of the scale animation so it spans
        // the whole scene. If the estimate drifts, the animation ends slightly
        // before or after the lipsync ends but the video still composes cleanly.
        const estimateSceneDuration = (script: string): number => {
          return Math.min(30, Math.max(2, script.length * 0.07 + 0.5));
        };
        const elements: Array<Record<string, unknown>> = [];
        lipsyncUrls.forEach((url, i) => {
          const videoId = `video-scene-${i + 1}`;
          const sceneDuration = estimateSceneDuration(scripts[i]!);
          // Build the animations array per video element based on options.
          // Empirically verified shapes (2026-05-19, sesión 7):
          //   - zoom_in / zoom_out: type="scale", scope="element", with
          //     start_scale/end_scale percentages. easing="linear", fade=false.
          //   - pan_*: type="pan", scope="element", with start_x/start_y/end_x/end_y
          //     percentages. easing="linear".
          //   - slide_*: type="slide", transition=true, direction in degrees,
          //     time=0, duration=1.
          //   - wipe_*: type="wipe", transition=true, x_anchor percentage,
          //     easing="cubic-in-out", duration=1.
          //
          // Only zoom_in, pan_left, slide_left, wipe_left were verified by raw
          // capture; the other directional siblings are derived by swapping
          // coordinates (pan, zoom) or degrees (slide) on the verified pattern.
          // First scene never gets a transition (no previous scene to enter from).
          const animations: Array<Record<string, unknown>> = [];
          if (scene_animation && scene_animation !== "none") {
            if (scene_animation === "zoom_in") {
              animations.push({ type: "scale", scope: "element", start_scale: "100%", end_scale: "110%", easing: "linear", fade: false, time: 0, duration: sceneDuration });
            } else if (scene_animation === "zoom_out") {
              animations.push({ type: "scale", scope: "element", start_scale: "110%", end_scale: "100%", easing: "linear", fade: false, time: 0, duration: sceneDuration });
            } else if (scene_animation === "pan_left") {
              animations.push({ type: "pan", scope: "element", start_x: "55%", start_y: "50%", end_x: "45%", end_y: "50%", easing: "linear", time: 0, duration: sceneDuration });
            } else if (scene_animation === "pan_right") {
              animations.push({ type: "pan", scope: "element", start_x: "45%", start_y: "50%", end_x: "55%", end_y: "50%", easing: "linear", time: 0, duration: sceneDuration });
            } else if (scene_animation === "pan_up") {
              animations.push({ type: "pan", scope: "element", start_x: "50%", start_y: "55%", end_x: "50%", end_y: "45%", easing: "linear", time: 0, duration: sceneDuration });
            } else if (scene_animation === "pan_down") {
              animations.push({ type: "pan", scope: "element", start_x: "50%", start_y: "45%", end_x: "50%", end_y: "55%", easing: "linear", time: 0, duration: sceneDuration });
            }
          }
          if (scene_transition && scene_transition !== "none" && i > 0) {
            if (scene_transition === "slide_left") {
              animations.push({ type: "slide", transition: true, direction: "180°", time: 0, duration: 1 });
            } else if (scene_transition === "slide_right") {
              animations.push({ type: "slide", transition: true, direction: "0°", time: 0, duration: 1 });
            } else if (scene_transition === "slide_up") {
              animations.push({ type: "slide", transition: true, direction: "90°", time: 0, duration: 1 });
            } else if (scene_transition === "slide_down") {
              animations.push({ type: "slide", transition: true, direction: "270°", time: 0, duration: 1 });
            } else if (scene_transition === "wipe_left") {
              animations.push({ type: "wipe", transition: true, x_anchor: "100%", easing: "cubic-in-out", time: 0, duration: 1 });
            } else if (scene_transition === "wipe_right") {
              animations.push({ type: "wipe", transition: true, x_anchor: "0%", easing: "cubic-in-out", time: 0, duration: 1 });
            }
          }
          elements.push({
            type: "video",
            id: videoId,
            source: url,
            track: i * 2 + 1,
            ...(animations.length > 0 ? { animations } : {}),
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
                  backgrounds_generated: generate_backgrounds === true,
                  background_ai_result_ids: backgroundAiResultIds,
                  lipsync_image_urls: lipsyncImageUrls,
                  scene_animation: scene_animation ?? "none",
                  scene_transition: scene_transition ?? "none",
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
