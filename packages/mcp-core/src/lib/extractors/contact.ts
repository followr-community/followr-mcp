// Contact info extractor.
//
// Pulls emails, phones, and physical addresses from the parsed page.
// Regex is fine here because we are operating on the BODY TEXT (already
// extracted by the html-parser wrapper, with scripts and styles stripped),
// not on raw HTML.
//
// Emails: standard RFC-ish pattern. Dedupes and lowercases.
// Phones: matches common Argentine, US, EU formats. Best-effort.
// Addresses: when JSON-LD PostalAddress is present, prefer that (caller's
//   job to merge). This module only does the text-mining fallback.

import type { ParsedHtml } from "./html-parser.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Matches sequences of digits, spaces, parens, plus, dashes that look
// like a phone number. Captures groups like:
//   +54 11 4444 5555
//   (011) 4444-5555
//   +1 (415) 555-1234
//   011-4444-5555
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}/g;

export interface ContactInfo {
  emails: string[];
  phones: string[];
}

export function extractContact(parsed: ParsedHtml): ContactInfo {
  // Also scan mailto: and tel: anchors. Those are explicit signals.
  const anchorEmails: string[] = [];
  const anchorPhones: string[] = [];
  for (const a of Array.from(parsed.document.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("mailto:")) {
      const e = href.slice(7).split("?")[0]?.trim();
      if (e) anchorEmails.push(e.toLowerCase());
    } else if (href.startsWith("tel:")) {
      const p = href.slice(4).trim();
      if (p) anchorPhones.push(p);
    }
  }

  const textEmails = (parsed.body_text.match(EMAIL_RE) ?? []).map((s) => s.toLowerCase());
  const textPhones = parsed.body_text.match(PHONE_RE) ?? [];

  const emails = dedupe([...anchorEmails, ...textEmails]).slice(0, 10);

  // Phone heuristic: drop matches with fewer than 7 digits to avoid
  // years, prices, room numbers. Normalize whitespace.
  const phones = dedupe(
    [...anchorPhones, ...textPhones]
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => (s.match(/\d/g)?.length ?? 0) >= 7),
  ).slice(0, 10);

  return { emails, phones };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
