// Timezone helper tests.
//
// The headline case: V8's Intl ACCEPTS legacy abbreviations ("ART", "EST",
// "PST", "CET") and maps them to surprising offsets ("ART" -> GMT+3, not
// Argentina's -3). isValidIanaTimezone must reject those, because an LLM that
// emits "ART" meaning Argentina would otherwise schedule posts 6h off in
// silence. Real IANA ids are "UTC" or Area/Location forms with a "/".

import { describe, it, expect } from "vitest";

import {
  isValidIanaTimezone,
  normalizeDetectedTimezone,
  detectServerTimezone,
  timezoneHumanLabel,
  localDateTimeToUtcIso,
} from "./timezone.js";

describe("isValidIanaTimezone", () => {
  it("accepts canonical Area/Location zones and UTC", () => {
    for (const tz of [
      "America/Buenos_Aires",
      "America/Argentina/Buenos_Aires",
      "Europe/Madrid",
      "Asia/Kolkata",
      "America/New_York",
      "Etc/UTC",
      "UTC",
    ]) {
      expect(isValidIanaTimezone(tz)).toBe(true);
    }
  });

  it("rejects legacy bare abbreviations even though Intl accepts them", () => {
    // These DO NOT throw in V8, but map to wrong offsets. Must be rejected.
    for (const tz of ["ART", "EST", "PST", "CET", "WET", "GMT", "GMT0", "ZULU"]) {
      expect(isValidIanaTimezone(tz)).toBe(false);
    }
  });

  it("rejects malformed / empty / non-string input", () => {
    for (const tz of ["", "  ", "GMT-3", "Buenos Aires", "Foo/Bar", "XYZ", null, undefined]) {
      expect(isValidIanaTimezone(tz as string)).toBe(false);
    }
  });

  it("is the gate that stops the ART footgun from reaching publish_at", () => {
    // localDateTimeToUtcIso WOULD happily compute a (wrong) instant for "ART"
    // because Intl accepts it. isValidIanaTimezone is what catches it first.
    expect(localDateTimeToUtcIso("2026-06-01", "13:00", "ART")).not.toBeNull();
    expect(isValidIanaTimezone("ART")).toBe(false);
  });
});

describe("normalizeDetectedTimezone", () => {
  it("returns a real geographic zone unchanged", () => {
    expect(normalizeDetectedTimezone("America/Buenos_Aires")).toBe("America/Buenos_Aires");
    expect(normalizeDetectedTimezone("Europe/London")).toBe("Europe/London");
  });

  it("treats a literal UTC-family id as no-signal (null)", () => {
    for (const tz of ["UTC", "Etc/UTC", "Etc/GMT+5", "etc/utc"]) {
      expect(normalizeDetectedTimezone(tz)).toBeNull();
    }
  });

  it("returns null for empty / invalid / non-string", () => {
    for (const tz of ["", "ART", "Foo/Bar", null, undefined]) {
      expect(normalizeDetectedTimezone(tz)).toBeNull();
    }
  });
});

describe("detectServerTimezone", () => {
  it("returns null or a valid IANA zone (never a bare abbreviation)", () => {
    const got = detectServerTimezone();
    expect(got === null || isValidIanaTimezone(got)).toBe(true);
  });
});

describe("timezoneHumanLabel", () => {
  it("renders city + offset", () => {
    const ref = new Date("2026-06-01T12:00:00Z");
    expect(timezoneHumanLabel("America/Argentina/Buenos_Aires", ref)).toBe("Buenos Aires (GMT-3)");
    expect(timezoneHumanLabel("Europe/Madrid", ref)).toBe("Madrid (GMT+2)");
    expect(timezoneHumanLabel("Asia/Kolkata", ref)).toBe("Kolkata (GMT+5:30)");
  });

  it("falls back to just the city when offset cannot be rendered", () => {
    // A bogus zone never reaches this in practice (guarded upstream), but the
    // helper must not throw.
    expect(timezoneHumanLabel("America/Buenos_Aires", new Date("2026-06-01T12:00:00Z"))).toContain(
      "Buenos Aires",
    );
  });
});
