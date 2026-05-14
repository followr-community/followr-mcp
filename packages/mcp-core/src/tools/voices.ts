import { FollowrClient } from "@followr-mcp/shared";
import type { ElevenLabsVoice, Voice } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

// Strip BYOK/secret fields if the API embedded `company` via include chain.
function sanitizeVoice(voice: Voice): Voice {
  const v = voice as Voice & {
    company?: { ai_keys?: unknown; webhook_secret?: unknown; [k: string]: unknown };
  };
  if (v.company) {
    const { ai_keys: _ak, webhook_secret: _ws, ...safeCompany } = v.company;
    v.company = safeCompany;
  }
  return v;
}

export function registerVoiceTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_voices",
    {
      title: "List voices in a workspace",
      description:
        "List voice profiles already created in a Followr workspace. Each voice is linked to a TTS provider (typically ElevenLabs) and can be assigned to an avatar or used directly for audio generation. Use this before generate_audio or create_avatar_full_flow to discover available voices.",
      inputSchema: {
        company_id: z.number().int().positive(),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, page_size }) => {
      const voices = await client.listVoices(company_id, {
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              voices.map((v) => ({
                id: v.id,
                name: v.name,
                language_code: v.language_code,
                platform: v.platform,
                platform_external_id: v.platform_external_id,
                accent: v.accent,
                description: v.description,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_voice",
    {
      title: "Get a single voice with its audio sample",
      description:
        "Fetch one voice by id, with the audio sample hydrated. Use this to confirm a freshly created voice has its sample uploaded, or to retrieve the audio preview URL.",
      inputSchema: {
        voice_id: z.number().int().positive(),
      },
    },
    async ({ voice_id }) => {
      const voice = await client.getVoice(voice_id);
      return { content: [{ type: "text", text: JSON.stringify(sanitizeVoice(voice), null, 2) }] };
    },
  );

  server.registerTool(
    "list_elevenlabs_voices",
    {
      title: "Browse the ElevenLabs voice catalog with optional filters",
      description:
        "Returns a page of voices from the ElevenLabs catalog with rich metadata (language, gender, age, accent, use_case, preview_url, social handles). Supports client-side filtering by language, gender, category, and free-text query against name and description. Use this to pick a voice_id before calling create_voice_from_elevenlabs.",
      inputSchema: {
        page: z.number().int().positive().optional().describe("API page number. 30 voices per page. Default 1."),
        language: z.string().optional().describe("Filter by ISO 639-1 code (en, es, pt, fr, etc.)."),
        gender: z.enum(["male", "female", "non-binary"]).optional(),
        category: z.string().optional().describe("e.g. professional, casual."),
        query: z.string().optional().describe("Substring match against name or description (case-insensitive)."),
        featured_only: z.boolean().optional().describe("If true, only return voices marked featured."),
      },
    },
    async ({ page, language, gender, category, query, featured_only }) => {
      const all = await client.listElevenlabsVoices({ ...(page ? { page } : {}) });
      const q = query?.toLowerCase();
      const filtered = all.filter((v: ElevenLabsVoice) => {
        if (language && v.language !== language) return false;
        if (gender && v.gender !== gender) return false;
        if (category && v.category !== category) return false;
        if (featured_only && !v.featured) return false;
        if (q) {
          const hay = `${v.name ?? ""} ${v.description ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const slim = filtered.map((v: ElevenLabsVoice) => ({
        voice_id: v.voice_id,
        name: v.name,
        language: v.language,
        locale: v.locale,
        gender: v.gender,
        age: v.age,
        accent: v.accent,
        category: v.category,
        description: v.description,
        use_case: v.use_case,
        preview_url: v.preview_url,
        featured: v.featured,
      }));
      return { content: [{ type: "text", text: JSON.stringify(slim, null, 2) }] };
    },
  );

  server.registerTool(
    "create_voice_from_elevenlabs",
    {
      title: "Create a Followr voice linked to an ElevenLabs voice",
      description:
        "Create a Voice resource in the workspace that wraps an ElevenLabs voice_id. Required: name, language_code (ISO 639-1), elevenlabs_voice_id (from list_elevenlabs_voices). The voice is usable immediately for generate_audio and create_avatar_full_flow even though the optional audio sample upload is not part of this tool (voice.audio will be null until manually uploaded). Cannot be undone via the MCP (voice resource persists).",
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1).max(50).describe("Human-readable voice name."),
        language_code: z.string().min(2).max(5).describe("ISO 639-1 code, e.g. en, es, pt, fr."),
        elevenlabs_voice_id: z.string().min(1).describe("ElevenLabs voice_id from list_elevenlabs_voices."),
        accent: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ company_id, name, language_code, elevenlabs_voice_id, accent, description }) => {
      const voice = await client.createVoice(company_id, {
        name,
        language_code,
        platform: "elevenlabs",
        platform_external_id: elevenlabs_voice_id,
        ...(accent !== undefined ? { accent } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(sanitizeVoice(voice), null, 2) }] };
    },
  );
}
