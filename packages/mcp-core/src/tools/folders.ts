import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION, READ_ONLY } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function registerFolderTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_folders",
    {
      annotations: READ_ONLY,
      title: "List folders in a company",
      description: `List folders (used to organize assets) in a Followr company. Returns name, color, parent_id, created_at per folder.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

NESTING: pass parent_id to list children of a specific folder; parent_id_null=true to list only top-level. Omit both to list all folders flat.

PRESENTING: refer to folders by name, never by id, when speaking with the user.`,
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
      annotations: READ_ONLY,
      title: "Get a single folder by id",
      description: `Fetch one folder's details (name, color, parent_id, created_at). Useful before update_folder (to compute the patch) or delete_folder (to confirm what is being deleted).

Path is flat (/api/folders/{id}); nested variant returns 404.`,
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
      annotations: MUTATION,
      title: "Create a folder in a company",
      description: `Create a folder under a company, optionally nested inside a parent folder. Used to organize assets, generated images, campaign material.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

DEDUPE: before creating, consider calling list_folders to check if a folder with the same name already exists. Creating duplicates clutters the company.

OPTIONAL: parent_id for nested folders; color (hex like #22c55e) for UI organization.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1).describe("Folder name."),
        parent_id: z.number().int().positive().optional().describe("Parent folder id. Omit for top-level."),
        color: z.string().regex(HEX_COLOR).optional().describe("Hex color, e.g. #22c55e."),
      },
    },
    async ({ company_id, name, parent_id, color }) => {
      try {
        const folder = await client.createFolder(company_id, {
          name,
          ...(parent_id !== undefined ? { parent_id } : {}),
          ...(color ? { color } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(folder, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "update_folder",
    {
      annotations: MUTATION,
      title: "Update a folder",
      description: `Patch a folder's name, color, or parent_id. Use to rename, recolor, or move into a different parent (pass parent_id=null to move to top-level).

BEFORE: when changing parent, consider calling get_folder on the new parent first to confirm it exists and is not a descendant of the folder being moved (which would create a cycle).`,
      inputSchema: {
        folder_id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        color: z.string().regex(HEX_COLOR).optional(),
        parent_id: z.number().int().positive().nullable().optional().describe("New parent folder id, or null to move to top-level."),
      },
    },
    async ({ folder_id, ...patch }) => {
      try {
        const folder = await client.updateFolder(folder_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(folder, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_folder",
    {
      annotations: DESTRUCTIVE,
      title: "Delete a folder (destructive)",
      description: `Permanently delete a folder. Cannot be undone.

CRITICAL: Confirm with the user verbatim before calling. State the folder name (not id) and the fact that this is permanent.

NESTED CONTENT: server-side behavior with nested folders or assets inside is not enforced from the MCP. Use list_folders with parent_id, and list_assets with folder filter (if available), to surface what would be affected. Clear contents first if the user wants nothing lost.`,
      inputSchema: {
        folder_id: z.number().int().positive(),
      },
    },
    async ({ folder_id }) => {
      try {
        await client.deleteFolder(folder_id);
        return { content: [{ type: "text", text: `Deleted folder ${folder_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
