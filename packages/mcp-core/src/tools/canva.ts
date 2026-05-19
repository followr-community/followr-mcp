import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY_EXTERNAL } from "../lib/annotations.js";
import { toolError, ToolErrorException, toolErrorFromException } from "../lib/tool-error.js";

// Loose shape of an export job poll response. status terminal: "success" | "failed".
// Verified empirically 2026-05-17: backend returns `{id, status, urls}` (not job_id).
// Terminal success status is "success" (not "completed").
interface CanvaExportJobLite {
  id?: string;
  status?: string;
  urls?: string[];
  url?: string;
  error?: unknown;
}

const CANVA_TERMINAL_SUCCESS = "success";
const CANVA_TERMINAL_FAILED = "failed";

function isTerminal(status: string | undefined): boolean {
  return status === CANVA_TERMINAL_SUCCESS || status === CANVA_TERMINAL_FAILED;
}

async function pollExportJob(
  client: FollowrClient,
  companyId: number,
  jobId: string,
  options: { timeoutMs: number; intervalMs: number },
): Promise<CanvaExportJobLite> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const raw = (await client.getCanvaDesignExportJob(companyId, jobId)) as CanvaExportJobLite;
    if (isTerminal(raw.status)) return raw;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new ToolErrorException(
    toolError({
      reason: "canva_export_timeout",
      user_message: `Canva export job did not complete within ${Math.round(options.timeoutMs / 1000)} seconds.`,
      suggested_actions: [
        {
          rationale:
            "Retry with a longer timeout_seconds. Complex designs (many pages, video) can take up to 3 minutes.",
        },
        {
          rationale:
            "If the same design times out repeatedly, the issue is on Canva's side. Check if the design opens in the Canva editor.",
        },
      ],
      details: {
        job_id: jobId,
        timeout_ms: options.timeoutMs,
      },
    }),
  );
}

function urlsFromExportJob(job: CanvaExportJobLite): string[] {
  if (Array.isArray(job.urls) && job.urls.length > 0) return job.urls;
  if (typeof job.url === "string" && job.url) return [job.url];
  return [];
}

async function uploadExportedPageAsAsset(
  client: FollowrClient,
  companyId: number,
  pageUrl: string,
  pageIndex: number,
  designId: string,
  type: "image" | "video",
): Promise<number> {
  const downloadResp = await fetch(pageUrl);
  if (!downloadResp.ok) {
    throw new ToolErrorException(
      toolError({
        reason: "canva_page_download_failed",
        user_message: `Failed to download exported page ${pageIndex + 1} of the Canva design (HTTP ${downloadResp.status} ${downloadResp.statusText}). The Canva CDN may be having issues.`,
        suggested_actions: [
          {
            rationale:
              "Retry the workflow; Canva CDN issues are usually transient. The export job (which consumes a Canva API call) succeeded, but the downloads failed midway.",
          },
        ],
        details: {
          page_index: pageIndex,
          page_url: pageUrl,
          design_id: designId,
          http_status: downloadResp.status,
          http_status_text: downloadResp.statusText,
        },
      }),
    );
  }
  const contentType =
    downloadResp.headers.get("content-type") ?? (type === "image" ? "image/jpeg" : "video/mp4");
  const buffer = await downloadResp.arrayBuffer();
  const ext = type === "image" ? "jpg" : "mp4";
  const filename = `canva-${designId}-page-${pageIndex + 1}.${ext}`;
  const asset = await client.createAsset(companyId, { name: filename, type });
  const upload = await client.requestAssetUpload(asset.id, type, {
    filename,
    type,
    visibility: "public",
  });
  await client.uploadToBlob(upload.presigned_url, buffer, contentType);
  return asset.id;
}

export function registerCanvaTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_canva_designs",
    {
      annotations: READ_ONLY_EXTERNAL,
      title: "List Canva designs available to the company",
      description: `List Canva designs that the company's connected Canva account can access. Returns id, title, page count, thumbnail, and Canva edit/view URLs.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name. Requires Canva OAuth to be connected for the company; if not connected, the call fails. Surface that to the user with a pointer to connect Canva in the Followr UI.

FILTERS: search is a substring match against title.

PRESENTING: refer to designs by title. Include the thumbnail URL or view_url when offering options to the user so they can visually identify the design.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        search: z.string().optional().describe("Substring match on design title."),
        limit: z.number().int().positive().max(100).optional(),
        continuation_token: z.string().optional().describe("Cursor for next page (from prior response)."),
      },
    },
    async ({ company_id, search, limit, continuation_token }) => {
      const designs = await client.listCanvaDesigns(company_id, {
        ...(search ? { search } : {}),
        ...(limit ? { limit } : {}),
        ...(continuation_token ? { continuationToken: continuation_token } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              designs.map((d) => ({
                id: d.id,
                title: d.title,
                page_count: d.page_count,
                thumbnail_url: d.thumbnail?.url,
                edit_url: d.urls?.edit_url,
                view_url: d.urls?.view_url,
                updated_at: d.updated_at,
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
    "export_canva_design",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Export a Canva design and return the downloadable URLs",
      description: `Start a Canva export job for a design and poll until it completes, returning the per-page downloadable URLs. One URL per page.

USE WHEN: the user wants the raw exported assets without immediately turning them into a post (e.g. for review, manual editing, or upload elsewhere).

ALTERNATIVE: import_canva_design_as_post for the all-in-one workflow (export + upload + create PostGroup + create Posts).

FORMATS: jpg (default), png, pdf, gif, mp4. Pick mp4 for animated/video designs.

QUALITY: only applies to some formats. For jpg pass a string of an integer 1-100 (e.g. "75", "100"); default 92. For mp4 pass a size preset string like "horizontal_1080p", "horizontal_720p", "vertical_1080p". png/pdf/gif IGNORE quality, do not pass it. Omit unless you need a specific value.

LATENCY: 5-120 seconds depending on design complexity. The tool blocks until done or timeout_seconds elapses.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        design_id: z.string().min(1).describe("Canva design id (from list_canva_designs)."),
        type: z.enum(["jpg", "png", "pdf", "gif", "mp4"]).optional().describe("Export format. Default jpg."),
        quality: z
          .string()
          .optional()
          .describe(
            "Format-specific quality preset. jpg: stringified integer 1-100. mp4: size preset like 'horizontal_1080p'. png/pdf/gif: ignored. Omit by default.",
          ),
        timeout_seconds: z.number().int().positive().max(300).optional().describe("Max seconds to poll. Default 120."),
      },
    },
    async ({ company_id, design_id, type, quality, timeout_seconds }) => {
      try {
        const start = await client.startCanvaDesignExport(company_id, {
          design_id,
          format: {
            type: type ?? "jpg",
            ...(quality ? { quality } : {}),
          },
        });
        const job = await pollExportJob(client, company_id, start.id, {
          timeoutMs: (timeout_seconds ?? 120) * 1000,
          intervalMs: 2500,
        });
        if (job.status !== CANVA_TERMINAL_SUCCESS) {
          return toolError({
            reason: "canva_export_job_failed",
            user_message: `Canva export job failed (status=${job.status ?? "unknown"}).`,
            suggested_actions: [
              {
                rationale:
                  "Retry the export; Canva export jobs occasionally fail transiently. If it persists, try a different format (jpg vs png vs pdf).",
              },
              {
                rationale:
                  "Verify the Canva OAuth connection for this company is still valid in the Followr UI.",
              },
            ],
            details: {
              job_id: start.id,
              job_status: job.status ?? null,
              job_error: job.error ?? null,
            },
          });
        }
        const urls = urlsFromExportJob(job);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { job_id: start.id, status: job.status, page_count: urls.length, urls },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "import_canva_design_as_post",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Export a Canva design and create a scheduled or draft post from it (MEGA workflow)",
      description: `Compound end-to-end workflow: 1) export a Canva design, 2) wait for completion, 3) upload each exported page as a Followr asset, 4) create a PostGroup, 5) create one Post per requested social network attaching the uploaded asset ids (multi-page designs become carousels).

CRITICAL: Multi-step write workflow with side effects in multiple resources. Before calling:
1. Confirm company (by name, not id) if multiple companies.
2. Confirm the target social networks with the user verbatim.
3. If publish_at is provided, confirm date, time, and timezone (translate from user's local to UTC explicitly).
4. Confirm whether the design's content (text, branding) is appropriate for the networks chosen; carousels on LinkedIn vs Instagram have different best practices.

PRECONDITION: company_id required. design_id required (from list_canva_designs). social_networks must be at least one network type.

DRAFT VS SCHEDULE: omit publish_at to create as draft (recommended for review-first flows). Pass publish_at to schedule immediately.

PARTIAL FAILURES: if Canva export fails or asset upload fails for one page, the whole workflow throws. There is no automatic cleanup; leftover assets may need manual deletion via the Followr UI.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        design_id: z.string().min(1),
        social_networks: z
          .array(z.string())
          .min(1)
          .describe("Network types to publish to. e.g. ['instagram', 'facebook', 'linkedin']."),
        description: z.string().optional().describe("Post copy (same for all networks). Use update_post_group later for per-network tweaks."),
        title: z.string().optional(),
        publish_at: z.string().optional().describe("ISO 8601 UTC datetime. If omitted, the PostGroup is created as draft."),
        export_type: z.enum(["jpg", "png", "mp4"]).optional().describe("Export format. Default jpg. Use mp4 for video designs."),
        quality: z.string().optional(),
        timeout_seconds: z.number().int().positive().max(300).optional(),
      },
    },
    async ({
      company_id,
      design_id,
      social_networks,
      description,
      title,
      publish_at,
      export_type,
      quality,
      timeout_seconds,
    }) => {
      try {
        // 1. Start export.
        const exportType = export_type ?? "jpg";
        const start = await client.startCanvaDesignExport(company_id, {
          design_id,
          format: {
            type: exportType,
            ...(quality ? { quality } : {}),
          },
        });
        // 2. Poll until done.
        const job = await pollExportJob(client, company_id, start.id, {
          timeoutMs: (timeout_seconds ?? 180) * 1000,
          intervalMs: 2500,
        });
        if (job.status !== CANVA_TERMINAL_SUCCESS) {
          return toolError({
            reason: "canva_export_job_failed",
            user_message: `Canva export job failed (status=${job.status ?? "unknown"}). No PostGroup was created.`,
            suggested_actions: [
              {
                rationale:
                  "Retry; Canva export jobs occasionally fail transiently. If it persists, try a different export_type (jpg vs png vs mp4).",
              },
            ],
            details: {
              job_id: start.id,
              job_status: job.status ?? null,
              job_error: job.error ?? null,
            },
          });
        }
        const urls = urlsFromExportJob(job);
        if (urls.length === 0) {
          return toolError({
            reason: "canva_export_no_urls",
            user_message:
              "Canva export completed but returned no downloadable URLs. The design may be empty or corrupted on Canva's side.",
            suggested_actions: [
              {
                rationale:
                  "Open the design in Canva (list_canva_designs returns edit_url) and verify it has content before retrying.",
              },
            ],
            details: { job_id: start.id },
          });
        }
        // 3. Upload each page as an asset.
        const assetType: "image" | "video" = exportType === "mp4" ? "video" : "image";
        const assetIds = await Promise.all(
          urls.map((u, i) => uploadExportedPageAsAsset(client, company_id, u, i, design_id, assetType)),
        );
        // 4. Create PostGroup.
        const draft = publish_at ? false : true;
        const postGroup = await client.createPostGroup(company_id, {
          draft: draft ? 1 : 0,
          auto_publish: 0,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
        });
        if (publish_at) {
          await client.updatePostGroup(postGroup.id, { publish_at });
        }
        // 5. Create one Post per requested network with the uploaded assets attached.
        const posts = await Promise.all(
          social_networks.map(async (net) => {
            const post = await client.createPost(postGroup.id, {
              social_network_type: net,
              assets_ids: assetIds,
              ...(description ? { description } : {}),
              ...(title ? { title } : {}),
            });
            return { network: net, post };
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  canva_export_job_id: start.id,
                  asset_ids: assetIds,
                  post_group: { id: postGroup.id, draft, publish_at: publish_at ?? null },
                  posts,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
