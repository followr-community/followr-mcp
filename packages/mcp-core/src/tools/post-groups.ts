import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerPostGroupTools(
  server: McpServer,
  client: FollowrClient,
  options: RegisterOptions,
): void {
  server.registerTool(
    "list_drafts",
    {
      title: "List pending drafts in a workspace",
      description:
        "Return PostGroups in draft state (not yet scheduled) for a workspace. Drafts are content waiting for approval or scheduling. Sorted newest first.",
      inputSchema: {
        company_id: z.number().int().positive().describe("The Followr company id (workspace)."),
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
      title: "List scheduled posts in a date range",
      description:
        "Return PostGroups scheduled (publish_at NOT NULL, draft=false) in a date range. Use for calendar queries like 'what do I have scheduled for next week'.",
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
      title: "Get full details of a PostGroup with hydrated assets",
      description:
        "Get a single PostGroup with all its posts, asset URLs (image and video thumbnails), tags, and the user who created it. Useful for showing a full preview.",
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
      title: "Create a new PostGroup (draft or ready-to-schedule)",
      description:
        "Create a PostGroup in the specified workspace. Returns the new id. After creation, use create_post to add posts per social network, and update_post_group to set publish_at.",
      inputSchema: {
        company_id: z.number().int().positive(),
        draft: z.boolean().optional().default(true).describe("If true, post stays as draft. If false, it's ready to schedule."),
        auto_publish: z.boolean().optional().default(false),
        title: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ company_id, draft, auto_publish, title, description }) => {
      const group = await client.createPostGroup(company_id, {
        draft: draft ? 1 : 0,
        auto_publish: auto_publish ? 1 : 0,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    },
  );

  server.registerTool(
    "update_post_group",
    {
      title: "Update a PostGroup",
      description:
        "Patch fields of a PostGroup. Common use: schedule (set publish_at), change draft status, add or remove tags. tags_ids is REPLACE not append (caller must merge).",
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
      const { post_group_id, ...patch } = input;
      const group = await client.updatePostGroup(post_group_id, patch);
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    },
  );

  server.registerTool(
    "delete_post_group",
    {
      title: "Delete a PostGroup (destructive)",
      description: "Permanently delete a PostGroup. Cannot be undone.",
      inputSchema: {
        post_group_id: z.number().int().positive(),
      },
    },
    async ({ post_group_id }) => {
      await client.deletePostGroup(post_group_id);
      return { content: [{ type: "text", text: `Deleted post_group ${post_group_id}.` }] };
    },
  );

  server.registerTool(
    "publish_post_group_now",
    {
      title: "Force-publish a PostGroup immediately to a network",
      description:
        "Bypass scheduling and publish a PostGroup right now to the specified social network. Useful for crisis-response or trend-hijacking scenarios.",
      inputSchema: {
        post_group_id: z.number().int().positive(),
        social_network_type: z.string().describe("e.g. instagram, facebook, twitter, linkedin, tiktok, threads, bluesky"),
      },
    },
    async ({ post_group_id, social_network_type }) => {
      const result = await client.publishPostGroup(post_group_id, social_network_type);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
