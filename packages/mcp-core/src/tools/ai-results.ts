import { FollowrClient } from "@followr-mcp/shared";
import type { AiResult, Avatar } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

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
      title: "Generate text with Followr AI (chat completion)",
      description:
        "Generate text using Followr's AI text endpoint. Use this for any prompt-based text task: brainstorm ideas, draft copy, rewrite in a different tone, translate, suggest hashtags, summarize an article. The caller passes an arbitrary prompt. Default driver is openai with gpt-4.1-mini; override via the model and driver params if a different LLM is preferred. By default this tool blocks until the result is completed (set wait=false to return immediately with a pending id).",
      inputSchema: {
        company_id: z.number().int().positive().describe("The Followr company id (workspace)."),
        prompt: z.string().min(1).describe("The full prompt to send to the model."),
        driver: z.string().optional().describe("Optional provider override. Visto: openai, anthropic, deepseek. Default uses the workspace's text_driver."),
        model: z.string().optional().describe("Optional model override. e.g. gpt-4.1-mini, claude-sonnet-4-5, deepseek-chat. Default uses the workspace's text_model."),
        queue: z.boolean().optional().describe("If true, run async via queue. Default true (matches SPA behavior)."),
        wait: z.boolean().optional().default(true).describe("If true (default), poll until the result is completed or failed and return the final result. If false, return the initial pending result."),
        timeout_seconds: z.number().int().positive().max(600).optional().describe("Max seconds to wait for completion when wait=true. Default 300."),
      },
    },
    async ({ company_id, prompt, driver, model, queue, wait, timeout_seconds }) => {
      const initial = await client.generateChat({
        q: prompt,
        company_id,
        ...(driver ? { driver } : {}),
        ...(model ? { model } : {}),
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
    "generate_image",
    {
      title: "Generate an image with Followr AI",
      description:
        "Generate an image using Followr's AI image endpoint. Supports image-to-image consistency via image_url (use this to keep a subject consistent across multiple generations, e.g. avatar scenes). Default driver fal with model nano_banana_2; override for Recraft, OpenAI DALL-E, etc. Costs around 25 credits per image. Returns the completed result including image_url when wait=true (default).",
      inputSchema: {
        company_id: z.number().int().positive(),
        prompt: z.string().min(1).describe("Visual prompt describing the desired image."),
        aspect_ratio: z
          .enum(["1:1", "9:16", "16:9", "4:5"])
          .optional()
          .describe("Output aspect ratio. 1:1 square (default), 9:16 vertical/story, 16:9 horizontal, 4:5 portrait."),
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
      const initial = await client.generateImage({
        q: prompt,
        company_id,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(image_url ? { image_url } : {}),
        ...(image_urls?.length ? { image_urls } : {}),
        ...(n ? { n } : {}),
        ...(driver ? { driver } : {}),
        ...(model ? { model } : {}),
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
    "generate_audio",
    {
      title: "Generate TTS audio with Followr AI",
      description:
        "Generate text-to-speech audio. Requires a voice identifier (use list_voices to find the platform_external_id of a workspace voice, or list_elevenlabs_voices for ElevenLabs voice_ids). Use this to narrate scripts, create podcast snippets, or pre-generate audio for avatar videos. Returns the completed result including audio_url when wait=true.",
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
        ...(driver ? { driver } : {}),
        ...(model ? { model } : {}),
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
      title: "Generate a lipsync video using an existing avatar",
      description:
        "Workflow tool that produces a single avatar lipsync video clip. Steps internally: 1) fetch the avatar's voice and image, 2) generate TTS audio for the script using the avatar's voice, 3) wait for audio completion, 4) generate the lipsync video. Heavy operation: 775 credits Regular, 930 Fast. Pre-existing avatar required (use list_avatars or create_avatar_full_flow first). For multi-scene videos, call this once per scene.",
      inputSchema: {
        company_id: z.number().int().positive(),
        avatar_id: z.number().int().positive().describe("The avatar to use (must have a voice and image already set)."),
        script: z.string().min(1).describe("Text the avatar will say in this scene. Typical 100-150 chars."),
        aspect_ratio: z.enum(["9:16", "16:9", "1:1"]).optional().describe("Default 9:16 (viral short)."),
        driver: z.string().optional().describe("Default fal."),
        model: z.string().optional().describe("Lipsync model id (provider-specific)."),
        audio_speed: z.number().min(0.5).max(2.0).optional().describe("TTS speed. Default 1.0."),
        timeout_seconds: z.number().int().positive().max(900).optional().describe("Max seconds for video to complete. Default 600."),
      },
    },
    async ({ company_id, avatar_id, script, aspect_ratio, driver, model, audio_speed, timeout_seconds }) => {
      const avatar: Avatar = await client.getAvatar(avatar_id, {
        include: "image,voice,voice.audio",
      });
      const voicePlatformId = avatar.voice?.platform_external_id;
      const imageUrl = avatar.image?.url;
      if (!voicePlatformId) {
        throw new Error(
          `Avatar ${avatar_id} has no voice.platform_external_id. Assign a voice before generating videos.`,
        );
      }
      if (!imageUrl) {
        throw new Error(
          `Avatar ${avatar_id} has no image.url. Attach an image (via create_avatar_full_flow) first.`,
        );
      }
      // Generate TTS audio with avatar's voice.
      const audioInitial = await client.generateAudio({
        q: script,
        company_id,
        type: "audio",
        voice: voicePlatformId,
        ...(audio_speed !== undefined ? { speed: audio_speed } : {}),
        ...(driver ? { driver } : {}),
        ...(model ? { model } : {}),
      });
      const audioFinal = await client.waitForAiResult(audioInitial.id, {
        timeoutMs: (timeout_seconds ?? 600) * 1000,
      });
      if (audioFinal.status !== "completed" || !audioFinal.audio_url) {
        throw new Error(
          `Audio generation failed for avatar ${avatar_id}: status=${audioFinal.status} message=${audioFinal.status_message ?? "(none)"}`,
        );
      }
      // Generate lipsync video.
      const videoInitial = await client.generateVideo({
        type: "video",
        q: script,
        audio_url: audioFinal.audio_url,
        image_url: imageUrl,
        aspect_ratio: aspect_ratio ?? "9:16",
        driver: driver ?? "fal",
        model: model ?? "veed/lipsync-1",
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
                video: sanitizeAiResult(videoFinal),
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
    "list_ai_results",
    {
      title: "List past AI generations in a workspace",
      description:
        "List previously generated AI results in a workspace, filtered by type and optionally by model. Use this to recover prior generations and reference their URLs without paying credits to regenerate. Sorted newest first by default.",
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
      title: "Get a single AI result by id (no polling)",
      description:
        "Fetch a single aiResult by id. Use this for a cheap status check on an async job. For automatic polling until terminal state, use wait_for_ai_result instead.",
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
      title: "Wait for an AI result to complete (polling helper)",
      description:
        "Poll an aiResult by id until its status is terminal (completed or failed) or the timeout elapses. Use when you have an id from a previous generate_* call with wait=false and want to block until done.",
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
