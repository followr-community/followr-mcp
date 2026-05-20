// FollowrClient: thin HTTP client over Followr's REST API.
//
// Design notes:
// - All endpoints documented and verified empirically in /docs/followr-api/ (sessions 2026-05-13).
// - Quirks handled here so MCP tools don't have to:
//   - Real base URL is api.followr.ai, not app.followr.ai (spec lies)
//   - sort=-id required on /companies/{id}/postGroups
//   - GET /api/postGroups/{id}/posts returns 500, use include chain on parent
//   - asset URLs require include chain "posts.assets.image.thumbnail,..."
//   - tags_ids is REPLACE, not append (caller must merge)
// - fetch is wrapped in a closure so `this` binding survives in Cloudflare Workers.
//   See PostApprove RULE 7 in CLAUDE.md.

import { FollowrApiError, translateError } from "./errors.js";
import type {
  AiResult,
  ApiCollection,
  ApiSingle,
  Asset,
  Avatar,
  CanvaDesign,
  Company,
  Conversation,
  ElevenLabsVoice,
  ExternalUser,
  Folder,
  FollowrUser,
  Message,
  PostGroup,
  Prompt,
  RuleGroup,
  SubscriptionBalance,
  Tag,
  Voice,
} from "./types.js";

export interface FollowrClientOptions {
  /** API token from Followr Settings > API Keys. */
  token: string;
  /** Override base URL (default: https://api.followr.ai). Used for testing. */
  baseUrl?: string;
  /** Custom fetch impl (default: globalThis.fetch). Useful for tests/proxies. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.followr.ai";

type Query = Record<string, string | number | boolean | string[] | undefined>;

function buildQueryString(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      params.append(key, value.join(","));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class FollowrClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: FollowrClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const f = options.fetchImpl ?? globalThis.fetch;
    // Wrap in closure: fetch on Cloudflare Workers loses `this = globalThis` when called as method
    this.fetchImpl = (input, init) => f(input, init);
  }

  private async request<T>(
    method: string,
    path: string,
    options?: { query?: Query; body?: unknown },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQueryString(options?.query)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    let bodyInit: BodyInit | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(options.body);
    }
    const response = await this.fetchImpl(url, { method, headers, body: bodyInit });
    if (!response.ok) {
      const err = await FollowrApiError.fromResponse(response, url);
      err.message = translateError(err.message);
      throw err;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  // ──────────────────────────────────────────────────────────
  // Auth / user
  // ──────────────────────────────────────────────────────────

  /** GET /api/users/me. Returns the user that owns the current token. */
  async getMe(): Promise<FollowrUser> {
    const result = await this.request<ApiSingle<FollowrUser>>("GET", "/api/users/me");
    return result.data;
  }

  /**
   * GET /api/users?filter[companies.id]=X. Lists users with access to a workspace.
   * Filter is `companies.id` (relation), per session 6 convention check.
   */
  async listUsersInCompany(companyId: number, options?: { pageSize?: number }): Promise<FollowrUser[]> {
    const result = await this.request<ApiCollection<FollowrUser>>("GET", "/api/users", {
      query: {
        "filter[companies.id]": companyId,
        "page[size]": options?.pageSize ?? 30,
      },
    });
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Companies
  // ──────────────────────────────────────────────────────────

  async listCompanies(options?: { pageSize?: number; pageNumber?: number; query?: string }): Promise<Company[]> {
    const result = await this.request<ApiCollection<Company>>("GET", "/api/companies", {
      query: {
        "page[size]": options?.pageSize ?? 30,
        "page[number]": options?.pageNumber ?? 1,
        ...(options?.query ? { "filter[name]": options.query } : {}),
      },
    });
    return result.data;
  }

  async getCompany(companyId: number): Promise<Company> {
    const result = await this.request<ApiSingle<Company>>("GET", `/api/companies/${companyId}`);
    return result.data;
  }

  /** PUT /api/companies/{id} with merged field. Used for webhook_posts_url, ai_keys, menu_visibility, etc. */
  async updateCompany(companyId: number, patch: Partial<Company>): Promise<Company> {
    const result = await this.request<ApiSingle<Company>>("PUT", `/api/companies/${companyId}`, {
      body: patch,
    });
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Post Groups
  // ──────────────────────────────────────────────────────────

  /**
   * GET /api/companies/{id}/postGroups?sort=-id&...
   * `sort=-id` is REQUIRED in practice. Without it Followr returns the 30 oldest, which
   * is useless for almost any caller. Default kept here defensively.
   */
  async listCompanyPostGroups(
    companyId: number,
    options?: {
      sort?: string;
      pageSize?: number;
      pageNumber?: number;
      draft?: boolean;
      include?: string;
      publishAtAfter?: string;
      publishAtBefore?: string;
      publishAtNull?: boolean;
      socialNetworkTypes?: string[];
      ignoreTags?: string;
      hasRelation?: boolean;
      postsDescription?: string;
    },
  ): Promise<PostGroup[]> {
    const query: Query = {
      sort: options?.sort ?? "-id",
      "page[size]": options?.pageSize ?? 30,
      "page[number]": options?.pageNumber ?? 1,
    };
    if (options?.include) query["include"] = options.include;
    if (options?.draft !== undefined) query["filter[draft]"] = options.draft ? 1 : 0;
    if (options?.publishAtAfter) query["filter[publish_at_after]"] = options.publishAtAfter;
    if (options?.publishAtBefore) query["filter[publish_at_before]"] = options.publishAtBefore;
    if (options?.publishAtNull) query["filter[publish_at_null]"] = 1;
    if (options?.socialNetworkTypes?.length) {
      query["filter[posts.social_network_type]"] = options.socialNetworkTypes;
    }
    if (options?.ignoreTags !== undefined) query["filter[ignoreTags]"] = options.ignoreTags;
    if (options?.hasRelation !== undefined) query["filter[has_relation]"] = options.hasRelation ? 1 : 0;
    if (options?.postsDescription) query["filter[posts.description]"] = options.postsDescription;
    const result = await this.request<ApiCollection<PostGroup>>(
      "GET",
      `/api/companies/${companyId}/postGroups`,
      { query },
    );
    return result.data;
  }

  /** GET /api/postGroups/{id} with full include chain to hydrate assets. */
  async getPostGroup(postGroupId: number, options?: { include?: string }): Promise<PostGroup> {
    const include =
      options?.include ??
      "posts,posts.assets,posts.assets.image,posts.assets.image.thumbnail,posts.assets.video,posts.assets.video.thumbnail,tags,user,ruleGroup";
    const result = await this.request<ApiSingle<PostGroup>>("GET", `/api/postGroups/${postGroupId}`, {
      query: { include },
    });
    return result.data;
  }

  /** POST /api/companies/{id}/postGroups */
  /**
   * POST /api/companies/{companyId}/postGroups
   *
   * Verified empirically 2026-05-17: the create endpoint accepts `topic` and
   * `publish_at` directly in the body (no separate followup update needed).
   * Earlier versions of this client omitted those fields from the body type,
   * causing the tool MCP to silently drop them. Fixed.
   */
  async createPostGroup(
    companyId: number,
    body: {
      draft?: 0 | 1 | boolean;
      auto_publish?: 0 | 1 | boolean;
      title?: string;
      description?: string;
      topic?: string;
      publish_at?: string;
    },
  ): Promise<PostGroup> {
    const result = await this.request<ApiSingle<PostGroup>>(
      "POST",
      `/api/companies/${companyId}/postGroups`,
      { body },
    );
    return result.data;
  }

  /** PUT /api/postGroups/{id}. Caller must merge tags_ids (it's REPLACE, not append). */
  async updatePostGroup(postGroupId: number, patch: Partial<PostGroup> & { tags_ids?: number[] }): Promise<PostGroup> {
    const result = await this.request<ApiSingle<PostGroup>>("PUT", `/api/postGroups/${postGroupId}`, {
      body: patch,
    });
    return result.data;
  }

  /** DELETE /api/postGroups/{id} */
  async deletePostGroup(postGroupId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/postGroups/${postGroupId}`);
  }

  /** POST /api/postGroups/{id}/publish. Force-publish to a specific network now. */
  async publishPostGroup(postGroupId: number, socialNetworkType: string): Promise<unknown> {
    return this.request<unknown>("POST", `/api/postGroups/${postGroupId}/publish`, {
      body: { social_network_type: socialNetworkType },
    });
  }

  // ──────────────────────────────────────────────────────────
  // Posts (per-network within a PostGroup)
  // ──────────────────────────────────────────────────────────

  /** POST /api/postGroups/{id}/posts. Creates one post per social network. */
  async createPost(postGroupId: number, body: {
    social_network_type: string;
    description?: string;
    title?: string;
    assets_ids?: number[];
    preferences?: Record<string, unknown>;
    comments_to_create?: unknown[];
    link?: string;
  }): Promise<unknown> {
    return this.request<unknown>("POST", `/api/postGroups/${postGroupId}/posts`, { body });
  }

  // ──────────────────────────────────────────────────────────
  // Tags (CRUD complete, sessions 5 + 6 verified empirically)
  // ──────────────────────────────────────────────────────────

  async listTags(companyId: number, options?: { pageSize?: number; name?: string }): Promise<Tag[]> {
    const query: Query = {
      "filter[company_id]": companyId,
      "page[size]": options?.pageSize ?? 100,
    };
    // `filter[name]` does an indexed lookup. Useful for find-or-create flows
    // where we want a strongly consistent existence check right after a write.
    if (options?.name !== undefined) query["filter[name]"] = options.name;
    const result = await this.request<ApiCollection<Tag>>("GET", "/api/tags", { query });
    return result.data;
  }

  async createTag(body: { name: string; company_id: number; color?: string; active?: boolean }): Promise<Tag> {
    const result = await this.request<ApiSingle<Tag>>("POST", "/api/tags", { body });
    return result.data;
  }

  async updateTag(tagId: number, patch: Partial<Tag>): Promise<Tag> {
    const result = await this.request<ApiSingle<Tag>>("PUT", `/api/tags/${tagId}`, { body: patch });
    return result.data;
  }

  async deleteTag(tagId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/tags/${tagId}`);
  }

  // ──────────────────────────────────────────────────────────
  // Folders (CREATE nested, GET/PUT/DELETE flat. Verified.)
  // ──────────────────────────────────────────────────────────

  async listFolders(companyId: number, options?: { pageSize?: number; parentId?: number | null }): Promise<Folder[]> {
    const query: Query = { "page[size]": options?.pageSize ?? 30 };
    if (options?.parentId !== undefined) query["filter[parent_id]"] = options.parentId === null ? "null" : options.parentId;
    const result = await this.request<ApiCollection<Folder>>("GET", `/api/companies/${companyId}/folders`, { query });
    return result.data;
  }

  async getFolder(folderId: number): Promise<Folder> {
    const result = await this.request<ApiSingle<Folder>>("GET", `/api/folders/${folderId}`);
    return result.data;
  }

  async createFolder(companyId: number, body: { name: string; parent_id?: number | null; color?: string }): Promise<Folder> {
    const result = await this.request<ApiSingle<Folder>>("POST", `/api/companies/${companyId}/folders`, { body });
    return result.data;
  }

  async updateFolder(folderId: number, patch: Partial<Folder>): Promise<Folder> {
    const result = await this.request<ApiSingle<Folder>>("PUT", `/api/folders/${folderId}`, { body: patch });
    return result.data;
  }

  async deleteFolder(folderId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/folders/${folderId}`);
  }

  // ──────────────────────────────────────────────────────────
  // RuleGroups (Autopilot)
  // ──────────────────────────────────────────────────────────

  async listRuleGroups(companyId: number, options?: { include?: string }): Promise<RuleGroup[]> {
    const result = await this.request<ApiCollection<RuleGroup>>("GET", "/api/ruleGroups", {
      query: { "filter[company_id]": companyId, ...(options?.include ? { include: options.include } : {}) },
    });
    return result.data;
  }

  async getRuleGroup(ruleGroupId: number): Promise<RuleGroup> {
    const result = await this.request<ApiSingle<RuleGroup>>("GET", `/api/ruleGroups/${ruleGroupId}`);
    return result.data;
  }

  /**
   * POST /api/ruleGroups.
   *
   * Body field is `active` (boolean), NOT `is_active`. Earlier versions of
   * this client used `is_active`, which the backend silently ignored, leaving
   * the created rule group with `active: null` regardless of caller intent.
   * Verified empirically 2026-05-17 and fixed.
   */
  async createRuleGroup(body: {
    name: string;
    company_id: number;
    active?: boolean;
    description?: string;
    random_minutes?: number;
  }): Promise<RuleGroup> {
    const result = await this.request<ApiSingle<RuleGroup>>("POST", "/api/ruleGroups", { body });
    return result.data;
  }

  async updateRuleGroup(ruleGroupId: number, patch: Partial<RuleGroup>): Promise<RuleGroup> {
    const result = await this.request<ApiSingle<RuleGroup>>("PUT", `/api/ruleGroups/${ruleGroupId}`, {
      body: patch,
    });
    return result.data;
  }

  async deleteRuleGroup(ruleGroupId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/ruleGroups/${ruleGroupId}`);
  }

  // ──────────────────────────────────────────────────────────
  // Voices
  // ──────────────────────────────────────────────────────────

  async listVoices(companyId: number, options?: { pageSize?: number }): Promise<Voice[]> {
    const result = await this.request<ApiCollection<Voice>>(
      "GET",
      `/api/companies/${companyId}/voices`,
      { query: { "page[size]": options?.pageSize ?? 30 } },
    );
    return result.data;
  }

  async getVoice(voiceId: number): Promise<Voice> {
    const result = await this.request<ApiSingle<Voice>>("GET", `/api/voices/${voiceId}`);
    return result.data;
  }

  /**
   * GET /api/voices/elevenlabs. Proxy to ElevenLabs shared-voices catalog.
   *
   * Server-side filters verified empirically 2026-05-20 (ver
   * docs/followr-api/voices.md):
   *   language, locale, accent (needs language ctx), gender, age, category,
   *   sort, search, featured (use 1/0, NOT true/false; featured=true → 422),
   *   min_notice_period_days, page (0-indexed), page_size (max 100).
   *
   * Server accepts but IGNORES (Followr proxy quirk):
   *   use_case, descriptive, voice_types, featured_only.
   *
   * meta.total is unreliable (engañoso). Use meta.has_more to paginate.
   */
  async listElevenlabsVoices(options?: {
    page?: number;
    page_size?: number;
    language?: string;
    locale?: string;
    accent?: string;
    gender?: "male" | "female" | "non-binary";
    age?: "young" | "middle_aged";
    category?: "professional" | "high_quality";
    sort?: "trending" | "latest";
    search?: string;
    featured?: 0 | 1;
    min_notice_period_days?: number;
  }): Promise<{ data: ElevenLabsVoice[]; meta?: { has_more?: boolean; total?: number; current_page?: number; per_page?: string; from?: number | null; to?: number | null } }> {
    const query: Query = {
      page: options?.page ?? 0,
      page_size: options?.page_size ?? 30,
    };
    if (options?.language) query.language = options.language;
    if (options?.locale) query.locale = options.locale;
    if (options?.accent) query.accent = options.accent;
    if (options?.gender) query.gender = options.gender;
    if (options?.age) query.age = options.age;
    if (options?.category) query.category = options.category;
    if (options?.sort) query.sort = options.sort;
    if (options?.search) query.search = options.search;
    if (options?.featured !== undefined) query.featured = options.featured;
    if (options?.min_notice_period_days !== undefined) query.min_notice_period_days = options.min_notice_period_days;
    const result = await this.request<{ data: ElevenLabsVoice[]; meta?: { has_more?: boolean; total?: number; current_page?: number; per_page?: string; from?: number | null; to?: number | null } }>(
      "GET",
      "/api/voices/elevenlabs",
      { query },
    );
    return result;
  }

  /**
   * POST /api/companies/{companyId}/voices. Creates a voice profile linked to a
   * TTS provider (e.g. ElevenLabs).
   *
   * Note: the path is NESTED under the company. The internal doc previously
   * listed this as `POST /api/voices` (flat) but that route returns 404. The
   * nested path was verified empirically 2026-05-14.
   */
  async createVoice(
    companyId: number,
    body: {
      name: string;
      language_code: string;
      platform: string;
      platform_external_id: string;
      accent?: string | null;
      description?: string | null;
    },
  ): Promise<Voice> {
    const result = await this.request<ApiSingle<Voice>>(
      "POST",
      `/api/companies/${companyId}/voices`,
      { body },
    );
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Avatars
  // ──────────────────────────────────────────────────────────

  async listAvatars(companyId: number, options?: { include?: string; pageSize?: number }): Promise<Avatar[]> {
    const result = await this.request<ApiCollection<Avatar>>("GET", `/api/companies/${companyId}/avatars`, {
      query: {
        include: options?.include ?? "image.thumbnail,scenes,scenes.thumbnail,voice,voice.audio",
        "page[size]": options?.pageSize ?? 30,
      },
    });
    return result.data;
  }

  async getAvatar(avatarId: number, options?: { include?: string }): Promise<Avatar> {
    const result = await this.request<ApiSingle<Avatar>>("GET", `/api/avatars/${avatarId}`, {
      query: options?.include ? { include: options.include } : undefined,
    });
    return result.data;
  }

  /**
   * POST /api/companies/{companyId}/avatars. Creates a custom avatar resource
   * (without image; image attached in next step). Path is NESTED under the
   * company, same as the other CREATE endpoints (voices, folders, postGroups).
   * The internal doc previously listed this as POST /api/avatars (flat) but
   * that route returns 404. Verified empirically 2026-05-14.
   */
  async createAvatar(
    companyId: number,
    body: {
      name: string;
      description: string;
      voice_id: number;
      default?: boolean;
    },
  ): Promise<Avatar> {
    const result = await this.request<ApiSingle<Avatar>>(
      "POST",
      `/api/companies/${companyId}/avatars`,
      { body },
    );
    return result.data;
  }

  /**
   * PUT /api/avatars/{id}.
   * Endpoint verified empirically 2026-05-13 (PUT with non-existent id returns 404 ModelNotFoundException,
   * confirming the route exists and accepts PUT, same Laravel pattern as tags/folders/ruleGroups).
   */
  async updateAvatar(avatarId: number, patch: Partial<Avatar>): Promise<Avatar> {
    const result = await this.request<ApiSingle<Avatar>>("PUT", `/api/avatars/${avatarId}`, { body: patch });
    return result.data;
  }

  /** DELETE /api/avatars/{id}. Verified empirically 2026-05-13 (same ModelNotFoundException probe pattern). */
  async deleteAvatar(avatarId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/avatars/${avatarId}`);
  }

  /** DELETE /api/voices/{id}. Verified empirically 2026-05-17 with curl (HTTP 204 No Content). */
  async deleteVoice(voiceId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/voices/${voiceId}`);
  }

  /** DELETE /api/assets/{id}. Verified empirically 2026-05-17 with curl (HTTP 204 No Content). */
  async deleteAsset(assetId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/assets/${assetId}`);
  }

  /** POST /api/avatars/{id}/image. Step 1 of 3-step image upload for avatar. Returns presigned URL. */
  async requestAvatarImageUpload(
    avatarId: number,
    body: { filename: string; type: "image"; visibility: "public" | "private" },
  ): Promise<{ presigned_url: string; url: string; id: number }> {
    const result = await this.request<ApiSingle<{ presigned_url: string; url: string; id: number }>>(
      "POST",
      `/api/avatars/${avatarId}/image`,
      { body },
    );
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Social Hub
  // ──────────────────────────────────────────────────────────

  async listConversations(companyId: number, options?: {
    socialNetworkId?: number;
    hasUnreadMessages?: boolean;
    pageSize?: number;
  }): Promise<Conversation[]> {
    const query: Query = {
      "filter[externalUser.company_id]": companyId,
      "page[size]": options?.pageSize ?? 30,
      include: "lastMessage,unreadMessagesCount,externalUser.image",
    };
    if (options?.socialNetworkId !== undefined) query["filter[social_network_id]"] = options.socialNetworkId;
    if (options?.hasUnreadMessages) query["filter[has_unreadMessages]"] = 1;
    const result = await this.request<ApiCollection<Conversation>>("GET", "/api/conversations", { query });
    return result.data;
  }

  async listMessages(conversationId: number, options?: { pageSize?: number }): Promise<Message[]> {
    const result = await this.request<ApiCollection<Message>>("GET", "/api/messages", {
      query: { "filter[conversation_id]": conversationId, "page[size]": options?.pageSize ?? 30 },
    });
    return result.data;
  }

  /** Platform-specific message reading (Facebook + Instagram only). */
  async listPlatformMessages(
    platform: "facebook" | "instagram",
    conversationId: number,
  ): Promise<unknown[]> {
    const result = await this.request<ApiCollection<unknown>>(
      "GET",
      `/api/${platform}/conversations/${conversationId}/messages`,
    );
    return result.data;
  }

  async markConversationRead(conversationId: number): Promise<Conversation> {
    const result = await this.request<ApiSingle<Conversation>>(
      "PUT",
      `/api/conversations/${conversationId}`,
      { body: { is_read: true } },
    );
    return result.data;
  }

  async listExternalUsers(companyId: number, options?: { pageSize?: number; type?: string }): Promise<ExternalUser[]> {
    const query: Query = { "filter[company_id]": companyId, "page[size]": options?.pageSize ?? 30 };
    if (options?.type) query["filter[type]"] = options.type;
    const result = await this.request<ApiCollection<ExternalUser>>("GET", "/api/externalUsers", { query });
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Prompts (brand-voice prompts, AKA "social_network_prompts")
  // ──────────────────────────────────────────────────────────
  //
  // The /api/prompts resource is the source of truth for the brand-voice
  // feature exposed in the Followr UI under Company Settings → Prompts.
  // Each prompt belongs to a (company_id, social_network_type) tuple, has a
  // `default` flag, and can be selected at generate time. Multiple prompts
  // with default=true per network are allowed; Followr picks one.
  //
  // The legacy field `Company.social_network_prompts` is a denormalized
  // mirror of this resource and is read-only via PUT /api/companies/{id}.
  // Discovered empirically 2026-05-14.

  async listPrompts(options: {
    companyId: number | null;
    socialNetworkType?: string;
    onlyDefault?: boolean;
    include?: string;
    pageSize?: number;
    sort?: string;
  }): Promise<Prompt[]> {
    const query: Query = {
      // company_id=null surfaces the global Followr defaults; numeric scopes
      // to the workspace.
      "filter[company_id]": options.companyId === null ? "null" : options.companyId,
      "page[size]": options.pageSize ?? 30,
      sort: options.sort ?? "-created_at",
    };
    if (options.socialNetworkType) query["filter[social_network_type]"] = options.socialNetworkType;
    if (options.onlyDefault) query["filter[default]"] = 1;
    if (options.include) query["include"] = options.include;
    const result = await this.request<ApiCollection<Prompt>>("GET", "/api/prompts", { query });
    return result.data;
  }

  async getPrompt(promptId: number): Promise<Prompt> {
    const result = await this.request<ApiSingle<Prompt>>("GET", `/api/prompts/${promptId}`);
    return result.data;
  }

  async createPrompt(body: {
    company_id: number;
    social_network_type: string;
    name: string;
    prompt: string;
    type?: string;
    default?: boolean;
  }): Promise<Prompt> {
    const result = await this.request<ApiSingle<Prompt>>("POST", "/api/prompts", {
      body: { type: "text", default: false, ...body },
    });
    return result.data;
  }

  async updatePrompt(promptId: number, patch: Partial<Prompt>): Promise<Prompt> {
    const result = await this.request<ApiSingle<Prompt>>("PUT", `/api/prompts/${promptId}`, { body: patch });
    return result.data;
  }

  async deletePrompt(promptId: number): Promise<void> {
    await this.request<void>("DELETE", `/api/prompts/${promptId}`);
  }

  /**
   * GET /api/comments. Filter is `externalUser.company_id` (deep relation, not `company_id` directly).
   * Verified empirically in session 5 (2026-05-13).
   */
  async listComments(
    companyId: number,
    options?: { postId?: number; pageSize?: number; include?: string },
  ): Promise<unknown[]> {
    const query: Query = {
      "filter[externalUser.company_id]": companyId,
      "page[size]": options?.pageSize ?? 30,
    };
    if (options?.postId !== undefined) query["filter[post_id]"] = options.postId;
    if (options?.include) query["include"] = options.include;
    const result = await this.request<ApiCollection<unknown>>("GET", "/api/comments", { query });
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Analytics
  // ──────────────────────────────────────────────────────────

  async listSocialNetworkPostMetrics(
    socialNetworkId: number,
    options: { since: string; until: string; fields?: string; limit?: number },
  ): Promise<unknown[]> {
    const query: Query = { since: options.since, until: options.until };
    if (options.fields) query["fields"] = options.fields;
    if (options.limit) query["limit"] = options.limit;
    const result = await this.request<ApiCollection<unknown>>(
      "GET",
      `/api/socialNetworks/${socialNetworkId}/posts`,
      { query },
    );
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Social Networks (connected accounts)
  // ──────────────────────────────────────────────────────────

  async listSocialNetworks(companyId: number): Promise<unknown[]> {
    const result = await this.request<ApiCollection<unknown>>(
      "GET",
      `/api/companies/${companyId}/socialNetworks`,
    );
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Subscription / credits
  // ──────────────────────────────────────────────────────────

  async getSubscriptionBalance(): Promise<SubscriptionBalance> {
    const result = await this.request<ApiSingle<SubscriptionBalance>>(
      "GET",
      "/api/subscriptions/balance",
    );
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // AI Results (master endpoint for all AI generation)
  // ──────────────────────────────────────────────────────────

  /** POST /api/aiResults/chat. Text generation. */
  async generateChat(body: { q: string; company_id?: number; driver?: string; model?: string; queue?: boolean; chargeable?: number }): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("POST", "/api/aiResults/chat", { body });
    return result.data;
  }

  /** POST /api/aiResults/image. */
  async generateImage(body: {
    q: string;
    company_id: number;
    aspect_ratio?: string;
    driver?: string;
    model?: string;
    n?: number;
    chargeable?: number;
    queue?: boolean;
    image_url?: string;
    image_urls?: string[];
  }): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("POST", "/api/aiResults/image", { body });
    return result.data;
  }

  /** POST /api/aiResults/audio. TTS. */
  async generateAudio(body: {
    q: string;
    company_id: number;
    type: "audio";
    voice: string;
    speed?: number;
    driver?: string;
    model?: string;
    chargeable?: number;
    queue?: boolean;
  }): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("POST", "/api/aiResults/audio", { body });
    return result.data;
  }

  /** POST /api/aiResults/video. Lipsync video generation. */
  async generateVideo(body: {
    type: "video";
    q: string;
    audio_url: string;
    image_url: string;
    aspect_ratio: string;
    driver: string;
    model: string;
    company_id: number;
    chargeable?: number;
  }): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("POST", "/api/aiResults/video", { body });
    return result.data;
  }

  /**
   * POST /api/aiResults/video for TEXT-TO-VIDEO (no avatar, no lipsync).
   * Body shape: { type:"video", q:prompt, model, driver?, aspect_ratio,
   * company_id, image_url?, queue?, chargeable? }. No audio_url, no image_url
   * for lipsync (the lipsync flavor uses `generateVideo`). Verified shape
   * empirically 2026-05-18 against `/api/aiResults/video` with Veo models.
   * image_url is optional and enables image-to-video mode on models that
   * support it (not fully verified per model).
   */
  async generateAiVideoClip(body: {
    type: "video";
    q: string;
    aspect_ratio: string;
    model: string;
    driver?: string;
    company_id: number;
    image_url?: string;
    queue?: boolean;
    chargeable?: number;
  }): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("POST", "/api/aiResults/video", { body });
    return result.data;
  }

  /**
   * POST /api/aiResults/video in Creatomate mode.
   * Used to concat N pre-rendered lipsync clips into one final video with
   * burned-in subtitles. Different body shape than `generateVideo` (no
   * audio_url/image_url; instead a `render_script` timeline). Verified empirically
   * 2026-05-19 via Chrome capture of the Avatar Video Creator UI.
   */
  async generateVideoConcat(body: {
    type: "video";
    q: "creatomate";
    aspect_ratio: string;
    driver: "creatomate";
    model: "creatomate_video";
    render_script: {
      output_format: "mp4";
      width: number;
      height: number;
      elements: Array<Record<string, unknown>>;
    };
    company_id: number;
    chargeable?: number;
  }): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("POST", "/api/aiResults/video", { body });
    return result.data;
  }

  /** GET /api/aiResults/{id}. Polling endpoint. */
  async getAiResult(aiResultId: number): Promise<AiResult> {
    const result = await this.request<ApiSingle<AiResult>>("GET", `/api/aiResults/${aiResultId}`);
    return result.data;
  }

  /** Convenience: poll until completed or failed. */
  async waitForAiResult(
    aiResultId: number,
    options?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<AiResult> {
    const intervalMs = options?.intervalMs ?? 2500;
    const timeoutMs = options?.timeoutMs ?? 5 * 60_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.getAiResult(aiResultId);
      if (result.status === "completed" || result.status === "failed") return result;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new FollowrApiError(
      `Timeout waiting for aiResult ${aiResultId} (>${timeoutMs}ms)`,
      408,
      `/api/aiResults/${aiResultId}`,
    );
  }

  async listAiResults(options: {
    companyId: number;
    type?: string;
    model?: string;
    include?: string;
    pageSize?: number;
    sort?: string;
  }): Promise<AiResult[]> {
    const query: Query = {
      "filter[company_id]": options.companyId,
      "page[size]": options.pageSize ?? 30,
      sort: options.sort ?? "-created_at",
    };
    if (options.type) query["filter[type]"] = options.type;
    if (options.model) query["filter[model]"] = options.model;
    if (options.include) query["include"] = options.include;
    const result = await this.request<ApiCollection<AiResult>>("GET", "/api/aiResults", { query });
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Canva integration
  // ──────────────────────────────────────────────────────────

  async listCanvaDesigns(companyId: number, options?: { search?: string; limit?: number; continuationToken?: string }): Promise<CanvaDesign[]> {
    const query: Query = {};
    if (options?.search) query["search"] = options.search;
    if (options?.limit) query["limit"] = options.limit;
    if (options?.continuationToken) query["continuation_token"] = options.continuationToken;
    const result = await this.request<ApiCollection<CanvaDesign>>(
      "GET",
      `/api/companies/${companyId}/canva/designs`,
      { query },
    );
    return result.data;
  }

  /**
   * Start a Canva design export.
   *
   * Body shape verified empirically 2026-05-17 by capturing the SPA network
   * payload: `{design_id, format: {type, quality?}}` where `format` is an OBJECT,
   * not a string, and `quality` is OPTIONAL and FORMAT-SPECIFIC:
   * - jpg: stringified integer 1-100 (e.g. "75", "100"); default 92 server-side.
   * - mp4: size preset string like "horizontal_1080p", "horizontal_720p".
   * - png/pdf/gif: do NOT pass quality (server rejects with
   *   "The selected format.quality is invalid.").
   *
   * Response unwrapped from `{data: {id, status}}`. The job id is `id`, not
   * `job_id` as a prior version of this method declared.
   */
  async startCanvaDesignExport(
    companyId: number,
    body: { design_id: string; format: { type: string; quality?: string } },
  ): Promise<{ id: string; status: string }> {
    const result = await this.request<ApiSingle<{ id: string; status: string }>>(
      "POST",
      `/api/companies/${companyId}/canva/designExportJob`,
      { body },
    );
    return result.data;
  }

  async getCanvaDesignExportJob(companyId: number, jobId: string): Promise<unknown> {
    const result = await this.request<ApiSingle<unknown>>(
      "GET",
      `/api/companies/${companyId}/canva/designExportJob/${jobId}`,
    );
    return result.data;
  }

  // ──────────────────────────────────────────────────────────
  // Asset upload (3-step pattern)
  // ──────────────────────────────────────────────────────────

  /** Step 1: create asset placeholder under company. */
  async createAsset(companyId: number, body: { name: string; type: "image" | "video" }): Promise<Asset> {
    const result = await this.request<ApiSingle<Asset>>("POST", `/api/companies/${companyId}/assets`, { body });
    return result.data;
  }

  /**
   * GET /api/companies/{id}/assets. List assets in a workspace, optionally filtered by type and folder.
   * Verified empirically (used by bulkuploader).
   */
  async listAssets(
    companyId: number,
    options?: { type?: string; folderId?: number | null; pageSize?: number; include?: string },
  ): Promise<Asset[]> {
    const query: Query = { "page[size]": options?.pageSize ?? 30 };
    if (options?.type) query["filter[type]"] = options.type;
    if (options?.folderId !== undefined) {
      query["filter[folder_id]"] = options.folderId === null ? "null" : options.folderId;
    }
    if (options?.include) query["include"] = options.include;
    const result = await this.request<ApiCollection<Asset>>(
      "GET",
      `/api/companies/${companyId}/assets`,
      { query },
    );
    return result.data;
  }

  /** Step 2: request presigned upload URL for the asset. */
  async requestAssetUpload(
    assetId: number,
    kind: "image" | "video",
    body: { filename: string; type: "image" | "video"; visibility: "public" | "private"; width?: number; height?: number },
  ): Promise<{ presigned_url: string; url: string }> {
    const result = await this.request<ApiSingle<{ presigned_url: string; url: string }>>(
      "POST",
      `/api/assets/${assetId}/${kind}`,
      { body },
    );
    return result.data;
  }

  /** Step 3: PUT binary to the Azure presigned URL. Caller responsibility, but helper provided. */
  async uploadToBlob(presignedUrl: string, binary: ArrayBuffer | Blob | Uint8Array, contentType: string): Promise<void> {
    const response = await this.fetchImpl(presignedUrl, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": contentType,
      },
      // ts-prune-ignore-next
      body: binary as BodyInit,
    });
    if (!response.ok) {
      throw new FollowrApiError(
        `Azure blob upload failed: ${response.status}`,
        response.status,
        presignedUrl,
      );
    }
  }
}
