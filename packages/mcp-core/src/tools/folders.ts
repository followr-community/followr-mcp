import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function registerFolderTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_folders",
    {
      title: "List folders in a workspace",
      description:
        "List folders (used to organize assets) in a Followr workspace. Optionally narrow to a specific parent folder (use parent_id_null=true to list only top-level folders).",
      inputSchema: {
        company_id: z.number().int().positive(),
        parent_id: z.number().int().positive().optional().describe("Restrict to children of this parent folder."),
        parent_id_null: z.boolean().optional().describe("If true, only return top-level folders (parent_id is null). Ignored if parent_id is set."),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, parent_id, parent_id_null, page_size }) => {
      const parentArg = parent_id !== undefined ? parent_id : parent_id_null ? null : undefined;
      const folders = await client.listFolders(company_id, {
        ...(parentArg !== undefined ? { parentId: parentArg } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              folders.map((f) => ({
                id: f.id,
                name: f.name,
                color: f.color,
                parent_id: f.parent_id,
                created_at: f.created_at,
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
    "get_folder",
    {
      title: "Get a single folder by id",
      description: "Fetch one folder's details (name, color, parent). Path is flat (/api/folders/{id}); nested variant returns 404.",
      inputSchema: {
        folder_id: z.number().int().positive(),
      },
    },
    async ({ folder_id }) => {
      const folder = await client.getFolder(folder_id);
      return { content: [{ type: "text", text: JSON.stringify(folder, null, 2) }] };
    },
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder in a workspace",
      description:
        "Create a folder under a workspace, optionally nested inside a parent folder. Use to organize assets, generated images, or campaign material.",
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1).describe("Folder name."),
        parent_id: z.number().int().positive().optional().describe("Parent folder id. Omit for top-level."),
        color: z.string().regex(HEX_COLOR).optional().describe("Hex color, e.g. #22c55e."),
      },
    },
    async ({ company_id, name, parent_id, color }) => {
      const folder = await client.createFolder(company_id, {
        name,
        ...(parent_id !== undefined ? { parent_id } : {}),
        ...(color ? { color } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(folder, null, 2) }] };
    },
  );

  server.registerTool(
    "update_folder",
    {
      title: "Update a folder",
      description: "Patch a folder's name, color, or parent. Use to rename, recolor, or move into a different parent.",
      inputSchema: {
        folder_id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        color: z.string().regex(HEX_COLOR).optional(),
        parent_id: z.number().int().positive().nullable().optional().describe("New parent folder id, or null to move to top-level."),
      },
    },
    async ({ folder_id, ...patch }) => {
      const folder = await client.updateFolder(folder_id, patch);
      return { content: [{ type: "text", text: JSON.stringify(folder, null, 2) }] };
    },
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete a folder (destructive)",
      description:
        "Permanently delete a folder. Cannot be undone. Behavior with nested folders or assets inside is not enforced server-side from the MCP's perspective; caller should clear contents first if needed.",
      inputSchema: {
        folder_id: z.number().int().positive(),
      },
    },
    async ({ folder_id }) => {
      await client.deleteFolder(folder_id);
      return { content: [{ type: "text", text: `Deleted folder ${folder_id}.` }] };
    },
  );
}
