import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";

export function registerUserTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_current_user",
    {
      annotations: READ_ONLY,
      title: "Get the user that owns the current API token",
      description: `Return the Followr user identified by the API token in use: id, name, email, timezone, language, credit balance, password presence, created_at.

USE AT START of a conversation to anchor "who am I" and to discover the user's timezone for scheduling decisions. The timezone returned here is the DEFAULT to assume for verbal time references ("9 AM", "tomorrow") unless the user states a different one.

Combined with list_companies, this is the foundation for orienting any Followr session: who the user is, which companies they can access, and what timezone to use for time math.`,
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
      annotations: READ_ONLY,
      title: "List users with access to a company",
      description: `List Followr users that have access to a specific company (team members). Returns each user's id, name, email, timezone, language.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE FOR: mapping ownership ("who created this draft?"), finding collaborators, checking who else operates in the company before making team-visible changes (e.g. set_menu_visibility).

PRESENTING: refer to users by name (or email if name is empty), never by id.`,
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
