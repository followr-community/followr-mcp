import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION, READ_ONLY } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

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
      title: "Create a new PostGroup (draft or ready-to-schedule)",
      description: `Create a PostGroup (the container for one or more cross-network posts) in a specific company.

PRECONDITION: company_id must be explicit. If the user has more than one company and hasn't named one for this task, call list_companies first and ask the user to choose by name before calling this tool. Never default silently. Company mistakes are expensive because content can end up published in the wrong account.

DEFAULT BEHAVIOR: PostGroup is created with draft=true. It is NOT scheduled or published by this call. To schedule, follow with create_post (per target network), validate_against_specs (per post), and update_post_group (to set publish_at and toggle draft=false).

NEXT STEPS: After this returns an id, call create_post once per target social network. Posts inherit content context from the PostGroup but can override per-network specifics (caption, assets, preferences).

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
}
