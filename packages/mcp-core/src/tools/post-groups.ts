import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION, READ_ONLY } from "../lib/annotations.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";
import { gatherRuntimeContext } from "../specs/runtime-context.js";
import type { NetworkType, ProductType, SpecWarning } from "../specs/types.js";
import { validateAgainstSpec } from "../specs/validate.js";

const BULK_NETWORK_ENUM = [
  "medium",
  "pinterest",
  "twitter",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "youtube",
  "threads",
  "bluesky",
] as const satisfies readonly NetworkType[];

const BULK_PRODUCT_TYPE_ENUM = ["feed", "reel", "story", "short"] as const satisfies readonly ProductType[];

const BULK_NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE: ReadonlySet<NetworkType> = new Set([
  "instagram",
  "facebook",
  "youtube",
]);

const BULK_PRODUCT_TYPE_TO_FOLLOWR: Record<ProductType, string> = {
  feed: "FEED",
  reel: "REEL",
  story: "STORY",
  short: "SHORT",
};

const BULK_BLOCKING_VALIDATION_RULES: ReadonlySet<string> = new Set([
  "required",
  "video_required_for_product_type",
  "no_mixed_media",
  "max_total_exceeded",
  "max_count_exceeded",
  "max_size_exceeded",
  "video_too_long",
  "video_too_short",
  "video_max_width_exceeded",
  "video_min_width_below",
  "aspect_ratio_out_of_range",
  "not_supported",
]);

function pickBulkBlockingWarnings(warnings: SpecWarning[]): SpecWarning[] {
  return warnings.filter(
    (w) => w.severity === "hard_fail" && BULK_BLOCKING_VALIDATION_RULES.has(w.rule),
  );
}

export function registerPostGroupTools(
  server: McpServer,
  client: FollowrClient,
  options: RegisterOptions,
): void {
  server.registerTool(
    "list_drafts",
    {
      annotations: READ_ONLY,
      title: "List pending drafts in a company",
      description: `Return PostGroups in draft state (not yet scheduled) for a company. Drafts are content waiting for approval or scheduling. Sorted newest first.

PRECONDITION: company_id required. If the user has multiple companies and hasn't named one for this task, call list_companies first and ask the user to choose by name before calling this tool.

USE FOR: questions like "what drafts are pending in {company}?", "show me unfinished posts", "what's waiting to be scheduled?". When presenting results to the user, refer to PostGroups by title (or description if no title), not by id.`,
      inputSchema: {
        company_id: z.number().int().positive().describe("The Followr company id (company)."),
        page_size: z.number().int().positive().max(100).optional().default(30),
      },
    },
    async ({ company_id, page_size }) => {
      const groups = await client.listCompanyPostGroups(company_id, {
        draft: true,
        sort: "-id",
        pageSize: page_size,
        include: "tags,posts,user",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              groups.map((g) => ({
                id: g.id,
                title: g.title,
                topic: g.topic,
                description: g.description?.slice(0, 200),
                publish_at: g.publish_at,
                draft: g.draft,
                auto_publish: g.auto_publish,
                created_at: g.created_at,
                networks: (g.posts ?? []).map((p) => p.social_network_type),
                tags: (g.tags ?? []).map((t) => t.name),
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
    "list_scheduled",
    {
      annotations: READ_ONLY,
      title: "List scheduled posts in a date range",
      description: `Return PostGroups scheduled (publish_at NOT NULL, draft=false) in a date range. Use for calendar queries like "what do I have scheduled for next week".

PRECONDITION: company_id required. If the user has multiple companies and hasn't named one, call list_companies first and ask the user to choose by name.

DATE RANGE: from_iso and to_iso are ISO 8601 timestamps. Build them from the user's verbal range ("next week", "this month") by translating to the company timezone explicitly before calling. publish_at values returned are in UTC; when surfacing to the user, convert back to their local timezone.

When presenting results, refer to PostGroups by title and to social networks by their display name (instagram, linkedin, etc.), not by internal id.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        from_iso: z.string().describe("ISO 8601 start of range. e.g. 2026-05-13T00:00:00Z"),
        to_iso: z.string().describe("ISO 8601 end of range."),
        page_size: z.number().int().positive().max(100).optional().default(50),
        social_networks: z
          .array(z.string())
          .optional()
          .describe("Optional filter by network types (instagram, facebook, etc)."),
      },
    },
    async ({ company_id, from_iso, to_iso, page_size, social_networks }) => {
      const groups = await client.listCompanyPostGroups(company_id, {
        draft: false,
        publishAtAfter: from_iso,
        publishAtBefore: to_iso,
        pageSize: page_size,
        sort: "publish_at",
        include: "tags,posts,user",
        ...(social_networks?.length ? { socialNetworkTypes: social_networks } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              groups.map((g) => ({
                id: g.id,
                title: g.title,
                publish_at: g.publish_at,
                networks: (g.posts ?? []).map((p) => p.social_network_type),
                tags: (g.tags ?? []).map((t) => t.name),
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
    "get_post_group",
    {
      annotations: READ_ONLY,
      title: "Get full details of a PostGroup with hydrated assets",
      description: `Get a single PostGroup with all its posts, asset URLs (image and video thumbnails), tags, and the user who created it.

USE BEFORE: update_post_group (especially when patching tags_ids, which has REPLACE semantics and requires computing the union of existing + new tags); publish_post_group_now (to confirm content with the user before going public); delete_post_group (to confirm what is about to be deleted). Also useful for showing a full preview to the user.`,
      inputSchema: {
        post_group_id: z.number().int().positive(),
      },
    },
    async ({ post_group_id }) => {
      const group = await client.getPostGroup(post_group_id);
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    },
  );

  server.registerTool(
    "create_post_group",
    {
      annotations: MUTATION,
      title: "Create a new PostGroup (cross-network campaign container, draft or scheduled publication)",
      description: `Create a PostGroup, the container that groups one or more per-network social media posts (publication, content piece, campaign entry, draft) so they share the same caption seed, scheduling, tags, and topic across Instagram, TikTok, Facebook, Twitter/X, LinkedIn, YouTube, Pinterest, Threads, Bluesky, or Medium.

PRECONDITION: company_id must be explicit. If the user has more than one company and hasn't named one for this task, call list_companies first and ask the user to choose by name before calling this tool. Never default silently. Company mistakes are expensive because content can end up published in the wrong account.

DEFAULT BEHAVIOR: PostGroup is created with draft=true. It is NOT scheduled or published by this call. To schedule, follow with create_post (per target network), validate_against_specs (per post), and update_post_group (to set publish_at and toggle draft=false).

NEXT STEPS: After this returns an id, call create_post once per target social network. Posts inherit content context from the PostGroup but can override per-network specifics (caption, assets, preferences). When the group targets Reels / Shorts / TikTok and the user has no footage yet, propose a video generation flow (generate_avatar_video, generate_avatar_lipsync_clip, or generate_ai_video_clip) BEFORE calling create_post.

BULK ALTERNATIVE: When creating a PostGroup plus multiple per-network Posts in one shot (typical for a cross-network campaign), prefer create_post_group_with_posts. It runs validation across all sub-posts, fails atomically if any has a blocker, and avoids leaving an empty PostGroup behind.

OPTIONAL topic / publish_at: passing topic at creation seeds the AI-driven content suggestions for downstream create_post calls. Passing publish_at here ALSO sets the schedule (skips a follow-up update_post_group). If you pass publish_at but leave draft=true, the schedule is stored but the group stays parked until you flip draft=false later.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        draft: z.boolean().optional().default(true).describe("If true, post stays as draft. If false, it's ready to schedule."),
        auto_publish: z.boolean().optional().default(false),
        title: z.string().optional(),
        description: z.string().optional(),
        topic: z
          .string()
          .optional()
          .describe(
            "Optional topic seed used by Followr's AI to generate per-network content. e.g. 'product launch for our new line of dog food'.",
          ),
        publish_at: z
          .string()
          .optional()
          .describe(
            "Optional ISO 8601 UTC datetime. When provided, the schedule is set at creation. If draft=true, the schedule is stored but not enacted until draft=false.",
          ),
      },
    },
    async ({ company_id, draft, auto_publish, title, description, topic, publish_at }) => {
      try {
        const group = await client.createPostGroup(company_id, {
          draft: draft ? 1 : 0,
          auto_publish: auto_publish ? 1 : 0,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(topic ? { topic } : {}),
          ...(publish_at ? { publish_at } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "update_post_group",
    {
      annotations: MUTATION,
      title: "Update a PostGroup",
      description: `Patch fields of an existing PostGroup. Common uses: schedule (set publish_at and draft=false), toggle auto_publish, edit title/description, replace tags.

SCHEDULING: When setting publish_at, confirm date, time, and timezone with the user verbatim before calling. publish_at must be ISO 8601 UTC. If the user gives a local time, translate to UTC explicitly and surface the conversion (e.g. "9 AM Buenos Aires = 12:00 UTC"). Don't assume timezone from previous context unless the user established it in this conversation.

TAGS SEMANTICS: tags_ids is REPLACE, not append. To add a tag without losing existing ones, fetch current tags via get_post_group, build the union, and pass the full list. Forgetting this silently removes tags the user wanted to keep.

DRAFT TOGGLE: draft=false marks the PostGroup as ready to publish at publish_at. draft=true parks it. Don't toggle draft=false without first confirming that all per-network posts are created (via create_post) and validated (via validate_against_specs).`,
      inputSchema: {
        post_group_id: z.number().int().positive(),
        publish_at: z.string().optional().describe("ISO 8601 datetime in UTC."),
        draft: z.boolean().optional(),
        auto_publish: z.boolean().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe("Full list of tag ids (REPLACE semantics, not append)."),
      },
    },
    async (input) => {
      try {
        const { post_group_id, ...patch } = input;
        const group = await client.updatePostGroup(post_group_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_post_group",
    {
      annotations: DESTRUCTIVE,
      title: "Delete a PostGroup (destructive)",
      description: `Permanently delete a PostGroup and all its underlying Posts. Cannot be undone via the API.

CRITICAL: Confirm the user's intent verbatim before calling. State the PostGroup title (or first line of description if no title), the company name (not id), and the fact that this is permanent. Get explicit confirmation.

SCOPE: This deletes the PostGroup record, the Posts inside it (one per network), and references. It does NOT delete already-published social media posts on the actual networks; those have to be deleted directly on the platform.

Never chain this from generic intents like "clean up old drafts" unless the user has explicitly identified the specific PostGroups to delete and confirmed each, or confirmed a clearly-bounded batch.`,
      inputSchema: {
        post_group_id: z.number().int().positive(),
      },
    },
    async ({ post_group_id }) => {
      try {
        await client.deletePostGroup(post_group_id);
        return { content: [{ type: "text", text: `Deleted post_group ${post_group_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "search_posts_by_topic",
    {
      annotations: READ_ONLY,
      title: "Search past posts by topic or content keywords",
      description: `Search the history of PostGroups in a company by a semantic keyword. Followr's AI auto-populates each PostGroup's \`topic\` field with a one-line summary of the post body once content exists, so this tool answers questions like:

- "What did I post about last week / last month?"
- "Find posts where I mentioned <brand|product|theme>."
- "Have I already posted about <X>?"
- "Show me my last posts about <topic>."

HOW IT WORKS: server-side filter \`filter[posts.description]=<query>\` narrows to PostGroups whose underlying Posts (per-network content) contain the query in their description. Topic is the one-line summary returned alongside; description is the full body. Results are sorted newest first (\`sort=-id\`).

PRECONDITION: company_id required. If the user has multiple companies and hasn't named one for this task, call list_companies first and ask the user to choose by name before calling this tool.

QUERY: short keyword or phrase (e.g. "PostApprove", "lanzamiento de producto", "veganismo"). Backend matches as a contains/LIKE-style filter against the Post description text. Long sentences or fuzzy semantic queries may miss; prefer salient nouns.

PRESENTING: return PostGroups by title (or first 60 chars of topic if no title), with \`publish_at\` translated to the user's timezone if known, and the list of networks (\`networks\`) where each was published. Do NOT show internal ids.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        query: z
          .string()
          .min(1)
          .describe("Keyword or phrase to search in the description of the per-network Posts."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20)
          .describe("Max PostGroups to return. Default 20, max 100."),
        only_published: z
          .boolean()
          .optional()
          .describe(
            "If true, exclude drafts (filter[draft]=0). Default unset, which returns both drafts and published.",
          ),
      },
    },
    async ({ company_id, query, limit, only_published }) => {
      try {
        const groups = await client.listCompanyPostGroups(company_id, {
          postsDescription: query,
          pageSize: limit,
          sort: "-id",
          include: "posts,tags,user",
          ...(only_published ? { draft: false } : {}),
        });
        const compact = groups.map((g) => ({
          id: g.id,
          title: g.title,
          topic: g.topic,
          publish_at: g.publish_at,
          draft: g.draft,
          networks: (g.posts ?? []).map((p) => p.social_network_type),
          tags: (g.tags ?? []).map((t) => t.name),
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  count: compact.length,
                  results: compact,
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
    "publish_post_group_now",
    {
      annotations: DESTRUCTIVE,
      title: "Force-publish a PostGroup immediately to a network",
      description: `Publish a PostGroup to a social network IMMEDIATELY, bypassing draft and scheduling.

CRITICAL: This is an irreversible public action. The post goes live the moment this returns. Before calling:
1. The user must have explicitly asked for immediate publishing ("publicá ahora", "publish now", "post it now"). "Create" or "schedule" do NOT authorize this tool.
2. Confirm verbatim with the user: state the network name, the company name (not id), and the post title or first line of content. Get an explicit yes before calling.
3. Verify the PostGroup has a corresponding Post for the requested network (via get_post_group). If not, this will fail.

USE CASES: crisis response, trend hijacking, manually-triggered publishing where the user is actively driving the timing. For all other flows use update_post_group with publish_at.

IRREVERSIBILITY: Followr cannot un-publish. The user would have to delete the post on the network itself.`,
      inputSchema: {
        post_group_id: z.number().int().positive(),
        social_network_type: z.string().describe("e.g. instagram, facebook, twitter, linkedin, tiktok, threads, bluesky"),
      },
    },
    async ({ post_group_id, social_network_type }) => {
      try {
        const result = await client.publishPostGroup(post_group_id, social_network_type);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // Tool: create_post_group_with_posts (bulk).
  // One-shot creation of a PostGroup plus N per-network Posts. Reduces the
  // 2N+1 round-trips of the manual flow (one create_post_group + N create_post)
  // down to ~N+1 backend calls (post creations still happen one per network)
  // and adds atomic-failure semantics: if ANY sub-post has a validation
  // blocker, NOTHING is created (no orphan PostGroup left behind).
  const BulkAssetSchema = z.object({
    id: z.number().int().positive(),
    type: z.enum(["image", "video", "gif"]),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    size_bytes: z.number().nonnegative().optional(),
    duration_seconds: z.number().positive().optional(),
  });

  const BulkPostInputSchema = z.object({
    social_network_type: z.enum(BULK_NETWORK_ENUM),
    product_type: z.enum(BULK_PRODUCT_TYPE_ENUM),
    description: z.string().optional(),
    title: z.string().optional(),
    link: z.string().optional(),
    assets: z.array(BulkAssetSchema).optional(),
    preferences: z.record(z.string(), z.unknown()).optional(),
    comments_to_create: z.array(z.unknown()).optional(),
  });

  server.registerTool(
    "create_post_group_with_posts",
    {
      annotations: MUTATION,
      title: "Create a PostGroup plus all its per-network Posts in one shot (bulk)",
      description: `Create a PostGroup AND all its per-network Posts in a single tool call. Equivalent to create_post_group followed by N create_post calls, but with two important differences:

1. ATOMIC VALIDATION: every per-network Post is validated against the network's spec BEFORE any record is created. If ANY sub-post has a blocking warning (missing required asset, wrong asset type for product_type, asset over size limit, video duration out of range, aspect ratio out of range, mixed media not allowed, exceeded count caps, caption sent to a network that doesn't accept it), the tool aborts without creating the PostGroup. No orphan group is left behind. Override with acknowledge_validation_errors=true to force creation against the user's explicit instruction.
2. FEWER ROUND-TRIPS: one tool call instead of 1 + N. Best for cross-network campaigns where you build the group + posts together.

PRECONDITION: company_id required. If multiple companies, confirm by name (rule 1).

USE FOR: planning a cross-network campaign ("Instagram feed + Instagram reel + TikTok video + LinkedIn post, same theme"). The agent builds the spec for each network and submits all at once.

DO NOT USE: when only one network is involved (use create_post_group + create_post instead, simpler). When the posts need iterative review between creation steps. When asset uploads need to happen in between (do those first via upload_image_from_url / upload_video_from_url / upload_images_from_urls).

VIDEO WORKFLOW: if any sub-post targets a reel / short, the validator requires assets[].type=video for that sub-post. Generate or upload the video FIRST (generate_avatar_video, generate_ai_video_clip, upload_video_from_url) and pass the resulting asset id in the corresponding sub-post.

SCHEDULING: pass publish_at on the PostGroup-level fields if the group should be scheduled at creation; same semantics as create_post_group (draft=true + publish_at parks the schedule).

RETURNS: { post_group, posts: Post[], validation: { warnings_by_post: SpecWarning[][] }, runtime_context }.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        draft: z.boolean().optional().default(true),
        auto_publish: z.boolean().optional().default(false),
        title: z.string().optional(),
        description: z.string().optional(),
        topic: z.string().optional(),
        publish_at: z.string().optional().describe("Optional ISO 8601 UTC datetime. Same semantics as create_post_group.publish_at."),
        posts: z
          .array(BulkPostInputSchema)
          .min(1)
          .max(10)
          .describe("Per-network Posts to create inside the new PostGroup. 1 to 10 per call. Each follows the same shape as create_post's input (minus post_group_id and company_id, which are inherited)."),
        acknowledge_validation_errors: z
          .boolean()
          .optional()
          .describe(
            "Default false. When false, the whole batch aborts before any record is created if ANY sub-post has a blocking warning. Set to true ONLY to force creation against the user's explicit instruction after they were told about the blockers.",
          ),
      },
    },
    async (input) => {
      try {
        // 1. Pre-validate every sub-post BEFORE creating anything.
        const runtimeContextByNetwork = new Map<NetworkType, Awaited<ReturnType<typeof gatherRuntimeContext>>>();
        const warningsByPost: SpecWarning[][] = [];
        const mergedPreferencesByPost: Record<string, unknown>[] = [];
        for (const post of input.posts) {
          let ctx = runtimeContextByNetwork.get(post.social_network_type);
          if (!ctx) {
            ctx = await gatherRuntimeContext(input.company_id, post.social_network_type, client);
            runtimeContextByNetwork.set(post.social_network_type, ctx);
          }
          const mergedPreferences: Record<string, unknown> = { ...(post.preferences ?? {}) };
          if (
            BULK_NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE.has(post.social_network_type) &&
            !("media_product_type" in mergedPreferences)
          ) {
            mergedPreferences["media_product_type"] = BULK_PRODUCT_TYPE_TO_FOLLOWR[post.product_type];
          }
          mergedPreferencesByPost.push(mergedPreferences);
          const warnings = validateAgainstSpec(
            {
              network: post.social_network_type,
              product_type: post.product_type,
              description: post.description,
              title: post.title,
              link: post.link,
              assets: post.assets,
              preferences: mergedPreferences,
            },
            ctx,
          );
          warningsByPost.push(warnings);
        }

        // 2. Collect blockers across all sub-posts. If any and not acknowledged,
        // abort BEFORE creating the PostGroup so no orphan record is left.
        const blockersByPost = warningsByPost.map(pickBulkBlockingWarnings);
        const hasAnyBlocker = blockersByPost.some((bs) => bs.length > 0);
        if (hasAnyBlocker && input.acknowledge_validation_errors !== true) {
          const summary = blockersByPost
            .map((blockers, i) => {
              if (blockers.length === 0) return null;
              const post = input.posts[i]!;
              const lines = blockers
                .map((w) => `    - ${w.field}: ${w.suggestion ?? w.rule}`)
                .join("\n");
              return `  posts[${i}] (${post.social_network_type} ${post.product_type}):\n${lines}`;
            })
            .filter((s): s is string => s !== null)
            .join("\n");
          return toolError({
            reason: "validation_blockers",
            user_message: `Cannot create the PostGroup: ${blockersByPost.reduce((acc, bs) => acc + bs.length, 0)} blocking validation issue(s) across the sub-posts. No record was created. Fix the issues below and retry:\n${summary}`,
            suggested_actions: [
              {
                tool: "generate_avatar_video",
                rationale: "Use this for any reel/short sub-post that is missing a video asset.",
              },
              {
                tool: "generate_ai_video_clip",
                rationale: "Or generate a single 8-second AI video clip for a reel/short.",
              },
              {
                tool: "upload_video_from_url",
                rationale: "If the user has footage, upload it first and pass the asset id.",
              },
            ],
            details: {
              blockers_by_post: blockersByPost,
              all_warnings_by_post: warningsByPost,
              override_hint:
                "Pass acknowledge_validation_errors=true to create the batch anyway (not recommended; the network will reject the broken sub-posts).",
            },
          });
        }

        // 3. Create the PostGroup.
        const group = await client.createPostGroup(input.company_id, {
          draft: (input.draft ?? true) ? 1 : 0,
          auto_publish: (input.auto_publish ?? false) ? 1 : 0,
          ...(input.title ? { title: input.title } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.topic ? { topic: input.topic } : {}),
          ...(input.publish_at ? { publish_at: input.publish_at } : {}),
        });

        // 4. Create per-network Posts in parallel.
        const createdPosts = await Promise.all(
          input.posts.map((post, i) => {
            const mergedPreferences = mergedPreferencesByPost[i] ?? {};
            const body: Parameters<FollowrClient["createPost"]>[1] = {
              social_network_type: post.social_network_type,
            };
            if (post.description !== undefined) body.description = post.description;
            if (post.title !== undefined) body.title = post.title;
            if (post.link !== undefined) body.link = post.link;
            if (post.assets && post.assets.length > 0) {
              body.assets_ids = post.assets.map((a) => a.id);
            }
            if (Object.keys(mergedPreferences).length > 0) body.preferences = mergedPreferences;
            if (post.comments_to_create !== undefined) body.comments_to_create = post.comments_to_create;
            return client.createPost(group.id, body);
          }),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  post_group: group,
                  posts: createdPosts,
                  validation: {
                    warnings_by_post: warningsByPost,
                    total_warnings: warningsByPost.reduce((acc, w) => acc + w.length, 0),
                  },
                  runtime_context_by_network: Object.fromEntries(runtimeContextByNetwork),
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
}
