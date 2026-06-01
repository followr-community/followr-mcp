import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { FollowrApiError, ensureFilenameExtension } from "@followr-mcp/shared";
import type { Asset, FollowrClient } from "@followr-mcp/shared";

import { ToolErrorException } from "../lib/tool-error.js";
import { uploadFromUrl } from "./assets.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function makeAsset(id: number): Asset {
  return { id, name: "test.mp4", type: "video" } as Asset;
}

function makeFakeClient(overrides: {
  createAsset?: FollowrClient["createAsset"];
  requestAssetUpload?: FollowrClient["requestAssetUpload"];
  uploadToBlob?: FollowrClient["uploadToBlob"];
  deleteAsset?: FollowrClient["deleteAsset"];
}): FollowrClient {
  return {
    createAsset: overrides.createAsset ?? (async () => makeAsset(123)),
    requestAssetUpload:
      overrides.requestAssetUpload ??
      (async () => ({ presigned_url: "https://blob/upload", url: "https://cdn/asset" })),
    uploadToBlob: overrides.uploadToBlob ?? (async () => {}),
    deleteAsset: overrides.deleteAsset ?? (async () => {}),
  } as unknown as FollowrClient;
}

function fakeOkResponse(body = new Uint8Array([1, 2, 3])): Response {
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: { "Content-Type": "video/mp4" },
  });
}

beforeEach(() => {
  // Stub fetch globally to return tiny mp4 bytes
  vi.stubGlobal("fetch", vi.fn(async () => fakeOkResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("uploadFromUrl happy path", () => {
  it("returns the asset with merged url when all 3 steps succeed", async () => {
    const client = makeFakeClient({});
    const result = await uploadFromUrl(client, {
      companyId: 42,
      url: "https://cdn/source.mp4",
      type: "video",
    });
    expect(result.id).toBe(123);
    expect(result.url).toBe("https://cdn/asset");
  });
});

// ── Step 1 (placeholder_create) failure: NO cleanup needed ───────────────────

describe("uploadFromUrl step 1 (placeholder_create) failure", () => {
  it("does NOT attempt cleanup when placeholder creation fails", async () => {
    const deleteAsset = vi.fn(async () => {});
    const client = makeFakeClient({
      createAsset: async () => {
        throw new FollowrApiError("Server Error", 500, "https://api/companies/42/assets");
      },
      deleteAsset,
    });

    await expect(
      uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" }),
    ).rejects.toMatchObject({
      result: { structuredContent: { reason: expect.stringContaining("upload_failed_at_placeholder_create") } },
    });
    expect(deleteAsset).not.toHaveBeenCalled();
  }, 15_000);
});

// ── Step 2 (presigned_request) failure: cleanup placeholder ──────────────────

describe("uploadFromUrl step 2 (presigned_request) failure", () => {
  it("cleans up the placeholder when presigned URL request fails", async () => {
    const deleteAsset = vi.fn(async () => {});
    const client = makeFakeClient({
      createAsset: async () => makeAsset(777),
      requestAssetUpload: async () => {
        throw new FollowrApiError("Server Error", 500, "https://api/assets/777/video");
      },
      deleteAsset,
    });

    await expect(
      uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" }),
    ).rejects.toMatchObject({
      result: { structuredContent: { reason: expect.stringContaining("upload_failed_at_presigned_request") } },
    });
    expect(deleteAsset).toHaveBeenCalledWith(777);
  }, 15_000);

  it("surfaces the backend's response body inside the 5xx hint", async () => {
    // Regression: prior versions of wrapStepFailure threw the backend
    // message away for 5xx and surfaced only a generic "transient hiccup"
    // hint. Real case (PipeLime 2026-05-28): backend likely told us WHY
    // the upload failed but the agent only saw "wait a minute and retry".
    // The hint now carries the backend body so the agent can decide whether
    // to retry or change something.
    const backendBody =
      "Queue saturated: presigned URL service unavailable. Try again in ~5 min.";
    const client = makeFakeClient({
      createAsset: async () => makeAsset(7771),
      requestAssetUpload: async () => {
        throw new FollowrApiError(backendBody, 500, "https://api/assets/7771/video");
      },
    });

    try {
      await uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" });
      throw new Error("should have thrown");
    } catch (err) {
      const result = (err as ToolErrorException).result;
      // user_message embeds the hint; the backend body must appear in it.
      const userMessage = (result.structuredContent.user_message as string) ?? "";
      expect(userMessage).toContain(backendBody);
      // Structured details still keep the message verbatim too.
      const details = result.structuredContent.details as Record<string, unknown>;
      expect(details["backend_message"]).toBe(backendBody);
    }
  }, 15_000);

  it("attempts 5 total tries before giving up on persistent 5xx (escalated backoff)", async () => {
    // Regression: prior versions retried only 3 times (~10s total) which
    // was not enough to outlast multi-minute backend hiccups. The bumped
    // backoffs (2s+8s+30s+90s with test overrides for fast suite) now do
    // up to 5 attempts. The exact count is asserted here so a future
    // refactor doesn't silently shrink it.
    let attempts = 0;
    const client = makeFakeClient({
      createAsset: async () => makeAsset(7772),
      requestAssetUpload: async () => {
        attempts += 1;
        throw new FollowrApiError("Server Error", 500, "https://api/assets/7772/video");
      },
    });

    await expect(
      uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" }),
    ).rejects.toBeDefined();
    expect(attempts).toBe(5);
  }, 15_000);

  it("surfaces 401 with a token-expired hint and still cleans up", async () => {
    const deleteAsset = vi.fn(async () => {});
    const client = makeFakeClient({
      createAsset: async () => makeAsset(888),
      requestAssetUpload: async () => {
        throw new FollowrApiError("Unauthenticated", 401, "https://api/assets/888/video");
      },
      deleteAsset,
    });

    try {
      await uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolErrorException);
      const result = (err as ToolErrorException).result;
      expect(result.structuredContent.reason).toContain("auth");
      expect(JSON.stringify(result)).toMatch(/token/i);
    }
    expect(deleteAsset).toHaveBeenCalledWith(888);
  });

  it("swallows a cleanup failure and surfaces both errors", async () => {
    const client = makeFakeClient({
      createAsset: async () => makeAsset(999),
      requestAssetUpload: async () => {
        throw new FollowrApiError("Server Error", 500, "https://api/assets/999/video");
      },
      deleteAsset: async () => {
        throw new Error("delete also failed");
      },
    });

    try {
      await uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" });
      throw new Error("should have thrown");
    } catch (err) {
      const result = (err as ToolErrorException).result;
      const details = result.structuredContent.details as Record<string, unknown>;
      expect(details["cleaned_up_placeholder_asset_id"]).toBe(999);
      expect(details["cleanup_succeeded"]).toBe(false);
      expect(details["cleanup_error"]).toContain("delete also failed");
    }
  }, 15_000);
});

// ── Step 3 (azure_blob_put) failure: cleanup placeholder ─────────────────────

describe("uploadFromUrl step 3 (azure_blob_put) failure", () => {
  it("cleans up when Azure blob PUT fails", async () => {
    const deleteAsset = vi.fn(async () => {});
    const client = makeFakeClient({
      createAsset: async () => makeAsset(1234),
      uploadToBlob: async () => {
        throw new FollowrApiError("Azure 500", 500, "https://blob/upload");
      },
      deleteAsset,
    });

    await expect(
      uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" }),
    ).rejects.toMatchObject({
      result: { structuredContent: { reason: expect.stringContaining("upload_failed_at_azure_blob_put") } },
    });
    expect(deleteAsset).toHaveBeenCalledWith(1234);
  }, 15_000);
});

// ── Retry behavior ───────────────────────────────────────────────────────────

describe("uploadFromUrl retry-on-5xx", () => {
  it("retries a transient 500 on createAsset and succeeds on the second attempt", async () => {
    let attempts = 0;
    const client = makeFakeClient({
      createAsset: async () => {
        attempts++;
        if (attempts < 2) {
          throw new FollowrApiError("Server Error", 503, "https://api/companies/42/assets");
        }
        return makeAsset(55);
      },
    });

    const result = await uploadFromUrl(client, {
      companyId: 42,
      url: "https://cdn/x.mp4",
      type: "video",
    });
    expect(result.id).toBe(55);
    expect(attempts).toBe(2);
  }, 15_000);

  it("does NOT retry on 4xx (permanent error)", async () => {
    let attempts = 0;
    const client = makeFakeClient({
      createAsset: async () => {
        attempts++;
        throw new FollowrApiError("Bad Request", 422, "https://api/companies/42/assets");
      },
    });

    await expect(
      uploadFromUrl(client, { companyId: 42, url: "https://cdn/x.mp4", type: "video" }),
    ).rejects.toMatchObject({
      result: { structuredContent: { reason: expect.stringContaining("4xx") } },
    });
    expect(attempts).toBe(1);
  });
});

// ── Filename extension guarantee ─────────────────────────────────────────────
// Regression: Followr's presigned-upload endpoints (POST /api/assets/{id}/video
// and /image) return HTTP 500 when `filename` has no file extension. Verified
// empirically 2026-06-01 against api.followr.ai:
//   "Avatar Mia reel (3 scenes, 2026-06-01)"     -> 500 (every avatar video)
//   "Avatar Mia reel (3 scenes, 2026-06-01).mp4" -> 201
//   "test" -> 500 ; "test.mp4" -> 201 ; "test.xyz" -> 201 ; "test." -> 201
// The avatar auto-upload (ai-results.ts) passes a human-readable name with no
// extension, so every avatar reel upload died at step 2 and was MISDIAGNOSED in
// code comments as a transient backend outage (the retry hardening could never
// help: the request is malformed identically on every attempt). uploadFromUrl
// must guarantee an extension on BOTH the placeholder name (step 1) and the
// presigned filename (step 2).

describe("uploadFromUrl filename extension guarantee", () => {
  it("appends a .mp4 extension when a video name has none (the avatar bug)", async () => {
    let placeholderName: string | undefined;
    let presignFilename: string | undefined;
    const client = makeFakeClient({
      createAsset: async (_companyId, body) => {
        placeholderName = body.name;
        return makeAsset(321);
      },
      requestAssetUpload: async (_assetId, _kind, body) => {
        presignFilename = body.filename;
        return { presigned_url: "https://blob/upload", url: "https://cdn/asset" };
      },
    });

    await uploadFromUrl(client, {
      companyId: 42,
      url: "https://cdn/no-extension-here", // URL carries no extension either
      type: "video",
      name: "Avatar Mia reel (3 scenes, 2026-06-01)",
    });

    // Both the step-1 placeholder name and the step-2 presigned filename must
    // carry the extension, so the upload succeeds AND the library shows a sane
    // name. Spaces/parens/commas are fine; only the missing extension 500s.
    expect(presignFilename).toBe("Avatar Mia reel (3 scenes, 2026-06-01).mp4");
    expect(placeholderName).toBe("Avatar Mia reel (3 scenes, 2026-06-01).mp4");
  });

  it("appends a .jpg extension when an image name has none", async () => {
    let presignFilename: string | undefined;
    const client = makeFakeClient({
      requestAssetUpload: async (_assetId, _kind, body) => {
        presignFilename = body.filename;
        return { presigned_url: "https://blob/upload", url: "https://cdn/asset" };
      },
    });

    await uploadFromUrl(client, {
      companyId: 42,
      url: "https://cdn/whatever",
      type: "image",
      name: "Brand hero shot",
    });

    expect(presignFilename).toBe("Brand hero shot.jpg");
  });

  it("leaves a filename that already has a real extension untouched", async () => {
    let presignFilename: string | undefined;
    const client = makeFakeClient({
      requestAssetUpload: async (_assetId, _kind, body) => {
        presignFilename = body.filename;
        return { presigned_url: "https://blob/upload", url: "https://cdn/asset" };
      },
    });

    await uploadFromUrl(client, {
      companyId: 42,
      url: "https://cdn/clip.mov",
      type: "video",
      name: "Product teaser.mov",
    });

    expect(presignFilename).toBe("Product teaser.mov");
  });
});

// ── ensureFilenameExtension (pure) ───────────────────────────────────────────

describe("ensureFilenameExtension", () => {
  it("appends the type-appropriate extension when none is present", () => {
    expect(ensureFilenameExtension("Avatar Mia reel (3 scenes, 2026-06-01)", "video")).toBe(
      "Avatar Mia reel (3 scenes, 2026-06-01).mp4",
    );
    expect(ensureFilenameExtension("test", "video")).toBe("test.mp4");
    expect(ensureFilenameExtension("brand hero", "image")).toBe("brand hero.jpg");
    expect(ensureFilenameExtension("2026-06-01", "video")).toBe("2026-06-01.mp4");
  });

  it("is idempotent for filenames that already have a 1-5 char alnum extension", () => {
    expect(ensureFilenameExtension("clip.mp4", "video")).toBe("clip.mp4");
    expect(ensureFilenameExtension("photo.jpeg", "image")).toBe("photo.jpeg");
    expect(ensureFilenameExtension("teaser.MOV", "video")).toBe("teaser.MOV");
    expect(ensureFilenameExtension("a.b", "video")).toBe("a.b");
    expect(ensureFilenameExtension("my.report.final.png", "image")).toBe("my.report.final.png");
  });

  it("appends when the trailing 'extension' is not a sane token (spaces, too long)", () => {
    // "v1.2 final" -> last segment "2 final" is not a real extension.
    expect(ensureFilenameExtension("v1.2 final", "video")).toBe("v1.2 final.mp4");
  });
});
