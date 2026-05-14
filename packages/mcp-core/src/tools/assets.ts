import { FollowrClient } from "@followr-mcp/shared";
import type { Asset } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

function filenameFromUrl(url: string, fallbackExt: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && last.includes(".")) return last;
    return `asset-${Date.now()}.${fallbackExt}`;
  } catch {
    return `asset-${Date.now()}.${fallbackExt}`;
  }
}

async function uploadFromUrl(
  client: FollowrClient,
  args: {
    companyId: number;
    url: string;
    type: "image" | "video";
    name?: string;
    visibility?: "public" | "private";
    contentTypeOverride?: string;
  },
): Promise<Asset> {
  const { companyId, url, type, name, visibility, contentTypeOverride } = args;
  const downloadResp = await fetch(url);
  if (!downloadResp.ok) {
    throw new Error(`Failed to download ${type} from URL: ${downloadResp.status} ${downloadResp.statusText}`);
  }
  const contentType =
    contentTypeOverride ?? downloadResp.headers.get("content-type") ?? (type === "image" ? "image/jpeg" : "video/mp4");
  const buffer = await downloadResp.arrayBuffer();
  const fallbackExt = type === "image" ? "jpg" : "mp4";
  const filename = name ?? filenameFromUrl(url, fallbackExt);
  const asset = await client.createAsset(companyId, { name: filename, type });
  const upload = await client.requestAssetUpload(asset.id, type, {
    filename,
    type,
    visibility: visibility ?? "public",
  });
  await client.uploadToBlob(upload.presigned_url, buffer, contentType);
  return { ...asset, url: upload.url };
}

export function registerAssetTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "upload_image_from_url",
    {
      title: "Upload an image to a workspace from a public URL",
      description:
        "Download an image from a public URL and upload it to the workspace's asset library via the 3-step pattern (create asset placeholder, request presigned URL, PUT binary). Returns the final Asset with `url` ready to attach to a Post. Caller must ensure the URL is reachable and serves the image bytes (not an HTML page).",
      inputSchema: {
        company_id: z.number().int().positive(),
        url: z.string().url().describe("Public URL of the image to ingest."),
        name: z.string().optional().describe("Optional filename. Defaults to the URL's last path segment."),
        visibility: z.enum(["public", "private"]).optional().describe("Default public."),
      },
    },
    async ({ company_id, url, name, visibility }) => {
      const asset = await uploadFromUrl(client, {
        companyId: company_id,
        url,
        type: "image",
        ...(name ? { name } : {}),
        ...(visibility ? { visibility } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(asset, null, 2) }] };
    },
  );

  server.registerTool(
    "upload_video_from_url",
    {
      title: "Upload a video to a workspace from a public URL",
      description:
        "Download a video from a public URL and upload it to the workspace's asset library via the 3-step pattern. Returns the final Asset with `url` ready to attach to a Post (Reel, Story, TikTok, etc.). Caller must ensure the URL is reachable and serves the video bytes directly.",
      inputSchema: {
        company_id: z.number().int().positive(),
        url: z.string().url().describe("Public URL of the video to ingest."),
        name: z.string().optional(),
        visibility: z.enum(["public", "private"]).optional(),
      },
    },
    async ({ company_id, url, name, visibility }) => {
      const asset = await uploadFromUrl(client, {
        companyId: company_id,
        url,
        type: "video",
        ...(name ? { name } : {}),
        ...(visibility ? { visibility } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(asset, null, 2) }] };
    },
  );

  server.registerTool(
    "list_assets",
    {
      title: "List assets in a workspace",
      description:
        "List assets (uploaded images and videos) in a workspace, optionally filtered by type and folder. Use to discover existing assets before deciding to re-upload.",
      inputSchema: {
        company_id: z.number().int().positive(),
        type: z
          .enum(["image", "video", "audio"])
          .optional()
          .describe("Filter by type. Omit for all."),
        folder_id: z.number().int().positive().optional(),
        in_root_only: z.boolean().optional().describe("If true, only return assets at the workspace root (folder_id is null). Ignored if folder_id is set."),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, type, folder_id, in_root_only, page_size }) => {
      const folderArg = folder_id !== undefined ? folder_id : in_root_only ? null : undefined;
      const assets = await client.listAssets(company_id, {
        ...(type ? { type } : {}),
        ...(folderArg !== undefined ? { folderId: folderArg } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              assets.map((a) => ({
                id: a.id,
                name: a.name,
                type: a.type,
                url: a.url,
                extension: a.extension,
                width: a.width,
                height: a.height,
                duration: a.duration,
                size: a.size,
                visibility: a.visibility,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
