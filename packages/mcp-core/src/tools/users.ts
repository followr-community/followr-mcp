import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerUserTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_current_user",
    {
      title: "Get the user that owns the current API token",
      description:
        "Return the Followr user identified by the API token in use: id, name, email, timezone, language, credit balance. Use this at the start of a conversation to anchor 'who am I' and to discover the user's timezone for scheduling decisions.",
      inputSchema: {},
    },
    async () => {
      const me = await client.getMe();
      const safe = {
        id: me.id,
        name: me.name,
        email: me.email,
        timezone: me.timezone,
        language: me.language,
        credits: me.credits,
        has_password: me.has_password,
        created_at: me.created_at,
      };
      return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }] };
    },
  );

  server.registerTool(
    "list_team_users",
    {
      title: "List users with access to a workspace",
      description:
        "List Followr users that have access to a specific workspace (team members). Uses the relation filter `companies.id`. Use to map ownership, find collaborators, or check who created a draft.",
      inputSchema: {
        company_id: z.number().int().positive(),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, page_size }) => {
      const users = await client.listUsersInCompany(company_id, {
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              users.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                timezone: u.timezone,
                language: u.language,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
