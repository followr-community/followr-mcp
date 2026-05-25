// Sanitizer for backend responses before they reach MCP tools and the LLM.
//
// Context: Followr's backend exposes a legacy 'credits' field on several
// resources (FollowrUser, SubscriptionBalance, embedded user objects in
// other responses) that is a vestigial AppSumo lifetime + topups counter
// unrelated to the actual AI generation budget. Previous incidents:
// agents read `user.credits: 221` after an upload_video_from_url response
// and concluded "you only have 221 credits left" while the real budget
// (images_allowed - images_spent) was 16,397.
//
// Strategy: strip the bare key `credits` from every response, recursively,
// only when its value is a number (so it is unambiguous which field is the
// legacy counter). Composite keys like `credits_consumed`, `total_credits`,
// `cost_per_image_credits` stay untouched because they are MCP-computed
// fields with meaningful semantics.

const LEGACY_KEY = "credits";

/**
 * Recursively walks a JSON-shaped value and removes any bare `credits`
 * key whose value is a number. Returns a new structure when a strip
 * happened; otherwise returns the input by reference (so the hot path
 * for responses without the legacy field stays zero-copy).
 */
export function stripLegacyCredits<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let mutated = false;
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const sanitized = stripLegacyCredits(item);
      if (sanitized !== item) mutated = true;
      out[i] = sanitized;
    }
    return (mutated ? (out as unknown as T) : value);
  }
  const obj = value as Record<string, unknown>;
  let mutated = false;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (key === LEGACY_KEY && typeof v === "number") {
      mutated = true;
      continue;
    }
    const sanitized = stripLegacyCredits(v);
    if (sanitized !== v) mutated = true;
    out[key] = sanitized;
  }
  return mutated ? (out as T) : value;
}
