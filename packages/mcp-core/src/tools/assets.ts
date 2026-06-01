import { FollowrApiError, FollowrClient, ensureFilenameExtension } from "@followr-mcp/shared";
import type { Asset } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import { syncBrandIdentityAfterDelete } from "../lib/brand-identity.js";
import { toolError, ToolErrorException, toolErrorFromException } from "../lib/tool-error.js";

/**
 * Run an async task over each item with a fixed concurrency cap. Preserves
 * input order in the returned array. Used by the bulk upload tools so we
 * upload many URLs in parallel without hammering blob storage.
 */
async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await task(item, i);
    }
  });
  await Promise.all(workers);
  return results;
}

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

// Steps of the 3-step asset upload pattern, used for granular error
// surfacing. The user gets to know WHICH step failed, not just "Server Error".
type UploadStep =
  | "url_download"
  | "placeholder_create"
  | "presigned_request"
  | "azure_blob_put";

// Retriable failures: transient 5xx from the Followr backend or Azure blob,
// and generic network errors (fetch TypeError). 4xx are NOT retried (they
// indicate permanent issues: bad input, auth, etc.).
function isRetriableUploadError(err: unknown): boolean {
  if (err instanceof FollowrApiError) {
    return err.status >= 500 && err.status < 600;
  }
  // Network errors from fetch surface as TypeError ("fetch failed", "network
  // request failed"). These are usually transient.
  if (err instanceof TypeError) return true;
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrap a step with exponential backoff retries for transient errors.
// Production: 4 retries with delays of 2s, 8s, 30s, 90s. Total worst case =
// 5 attempts over ~130s before giving up. The long tail (30s + 90s) is what
// lets the retry survive a multi-minute backend hiccup window. Real case:
// PipeLime 2026-05-28 saw ~5-10 min where presigned_request returned 500
// deterministically; the old [2s, 8s] (~10s total) gave up well inside the
// outage and the user had to retry by hand once the backend healed.
// Test runs (process.env.VITEST set by vitest) use tiny delays so the suite
// stays in sub-second range without changing test assertions.
const UPLOAD_RETRY_BACKOFFS_MS_PROD: ReadonlyArray<number> = [2000, 8000, 30_000, 90_000];
const UPLOAD_RETRY_BACKOFFS_MS_TEST: ReadonlyArray<number> = [5, 10, 15, 20];

async function withUploadRetry<T>(fn: () => Promise<T>): Promise<T> {
  const backoffsMs =
    process.env["VITEST"] === "true" ? UPLOAD_RETRY_BACKOFFS_MS_TEST : UPLOAD_RETRY_BACKOFFS_MS_PROD;
  const maxAttempts = backoffsMs.length + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts - 1 || !isRetriableUploadError(err)) {
        throw err;
      }
      await sleepMs(backoffsMs[attempt]!);
    }
  }
  throw lastError;
}

// Best-effort cleanup of an asset placeholder that was created in step 1
// but never received bytes (step 2 or 3 failed). Without this, every failed
// upload leaks a "phantom" asset entry into the user's library. Real case:
// PipeLime 2026-05-28 session left 4 phantom assets for one failed reel.
// If the cleanup itself fails, we swallow the error: the user is already
// being told the upload failed; a noisy cleanup error would distract from
// the real problem.
async function cleanupPhantomPlaceholder(
  client: FollowrClient,
  assetId: number,
): Promise<{ deleted: boolean; cleanup_error?: string }> {
  try {
    await client.deleteAsset(assetId);
    return { deleted: true };
  } catch (err) {
    return {
      deleted: false,
      cleanup_error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface StepFailureContext {
  step: UploadStep;
  url: string;
  type: "image" | "video";
  companyId: number;
  /** Set when step 1 succeeded and a phantom was created (steps 2/3). */
  cleanedUpAssetId?: number;
  cleanupResult?: { deleted: boolean; cleanup_error?: string };
}

// Map an underlying error from any of the 3 upload steps into a
// ToolErrorException with a step-tagged reason, a friendly user_message
// that names the step + a hint based on the error class (401 -> token
// expired; 5xx after retries -> backend instability; etc.), and details
// useful for debugging.
function wrapStepFailure(err: unknown, ctx: StepFailureContext): ToolErrorException {
  const httpStatus = err instanceof FollowrApiError ? err.status : null;
  const backendMessage =
    err instanceof FollowrApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

  let hint: string;
  let reason: string;
  if (httpStatus === 401) {
    hint =
      "Your Followr API token appears to be expired or invalid. Generate a fresh one in Followr Settings > API Keys and retry.";
    reason = `upload_failed_at_${ctx.step}_auth`;
  } else if (httpStatus !== null && httpStatus >= 500) {
    // Surface the backend's response body (when present) so the agent and
    // the user know WHY the upload failed instead of seeing a generic
    // "transient hiccup". Real case: PipeLime 2026-05-28 hit a multi-minute
    // outage where presigned_request returned 500; the prior generic hint
    // told the user "wait a minute and retry" while the backend could have
    // been telling us "queue saturated, try in 5 min" or "presigned service
    // unavailable". We never knew because we discarded the body.
    const trimmedBackend = backendMessage.length > 400 ? `${backendMessage.slice(0, 400)}...` : backendMessage;
    hint = `The Followr backend returned ${httpStatus} on the "${ctx.step}" step even after retrying with backoff (~2 min total across 5 attempts). Backend said: "${trimmedBackend}". If the message describes a permanent issue (bad input, missing permission), retrying as-is will not help; if it looks transient (queue saturation, gateway hiccup, brief deploy window), wait a few minutes and retry.`;
    reason = `upload_failed_at_${ctx.step}_5xx`;
  } else if (httpStatus !== null && httpStatus >= 400) {
    hint = `The request was rejected (HTTP ${httpStatus}) on the "${ctx.step}" step. The backend message is "${backendMessage}". This is usually a permanent issue (bad input, missing permission, invalid asset state); retrying as-is will not help.`;
    reason = `upload_failed_at_${ctx.step}_4xx`;
  } else {
    hint = `Network or runtime error on the "${ctx.step}" step: "${backendMessage}". Check connectivity and retry.`;
    reason = `upload_failed_at_${ctx.step}_network`;
  }

  const cleanupNote =
    ctx.cleanedUpAssetId !== undefined
      ? ctx.cleanupResult?.deleted
        ? ` Cleaned up the placeholder asset (id ${ctx.cleanedUpAssetId}) so it does not leak into your library.`
        : ` Tried to clean up the placeholder asset (id ${ctx.cleanedUpAssetId}) but the delete itself failed (${ctx.cleanupResult?.cleanup_error}). Run scripts/cleanup-phantom-assets.mjs if you want to scrub the leftover entries.`
      : "";

  return new ToolErrorException(
    toolError({
      reason,
      user_message: `Failed to upload ${ctx.type} (step "${ctx.step}"): ${backendMessage}.${cleanupNote} ${hint}`,
      details: {
        step: ctx.step,
        source_url: ctx.url,
        asset_type: ctx.type,
        company_id: ctx.companyId,
        http_status: httpStatus,
        backend_message: backendMessage,
        ...(ctx.cleanedUpAssetId !== undefined
          ? {
              cleaned_up_placeholder_asset_id: ctx.cleanedUpAssetId,
              cleanup_succeeded: ctx.cleanupResult?.deleted ?? false,
              ...(ctx.cleanupResult?.cleanup_error
                ? { cleanup_error: ctx.cleanupResult.cleanup_error }
                : {}),
            }
          : {}),
      },
    }),
  );
}

export async function uploadFromUrl(
  client: FollowrClient,
  args: {
    companyId: number;
    url: string;
    type: "image" | "video";
    name?: string;
    visibility?: "public" | "private";
    contentTypeOverride?: string;
    folderId?: number | null;
  },
): Promise<Asset> {
  const { companyId, url, type, name, visibility, contentTypeOverride, folderId } = args;

  // ── Step 0: download source bytes ────────────────────────────────────
  // Pre-step (the placeholder doesn't exist yet, no cleanup needed on
  // failure). Kept with its original error shape for backwards-compat with
  // callers that branch on reason="url_download_failed".
  let downloadResp: Response;
  try {
    downloadResp = await withUploadRetry(() => fetch(url));
  } catch (err) {
    throw new ToolErrorException(
      toolError({
        reason: "url_download_failed",
        user_message: `Failed to download ${type} from "${url}": ${err instanceof Error ? err.message : String(err)}. Check that the URL is reachable.`,
        details: {
          source_url: url,
          asset_type: type,
          network_error: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
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
  // Guarantee an extension: a human-readable `name` (e.g. the avatar
  // auto-upload's "Avatar X reel (...)") has none, and the presigned endpoint
  // 500s on extensionless filenames. Applied here so BOTH the step-1
  // placeholder name and the step-2 presigned filename carry the extension.
  const filename = ensureFilenameExtension(name ?? filenameFromUrl(url, fallbackExt), type);

  // ── Step 1: create placeholder asset ─────────────────────────────────
  let asset: Asset;
  try {
    asset = await withUploadRetry(() =>
      client.createAsset(companyId, {
        name: filename,
        type,
        ...(folderId !== undefined ? { folder_id: folderId } : {}),
      }),
    );
  } catch (err) {
    // No placeholder created yet; nothing to clean up.
    throw wrapStepFailure(err, { step: "placeholder_create", url, type, companyId });
  }

  // ── Step 2: request presigned upload URL ─────────────────────────────
  // From here on, a failure means we have a phantom placeholder in the
  // user's library. Best-effort delete before propagating.
  let upload: { presigned_url: string; url: string };
  try {
    upload = await withUploadRetry(() =>
      client.requestAssetUpload(asset.id, type, {
        filename,
        type,
        visibility: visibility ?? "public",
      }),
    );
  } catch (err) {
    const cleanupResult = await cleanupPhantomPlaceholder(client, asset.id);
    throw wrapStepFailure(err, {
      step: "presigned_request",
      url,
      type,
      companyId,
      cleanedUpAssetId: asset.id,
      cleanupResult,
    });
  }

  // ── Step 3: PUT bytes to Azure blob ──────────────────────────────────
  try {
    await withUploadRetry(() => client.uploadToBlob(upload.presigned_url, buffer, contentType));
  } catch (err) {
    const cleanupResult = await cleanupPhantomPlaceholder(client, asset.id);
    throw wrapStepFailure(err, {
      step: "azure_blob_put",
      url,
      type,
      companyId,
      cleanedUpAssetId: asset.id,
      cleanupResult,
    });
  }

  return { ...asset, url: upload.url };
}

/**
 * Decode an "image_data" input into a binary buffer plus the detected
 * MIME type. Accepts:
 *   - data URLs:  data:image/png;base64,iVBORw0K...
 *   - raw base64: iVBORw0KGgoAAAANSUhEUg...   (extension inferred from magic bytes)
 *
 * Used by upload_image_from_data so an MCP client that can pass attached
 * images as base64 (Claude Desktop with image-capable transports, future
 * clients that surface chat attachments to tools) can push them straight
 * into a company library without requiring a public URL.
 */
function decodeImageData(input: string): { buffer: Uint8Array; contentType: string; ext: string } {
  const trimmed = input.trim();
  const dataUrlMatch = trimmed.match(/^data:([\w./+-]+);base64,(.+)$/u);
  const base64 = dataUrlMatch ? dataUrlMatch[2]! : trimmed;
  const declaredMime = dataUrlMatch ? dataUrlMatch[1]! : null;

  // Decode base64. Node 20 has globalThis.atob but the binary string
  // route loses bytes above 0xFF in some runtimes, so go via Buffer when
  // available and fall back to atob otherwise.
  let buffer: Uint8Array;
  const globalBuffer = (globalThis as { Buffer?: { from(input: string, enc: string): Uint8Array } }).Buffer;
  if (globalBuffer) {
    buffer = globalBuffer.from(base64, "base64");
  } else {
    const binary = atob(base64);
    buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  }

  const sniffed = sniffImageType(buffer);
  const contentType = declaredMime ?? sniffed?.mime ?? "image/jpeg";
  const ext = (sniffed?.ext ?? contentType.split("/")[1] ?? "jpg").toLowerCase();
  return { buffer, contentType, ext };
}

function sniffImageType(buffer: Uint8Array): { mime: string; ext: string } | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export async function uploadFromData(
  client: FollowrClient,
  args: {
    companyId: number;
    imageData: string;
    name?: string;
    visibility?: "public" | "private";
    folderId?: number | null;
  },
): Promise<Asset> {
  const { companyId, imageData, name, visibility, folderId } = args;
  let decoded: ReturnType<typeof decodeImageData>;
  try {
    decoded = decodeImageData(imageData);
  } catch (err) {
    throw new ToolErrorException(
      toolError({
        reason: "invalid_image_data",
        user_message:
          "The image data could not be decoded. Pass either a data URL (data:image/png;base64,...) or a raw base64 string of an image file (jpeg, png, gif, webp).",
        details: { decode_error: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
  const filename = ensureFilenameExtension(name ?? `upload-${Date.now()}.${decoded.ext}`, "image");
  const asset = await client.createAsset(companyId, {
    name: filename,
    type: "image",
    ...(folderId !== undefined ? { folder_id: folderId } : {}),
  });
  const upload = await client.requestAssetUpload(asset.id, "image", {
    filename,
    type: "image",
    visibility: visibility ?? "public",
  });
  await client.uploadToBlob(upload.presigned_url, decoded.buffer, decoded.contentType);
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
      title: "Upload an image to a company asset library from a public URL (ingest, attach, prepare for posts)",
      description: `Download an image (photo, picture, product shot, thumbnail, banner, creative) from a public URL and upload it to the company's asset library via the 3-step pattern (create asset placeholder, request presigned URL, PUT binary). The resulting asset id is what create_post / create_post_group_with_posts expect in assets_ids.

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

  // Tool: upload_images_from_urls (bulk).
  // Batched version of upload_image_from_url for the common "armar un plan
  // semanal con N imágenes del catálogo" flow. Runs uploads in parallel with
  // a fixed concurrency cap to avoid hammering the company's blob storage.
  // Returns assets[] in input order plus failures[] for URLs that did not
  // ingest; the caller decides whether to retry the failures.
  server.registerTool(
    "upload_images_from_urls",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Upload multiple images to a company from public URLs (bulk)",
      description: `Bulk version of upload_image_from_url. Downloads each URL and uploads it to the company's asset library via the 3-step pattern, in parallel (concurrency capped at 5 to be polite to blob storage).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE FOR: campaigns that need many product images at once (e.g. planning a week of posts off a product catalog). Reduces N round-trips to 1.

URL REQUIREMENTS: each URL must be reachable and must serve raw image bytes (not an HTML wrapper). Failing URLs are returned in a failures[] array; successful uploads are in assets[]. Partial success is allowed (the tool does not fail the whole batch if one URL fails).

RETURNS: { assets: Asset[], failures: [{url, reason, http_status?}] }. Use the assets' ids in create_post's assets_ids array.

DEDUPE: call list_assets first if duplicates matter; Followr does not auto-dedupe.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        urls: z
          .array(
            z.union([
              z.string().url(),
              z.object({
                url: z.string().url(),
                name: z.string().optional(),
              }),
            ]),
          )
          .min(1)
          .max(50)
          .describe("List of image URLs to ingest. Each item is either a URL string or {url, name?}. 1 to 50 per call."),
        visibility: z.enum(["public", "private"]).optional().describe("Default public, applied to every asset in the batch."),
      },
    },
    async ({ company_id, urls, visibility }) => {
      const normalized = urls.map((u) => (typeof u === "string" ? { url: u } : u));
      const results = await runConcurrent(normalized, 5, async (item) => {
        try {
          const asset = await uploadFromUrl(client, {
            companyId: company_id,
            url: item.url,
            type: "image",
            ...(item.name ? { name: item.name } : {}),
            ...(visibility ? { visibility } : {}),
          });
          return { ok: true as const, asset, url: item.url };
        } catch (err) {
          const details =
            err instanceof ToolErrorException
              ? (err.result.details as Record<string, unknown> | undefined)
              : undefined;
          return {
            ok: false as const,
            url: item.url,
            reason:
              err instanceof ToolErrorException
                ? err.result.reason
                : err instanceof Error
                  ? err.message
                  : String(err),
            http_status: typeof details?.["http_status"] === "number" ? (details["http_status"] as number) : undefined,
          };
        }
      });
      const assets = results.filter((r) => r.ok).map((r) => (r.ok ? r.asset : null)).filter(Boolean);
      const failures = results
        .filter((r): r is { ok: false; url: string; reason: string; http_status?: number } => !r.ok)
        .map((r) => ({
          url: r.url,
          reason: r.reason,
          ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
        }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                requested: urls.length,
                uploaded: assets.length,
                failed: failures.length,
                assets,
                failures,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "upload_image_from_data",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Upload an image to a company library from inline base64 data (no public URL needed)",
      description: `Upload an image to the company's asset library directly from base64 data, without requiring an intermediate public URL. The same 3-step backend pattern as upload_image_from_url (create asset placeholder, request presigned URL, PUT binary), just fed from inline bytes.

WHEN TO USE: when the user attached an image to the chat that you need to land in the company's library (logo for brand identity setup, product photo for a post, dashboard screenshot for a carousel) AND the host MCP client surfaces that attachment to you as base64 or data URL. Some clients support this directly; others do not (Claude.ai web with stock MCP transports does NOT pass attached binary to tools). When passing is not supported, FALL BACK to one of:
  1. Ask the user to drop the file into the company's media library in the Followr web app, then continue.
  2. Ask the user for an existing public URL (Drive shared link, a CDN, etc.) and use upload_image_from_url.
DO NOT loop searching for alternative tools.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

ACCEPTS:
  - data URLs ("data:image/png;base64,iVBOR..."). MIME is read from the URL.
  - raw base64 strings ("iVBORw0KGgo..."). MIME is sniffed from magic bytes (jpeg, png, gif, webp).

LIMITS: base64 payloads are large. Prefer image_data only for images < ~2MB raw. Bigger files: use upload_image_from_url against a hosted URL.

RETURNS: an Asset object with id and url. Use the id for create_post's assets_ids and for tagging it into brand identity folders.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        image_data: z
          .string()
          .min(64)
          .describe(
            "Base64-encoded image bytes. Either a data URL (data:image/png;base64,...) or a raw base64 string. JPEG, PNG, GIF, and WEBP are auto-detected.",
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Optional filename. Defaults to upload-<ts>.<ext> with the extension picked from the detected MIME.",
          ),
        visibility: z.enum(["public", "private"]).optional().describe("Default public."),
      },
    },
    async ({ company_id, image_data, name, visibility }) => {
      try {
        const asset = await uploadFromData(client, {
          companyId: company_id,
          imageData: image_data,
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
    "upload_videos_from_urls",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Upload multiple videos to a company from public URLs (bulk)",
      description: `Bulk version of upload_video_from_url. Downloads each URL and uploads it to the company's asset library via the 3-step pattern, in parallel (concurrency capped at 3 because video uploads are heavier than images).

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

URL REQUIREMENTS: each URL must be reachable and must serve raw video bytes (not a YouTube / Vimeo player page). Failing URLs are returned in a failures[] array; successful uploads are in assets[]. Partial success allowed.

WORKS WITH FOLLOWR CDN URLs (verified 2026-05-27): URLs from ai_result.response (hosted at followrcdn-*.azurefd.net) ingest cleanly through this tool. The MCP fetches bytes locally and re-uploads to the asset library via the 3-step pattern (placeholder + presigned URL + PUT). The source URL is never proxied through Followr's backend, so self-CDN URLs are not a problem.

NETWORK CONSTRAINTS: different networks have strict video specs (aspect ratio, duration, codec). Call validate_against_specs after upload and before scheduling, especially for Reels / TikTok / Stories.

RETURNS: { assets: Asset[], failures: [{url, reason, http_status?}] }.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        urls: z
          .array(
            z.union([
              z.string().url(),
              z.object({
                url: z.string().url(),
                name: z.string().optional(),
              }),
            ]),
          )
          .min(1)
          .max(20)
          .describe("List of video URLs to ingest. Each item is either a URL string or {url, name?}. 1 to 20 per call."),
        visibility: z.enum(["public", "private"]).optional(),
      },
    },
    async ({ company_id, urls, visibility }) => {
      const normalized = urls.map((u) => (typeof u === "string" ? { url: u } : u));
      const results = await runConcurrent(normalized, 3, async (item) => {
        try {
          const asset = await uploadFromUrl(client, {
            companyId: company_id,
            url: item.url,
            type: "video",
            ...(item.name ? { name: item.name } : {}),
            ...(visibility ? { visibility } : {}),
          });
          return { ok: true as const, asset, url: item.url };
        } catch (err) {
          const details =
            err instanceof ToolErrorException
              ? (err.result.details as Record<string, unknown> | undefined)
              : undefined;
          return {
            ok: false as const,
            url: item.url,
            reason:
              err instanceof ToolErrorException
                ? err.result.reason
                : err instanceof Error
                  ? err.message
                  : String(err),
            http_status: typeof details?.["http_status"] === "number" ? (details["http_status"] as number) : undefined,
          };
        }
      });
      const assets = results.filter((r) => r.ok).map((r) => (r.ok ? r.asset : null)).filter(Boolean);
      const failures = results
        .filter((r): r is { ok: false; url: string; reason: string; http_status?: number } => !r.ok)
        .map((r) => ({
          url: r.url,
          reason: r.reason,
          ...(r.http_status !== undefined ? { http_status: r.http_status } : {}),
        }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                requested: urls.length,
                uploaded: assets.length,
                failed: failures.length,
                assets,
                failures,
              },
              null,
              2,
            ),
          },
        ],
      };
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

USE CASES: cleanup after a verification run, removing assets uploaded by mistake, freeing storage quota.

BRAND IDENTITY SIDE EFFECT: if you pass company_id and the asset is referenced in the company's Brand Visual Identity block (either tagged in asset_tag_map or listed in aspirational_refs_asset_ids), this tool also updates the block in-place: removes the asset_tag_map entry, decrements the relevant *_count, and prunes from aspirational_refs_asset_ids. Without company_id the brand block is left untouched; the next assess_brand_visual_identity call will reconcile lazily.`,
      inputSchema: {
        asset_id: z.number().int().positive(),
        company_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "When provided, the tool will sync the company's Brand Visual Identity block after deleting the asset (drop asset_tag_map entry, decrement counts, prune aspirational refs). Pass this when the asset might be brand-tagged; safe to pass always.",
          ),
      },
    },
    async ({ asset_id, company_id }) => {
      try {
        await client.deleteAsset(asset_id);
        let brandSync: Awaited<ReturnType<typeof syncBrandIdentityAfterDelete>> | null = null;
        if (company_id !== undefined) {
          brandSync = await syncBrandIdentityAfterDelete(client, company_id, {
            assetId: asset_id,
          });
        }
        const lines = [`Deleted asset ${asset_id}.`];
        if (brandSync !== null) {
          if (brandSync.detail.kind === "asset_removed") {
            lines.push(
              `Brand identity sync: removed asset_tag_map entry${brandSync.detail.from_count ? ` + decremented ${brandSync.detail.from_count}_count` : " (no count decrement, asset had no tags)"}; persisted=${brandSync.persisted}.`,
            );
          } else if (brandSync.detail.kind === "not_affected") {
            lines.push(`Brand identity sync: asset not referenced in block, no change.`);
          } else if (brandSync.detail.kind === "no_brand_identity") {
            lines.push(`Brand identity sync: company has no brand identity block, skipped.`);
          }
        }
        return { content: [{ type: "text", text: lines.join(" ") }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
