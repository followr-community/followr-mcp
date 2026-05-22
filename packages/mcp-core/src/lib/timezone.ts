// Timezone math helpers. The MCP receives publish times as (date, time_local,
// timezone) triples and Followr stores publish_at in UTC. There is no date
// library in the dependency tree, so we use the native Date + Intl APIs.
//
// All helpers tolerate invalid input by returning null instead of throwing,
// to avoid crashing execute_content_plan on a single malformed item.

/**
 * Convert a local wall-clock time in a given IANA timezone to an ISO 8601 UTC
 * string suitable for the Followr backend `publish_at` field.
 *
 * @param dateYmd "2026-05-25" (YYYY-MM-DD).
 * @param timeHm  "10:00" (HH:MM, 24h).
 * @param ianaTz  IANA timezone id, e.g. "America/Argentina/Buenos_Aires", "Europe/Madrid", "UTC".
 * @returns ISO 8601 UTC string like "2026-05-25T13:00:00.000Z", or null if any input is malformed.
 *
 * The math: build a Date assuming the wall-clock IS UTC, then re-render it as
 * local time in the target timezone, compare the parsed parts back, and use
 * the delta as the offset to subtract from the naive UTC. Standard technique
 * for offset computation without a tz library; correct across DST jumps.
 */
export function localDateTimeToUtcIso(
  dateYmd: string,
  timeHm: string,
  ianaTz: string,
): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeHm);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: ianaTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    // Invalid IANA tz string. Caller should fall back.
    return null;
  }
  const parts = formatter.formatToParts(naiveUtc);
  const pick = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : Number.NaN;
  };
  const ly = pick("year");
  const lm = pick("month");
  const ld = pick("day");
  let lh = pick("hour");
  const lmin = pick("minute");
  const lsec = pick("second");
  if (
    Number.isNaN(ly) ||
    Number.isNaN(lm) ||
    Number.isNaN(ld) ||
    Number.isNaN(lh) ||
    Number.isNaN(lmin) ||
    Number.isNaN(lsec)
  ) {
    return null;
  }
  // Intl with hour12:false occasionally emits "24" for midnight; normalize to 0.
  if (lh === 24) lh = 0;
  const localAsUtc = Date.UTC(ly, lm - 1, ld, lh, lmin, lsec);
  const offsetMs = localAsUtc - naiveUtc.getTime();
  const trueUtc = new Date(naiveUtc.getTime() - offsetMs);
  return trueUtc.toISOString();
}

/**
 * Best-effort timezone fallback chain when an item or plan does not carry one.
 * Caller passes the candidates in priority order; first non-empty wins. Falls
 * back to "UTC" so callers never have to handle null tz themselves.
 */
export function resolveTimezone(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "UTC";
}
