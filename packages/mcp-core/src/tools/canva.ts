import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

// Loose shape of an export job poll response. status terminal: "completed" | "failed".
interface CanvaExportJobLite {
  job_id?: string;
  status?: string;
  urls?: string[];
  url?: string;
  error?: unknown;
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
    const status = raw.status;
    if (status === "completed" || status === "failed") return raw;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  throw new Error(`Canva export job ${jobId} timed out after ${options.timeoutMs}ms`);
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
    throw new Error(`Failed to download Canva exported page ${pageIndex}: ${downloadResp.status}`);
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
      title: "List Canva designs available to the workspace",
      description:
        "List Canva designs that the workspace's connected Canva account can access. Supports title substring filter via `search`. Returns each design's id, title, page count, thumbnail, and Canva edit / view URLs. Requires Canva OAuth to be connected for this workspace.",
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
      title: "Export a Canva design and return the downloadable URLs",
      description:
        "Start a Canva export job for a design and poll until it completes, returning the per-page downloadable URLs. Use this when you want the raw exported assets without immediately turning them into a post (use import_canva_design_as_post for the all-in-one workflow). One URL per page of the design.",
      inputSchema: {
        company_id: z.number().int().positive(),
        design_id: z.string().min(1).describe("Canva design id (from list_canva_designs)."),
        type: z.enum(["jpg", "png", "pdf", "gif", "mp4"]).optional().describe("Export format. Default jpg."),
        quality: z.string().optional().describe("Quality preset. Common: regular, high_quality. Provider-specific."),
        timeout_seconds: z.number().int().positive().max(300).optional().describe("Max seconds to poll. Default 120."),
      },
    },
    async ({ company_id, design_id, type, quality, timeout_seconds }) => {
      const start = await client.startCanvaDesignExport(company_id, {
        design_id,
        format: { type: type ?? "jpg", quality: quality ?? "regular" },
      });
      const job = await pollExportJob(client, company_id, start.job_id, {
        timeoutMs: (timeout_seconds ?? 120) * 1000,
        intervalMs: 2500,
      });
      if (job.status !== "completed") {
        throw new Error(`Canva export job failed: status=${job.status} error=${JSON.stringify(job.error)}`);
      }
      const urls = urlsFromExportJob(job);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ job_id: start.job_id, status: job.status, page_count: urls.length, urls }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "import_canva_design_as_post",
    {
      title: "Export a Canva design and create a scheduled or draft post from it (MEGA workflow)",
      description:
        "End-to-end workflow: 1) export a Canva design, 2) wait for completion, 3) upload each exported page as a Followr asset, 4) create a PostGroup, 5) create one Post per requested social network attaching the uploaded asset ids (multi-page designs become carousels). If publish_at is omitted, the PostGroup is created as a draft. Replaces ~6 manual UI clicks. Use to programmatically syndicate a Canva design to multiple networks in one shot.",
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
      // 1. Start export.
      const exportType = export_type ?? "jpg";
      const start = await client.startCanvaDesignExport(company_id, {
        design_id,
        format: { type: exportType, quality: quality ?? "regular" },
      });
      // 2. Poll until done.
      const job = await pollExportJob(client, company_id, start.job_id, {
        timeoutMs: (timeout_seconds ?? 180) * 1000,
        intervalMs: 2500,
      });
      if (job.status !== "completed") {
        throw new Error(`Canva export job failed: status=${job.status} error=${JSON.stringify(job.error)}`);
      }
      const urls = urlsFromExportJob(job);
      if (urls.length === 0) {
        throw new Error("Canva export completed but returned no URLs.");
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
                canva_export_job_id: start.job_id,
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
    },
  );
}
