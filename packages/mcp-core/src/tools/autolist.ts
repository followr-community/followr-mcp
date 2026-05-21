import { FollowrClient } from "@followr-mcp/shared";
import type { Rule, RuleGroup } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

/**
 * High-level composite tool: create_autolist.
 *
 * One atomic call to spin up a complete Autopilot autolist in Followr:
 *  - optionally create one or more new tags
 *  - create the RuleGroup (container) with all tags attached inline
 *  - create N slot rules in parallel (one per day/time the user wants)
 *  - if anything fails mid-flow, roll back everything created so far so the
 *    workspace is left in its original state.
 *
 * Endpoints used (all verified empirically on VCP 2026-05-21 via Chrome MCP):
 *  POST /api/tags
 *  POST /api/ruleGroups  (with tags_ids[] inline)
 *  POST /api/rules       (with group_id, frequency, day_of_week, time)
 *
 * Backend constraint surfaced upfront: a tag can belong to at most ONE active
 * RuleGroup at a time. If active=true and the requested tags overlap with an
 * already-active group, the tool preflights via list_rule_groups and returns
 * a clear, user-readable error before any mutation runs.
 */
export function registerAutolistTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "create_autolist",
    {
      annotations: MUTATION,
      title: "Create a complete Autolist atomically (tags + container + slots)",
      description: `Spin up a complete Autopilot autolist (RuleGroup) in one call. Composes the work of create_tag (optional, for brand-new tags), create_rule_group (container), and create_rule (one per slot) into a single atomic transaction with rollback on failure.

WHEN TO USE: the user wants a new autolist set up end-to-end. Examples: "armame una autolist de promos los martes y jueves", "create an autolist for product launches", "set up a weekly content rotation for lifestyle posts".

PARA HISPANOHABLANTES: crear una autolista completa de Autopilot en una sola llamada. Asocia tags existentes o crea tags nuevos, configura los horarios (slots) y deja todo listo. Si algo falla, deshace todo lo que creó.

TAGS: pass either existing_tag_ids (already-created tags to associate), new_tags (specs to create from scratch), or both. The new ones are created first; the rule group ends up with the union. If the autolist will start active=true, the tool preflights for tag conflicts against other active rule groups (a tag may belong to only one active group at a time) and aborts before mutating.

SLOTS: each slot defines ONE (day_of_week, time) pair. Pass an array of slots for a weekly cadence with N posting times. Times must be HH:MM in UTC; translate from the user's local time explicitly and surface the conversion to them.

ACTIVATION: default active=false. Recommended pattern: create inactive, show the user what was built, then call update_rule_group with active=true after their explicit confirmation. Setting active=true here is OK if the user already gave clear consent and there are no tag conflicts.

ROLLBACK: on any failure (slot creation rejected, conflict detected late, etc.) the tool deletes everything it created in reverse order: slots → rule group → newly-created tags. Tags passed as existing_tag_ids are never deleted. The error message reports what was rolled back and what couldn't be.

POST-CREATION: the new autolist will only schedule PostGroups that (a) have at least one of the attached tags, (b) have draft=false, (c) have publish_at=null, (d) were created on/after posts_active_from. To feed it, create PostGroups with one of those tags (use update_post_group with tags_ids REPLACE semantics if adding tags to existing PostGroups).`,
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1).describe("User-facing name of the autolist, e.g. 'Lifestyle Reels', 'Promo Producto Halo', 'Daily Brand Story'."),
        description: z.string().optional(),
        active: z
          .boolean()
          .optional()
          .describe("If true, autolist starts scheduling immediately on confirmation. Default false (recommended). Only set true after explicit user consent."),
        random_minutes: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe("Random jitter in minutes around each scheduled time. Default 0 (exact)."),
        posts_active_from: z
          .string()
          .optional()
          .describe("ISO 8601 UTC timestamp. PostGroups created before this date are NOT eligible. If omitted, the backend default is company.created_at (every existing post is eligible)."),
        existing_tag_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe("Ids of tags that already exist in this company. Get them from list_tags."),
        new_tags: z
          .array(
            z.object({
              name: z.string().min(1),
              color: z
                .string()
                .regex(/^#[0-9A-Fa-f]{6}$/)
                .optional()
                .describe("Hex color #RRGGBB. Picks one matching the brand palette if omitted is up to the backend."),
            }),
          )
          .optional()
          .describe("Tags to create from scratch as part of this autolist setup. If the create succeeds but a later step fails, these tags are deleted as part of rollback."),
        slots: z
          .array(
            z.object({
              frequency: z
                .enum(["weekly"])
                .default("weekly")
                .describe(
                  "Only 'weekly' is supported by the Followr UI. Backend ALSO accepts 'daily' and 'monthly' but those CRASH the Followr web UI (TypeError moment.utc().day(null).hour, verified 2026-05-21 on VCP), leaving the entire /autopilot/rules page blank for the user. The MCP restricts to weekly until Followr fixes the front.",
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
                .describe("HH:MM in UTC. REQUIRED."),
            }),
          )
          .min(1)
          .describe("At least one slot. For a weekly cadence with several posting times, pass multiple slots."),
      },
    },
    async ({
      company_id,
      name,
      description,
      active,
      random_minutes,
      posts_active_from,
      existing_tag_ids,
      new_tags,
      slots,
    }) => {
      const allTagIds: number[] = [...(existing_tag_ids ?? [])];
      const createdTagIds: number[] = [];
      let createdRuleGroup: RuleGroup | null = null;
      const createdRules: Rule[] = [];

      const willBeActive = active === true;

      try {
        // ── Step 1: preflight conflict check if going live ──
        // A tag can belong to only one ACTIVE rule group. We surface conflicts
        // upfront so the user sees a clean error before any mutation.
        if (willBeActive && allTagIds.length > 0) {
          const existingGroups = await client.listRuleGroups(company_id, { include: "tags" });
          const conflicts: Array<{ tagId: number; rgName: string; rgId: number }> = [];
          for (const rg of existingGroups) {
            if (!rg.active) continue;
            const rgTagIds = (rg.tags ?? []).map((t) => t.id);
            for (const tid of allTagIds) {
              if (rgTagIds.includes(tid)) {
                conflicts.push({ tagId: tid, rgName: rg.name, rgId: rg.id });
              }
            }
          }
          if (conflicts.length > 0) {
            const summary = conflicts
              .map((c) => `tag id ${c.tagId} is already in active rule group '${c.rgName}' (id ${c.rgId})`)
              .join("; ");
            throw new Error(
              `Conflict on active autolist creation: ${summary}. A tag may belong to only ONE active rule group. Either (a) deactivate the conflicting group first via update_rule_group, (b) use a different tag, or (c) create this autolist with active=false (it will not steal tags).`,
            );
          }
        }

        // ── Step 2: create any brand-new tags ──
        if (new_tags && new_tags.length > 0) {
          for (const spec of new_tags) {
            const tag = await client.createTag({
              company_id,
              name: spec.name,
              ...(spec.color !== undefined ? { color: spec.color } : {}),
            });
            allTagIds.push(tag.id);
            createdTagIds.push(tag.id);
          }
        }

        // ── Step 3: create the RuleGroup container with tags_ids inline ──
        createdRuleGroup = await client.createRuleGroup({
          company_id,
          name,
          ...(description !== undefined ? { description } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(random_minutes !== undefined ? { random_minutes } : {}),
          ...(posts_active_from !== undefined ? { posts_active_from } : {}),
          ...(allTagIds.length > 0 ? { tags_ids: allTagIds } : {}),
        });

        // ── Step 4: create N slot rules in parallel ──
        //
        // ⚠️ Defensive runtime guard before fan-out. Zod already restricts
        // each slot's frequency to "weekly" and the client throws on anything
        // else, but a triple-check protects the user's UI from regressions.
        // See create_rule handler note for the full explanation.
        for (const slot of slots) {
          if (slot.frequency !== "weekly") {
            throw new Error(
              `slot.frequency must be "weekly" for every slot. The Followr web UI crashes (blank /autopilot/rules screen) on non-weekly rules. This restriction is permanent until the Followr frontend fixes the day_of_week=null render path.`,
            );
          }
        }
        const slotResults = await Promise.allSettled(
          slots.map((slot) =>
            client.createRule({
              group_id: createdRuleGroup!.id,
              frequency: slot.frequency,
              day_of_week: slot.day_of_week,
              time: slot.time,
            }),
          ),
        );

        const slotFailures = slotResults.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        const slotSuccesses = slotResults.filter(
          (r): r is PromiseFulfilledResult<Rule> => r.status === "fulfilled",
        );
        createdRules.push(...slotSuccesses.map((r) => r.value));

        if (slotFailures.length > 0) {
          const reasons = slotFailures
            .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
            .join("; ");
          throw new Error(`${slotFailures.length} of ${slots.length} slots failed to create: ${reasons}`);
        }

        // ── Step 5: return summary ──
        const summary = {
          rule_group: createdRuleGroup,
          tags_attached_ids: allTagIds,
          tags_created_in_this_call_ids: createdTagIds,
          slots: createdRules,
          status_note: willBeActive
            ? "ACTIVE. Pending PostGroups with matching tags will start being scheduled by Followr's Autopilot."
            : "INACTIVE. Toggle active=true via update_rule_group when ready. The user should confirm verbatim before activating.",
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        // ── Rollback in reverse order: slots → rule_group → newly-created tags ──
        const rollback: string[] = [];
        for (const rule of createdRules) {
          try {
            await client.deleteRule(rule.id);
            rollback.push(`deleted rule ${rule.id}`);
          } catch (e) {
            rollback.push(`FAILED to delete rule ${rule.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (createdRuleGroup) {
          try {
            await client.deleteRuleGroup(createdRuleGroup.id);
            rollback.push(`deleted rule_group ${createdRuleGroup.id}`);
          } catch (e) {
            rollback.push(
              `FAILED to delete rule_group ${createdRuleGroup.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        for (const tagId of createdTagIds) {
          try {
            await client.deleteTag(tagId);
            rollback.push(`deleted tag ${tagId}`);
          } catch (e) {
            rollback.push(`FAILED to delete tag ${tagId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const message = `create_autolist failed: ${err instanceof Error ? err.message : String(err)}. Rollback: ${rollback.length > 0 ? rollback.join("; ") : "nothing to undo"}.`;
        return toolErrorFromException(new Error(message));
      }
    },
  );
}
