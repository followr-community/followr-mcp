/**
 * Runtime context gatherer.
 *
 * Resolves values that depend on the connected account state but are not in
 * the static spec JSON:
 *
 * - Twitter `description.max_length`: 25000 if account is Premium-verified,
 *   else 280. Source: `preferences.verified` on the connected account.
 * - TikTok `video_max_duration_seconds`: varies per account tier (1 min on new
 *   accounts up to 60 min on established creators). Source:
 *   `preferences.max_video_post_duration_sec`.
 * - TikTok `privacy_level`: enum allowed values vary per account. Source:
 *   `preferences.privacy_level_options`.
 * - TikTok interaction toggles: `preferences.duet_disabled`,
 *   `preferences.stitch_disabled`, `preferences.comment_disabled`.
 *
 * Networks without runtime fields (medium, pinterest, facebook, instagram,
 * linkedin, youtube, threads, bluesky) skip the lookup entirely.
 *
 * Cached per (companyId, network) for 10 minutes. Fail-open: if the Followr
 * API call errors, returns an empty RuntimeContext and validation falls back
 * to static defaults from the spec JSON.
 */

import type { FollowrClient } from "@followr-mcp/shared";
import type { NetworkType, RuntimeContext } from "./types.js";

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  ctx: RuntimeContext;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

interface ConnectedAccount {
  id: number;
  type: string;
  preferences?: Record<string, unknown>;
}

export async function gatherRuntimeContext(
  companyId: number,
  network: NetworkType,
  client: FollowrClient,
): Promise<RuntimeContext> {
  if (network !== "twitter" && network !== "tiktok") return {};

  const key = `${companyId}:${network}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  let ctx: RuntimeContext = {};
  try {
    const accounts = (await client.listSocialNetworks(companyId)) as ConnectedAccount[];
    const account = accounts.find((a) => a.type === network);
    if (account) ctx = extractContext(network, account);
  } catch {
    ctx = {};
  }

  cache.set(key, { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  return ctx;
}

function extractContext(network: NetworkType, account: ConnectedAccount): RuntimeContext {
  const p = account.preferences ?? {};
  const ctx: RuntimeContext = {};

  if (network === "twitter") {
    if (typeof p["verified"] === "boolean") ctx.twitter_verified = p["verified"];
    return ctx;
  }

  if (network === "tiktok") {
    if (typeof p["max_video_post_duration_sec"] === "number") {
      ctx.tiktok_max_duration_seconds = p["max_video_post_duration_sec"];
    }
    if (Array.isArray(p["privacy_level_options"])) {
      ctx.tiktok_privacy_level_options = (p["privacy_level_options"] as unknown[]).filter(
        (v): v is string => typeof v === "string",
      );
    }
    if (typeof p["duet_disabled"] === "boolean") ctx.tiktok_duet_disabled = p["duet_disabled"];
    if (typeof p["stitch_disabled"] === "boolean") ctx.tiktok_stitch_disabled = p["stitch_disabled"];
    if (typeof p["comment_disabled"] === "boolean") {
      ctx.tiktok_comment_disabled = p["comment_disabled"];
    }
    return ctx;
  }

  return ctx;
}

/** Force-clear the cache. Useful for tests or explicit refresh after reconnect. */
export function clearRuntimeContextCache(): void {
  cache.clear();
}
