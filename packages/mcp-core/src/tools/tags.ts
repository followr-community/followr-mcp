import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerTagTools(server: McpServer, client: FollowrClient, _options: RegisterOptions): void {
  server.registerTool(
    "list_tags",
    {
      title: "List tags in a workspace",
      description:
        "List all tags for a Followr workspace. Tags are scoped to a company and used for categorizing PostGroups (and as a workaround for approval status via the 'Approved' / 'Rejected' convention).",
      inputSchema: {
        company_id: z.number().int().positive(),
      },
    },
    async ({ company_id }) => {
      const tags = await client.listTags(company_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tags.map((t) => ({ id: t.id, name: t.name, color: t.color, active: t.active })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_tag",
    {
      title: "Create a tag in a workspace",
      description:
        "Create a new tag in the specified workspace. Color is optional hex (e.g. #22c55e). Tags are idempotent by convention: caller should list existing first to avoid duplicates.",
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color, e.g. #22c55e"),
      },
    },
    async ({ company_id, name, color }) => {
      const tag = await client.createTag({ company_id, name, ...(color ? { color } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(tag, null, 2) }] };
    },
  );

  server.registerTool(
    "update_tag",
    {
      title: "Update a tag (rename, change color or active state)",
      description: "Patch a tag's name, color, or active flag.",
      inputSchema: {
        tag_id: z.number().int().positive(),
        name: z.string().optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        active: z.boolean().optional(),
      },
    },
    async ({ tag_id, ...patch }) => {
      const tag = await client.updateTag(tag_id, patch);
      return { content: [{ type: "text", text: JSON.stringify(tag, null, 2) }] };
    },
  );

  server.registerTool(
    "delete_tag",
    {
      title: "Delete a tag (destructive)",
      description: "Permanently delete a tag. PostGroups that referenced this tag will keep their tags_ids list with a now-broken reference. Cannot be undone.",
      inputSchema: {
        tag_id: z.number().int().positive(),
      },
    },
    async ({ tag_id }) => {
      await client.deleteTag(tag_id);
      return { content: [{ type: "text", text: `Deleted tag ${tag_id}.` }] };
    },
  );

  server.registerTool(
    "find_or_create_tag",
    {
      title: "Find a tag by name or create it if it doesn't exist",
      description:
        "Idempotent helper. Looks up tags in the workspace by case-insensitive name match. If found, returns its id. If not, creates a new tag with the given name and color.",
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
    },
    async ({ company_id, name, color }) => {
      // Indexed lookup by name. The previous implementation listed the whole
      // company's tags and filtered client-side, which missed just-created
      // tags due to read-after-write consistency lag on the list endpoint.
      const matches = await client.listTags(company_id, { name });
      const existing = matches.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        return {
          content: [{ type: "text", text: JSON.stringify({ found: true, tag: existing }, null, 2) }],
        };
      }
      const created = await client.createTag({ company_id, name, ...(color ? { color } : {}) });
      return {
        content: [{ type: "text", text: JSON.stringify({ found: false, tag: created }, null, 2) }],
      };
    },
  );
}
