import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";

export function registerCompanyTools(server: McpServer, client: FollowrClient, _options: RegisterOptions): void {
  server.registerTool(
    "list_companies",
    {
      annotations: READ_ONLY,
      title: "List Followr companies",
      description: `List the Followr companies (companies) accessible by the current API token. Each entry returns { id, name, type }.

PREFER get_session_context for session bootstrapping. It returns the same company list plus user info, credit balance, and a pre-formatted _assistant_guidance block (user_facing_options, id_lookup, next_step) in one call. Use list_companies only when you specifically need just the company list (e.g. mid-session lookup, refresh after a company was added).

PRESENTING TO THE USER: when more than one company is returned, present the options by NAME (not by id). Example: "Tenés acceso a 'PostApprove', 'Empresa B' y 'Empresa C'. ¿En cuál querés trabajar?". Use the id only inside subsequent tool calls, never in user-facing text.

STICKY CONTEXT: once the user picks a company, reuse that company_id for the rest of the conversation without re-asking, unless the user explicitly switches companies.`,
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
      annotations: READ_ONLY,
      title: "Get a Followr company by id",
      description: `Get full details of a Followr company: name, description, audience targeting, AI preferences, brand voice fields, social_network_prompts, ai_keys configured providers, menu_visibility, webhook config.

USE WHEN: the user asks about company settings; OR the agent needs creative context (brand voice, audience, social_network_prompts) to redact content well. Call this before generating posts so the output matches the company's voice and audience.

PRECONDITION: company_id required. If the user has multiple companies and hasn't named one, call list_companies first and ask.

SENSITIVE FIELDS: webhook_secret and ai_keys are stripped from the response (only presence/providers are returned). Don't ask for them back; they cannot be read.`,
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
