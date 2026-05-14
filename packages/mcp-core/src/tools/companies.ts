import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerCompanyTools(server: McpServer, client: FollowrClient, _options: RegisterOptions): void {
  server.registerTool(
    "list_companies",
    {
      title: "List Followr companies (workspaces)",
      description:
        "List the Followr workspaces (companies) accessible by the current API token. Use this first when the user asks about a specific workspace by name, to resolve its company_id.",
      inputSchema: {
        query: z.string().optional().describe("Optional name filter (substring match)."),
        page_size: z.number().int().positive().max(100).optional().describe("Items per page. Default 30."),
      },
    },
    async ({ query, page_size }) => {
      const companies = await client.listCompanies({ query, pageSize: page_size });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              companies.map((c) => ({ id: c.id, name: c.name, type: c.type })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_company",
    {
      title: "Get a Followr company (workspace) by id",
      description:
        "Get full details of a Followr workspace, including AI preferences, audience targeting, brand voice fields, and webhook configuration. Use when the user asks about workspace settings.",
      inputSchema: {
        company_id: z.number().int().positive().describe("The Followr company id."),
      },
    },
    async ({ company_id }) => {
      const company = await client.getCompany(company_id);
      // Strip sensitive fields before returning to the AI client.
      const { webhook_secret, ai_keys, ...safeCompany } = company;
      const summary = {
        ...safeCompany,
        webhook_secret_present: Boolean(webhook_secret),
        ai_keys_configured_providers: (ai_keys ?? []).map((k) => k.provider),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  );
}
