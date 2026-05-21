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
      title: "Create an Autopilot rule group (container only)",
      description: `Create a new Autopilot rule group (Autolist container) in a company. A rule group bundles slots (rules) that auto-fill empty calendar slots from a tagged pool of PostGroups.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

THIS IS THE CONTAINER ONLY. After creation, add the individual slots (day + time) with create_rule. Or, prefer create_autolist which does the whole atomic flow (container + tags + slots) in a single call.

ACTIVATION: active=false by default. Leaving it inactive lets the user configure rules first and toggle on via update_rule_group when ready. Don't set active=true on creation unless the user explicitly wants Autopilot running immediately.

TAGS (tags_ids): optional inline association of one or more Tags to the new rule group (many-to-many). If empty, the rule group has no posts to feed on until tags are attached later via update_rule_group. CONFLICT WARNING: a tag may belong to at most ONE active rule group at a time; the backend returns 422 "the same tags applied" if you try to grab a tag already taken by another active group. Preflight with list_rule_groups when in doubt.

JITTER: random_minutes (0-120) adds randomized offset to scheduled times to avoid bot-like patterns. Default 0.

POSTS_ACTIVE_FROM: ISO 8601 cutoff. PostGroups created before this timestamp are NOT eligible for this autolist, even if they match the tags. UI default is company.created_at (every post is eligible). Useful to scope an autolist to "only posts from campaign launch onwards".`,
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
        posts_active_from: z.string().optional().describe(
          "ISO 8601 UTC timestamp. Eligibility cutoff for PostGroups. UI default is company.created_at.",
        ),
        tags_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            "Optional list of tag ids to associate inline. Each tag may only belong to one active rule group at a time (backend constraint).",
          ),
      },
    },
    async ({ company_id, name, description, active, random_minutes, posts_active_from, tags_ids }) => {
      try {
        const group = await client.createRuleGroup({
          company_id,
          name,
          ...(description !== undefined ? { description } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(random_minutes !== undefined ? { random_minutes } : {}),
          ...(posts_active_from !== undefined ? { posts_active_from } : {}),
          ...(tags_ids !== undefined ? { tags_ids } : {}),
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
      title: "Update an Autopilot rule group (container only)",
      description: `Patch a rule group's container fields: name, description, active flag, random jitter, posts_active_from cutoff, OR the set of associated tags. Does NOT touch the slots (rules) inside. For slots use create_rule / delete_rule.

ACTIVE TOGGLE: setting active=true STARTS the Autopilot for this group. Followr will start auto-scheduling posts on empty calendar slots according to its rules. Confirm with the user verbatim before flipping active=true on a previously inactive group, especially in a live workspace. active=false STOPS new autopilot scheduling but does NOT cancel already-scheduled posts that were filled by this group; those remain on the calendar.

TAG ASSOCIATION (tags_ids): REPLACE semantics, same as update_post_group. To add a tag without losing existing ones, first call get_rule_group, build the union of current tags + new id, and pass the FULL list. Forgetting this silently detaches the existing tags.

CONFLICT WARNING: a Tag can belong to at MOST ONE active rule group at a time. If you set tags_ids that overlap with another ACTIVE rule group's tags, the backend rejects with 422 "the same tags applied". Preflight by calling list_rule_groups and checking for overlap before this call.`,
      inputSchema: {
        rule_group_id: z.number().int().positive(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        active: z.boolean().optional(),
        random_minutes: z.number().int().min(0).max(120).optional(),
        posts_active_from: z.string().optional().describe(
          "ISO 8601 UTC timestamp. Cutoff for which PostGroups are eligible to be picked up by this autolist (post must be created on/after this timestamp). UI default is the company.created_at.",
        ),
        tags_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            "FULL list of tag ids. REPLACE semantics, not append. To add one tag, compute the union of existing tags + the new id and pass the whole list.",
          ),
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
      description: `Permanently delete an Autopilot rule group AND all its slots (rules) in cascade. Cannot be undone.

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

  // ────────────────────────────────────────────────────────────
  // Individual slots (rules) inside a RuleGroup
  // ────────────────────────────────────────────────────────────

  server.registerTool(
    "create_rule",
    {
      annotations: MUTATION,
      title: "Create a slot (rule) inside an Autopilot rule group",
      description: `Add a single timing slot to an existing Autopilot rule group. Each slot defines ONE day-of-week + ONE time. To cover multiple days/times, call this tool once per (day, time) pair.

PRECONDITION: rule_group_id must reference an existing rule group. Get it from list_rule_groups or the response of create_rule_group / create_autolist.

DAY_OF_WEEK: ISO 8601 numeric. 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun. When showing the schedule to the user, translate back to day names.

TIME: "HH:MM" in UTC (no seconds). If the user gives a local time, translate to UTC explicitly using the company timezone and surface the conversion (e.g. "10am Buenos Aires = 13:00 UTC"). The backend response normalizes to "HH:MM:SS"; that's fine.

FREQUENCY: three values confirmed accepted by the backend (verified 2026-05-21 with empirical POSTs against VCP). The Followr web UI only exposes "weekly", but the backend also accepts:
- "weekly" (default): pair with day_of_week (1-7 ISO). Fires every <day> at <time>.
- "monthly": pair with day_of_month (1-31). Fires once a month on that day at <time>. Optional week_of_month + day_of_week for "3rd Monday" style cadence (not verified empirically yet).
- "daily": pair with nothing else. Fires every day at <time>. Useful for "story-a-day" cadences.
Any other value (e.g. "fortnightly") returns 422 "The selected frequency is invalid".

PARA HISPANOHABLANTES: agregar un horario (un dia + una hora) a una autolista existente. Cada llamada agrega UN slot; para varios dias/horarios llamar varias veces.`,
      inputSchema: {
        rule_group_id: z.number().int().positive().describe("Id of the parent RuleGroup. Maps to backend field `group_id` in the request; the response uses `rule_group_id`."),
        frequency: z
          .enum(["weekly"])
          .default("weekly")
          .describe(
            "Only `weekly` is supported by the Followr UI. Backend ALSO accepts `daily` and `monthly` (with day_of_month or week_of_month+day_of_week), but those crash the Followr web UI rendering the entire /autopilot/rules page (TypeError moment.utc().day(null).hour, verified 2026-05-21 on VCP). Until Followr fixes the front, the MCP restricts this enum to weekly only to keep the user's UI usable.",
          ),
        day_of_week: z
          .number()
          .int()
          .min(1)
          .max(7)
          .describe("ISO 8601: 1=Mon..7=Sun. Required."),
        time: z
          .string()
          .regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, "Must be HH:MM in 24h")
          .describe("HH:MM in UTC, no seconds. REQUIRED by the backend; 422 'The time field is required.' if omitted."),
        posts_active_from: z
          .string()
          .optional()
          .describe(
            "Per-slot eligibility cutoff (ISO 8601). Usually null; the rule group's posts_active_from already filters. Use only if a specific slot has a different cutoff.",
          ),
      },
    },
    async ({ rule_group_id, frequency, day_of_week, time, posts_active_from }) => {
      try {
        // ⚠️ Defensive runtime guard. Zod already restricts to "weekly" and
        // the client throws too, but a triple-check costs nothing and protects
        // the user's UI from regressions where any one of those layers gets
        // relaxed by accident.
        if (frequency !== "weekly") {
          throw new Error(
            `frequency must be "weekly". The Followr web UI crashes (blank screen on /autopilot/rules) when it encounters a rule with day_of_week=null, which is what daily and monthly rules produce. This restriction is permanent until the Followr frontend fixes that render path. Verified empirically 2026-05-21.`,
          );
        }
        const rule = await client.createRule({
          group_id: rule_group_id,
          frequency,
          day_of_week,
          time,
          ...(posts_active_from !== undefined ? { posts_active_from } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(rule, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "update_rule",
    {
      annotations: MUTATION,
      title: "Update a single slot (rule) inside an Autopilot rule group",
      description: `Edit a slot in place. Accepts partial PATCH-style body: pass only the fields that change. Verified 2026-05-21 against VCP with body \`{time: "15:30"}\` alone, returns 200 with the updated Rule.

PREFER OVER delete_rule + create_rule WHEN: just changing one or two fields (time, day, frequency). 1 round trip vs 2, preserves the slot id which is nicer for audit logs and any UI that pins to that id. The Followr web UI itself does delete-and-recreate, but the MCP doesn't have to.

USE delete_rule + create_rule WHEN: replacing the slot entirely (different frequency that requires different day fields, e.g. weekly→monthly). Cleaner to delete and recreate so the unused fields don't drag along.

FREQUENCY CHANGES: if you change frequency from weekly to monthly, the previous day_of_week becomes meaningless; pass day_of_month explicitly. The backend keeps the old field around (does not auto-null), so be explicit.

PARA HISPANOHABLANTES: editar un slot existente sin tener que borrarlo y recrearlo. Mas eficiente cuando solo cambia la hora o el dia.`,
      inputSchema: {
        rule_id: z.number().int().positive(),
        frequency: z
          .enum(["weekly"])
          .optional()
          .describe(
            "Only `weekly` is supported by the Followr UI. Backend accepts daily/monthly but the UI crashes (see create_rule notes).",
          ),
        day_of_week: z.number().int().min(1).max(7).optional(),
        time: z
          .string()
          .regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, "Must be HH:MM in 24h")
          .optional(),
        posts_active_from: z.string().nullable().optional(),
      },
    },
    async ({ rule_id, ...patch }) => {
      try {
        // ⚠️ Defensive runtime guard. See create_rule handler note.
        if (patch.frequency !== undefined && patch.frequency !== "weekly") {
          throw new Error(
            `frequency must be "weekly" (or omitted). The Followr web UI crashes on non-weekly rules. See create_rule for the full explanation. This restriction is permanent until the Followr frontend fixes the day_of_week=null render path.`,
          );
        }
        const rule = await client.updateRule(rule_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(rule, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_rule",
    {
      annotations: DESTRUCTIVE,
      title: "Delete a single slot (rule) from a rule group",
      description: `Remove ONE slot (day + time) from an Autopilot rule group. Cannot be undone. The parent rule group keeps existing.

USE WHEN: the user wants to remove just one scheduled time (e.g. "stop posting Friday 4pm"). For a full reset of slots, call this once per slot to delete, then create_rule for the new ones (the Followr UI does delete-and-recreate to edit slots).

CRITICAL: confirm with the user verbatim by describing the slot in human terms (day name + local time), never by raw id. Example: "About to remove the Friday 4:30pm slot from the Lifestile autolist, confirmá?".

PARA HISPANOHABLANTES: eliminar un horario puntual de una autolista. La autolista sigue existiendo.`,
      inputSchema: {
        rule_id: z.number().int().positive(),
      },
    },
    async ({ rule_id }) => {
      try {
        await client.deleteRule(rule_id);
        return { content: [{ type: "text", text: `Deleted rule ${rule_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
