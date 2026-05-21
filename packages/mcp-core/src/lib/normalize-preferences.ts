/**
 * Normalize per-network `preferences` so the Followr API never receives
 * values with the wrong case, plural form, or wrong primitive type.
 *
 * Why this exists: the Followr backend rejects subtle variants of correct
 * values with HTTP 422 errors that are easy to miss:
 *
 *   media_product_type: "reel"   ->  "media product type is invalid"
 *   media_product_type: "REELS"  ->  "preferences.media_product_type is invalid"
 *   privacy_level (YouTube): "UNLISTED"  ->  "selected privacy_level is invalid"
 *   privacy_level (TikTok):  "public_to_everyone" -> rejected
 *   category_id (YouTube): 22 (number)  ->  "category id must be a string"
 *
 * The agent or user code might generate any of these by mistake. We
 * auto-correct the ones with an unambiguous canonical form and emit a
 * notice the caller can surface back to the user ("I corrected ... so
 * the call would not fail").
 *
 * Authoritative source: docs/followr-api/posts.md "Quirks (PostPreferences)".
 */
import type { NetworkType } from "../specs/types.js";

const NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE: ReadonlySet<NetworkType> = new Set([
  "instagram",
  "facebook",
  "youtube",
]);

const VALID_MEDIA_PRODUCT_TYPE_UPPER = new Set(["FEED", "REEL", "STORY", "SHORT"]);
const VALID_YOUTUBE_PRIVACY_LOWER = new Set(["public", "unlisted", "private"]);

interface NormalizeResult {
  normalized: Record<string, unknown>;
  notices: string[];
}

/**
 * Normalize and validate the preferences map. Always returns a NEW object
 * (does not mutate the input). When a value is corrected, a human-readable
 * notice is pushed to notices[] so the caller can surface it.
 */
export function normalizePreferences(
  prefs: Record<string, unknown> | undefined,
  network: NetworkType,
): NormalizeResult {
  const out: Record<string, unknown> = { ...(prefs ?? {}) };
  const notices: string[] = [];

  // media_product_type: must be UPPERCASE singular. The Followr API rejects
  // lowercase ("reel") and plurals ("REELS"). Auto-correct.
  if (NETWORKS_NEEDING_MEDIA_PRODUCT_TYPE.has(network) && "media_product_type" in out) {
    const v = out["media_product_type"];
    if (typeof v === "string") {
      const upper = v.toUpperCase();
      // Trim trailing "S" only when the singular form is canonical (REELS -> REEL, SHORTS -> SHORT)
      const singular = upper.endsWith("S") && VALID_MEDIA_PRODUCT_TYPE_UPPER.has(upper.slice(0, -1))
        ? upper.slice(0, -1)
        : upper;
      if (singular !== v) {
        out["media_product_type"] = singular;
        notices.push(
          `Corregido preferences.media_product_type "${v}" -> "${singular}" (Followr requiere UPPERCASE singular: FEED | REEL | STORY | SHORT).`,
        );
      }
      if (!VALID_MEDIA_PRODUCT_TYPE_UPPER.has(singular)) {
        notices.push(
          `preferences.media_product_type "${singular}" no es uno de los valores válidos (FEED, REEL, STORY, SHORT). Followr probablemente rechace.`,
        );
      }
    }
  }

  // YouTube privacy_level must be LOWERCASE. UPPERCASE "PUBLIC" is rejected.
  if (network === "youtube" && "privacy_level" in out) {
    const v = out["privacy_level"];
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      if (lower !== v) {
        out["privacy_level"] = lower;
        notices.push(
          `Corregido preferences.privacy_level "${v}" -> "${lower}" (YouTube requiere lowercase: public | unlisted | private).`,
        );
      }
      if (!VALID_YOUTUBE_PRIVACY_LOWER.has(lower)) {
        notices.push(
          `preferences.privacy_level "${lower}" no es uno de los valores válidos para YouTube (public, unlisted, private).`,
        );
      }
    }
  }

  // YouTube category_id must be a STRING. Numbers are rejected with
  // "category id field must be a string".
  if (network === "youtube" && "category_id" in out) {
    const v = out["category_id"];
    if (typeof v === "number" && Number.isFinite(v)) {
      out["category_id"] = String(v);
      notices.push(
        `Corregido preferences.category_id ${v} (number) -> "${v}" (string). YouTube requiere string.`,
      );
    }
  }

  // TikTok privacy_level must be UPPERCASE with underscores (PUBLIC_TO_EVERYONE,
  // MUTUAL_FOLLOW_FRIENDS, SELF_ONLY, FOLLOWER_OF_CREATOR). We don't have a
  // perfect lowercase-to-uppercase map for these (the SPA enums them from
  // privacy_level_options at runtime), so emit only a warning if the value
  // looks lowercase; let validateAgainstSpec catch the real mismatch.
  if (network === "tiktok" && "privacy_level" in out) {
    const v = out["privacy_level"];
    if (typeof v === "string" && v !== v.toUpperCase()) {
      notices.push(
        `preferences.privacy_level "${v}" para TikTok probablemente esté en case incorrecto. Valores típicos: PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY, FOLLOWER_OF_CREATOR (UPPERCASE con underscores). Verificá con validate_against_specs antes de publicar.`,
      );
    }
  }

  return { normalized: out, notices };
}
