import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION, READ_ONLY } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

export function registerRuleGroupTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_rule_groups",
    {
      annotations: READ_ONLY,
      title: "List Autopilot rule groups in a company",
      description: `List rule groups (Autopilot scheduling rules) in a company. A rule group bundles rules that auto-fill empty calendar slots from a pool of tagged PostGroups.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

INCLUDES the underlying rules array by default. Each rule has days_of_week, time_slots, social_network_types, tag filters.

PRESENTING: refer to rule groups by name, never by id. When summarizing schedule patterns to the user, translate days_of_week from numeric (0-6) to names.`,
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
      annotations: READ_ONLY,
      title: "Get a single rule group by id",
      description: `Fetch one Autopilot rule group's details including its rules array. Path is flat (/api/ruleGroups/{id}).

USE BEFORE: update_rule_group (to compute a non-destructive patch) or delete_rule_group (to confirm what is being removed and which scheduled posts came from this group).`,
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
      annotations: MUTATION,
      title: "Create an Autopilot rule group",
      description: `Create a new Autopilot rule group in a company. A rule group bundles auto-scheduling rules that fill empty calendar slots from a tagged pool of PostGroups.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

NEXT STEPS: After creation, individual rules (days_of_week, time_slots, social_network_types, tag filters) must be added separately. This tool only creates the container.

ACTIVATION: active=false by default. Leaving it inactive lets the user configure rules first and toggle on via update_rule_group when ready. Don't set active=true on creation unless the user explicitly wants Autopilot running immediately.

JITTER: random_minutes (0-120) adds randomized offset to scheduled times to avoid bot-like patterns. Default 0. Mention this to the user when relevant.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1),
        description: z.string().optional(),
        active: z
          .boolean()
          .optional()
          .describe(
            "If true, the rule group is active immediately. Default false. NOTE: the backend field is `active` (not `is_active`); passing the wrong name silently leaves the group inactive.",
          ),
        random_minutes: z.number().int().min(0).max(120).optional().describe("Random jitter in minutes applied to scheduled times. Default 0."),
      },
    },
    async ({ company_id, name, description, active, random_minutes }) => {
      try {
        const group = await client.createRuleGroup({
          company_id,
          name,
          ...(description !== undefined ? { description } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(random_minutes !== undefined ? { random_minutes } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "update_rule_group",
    {
      annotations: MUTATION,
      title: "Update an Autopilot rule group",
      description: `Patch a rule group's name, description, active flag, or random jitter.

ACTIVE TOGGLE: setting active=true STARTS the Autopilot for this group, meaning Followr will start auto-scheduling posts on empty calendar slots according to its rules. Confirm with the user verbatim before flipping active=true on a previously inactive group, especially in a company with paying followers or live content.

active=false STOPS new autopilot scheduling but does NOT cancel already-scheduled posts that were filled by this group. Those remain on the calendar.`,
      inputSchema: {
        rule_group_id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        active: z.boolean().optional(),
        random_minutes: z.number().int().min(0).max(120).optional(),
      },
    },
    async ({ rule_group_id, ...patch }) => {
      try {
        const group = await client.updateRuleGroup(rule_group_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(group, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_rule_group",
    {
      annotations: DESTRUCTIVE,
      title: "Delete an Autopilot rule group (destructive)",
      description: `Permanently delete an Autopilot rule group. Cannot be undone.

CRITICAL: Confirm with the user verbatim before calling. State the rule group name (not id) and the fact that this is permanent.

SCOPE: deletion only affects FUTURE autopilot fills. Already-scheduled posts that were filled by this group remain on the calendar (they're now regular scheduled PostGroups, decoupled from the rule group).

ALTERNATIVE: if the user just wants to stop autopilot temporarily, use update_rule_group with active=false. It's reversible; delete is not.`,
      inputSchema: {
        rule_group_id: z.number().int().positive(),
      },
    },
    async ({ rule_group_id }) => {
      try {
        await client.deleteRuleGroup(rule_group_id);
        return { content: [{ type: "text", text: `Deleted rule_group ${rule_group_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
