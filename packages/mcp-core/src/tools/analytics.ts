import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";

// Loose shape for a connected social network. listSocialNetworks returns unknown[];
// we only need id / type / status to drive the aggregation tools.
interface SocialNetworkLite {
  id: number;
  type?: string;
  status?: string | null;
}

function readNumber(record: unknown, field: string): number | null {
  if (record && typeof record === "object" && field in record) {
    // Field access on an unknown record: typed via 'in' guard. Casting required.
    const value = (record as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

export function registerAnalyticsTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_post_analytics",
    {
      annotations: READ_ONLY,
      title: "Get per-post metrics for a specific connected social account",
      description: `Return per-post analytics for a single connected social network account in a date range.

INPUT: social_network_id is the id of a CONNECTED ACCOUNT (e.g. a specific Instagram page in the company), not the network type. To resolve it, the agent may need to inspect get_company or related tooling that lists company connections.

FIELDS: caller specifies which metrics to bring back (reach, impressions, likes, comments, shares, etc.) via the fields param. Provider-specific; omit for a default set.

DATE RANGE: since and until are ISO 8601. When the user uses verbal ranges ("last week"), translate to the company timezone explicitly before calling.

ALTERNATIVE: get_company_summary for a roll-up across all connected accounts in one call (heavier, useful for end-of-period reports).`,
      inputSchema: {
        social_network_id: z
          .number()
          .int()
          .positive()
          .describe("Connected account id (use list_companies + company settings to discover, or list_social_networks once added)."),
        since: z.string().describe("ISO 8601 lower bound (inclusive)."),
        until: z.string().describe("ISO 8601 upper bound (inclusive)."),
        fields: z
          .string()
          .optional()
          .describe("Comma-separated list of metric fields to include. Provider-specific. Omit for default set."),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ social_network_id, since, until, fields, limit }) => {
      const metrics = await client.listSocialNetworkPostMetrics(social_network_id, {
        since,
        until,
        ...(fields ? { fields } : {}),
        ...(limit ? { limit } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }] };
    },
  );

  server.registerTool(
    "get_company_summary",
    {
      annotations: READ_ONLY,
      title: "Aggregate analytics across every connected account in a company",
      description: `Iterate over all connected social networks in a company and pull per-post metrics for each in the given date range. Returns one entry per connected account with its metrics array.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

HEAVY: makes N parallel requests (one per connected account). For companies with 5-10 networks this is fine; for very large setups consider get_post_analytics on a single account first.

DATE RANGE: since and until are ISO 8601. Translate verbal ranges to the company timezone explicitly before calling.

PARTIAL FAILURES: if a single network's metrics request fails, its entry includes an error field instead of metrics. The overall call still succeeds; surface failed networks to the user transparently.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        since: z.string().describe("ISO 8601 lower bound."),
        until: z.string().describe("ISO 8601 upper bound."),
        fields: z.string().optional().describe("Comma-separated metric fields. Provider-specific."),
        limit_per_network: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ company_id, since, until, fields, limit_per_network }) => {
      const networks = (await client.listSocialNetworks(company_id)) as SocialNetworkLite[];
      const perNetwork = await Promise.all(
        networks.map(async (n) => {
          try {
            const metrics = await client.listSocialNetworkPostMetrics(n.id, {
              since,
              until,
              ...(fields ? { fields } : {}),
              ...(limit_per_network ? { limit: limit_per_network } : {}),
            });
            return {
              social_network_id: n.id,
              type: n.type ?? null,
              status: n.status ?? null,
              post_count: metrics.length,
              metrics,
            };
          } catch (err) {
            return {
              social_network_id: n.id,
              type: n.type ?? null,
              status: n.status ?? null,
              post_count: 0,
              error: err instanceof Error ? err.message : String(err),
              metrics: [] as unknown[],
            };
          }
        }),
      );
      return { content: [{ type: "text", text: JSON.stringify(perNetwork, null, 2) }] };
    },
  );

  server.registerTool(
    "get_best_performing_posts",
    {
      annotations: READ_ONLY,
      title: "Find the top performing posts across a company by a chosen metric",
      description: `Pull per-post analytics for every connected account in a company, flatten, and sort by a numeric metric field of your choice (e.g. reach, impressions, likes, engagement). Returns the top N posts.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE FOR: end-of-period highlights ("what worked best last month?"); informing future content strategy by surfacing patterns from top performers; feeding examples to generate_text when asking the AI to "redact in our most successful style".

SORT_BY: must be a numeric metric field that the provider returns. Common: reach, impressions, likes, engagement. If unsure, call get_company_summary first to inspect available fields.

FILTERS: network_type optionally narrows to one network (instagram, facebook, etc.). top_n defaults to 10.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        since: z.string().describe("ISO 8601 lower bound."),
        until: z.string().describe("ISO 8601 upper bound."),
        sort_by: z
          .string()
          .describe("Numeric metric field to sort by (provider-specific). Common: reach, impressions, likes, engagement."),
        network_type: z
          .string()
          .optional()
          .describe("Optional filter to a single network type (instagram, facebook, etc.)."),
        top_n: z.number().int().positive().max(100).optional().describe("Number of top posts to return. Default 10."),
        fields: z.string().optional().describe("Comma-separated metric fields to bring back (must include sort_by)."),
      },
    },
    async ({ company_id, since, until, sort_by, network_type, top_n, fields }) => {
      const networks = (await client.listSocialNetworks(company_id)) as SocialNetworkLite[];
      const filtered = network_type ? networks.filter((n) => n.type === network_type) : networks;
      const all: Array<{ social_network_id: number; type: string | null; post: unknown; sort_value: number | null }> = [];
      await Promise.all(
        filtered.map(async (n) => {
          try {
            const metrics = await client.listSocialNetworkPostMetrics(n.id, {
              since,
              until,
              ...(fields ? { fields } : {}),
            });
            for (const post of metrics) {
              all.push({
                social_network_id: n.id,
                type: n.type ?? null,
                post,
                sort_value: readNumber(post, sort_by),
              });
            }
          } catch {
            // skip networks that fail; surfaced indirectly via missing data
          }
        }),
      );
      all.sort((a, b) => {
        // Nulls go to the end.
        if (a.sort_value === null && b.sort_value === null) return 0;
        if (a.sort_value === null) return 1;
        if (b.sort_value === null) return -1;
        return b.sort_value - a.sort_value;
      });
      const top = all.slice(0, top_n ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(top, null, 2) }] };
    },
  );
}
