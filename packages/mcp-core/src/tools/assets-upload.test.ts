import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { FollowrApiError } from "@followr-mcp/shared";
import type { Asset, FollowrClient } from "@followr-mcp/shared";

import { ToolErrorException } from "../lib/tool-error.js";
import { uploadFromUrl } from "./assets.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function makeAsset(id: number): Asset {
  return { id, name: "test.mp4", type: "video" } as Asset;
}

function makeFakeClient(overrides: {
  createAsset?: () => Promise<Asset>;
  requestAssetUpload?: () => Promise<{ presigned_url: string; url: string }>;
  uploadToBlob?: () => Promise<void>;
  deleteAsset?: (id: number) => Promise<void>;
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
