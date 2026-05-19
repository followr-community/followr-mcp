import { FollowrClient } from "@followr-mcp/shared";
import type { Asset } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import { toolError, ToolErrorException, toolErrorFromException } from "../lib/tool-error.js";

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
    throw new ToolErrorException(
      toolError({
        reason: "url_download_failed",
        user_message: `Failed to download ${type} from "${url}" (HTTP ${downloadResp.status} ${downloadResp.statusText}). Check that the URL is reachable and serves raw ${type} bytes (not an HTML wrapper).`,
        suggested_actions: [
          {
            rationale:
              "Verify the URL in a browser or with curl. If it's a YouTube/Vimeo/Drive share link, replace with a direct file URL.",
          },
          {
            rationale: "If the URL is correct and just temporarily unavailable, retry after a brief wait.",
          },
        ],
        details: {
          source_url: url,
          asset_type: type,
          http_status: downloadResp.status,
          http_status_text: downloadResp.statusText,
        },
      }),
    );
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
      annotations: MUTATION_OPEN_WORLD,
      title: "Upload an image to a company from a public URL",
      description: `Download an image from a public URL and upload it to the company's asset library via the 3-step pattern (create asset placeholder, request presigned URL, PUT binary).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

URL REQUIREMENTS: must be reachable, must serve raw image bytes (not an HTML page wrapping the image). The tool fails loudly if the URL returns non-OK or non-image content. For Followr-generated images, prefer using the returned URL from generate_image directly.

DEDUPE: consider list_assets before re-uploading the same content. The Followr asset library has no automatic dedupe.

RETURNS: an Asset object with id and url. Use the id for create_post's assets_ids.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        url: z.string().url().describe("Public URL of the image to ingest."),
        name: z.string().optional().describe("Optional filename. Defaults to the URL's last path segment."),
        visibility: z.enum(["public", "private"]).optional().describe("Default public."),
      },
    },
    async ({ company_id, url, name, visibility }) => {
      try {
        const asset = await uploadFromUrl(client, {
          companyId: company_id,
          url,
          type: "image",
          ...(name ? { name } : {}),
          ...(visibility ? { visibility } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(asset, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "upload_video_from_url",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Upload a video to a company from a public URL",
      description: `Download a video from a public URL and upload it to the company's asset library via the 3-step pattern.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

URL REQUIREMENTS: must be reachable, must serve raw video bytes (not a YouTube/Vimeo player page). For Followr-generated videos (generate_avatar_video output), prefer using the returned URL directly.

NETWORK CONSTRAINTS: different networks have strict video specs (aspect ratio, duration, codec). Call validate_against_specs after uploading and before scheduling, especially for Reels/TikTok/Stories.

RETURNS: an Asset object with id and url. Use the id for create_post's assets_ids.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        url: z.string().url().describe("Public URL of the video to ingest."),
        name: z.string().optional(),
        visibility: z.enum(["public", "private"]).optional(),
      },
    },
    async ({ company_id, url, name, visibility }) => {
      try {
        const asset = await uploadFromUrl(client, {
          companyId: company_id,
          url,
          type: "video",
          ...(name ? { name } : {}),
          ...(visibility ? { visibility } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(asset, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "list_assets",
    {
      annotations: READ_ONLY,
      title: "List assets in a company",
      description: `List assets (uploaded images and videos) in a company.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

FILTERS: type narrows to one of image, video, audio. folder_id narrows to a folder; in_root_only=true returns only top-level (folder_id null). Omit both for all.

USE BEFORE upload_image_from_url / upload_video_from_url to avoid duplicates. Also useful when building a post that references existing brand assets.

PRESENTING: refer to assets by name; show width/height/duration when relevant to the user's choice.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        type: z
          .enum(["image", "video", "audio"])
          .optional()
          .describe("Filter by type. Omit for all."),
        folder_id: z.number().int().positive().optional(),
        in_root_only: z.boolean().optional().describe("If true, only return assets at the company root (folder_id is null). Ignored if folder_id is set."),
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

  server.registerTool(
    "delete_asset",
    {
      annotations: DESTRUCTIVE,
      title: "Delete an asset from a company (destructive)",
      description: `Permanently delete an Asset (image, video, audio) from a company's library. Cannot be undone via the API.

CRITICAL: Confirm with the user verbatim (by asset name and company name, not id) before calling.

SCOPE: removes the asset from the library and breaks references from Posts that included it via assets_ids. Drafts referencing the deleted asset will fail to publish with a missing-asset error. If the asset is referenced by ALREADY PUBLISHED posts, the public posts on social networks are unaffected (those have their own copies on the platforms).

USE CASES: cleanup after a verification run, removing assets uploaded by mistake, freeing storage quota.`,
      inputSchema: {
        asset_id: z.number().int().positive(),
      },
    },
    async ({ asset_id }) => {
      try {
        await client.deleteAsset(asset_id);
        return { content: [{ type: "text", text: `Deleted asset ${asset_id}.` }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
