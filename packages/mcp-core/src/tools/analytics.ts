import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

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
      title: "Get per-post metrics for a specific connected social account",
      description:
        "Return per-post analytics for a single connected social network account in a date range. Caller specifies which fields to bring back (reach, impressions, likes, comments, shares, etc.) via the `fields` param. Use get_workspace_summary if you want a roll-up across all connected accounts in one call.",
      inputSchema: {
        social_network_id: z
          .number()
          .int()
          .positive()
          .describe("Connected account id (use list_companies + workspace settings to discover, or list_social_networks once added)."),
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
    "get_workspace_summary",
    {
      title: "Aggregate analytics across every connected account in a workspace",
      description:
        "Iterate over all connected social networks in a workspace and pull per-post metrics for each in the given date range. Returns a map keyed by social network id. Heavy call: makes N requests (one per connected account). Useful for end-of-period reports.",
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
      title: "Find the top performing posts across a workspace by a chosen metric",
      description:
        "Pull per-post analytics for every connected account in a workspace, then flatten and sort by a numeric metric field of your choice (e.g. reach, impressions, engagement). Optionally filter to a single network type. Returns the top N posts.",
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
