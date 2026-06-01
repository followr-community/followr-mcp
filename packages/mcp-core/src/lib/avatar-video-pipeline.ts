// Avatar video pipeline executor.
//
// Extracted from tools/ai-results.ts so it can be invoked from two paths:
//   - Inline / sync mode (generate_avatar_video with wait=true): the tool
//     handler calls this directly, awaits the result, and returns the final
//     video to the agent in the same tool call.
//   - Background / async mode (generate_avatar_video with wait=false,
//     DEFAULT as of v0.5.0): the tool handler creates a PipelineState and
//     schedules this executor as a fire-and-forget background task. The
//     agent polls the pipeline state to track progress.
//
// The executor is identical in both modes; what differs is what the handler
// does with the result. Phase boundaries report progress via the optional
// `hooks.onPhase` callback so the async runner can mutate PipelineState.
// `hooks.checkCancelled` is called between phases so user-requested
// cancellation interrupts the flow without aborting in-flight backend jobs
// (those run to completion on Followr; we just stop orchestrating).

import type { AiResult, Avatar, FollowrClient } from "@followr-mcp/shared";

import { probeMp4Duration } from "./mp4-probe.js";
import { PipelineFailedException } from "./pipeline-exceptions.js";

// Re-export so callers that imported the exceptions from this file (legacy
// v0.5.0) keep compiling. Canonical location is lib/pipeline-exceptions.ts.
export { PipelineCancelledException, PipelineFailedException } from "./pipeline-exceptions.js";

// ── Public types ───────────────────────────────────────────────────────────

export type SceneAnimation =
  | "none"
  | "zoom_in"
  | "zoom_out"
  | "pan_left"
  | "pan_right"
  | "pan_up"
  | "pan_down";

export type SceneTransition =
  | "none"
  | "slide_left"
  | "slide_right"
  | "slide_up"
  | "slide_down"
  | "wipe_left"
  | "wipe_right";

export interface AvatarVideoPipelineParams {
  company_id: number;
  // Avatar must be pre-fetched and validated (has voice + image) by the
  // caller. The executor assumes both fields are present.
  avatar: Avatar;
  scripts: string[];
  aspect_ratio?: "16:9" | "9:16";
  audio_speed?: number;
  generate_backgrounds?: boolean;
  background_style?: string;
  outfit_description?: string;
  reference_image_urls?: string[];
  scene_reference_images?: Record<string, string[]>;
  scene_animation?: SceneAnimation;
  scene_transition?: SceneTransition;
  subtitle_text_color?: string;
  subtitle_highlight_color?: string;
  subtitle_max_chars?: number;
  subtitle_font?: string;
  // Hard cap on the whole pipeline. Per-job timeout is derived as
  // max(60_000, total/4). Default 1500s (25 min) when omitted; covers
  // the realistic worst case of 10 scenes with backgrounds.
  timeout_seconds?: number;
}

export interface PhaseProgress {
  completed: number;
  total: number;
}

export interface AvatarVideoPipelineHooks {
  // Called at every phase boundary with a free-form sub_phase label,
  // optional progress, and optional ETA in seconds. Async runner uses
  // these to mutate PipelineState. Sync mode can ignore.
  onPhase?: (info: {
    sub_phase: string;
    progress?: PhaseProgress | null;
    estimated_remaining_seconds?: number | null;
  }) => void;
  // Called when sub-job ai_result_ids are first known. Useful so the
  // pipeline state records durable ids even if the runner crashes later.
  onSubJobs?: (patch: Record<string, number | number[]>) => void;
  // Called at safe interruption points. Must throw PipelineCancelledException
  // when cancellation has been requested. No-op when undefined.
  checkCancelled?: (sub_phase: string) => void;
}

export interface AvatarVideoPipelineResult {
  avatar: Avatar;
  aspect_ratio: "9:16" | "16:9";
  backgroundsGenerated: boolean;
  backgroundAiResultIds: number[];
  audioFinals: AiResult[];
  videoFinals: AiResult[];
  lipsyncImageUrls: string[];
  lipsyncUrls: string[];
  finalVideo: AiResult;
}

// ── Estimator ──────────────────────────────────────────────────────────────

// Approximate wall-clock seconds the pipeline will take, used for ETA
// estimates surfaced to the user and for initial pipeline state. Rough
// numbers based on observed Followr backend latencies (May 2026):
//   - TTS via ElevenLabs tts_3: ~10-20s per scene in parallel = ~20s total
//   - Lipsync via veed_fabric_1.0: 60-120s per scene in parallel,
//     dominated by GPU contention. ~120s base + ~15s per extra scene.
//   - Concat via Creatomate: ~30-60s
//   - Backgrounds (optional): ~60-120s for chat prompt derivation + image
//     gen per scene in parallel. ~90s typical.
export function estimateAvatarVideoSeconds(
  sceneCount: number,
  withBackgrounds: boolean,
): number {
  const base = 180; // TTS + lipsync + concat realistic floor
  const bg = withBackgrounds ? 90 : 0;
  const sceneFactor = Math.max(0, (sceneCount - 3) * 15);
  return base + bg + sceneFactor;
}

// ── Internals ──────────────────────────────────────────────────────────────

// Per-scene duration FALLBACK from script length. ElevenLabs tts_3 reads
// roughly 0.06-0.07s per character; add a 0.5s buffer for natural pauses.
// This is ONLY a fallback for when probeMp4Duration can't read the real
// lipsync video duration (network failure, malformed mp4, server doesn't
// honor Range). The primary path uses the probed real duration of each
// lipsync mp4, which is the only way to avoid the truncation that made
// every scene end "cortada" in the PipeLime 2026-05-28 session. The
// estimator understates length whenever a script has multiple sentences
// (punctuation pauses), longer voices, or slower speech rates, and any
// understate sends Creatomate to cut the video before the avatar finishes
// the last word.
function estimateSceneDuration(script: string): number {
  return Math.min(30, Math.max(2, script.length * 0.07 + 0.5));
}

function buildAnimationsArray(
  sceneIndex: number,
  sceneDuration: number,
  scene_animation: SceneAnimation | undefined,
  scene_transition: SceneTransition | undefined,
): Array<Record<string, unknown>> {
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
  if (scene_transition && scene_transition !== "none" && sceneIndex > 0) {
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
  return animations;
}

// ── Executor ───────────────────────────────────────────────────────────────

export async function executeAvatarVideoPipeline(
  client: FollowrClient,
  params: AvatarVideoPipelineParams,
  hooks: AvatarVideoPipelineHooks = {},
): Promise<AvatarVideoPipelineResult> {
  const {
    company_id,
    avatar,
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
  } = params;

  const voicePlatformId = avatar.voice?.platform_external_id;
  const avatarImageUrl = avatar.image?.url;
  if (!voicePlatformId || !avatarImageUrl) {
    // This should have been validated upstream; defensive throw here.
    throw new PipelineFailedException(
      "validation",
      "Avatar is missing voice or image. Validate before invoking the pipeline.",
      { avatar_id: avatar.id },
    );
  }

  const totalTimeoutMs = (timeout_seconds ?? 1500) * 1000;
  const perJobTimeoutMs = Math.max(60_000, Math.floor(totalTimeoutMs / 4));
  const finalAspectRatio: "9:16" | "16:9" = aspect_ratio ?? "9:16";

  // === Phase 0 (optional): per-scene background generation. ===
  hooks.checkCancelled?.("backgrounds");
  let lipsyncImageUrls: string[] = scripts.map(() => avatarImageUrl);
  let backgroundAiResultIds: number[] = [];
  let imageFinals: AiResult[] = [];
  if (generate_backgrounds) {
    hooks.onPhase?.({
      sub_phase: `backgrounds (0/${scripts.length})`,
      progress: { completed: 0, total: scripts.length },
    });
    const styleHint = background_style ? ` Style hint: ${background_style}.` : "";
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
    hooks.onSubJobs?.({ background_prompt_chat: chatInitial.id });
    const chatFinal = await client.waitForAiResult(chatInitial.id, {
      timeoutMs: Math.max(60_000, Math.floor(perJobTimeoutMs / 2)),
    });
    if (chatFinal.status !== "completed" || !chatFinal.response) {
      throw new PipelineFailedException(
        "backgrounds",
        `Chat call to derive scene visual prompts failed (status=${chatFinal.status})${chatFinal.status_message ? `: ${chatFinal.status_message}` : ""}. You can retry with generate_backgrounds=false to skip this step and use the avatar's portrait as the background for every scene.`,
        { ai_result_id: chatFinal.id, status: chatFinal.status },
      );
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
      // Fallback: generic per-script prompts so the flow still works
      // even if the chat returned malformed output. Quality is lower
      // but the user still gets a finished video.
      imagePrompts = scripts.map(
        (s) =>
          `Professional photograph of the on-camera character in a scene matching this script: "${s.slice(0, 200)}". Portrait orientation, visible from waist up, soft cinematic lighting.${styleHint}`,
      );
    }
    hooks.checkCancelled?.("backgrounds");
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
    hooks.onSubJobs?.({ background_images: imageInitials.map((i) => i.id) });
    imageFinals = await Promise.all(
      imageInitials.map((init) =>
        client.waitForAiResult(init.id, { timeoutMs: perJobTimeoutMs }),
      ),
    );
    const failedImageIdx = imageFinals.findIndex(
      (img) => img.status !== "completed" || !img.response,
    );
    if (failedImageIdx >= 0) {
      const failed = imageFinals[failedImageIdx]!;
      throw new PipelineFailedException(
        "backgrounds",
        `Background image for scene ${failedImageIdx + 1} of ${scripts.length} failed (status=${failed.status})${failed.status_message ? `: ${failed.status_message}` : ""}. Retry with generate_backgrounds=false to skip the per-scene background step and use the avatar's portrait for all scenes.`,
        {
          failed_scene_index: failedImageIdx,
          ai_result_id: failed.id,
          status: failed.status,
          status_message: failed.status_message ?? null,
        },
      );
    }
    lipsyncImageUrls = imageFinals.map((img) => img.response!);
    backgroundAiResultIds = imageFinals.map((img) => img.id);
  }

  // === Phase 1: TTS audio per scene (parallel submit + parallel wait). ===
  hooks.checkCancelled?.("tts");
  hooks.onPhase?.({
    sub_phase: `tts (0/${scripts.length})`,
    progress: { completed: 0, total: scripts.length },
  });
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
  hooks.onSubJobs?.({ audio: audioInitials.map((a) => a.id) });
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
    throw new PipelineFailedException(
      "tts",
      `Audio for scene ${failedAudioIdx + 1} of ${scripts.length} failed (status=${failed.status})${failed.status_message ? `: ${failed.status_message}` : ""}.`,
      {
        failed_scene_index: failedAudioIdx,
        failed_script: scripts[failedAudioIdx] ?? null,
        ai_result_id: failed.id,
        status: failed.status,
        status_message: failed.status_message ?? null,
      },
    );
  }
  const audioUrls = audioFinals.map((a) => a.response!);

  // === Phase 2: Lipsync render per scene (parallel). HARDCODE model. ===
  hooks.checkCancelled?.("lipsync");
  hooks.onPhase?.({
    sub_phase: `lipsync (0/${scripts.length})`,
    progress: { completed: 0, total: scripts.length },
  });
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
  hooks.onSubJobs?.({ lipsync: videoInitials.map((v) => v.id) });
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
    throw new PipelineFailedException(
      "lipsync",
      `Lipsync for scene ${failedVideoIdx + 1} of ${scripts.length} failed (status=${failed.status})${failed.status_message ? `: ${failed.status_message}` : ""}. Audio jobs already completed successfully; you can retry the lipsync step or fall back to generate_avatar_lipsync_clip per scene.`,
      {
        failed_scene_index: failedVideoIdx,
        ai_result_id: failed.id,
        status: failed.status,
        audio_urls: audioUrls,
      },
    );
  }
  const lipsyncUrls = videoFinals.map((v) => v.response!);

  // === Phase 2.5: Probe REAL lipsync mp4 durations. ===
  // The old code used estimateSceneDuration(script.length * 0.07 + 0.5) for
  // both the video element's `duration` and the cumulative `time`. When the
  // estimate undershot the real audio (which happened on most multi-sentence
  // scripts because ElevenLabs adds ~0.3-0.5s pause per period), Creatomate
  // cut the video at the estimated mark and the avatar's last word was
  // chopped off. Every scene ended "cortada".
  //
  // Fix: probe each lipsync mp4's moov.mvhd via Range request and use the
  // real duration in render_script. If probing fails (network, malformed
  // file, server doesn't honor Range), fall back to the estimate so the
  // pipeline still ships. See lib/mp4-probe.ts and the PipeLime 2026-05-28
  // session for the trigger.
  hooks.checkCancelled?.("probing_durations");
  hooks.onPhase?.({
    sub_phase: `probing_durations (0/${lipsyncUrls.length})`,
    progress: { completed: 0, total: lipsyncUrls.length },
  });
  let probedCompleted = 0;
  const sceneRealDurations = await Promise.all(
    lipsyncUrls.map(async (url, i) => {
      const probed = await probeMp4Duration(url).catch(() => null);
      probedCompleted += 1;
      hooks.onPhase?.({
        sub_phase: `probing_durations (${probedCompleted}/${lipsyncUrls.length})`,
        progress: { completed: probedCompleted, total: lipsyncUrls.length },
      });
      return probed ?? estimateSceneDuration(scripts[i]!);
    }),
  );

  // === Phase 3: Build Creatomate render_script and submit concat. ===
  // Shape verified empirically 2026-05-19 (sesión 7) and corrected
  // 2026-05-27 after discovering the multi-scene defect. For each scene
  // we emit two elements: a video (lipsync clip) and a text overlay
  // (subtitles via transcript_source linking by id). Tracks alternate:
  // scene 0 = tracks 1+2, scene 1 = tracks 3+4, ... which stacks elements
  // in z-order, NOT in time. Sequential playback REQUIRES explicit `time`
  // and `duration` per element, computed cumulatively from the real probed
  // duration of each lipsync clip. Without them all scenes start at t=0 and
  // their audio tracks mix on top of each other. Empirical shape reference:
  // docs/followr-api/avatars.md:800.
  hooks.checkCancelled?.("concat");
  hooks.onPhase?.({
    sub_phase: "concat (assembling final video)",
    progress: null,
  });
  const isPortrait = finalAspectRatio === "9:16";
  const renderWidth = isPortrait ? 768 : 1376;
  const renderHeight = isPortrait ? 1376 : 768;

  const elements: Array<Record<string, unknown>> = [];
  let cumulativeTime = 0;
  lipsyncUrls.forEach((url, i) => {
    const videoId = `video-scene-${i + 1}`;
    // Use each lipsync clip's EXACT probed duration for both the element
    // duration and the cumulative scene placement, mirroring Creatomate's own
    // `duration: "media"` default (match the source length). We used to pad
    // +0.25s here on the belief that Creatomate freezes the last frame past
    // the source end. It does NOT: there is no hold-last-frame feature (loop
    // defaults to false, no freeze property) and the veed_fabric mp4s carry no
    // alpha, so every padded tail rendered as ~0.25s of BLACK and showed up as
    // a flash between scenes. The probe already returns the full clip length
    // (the original "cortada" anti-truncation fix), so dropping the pad keeps
    // every word intact and removes the black gap. Reported 2026-06-01.
    const sceneDuration = sceneRealDurations[i]!;
    const sceneTime = cumulativeTime;
    const animations = buildAnimationsArray(i, sceneDuration, scene_animation, scene_transition);
    elements.push({
      type: "video",
      id: videoId,
      source: url,
      time: sceneTime,
      duration: sceneDuration,
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
      time: sceneTime,
      duration: sceneDuration,
      track: i * 2 + 2,
    });
    cumulativeTime += sceneDuration;
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
  hooks.onSubJobs?.({ concat: concatInitial.id });
  const concatFinal = await client.waitForAiResult(concatInitial.id, {
    timeoutMs: perJobTimeoutMs,
  });
  if (concatFinal.status !== "completed" || !concatFinal.response) {
    throw new PipelineFailedException(
      "concat",
      `Final video concat failed (status=${concatFinal.status})${concatFinal.status_message ? `: ${concatFinal.status_message}` : ""}. Individual lipsync clips were generated successfully (URLs in details). You can either retry the concat by calling this tool again with the same scripts (lipsyncs will regenerate, costing credits) or build a final video manually from the individual URLs.`,
      {
        concat_ai_result_id: concatFinal.id,
        status: concatFinal.status,
        scene_count: scripts.length,
        individual_lipsync_urls: lipsyncUrls,
      },
    );
  }

  return {
    avatar,
    aspect_ratio: finalAspectRatio,
    backgroundsGenerated: generate_backgrounds === true,
    backgroundAiResultIds,
    audioFinals,
    videoFinals,
    lipsyncImageUrls,
    lipsyncUrls,
    finalVideo: concatFinal,
  };
}
