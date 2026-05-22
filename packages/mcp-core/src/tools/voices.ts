import { FollowrClient } from "@followr-mcp/shared";
import type { ElevenLabsVoice, Voice } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION_OPEN_WORLD, READ_ONLY, READ_ONLY_EXTERNAL } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

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
      annotations: READ_ONLY,
      title: "List voices in a company",
      description: `List voice profiles already created in a Followr company. Each voice is linked to a TTS provider (typically ElevenLabs) and can be assigned to an avatar or used directly for audio generation.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE BEFORE: generate_audio, create_avatar_full_flow (which requires voice_id). If no suitable voice exists in the company, follow up with list_elevenlabs_voices + create_voice_from_elevenlabs.

PRESENTING: refer to voices by name, never by id.`,
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
      annotations: READ_ONLY,
      title: "Get a single voice with its audio sample",
      description: `Fetch one voice by id, with the audio sample hydrated.

USE FOR: confirming a freshly created voice has its sample uploaded; retrieving the audio preview URL for the user to listen and approve; inspecting a voice before assigning it to an avatar.`,
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
      annotations: READ_ONLY_EXTERNAL,
      title: "Browse the ElevenLabs voice catalog with rich filters and pagination",
      description: `Browse the ElevenLabs shared-voices catalog (12,404 voices globally) via Followr's proxy. Rich metadata per voice (language, locale, accent, gender, age, category, descriptive, use_case, preview_url). Auto-paginates server-side and returns a curated shortlist plus the universe of filter values that appeared in the batch.

NO COMPANY NEEDED. The output is used to pick an elevenlabs_voice_id to pass into create_voice_from_elevenlabs.

REGIONAL VOICE SEARCH PATTERN:
- For an Argentine Spanish voice: pass language='es' AND locale='es-AR' (the proxy paginates ~505 unique Argentine voices in the catalog). Some are tagged accent='argentine' (~58) and others accent='latin american' + locale='es-AR' (~447); both are geographically Argentine.
- For Mexican: language='es' + locale='es-MX'.
- For British: language='en' + locale='en-GB' (or accent='british').
- For American: language='en' + locale='en-US' (or accent='american').

SERVER-SIDE FILTERS (forwarded by Followr proxy, verified empirically 2026-05-20):
- language (ISO 639-1: en, es, pt, fr, it, de, ja, ko, zh, hi, ar, tr, nl, pl, ru, da)
- locale (es-AR, es-MX, es-ES, es-CO, en-US, en-GB, en-AU, en-IN, pt-BR, pt-PT, fr-CA, fr-FR, it-IT, de-DE, ja-JP, ko-KR, tr-TR, ru-RU, pl-PL, nl-BE, ar-EG, da-DK, hi-IN, cmn-CN)
- accent: argentine, latin american, mexican, peninsular, colombian, chilean, peruvian, venezuelan, andalusian (for es); american, british, australian, indian, scottish (for en). Best when combined with language.
- gender (male / female / non-binary)
- age (young / middle_aged)
- category (professional / high_quality)
- sort (trending / latest)
- search (loose substring match; matches name + description + accent + locale)
- featured_only (boolean, mapped to featured=1 server-side)
- min_notice_period_days (filter floor on the voice's notice period)

CLIENT-SIDE FILTERS (Followr proxy silently ignores these; applied locally after fetching):
- use_case (advertisement / characters_animation / conversational / entertainment_tv / informative_educational / narrative_story / social_media)
- descriptive (calm / confident / deep / warm / upbeat / professional / gentle / casual / mature / etc.)

PAGINATION: auto-paginates server-side using has_more (the meta.total field is misleading; do NOT trust it). Default max_pages=3 fetches up to ~300 voices per call. Increase max_pages for exhaustive searches.

PRESENTING TO USER: never dump 100+ voices to the user. Pick a shortlist of 5-10 best matches and include their preview_url so the user can actually listen before picking. Reference voices by NAME, never by voice_id.

KNOWN QUIRK: when accent + page>0 are combined, the next page falls back to mixed accents (proxy bug). Mitigation: use page_size=100 + filter accent strictly client-side at the dedupe step.`,
      inputSchema: {
        language: z.string().optional().describe("ISO 639-1 code. Server-side. The primary filter for narrowing by spoken language."),
        locale: z.string().optional().describe("Locale tag like es-AR (Argentine), en-US, pt-BR. Server-side. The most reliable regional filter via Followr proxy."),
        accent: z.string().optional().describe("Voice accent like argentine, mexican, british. Server-side; requires language context for coherent results. Many Argentine voices use accent='latin american' + locale='es-AR'; for full Argentine coverage prefer locale=es-AR over accent=argentine alone."),
        gender: z.enum(["male", "female", "non-binary"]).optional().describe("Server-side."),
        age: z.enum(["young", "middle_aged"]).optional().describe("Server-side."),
        category: z.enum(["professional", "high_quality"]).optional().describe("Server-side."),
        sort: z.enum(["trending", "latest"]).optional().describe("Server-side. Default trending."),
        search: z.string().optional().describe("Loose substring match against name/description/accent/locale. Server-side. E.g. 'argentina', 'buenos aires', 'rioplatense'."),
        featured_only: z.boolean().optional().describe("If true, only featured voices (mapped to featured=1 server-side). NOTE: the proxy returns 422 on featured=true; this tool sends featured=1 automatically."),
        min_notice_period_days: z.number().int().min(0).optional().describe("Filter floor. Only voices with notice_period >= N days."),
        use_case: z.enum(["advertisement", "characters_animation", "conversational", "entertainment_tv", "informative_educational", "narrative_story", "social_media"]).optional().describe("CLIENT-SIDE (proxy ignores). Applied locally after fetching."),
        descriptive: z.string().optional().describe("CLIENT-SIDE (proxy ignores). Applied locally after fetching. Values like calm, warm, deep, confident, etc."),
        page_size: z.number().int().min(1).max(100).optional().describe("Server page size, max 100. Default 100. Values >100 return 422."),
        max_pages: z.number().int().min(1).max(10).optional().describe("How many pages to paginate (each up to page_size voices). Default 3 (~300 voices). Higher for exhaustive searches like 'all Argentine voices' (~5 pages cover 500+ es-AR voices)."),
      },
    },
    async ({ language, locale, accent, gender, age, category, sort, search, featured_only, min_notice_period_days, use_case, descriptive, page_size, max_pages }) => {
      const pageSize = page_size ?? 100;
      const maxPages = max_pages ?? 3;
      const seenIds = new Set<string>();
      const allVoices: ElevenLabsVoice[] = [];
      let pagesConsumed = 0;
      let hadMore = false;
      for (let page = 0; page < maxPages; page++) {
        const result = await client.listElevenlabsVoices({
          page,
          page_size: pageSize,
          ...(language ? { language } : {}),
          ...(locale ? { locale } : {}),
          ...(accent ? { accent } : {}),
          ...(gender ? { gender } : {}),
          ...(age ? { age } : {}),
          ...(category ? { category } : {}),
          ...(sort ? { sort } : {}),
          ...(search ? { search } : {}),
          ...(featured_only ? { featured: 1 as const } : {}),
          ...(min_notice_period_days !== undefined ? { min_notice_period_days } : {}),
        });
        const voices = result.data ?? [];
        if (voices.length === 0) {
          hadMore = false;
          break;
        }
        for (const v of voices) {
          if (!seenIds.has(v.voice_id)) {
            seenIds.add(v.voice_id);
            allVoices.push(v);
          }
        }
        pagesConsumed = page + 1;
        hadMore = result.meta?.has_more === true;
        if (!hadMore) break;
      }
      // Client-side filters (proxy ignores these).
      let filtered = allVoices;
      if (use_case) filtered = filtered.filter((v) => v.use_case === use_case);
      if (descriptive) filtered = filtered.filter((v) => v.descriptive === descriptive);
      // Compute the universe of filter values that appeared in the batch.
      const uniq = (extract: (v: ElevenLabsVoice) => string | null | undefined): string[] =>
        [...new Set(filtered.map(extract).filter((x): x is string => typeof x === "string" && x.length > 0))].sort();
      const filterOptions = {
        accents: uniq((v) => v.accent),
        locales: uniq((v) => v.locale),
        languages: uniq((v) => v.language),
        use_cases: uniq((v) => v.use_case),
        categories: uniq((v) => v.category),
        descriptives: uniq((v) => v.descriptive),
        ages: uniq((v) => v.age),
        genders: uniq((v) => v.gender),
      };
      const slim = filtered.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        language: v.language,
        locale: v.locale,
        gender: v.gender,
        age: v.age,
        accent: v.accent,
        category: v.category,
        description: v.description,
        descriptive: v.descriptive,
        use_case: v.use_case,
        preview_url: v.preview_url,
        featured: v.featured,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                voices: slim,
                _filter_options_available_in_batch: filterOptions,
                _meta: {
                  fetched_total: allVoices.length,
                  after_client_side_filters: filtered.length,
                  pages_consumed: pagesConsumed,
                  had_more_at_end: hadMore,
                  note:
                    "_meta.total from the upstream is unreliable; we paginate by has_more. To widen the search, increase max_pages (up to 10). To narrow, combine language + locale + accent.",
                },
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
    "create_voice_from_elevenlabs",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Create a Followr voice linked to an ElevenLabs voice",
      description: `Create a Voice resource in the company that wraps an ElevenLabs voice_id. Required: name, language_code (ISO 639-1), elevenlabs_voice_id (from list_elevenlabs_voices).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name. Confirm the chosen ElevenLabs voice with the user verbatim (by name + language) before calling; voice mistakes mean future generate_audio calls produce content in the wrong voice.

PERSISTENCE: The voice is usable immediately for generate_audio and create_avatar_full_flow. The audio sample upload is not part of this tool (voice.audio will be null until manually uploaded via the Followr UI).

CLEANUP: if you create a voice by mistake or for one-off testing, call delete_voice with the returned voice_id to remove it.`,
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
      try {
        const voice = await client.createVoice(company_id, {
          name,
          language_code,
          platform: "elevenlabs",
          platform_external_id: elevenlabs_voice_id,
          ...(accent !== undefined ? { accent } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(sanitizeVoice(voice), null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_voice",
    {
      annotations: DESTRUCTIVE,
      title: "Delete a voice from a company (destructive)",
      description: `Permanently delete a Voice resource from a company. Cannot be undone via the API.

CRITICAL: Confirm with the user verbatim (by voice name and company name, not id) before calling.

SCOPE: removes the Voice from the company library. Avatars previously linked to this voice will lose the link (voice_id becomes null on those avatars). Future generate_audio or generate_avatar_video calls referencing this voice fail with a clear error.

ALTERNATIVE: if the user wants to swap voices on a specific avatar without deleting, use update_avatar with a new voice_id.`,
      inputSchema: {
        voice_id: z.number().int().positive(),
      },
    },
    async ({ voice_id }) => {
      try {
        await client.deleteVoice(voice_id);
        return { content: [{ type: "text", text: `Deleted voice ${voice_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
