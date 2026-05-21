import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION, MUTATION_IDEMPOTENT, READ_ONLY } from "../lib/annotations.js";
import { toolErrorFromException } from "../lib/tool-error.js";

export function registerTagTools(server: McpServer, client: FollowrClient, _options: RegisterOptions): void {
  server.registerTool(
    "list_tags",
    {
      annotations: READ_ONLY,
      title: "List tags in a company",
      description: `List all tags for a Followr company. Each tag has id, name, color, active. Tags are scoped to a single company and used for categorizing PostGroups (and as a workaround for approval status via the "Approved" / "Rejected" convention).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE BEFORE: create_tag (to dedupe by name); update_post_group with tags_ids (to compute the REPLACE list correctly); create_autolist (to pick existing_tag_ids vs deciding to create new tags); analyzing autolists (a tag's name + the topics of PostGroups using it are how the agent infers what each Autopilot rule group is "about").

PRESENTING: refer to tags by name, never by id.

PARA HISPANOHABLANTES: lista los tags de la company. Cada autolista se filtra por uno o varios tags, asi que sirve para entender de que va cada autolista mirando los nombres.`,
      inputSchema: {
        company_id: z.number().int().positive(),
      },
    },
    async ({ company_id }) => {
      const tags = await client.listTags(company_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tags.map((t) => ({ id: t.id, name: t.name, color: t.color, active: t.active })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_tag",
    {
      annotations: MUTATION,
      title: "Create a tag in a company",
      description: `Create a new tag in the specified company. Color is optional hex (e.g. #22c55e).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

DEDUPE: prefer find_or_create_tag over create_tag whenever the agent doesn't know if the tag already exists. Creating duplicates clutters the company and can confuse downstream tag-based filters and rule groups.

NAMING: keep tag names short and consistent (no inflections, no emojis unless the user requests). Tag names appear in the Followr UI and on PostGroups.

AUTOLISTS: if the user is creating a brand-new autolist that needs a brand-new tag, prefer create_autolist with new_tags: [{name, color}] over a separate create_tag + create_autolist. The composite tool handles rollback (deletes the tag if the autolist creation fails), whereas the manual two-step flow can leave an orphan tag behind. Use standalone create_tag for tag-only operations (one-off categorization, approval status, etc.).

PARA HISPANOHABLANTES: crear un tag suelto en la company. Si vas a usarlo en una autolista nueva, mejor llamá create_autolist con new_tags inline (hace rollback si falla).`,
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color, e.g. #22c55e"),
      },
    },
    async ({ company_id, name, color }) => {
      try {
        const tag = await client.createTag({ company_id, name, ...(color ? { color } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(tag, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "update_tag",
    {
      annotations: MUTATION,
      title: "Update a tag (rename, change color or active state)",
      description: `Patch a tag's name, color, or active flag.

RENAMING: changing the name affects every PostGroup that uses the tag (they reference by id, so the relationship survives, but the displayed name updates everywhere). Confirm with the user before bulk-renaming tags that are in use.

ACTIVE FLAG: active=false hides the tag from default tag pickers in the Followr UI but does NOT remove it from existing PostGroups.`,
      inputSchema: {
        tag_id: z.number().int().positive(),
        name: z.string().optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        active: z.boolean().optional(),
      },
    },
    async ({ tag_id, ...patch }) => {
      try {
        const tag = await client.updateTag(tag_id, patch);
        return { content: [{ type: "text", text: JSON.stringify(tag, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "delete_tag",
    {
      annotations: DESTRUCTIVE,
      title: "Delete a tag (destructive)",
      description: `Permanently delete a tag. Cannot be undone.

CRITICAL: Confirm with the user verbatim before calling. State the tag name (not id) and the fact that this is permanent.

BROKEN REFERENCES: PostGroups that referenced this tag keep their tags_ids list pointing to the now-deleted tag id. The dangling reference doesn't crash queries but creates UI inconsistencies. Consider update_tag with active=false as a safer alternative if the user just wants to hide the tag.

AUTOLIST IMPACT: if the tag is currently attached to a RuleGroup (autolist), deleting it leaves the autolist with one fewer filter. The autolist itself is NOT deleted, but it will stop catching PostGroups that only had this tag. Surface this to the user if you detected the link via list_rule_groups before calling.

CLEANUP CONTEXT: appropriate when the user explicitly asks to remove a tag, or when an autolist creation flow rolled back and left an orphan tag the user wants to clean up. NOT appropriate as a casual housekeeping action; always confirm first.

PARA HISPANOHABLANTES: borra un tag permanentemente. Si esta vinculado a una autolista, esta sigue existiendo pero pierde ese filtro. Confirmar verbatim por nombre antes de llamar.`,
      inputSchema: {
        tag_id: z.number().int().positive(),
      },
    },
    async ({ tag_id }) => {
      try {
        await client.deleteTag(tag_id);
        return { content: [{ type: "text", text: `Deleted tag ${tag_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "find_or_create_tag",
    {
      annotations: MUTATION_IDEMPOTENT,
      title: "Find a tag by name or create it if it doesn't exist",
      description: `Idempotent helper. Looks up tags in the company by case-insensitive name match. If found, returns its id (and found=true). If not, creates a new tag with the given name and color (and returns found=false).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

PREFER THIS over create_tag whenever the agent isn't certain the tag exists. Safe to call repeatedly without creating duplicates.

USE CASE: building tagging workflows where the same tag (e.g. "Approved", a campaign name, a topic) is applied across many PostGroups over time.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        name: z.string().min(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
    },
    async ({ company_id, name, color }) => {
      try {
        // Indexed lookup by name. The previous implementation listed the whole
        // company's tags and filtered client-side, which missed just-created
        // tags due to read-after-write consistency lag on the list endpoint.
        const matches = await client.listTags(company_id, { name });
        const existing = matches.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          return {
            content: [{ type: "text", text: JSON.stringify({ found: true, tag: existing }, null, 2) }],
          };
        }
        const created = await client.createTag({ company_id, name, ...(color ? { color } : {}) });
        return {
          content: [{ type: "text", text: JSON.stringify({ found: false, tag: created }, null, 2) }],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
