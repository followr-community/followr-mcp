import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerRuleGroupTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_rule_groups",
    {
      title: "List Autopilot rule groups in a workspace",
      description:
        "List rule groups (Autopilot scheduling rules) in a workspace. A rule group bundles rules that auto-fill empty calendar slots from a pool of tagged PostGroups. Includes the underlying rules array by default.",
      inputSchema: {
        company_id: z.number().int().positive(),
        include: z.string().optional().describe("Override include chain. Default: rules."),
      },
    },
    async ({ company_id, include }) => {
      const groups = await client.listRuleGroups(company_id, {
        include: include ?? "rules",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              groups.map((g) => ({
                id: g.id,
                name: g.name,
                description: g.description,
                active: g.active,
                random_minutes: g.random_minutes,
                rules_count: g.rules?.length ?? 0,
                rules: g.rules,
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
    "get_rule_group",
    {
      title: "Get a single rule group by id",
      description: "Fetch one Autopilot rule group's details. Path is flat (/api/ruleGroups/{id}).",
      inputSchema: {
        rule_group_id: z.number().int().positive(),
      },
    },
    async ({ rule_group_id }) => {
      const group = await client.getRuleGroup(rule_group_id);
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    },
  );

  server.registerTool(
    "create_rule_group",
    {
      title: "Create an Autopilot rule group",
      description:
        "Create a new Autopilot rule group in a workspace. After creation, individual rules (days_of_week, time_slots, social_network_types, tag filters) must be added separately. random_minutes adds jitter to scheduled times to avoid bot-like patterns.",
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1),
        description: z.string().optional(),
        is_active: z.boolean().optional().describe("If true, the rule group is active immediately. Default false."),
        random_minutes: z.number().int().min(0).max(120).optional().describe("Random jitter in minutes applied to scheduled times. Default 0."),
      },
    },
    async ({ company_id, name, description, is_active, random_minutes }) => {
      const group = await client.createRuleGroup({
        company_id,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(is_active !== undefined ? { is_active } : {}),
        ...(random_minutes !== undefined ? { random_minutes } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    },
  );

  server.registerTool(
    "update_rule_group",
    {
      title: "Update an Autopilot rule group",
      description: "Patch a rule group's name, description, active flag, or random jitter.",
      inputSchema: {
        rule_group_id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        active: z.boolean().optional(),
        random_minutes: z.number().int().min(0).max(120).optional(),
      },
    },
    async ({ rule_group_id, ...patch }) => {
      const group = await client.updateRuleGroup(rule_group_id, patch);
      return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
    },
  );

  server.registerTool(
    "delete_rule_group",
    {
      title: "Delete an Autopilot rule group (destructive)",
      description:
        "Permanently delete an Autopilot rule group. Already-scheduled posts that were filled by this group will remain on the calendar (deletion only affects future autopilot fills). Cannot be undone.",
      inputSchema: {
        rule_group_id: z.number().int().positive(),
      },
    },
    async ({ rule_group_id }) => {
      await client.deleteRuleGroup(rule_group_id);
      return { content: [{ type: "text", text: `Deleted rule_group ${rule_group_id}.` }] };
    },
  );
}
