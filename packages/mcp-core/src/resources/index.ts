import { FollowrClient } from "@followr-mcp/shared";
import type { Company } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RegisterOptions } from "../index.js";

function sanitizeCompany(c: Company): Omit<Company, "ai_keys" | "webhook_secret"> & {
  webhook_secret_present: boolean;
  ai_keys_configured_providers: string[];
} {
  const { ai_keys, webhook_secret, ...safe } = c;
  return {
    ...safe,
    webhook_secret_present: Boolean(webhook_secret),
    ai_keys_configured_providers: (ai_keys ?? []).map((k) => k.provider),
  };
}

// 30-day window centered on "now": 7 days back to 23 days forward.
function defaultCalendarRange(): { from: string; to: string } {
  const now = Date.now();
  const from = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now + 23 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

export function registerFollowrResources(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerResource(
    "companies",
    "followr://companies",
    {
      title: "Companies catalog",
      description:
        "Catalog of Followr companies (companies) accessible to the current API token. Returns id, name, type, language, and timezone metadata. Read this once at session start to anchor which companies exist.",
      mimeType: "application/json",
    },
    async (uri) => {
      const companies = await client.listCompanies();
      const slim = companies.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        language: c.language,
        country_iso_code: c.country_iso_code,
        created_at: c.created_at,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(slim, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "post-group",
    new ResourceTemplate("followr://post-group/{id}", { list: undefined }),
    {
      title: "Hydrated PostGroup",
      description:
        "Read a single PostGroup with all its posts, asset URLs (image and video thumbnails), tags, and creator. Use as a stable reference document instead of repeatedly calling get_post_group.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawId = Array.isArray(variables["id"]) ? variables["id"][0] : variables["id"];
      const postGroupId = Number(rawId);
      if (!Number.isInteger(postGroupId) || postGroupId <= 0) {
        throw new Error(`Invalid post-group id in URI ${uri.href}: ${rawId}`);
      }
      const group = await client.getPostGroup(postGroupId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(group, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "calendar",
    new ResourceTemplate("followr://company/{id}/calendar", {
      list: async () => {
        const companies = await client.listCompanies();
        return {
          resources: companies.map((c) => ({
            uri: `followr://company/${c.id}/calendar`,
            name: `Calendar for ${c.name}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Company calendar (next 30 days)",
      description:
        "Read the scheduled posts of a company in a default window from 7 days ago to 23 days from now. For a custom date range, use the list_scheduled tool with explicit from_iso / to_iso instead.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawId = Array.isArray(variables["id"]) ? variables["id"][0] : variables["id"];
      const companyId = Number(rawId);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        throw new Error(`Invalid company id in URI ${uri.href}: ${rawId}`);
      }
      const { from, to } = defaultCalendarRange();
      const groups = await client.listCompanyPostGroups(companyId, {
        draft: false,
        publishAtAfter: from,
        publishAtBefore: to,
        sort: "publish_at",
        pageSize: 100,
        include: "tags,posts",
      });
      const items = groups.map((g) => ({
        id: g.id,
        title: g.title,
        publish_at: g.publish_at,
        networks: (g.posts ?? []).map((p) => p.social_network_type),
        tags: (g.tags ?? []).map((t) => t.name),
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ company_id: companyId, window: { from, to }, items }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "brand",
    new ResourceTemplate("followr://company/{id}/brand", {
      list: async () => {
        const companies = await client.listCompanies();
        return {
          resources: companies.map((c) => ({
            uri: `followr://company/${c.id}/brand`,
            name: `Brand voice for ${c.name}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Company brand voice and audience settings",
      description:
        "Read the brand-related fields of a company: per-network brand voice prompts, AI preferences (driver/model defaults), audience ages/genders/types, tones, palettes, and language type. Use to anchor copy and image generation to the brand's voice.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawId = Array.isArray(variables["id"]) ? variables["id"][0] : variables["id"];
      const companyId = Number(rawId);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        throw new Error(`Invalid company id in URI ${uri.href}: ${rawId}`);
      }
      const company = await client.getCompany(companyId);
      const safe = sanitizeCompany(company);
      const brand = {
        id: safe.id,
        name: safe.name,
        language: safe.language,
        language_iso_code: safe.language_iso_code,
        description: safe.description,
        website: safe.website,
        ai_preferences: safe.ai_preferences,
        ai_image_styles: safe.ai_image_styles,
        audience_ages: safe.audience_ages,
        audience_genders: safe.audience_genders,
        audience_types: safe.audience_types,
        interests: safe.interests,
        language_types: safe.language_types,
        palettes: safe.palettes,
        tones: safe.tones,
        syntaxes: safe.syntaxes,
        fonts: safe.fonts,
        emotions: safe.emotions,
        characters: safe.characters,
        social_network_prompts: safe.social_network_prompts,
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(brand, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "avatars",
    new ResourceTemplate("followr://company/{id}/avatars", {
      list: async () => {
        const companies = await client.listCompanies();
        return {
          resources: companies.map((c) => ({
            uri: `followr://company/${c.id}/avatars`,
            name: `Avatars for ${c.name}`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Avatars catalog for a company",
      description:
        "Read the avatar catalog of a company, hydrated with image, voice (with audio sample), and scenes. Use to pick an avatar before generate_avatar_video.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const rawId = Array.isArray(variables["id"]) ? variables["id"][0] : variables["id"];
      const companyId = Number(rawId);
      if (!Number.isInteger(companyId) || companyId <= 0) {
        throw new Error(`Invalid company id in URI ${uri.href}: ${rawId}`);
      }
      const avatars = await client.listAvatars(companyId);
      const slim = avatars.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        default: a.default,
        voice_id: a.voice_id,
        image_url: a.image?.url,
        voice_name: a.voice?.name,
        voice_platform: a.voice?.platform,
        scenes_count: a.scenes?.length ?? 0,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(slim, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "voices-elevenlabs",
    "followr://voices/elevenlabs",
    {
      title: "ElevenLabs voice catalog (first page)",
      description:
        "Read the first page (30 voices) of the ElevenLabs catalog with rich metadata (language, gender, age, accent, use_case, preview_url). For server-side filtering by language/gender/category, use the list_elevenlabs_voices tool instead.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await client.listElevenlabsVoices();
      const voices = result.data ?? [];
      const slim = voices.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        language: v.language,
        gender: v.gender,
        age: v.age,
        accent: v.accent,
        category: v.category,
        description: v.description,
        use_case: v.use_case,
        preview_url: v.preview_url,
        featured: v.featured,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(slim, null, 2),
          },
        ],
      };
    },
  );
}
